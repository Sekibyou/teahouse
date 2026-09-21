"""
Teahouse — LLM 请求封装

基于 take_out/01-ai-call 的经验重构。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any, AsyncGenerator

import httpx

from .config import LLMConfig
from .reasoning import effort_kwargs

logger = logging.getLogger("teahouse.llm")

# Network errors worth retrying — transient failures, not logic errors
RETRYABLE_EXCEPTIONS = (
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.ReadError,
    httpx.ReadTimeout,
    httpx.WriteError,
    httpx.WriteTimeout,
    httpx.RemoteProtocolError,
    httpx.PoolTimeout,
)


class LLMError(Exception):
    """Base exception for LLM API errors."""


# ===== Upstream error body rendering =====

# Upper bound on the error body kept in an LLMError message. Generous on purpose:
# the frontend shows a short toast preview but puts the full text in a scrollable
# dialog, so the only cost of a long body is a bigger payload — whereas cutting it
# short (200 chars, as it once did) can hide the actual cause entirely.
_ERROR_BODY_MAX = 4000


def _deepest_error(value: Any, depth: int = 0) -> tuple[str | None, Any]:
    """Descend into a (possibly doubly-encoded) error payload.

    Returns `(message, container)` — the innermost human message plus the object it
    was found in. The container is what's worth showing as structured context: the
    outer wrapper is gateway noise, and its nested string is precisely the layer
    that keeps the `\\"` escapes which made the raw body unreadable.
    """
    if depth > 8:
        return None, None
    if isinstance(value, str):
        s = value.strip()
        if s[:1] in ("{", "["):
            try:
                return _deepest_error(json.loads(s), depth + 1)
            except (json.JSONDecodeError, ValueError):
                return None, None
        return (s or None), None
    if isinstance(value, dict):
        for key in ("message", "detail", "error", "msg", "reason"):
            if key in value:
                message, container = _deepest_error(value[key], depth + 1)
                if message:
                    # A leaf string has no container of its own — this dict is the
                    # most specific object that holds the message.
                    return message, (container if container is not None else value)
        return None, None
    if isinstance(value, list):
        for item in value:
            message, container = _deepest_error(item, depth + 1)
            if message:
                return message, container
    return None, None


def format_error_body(raw: bytes | str) -> str:
    """Render an upstream error body as readable text.

    Two things routinely make these bodies unreadable as-is:

    1. `resp.aread()` hands back `bytes`; dropping that straight into an f-string
       yields Python's bytes repr (`b'...'`, non-ASCII as `\\xe8\\xaf\\xa5`).
    2. Gateways often carry their error payload *as a string* inside the outer
       JSON document, so the real message sits behind a layer of `\\"` escapes.

    Decode, peel the nesting, and lead with the innermost message with the parsed
    payload underneath (which keeps the code/status/type the message alone drops).
    """
    if isinstance(raw, (bytes, bytearray)):
        text = bytes(raw).decode("utf-8", errors="replace")
    else:
        text = str(raw)
    text = text.strip()
    if not text:
        return "(empty response body)"

    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return text[:_ERROR_BODY_MAX]

    if isinstance(parsed, str):
        return parsed[:_ERROR_BODY_MAX]

    message, container = _deepest_error(parsed)
    # Dump the *innermost* object, not the raw body: that is the layer that has
    # already been unescaped, so nothing shows up as `\"` soup.
    pretty = json.dumps(
        container if container is not None else parsed, ensure_ascii=False, indent=2
    )
    out = f"{message}\n\n{pretty}" if message else pretty
    return out[:_ERROR_BODY_MAX]


# ===== URL normalization (from take_out model_config.py) =====

# 匹配已带 API 版本路径的 base URL：`/v1`、`/v4`、`/v3`、`/v2`、`/v1beta/` 等。
# 这类 base 直接追加端点即可，不应再补 `/v1`（否则智谱 `/v4`、火山 `/v3`、千帆 `/v2`、
# Gemini `/v1beta/openai` 会被拼成 `.../v4/v1/chat/completions` 而 404）。
VERSIONED_BASE_RE = re.compile(r"/v\d+(?:/|$)|/v1beta/")


def normalize_api_url(url: str, api_format: str = "openai") -> str:
    """
    Intelligently complete API URL endpoint.

    OpenAI format:   append /v1/chat/completions（base 已带版本路径时只补 /chat/completions）
    Anthropic format: append /v1/messages
    Handles variants: bare domain, /v1, /v1/, /v4, /v1beta/openai, full endpoint already present.
    """
    url = url.strip().rstrip("/")
    if api_format == "anthropic":
        if "/messages" in url:
            return url
        if url.endswith("/v1"):
            return url + "/messages"
        return url + "/v1/messages"

    # openai / openai_strict
    if "/chat/completions" in url:
        return url
    if VERSIONED_BASE_RE.search(url):
        return url + "/chat/completions"
    return url + "/v1/chat/completions"


# ===== Usage normalization =====

def _coerce_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def normalize_usage(style: str, raw: dict | None) -> dict | None:
    """Normalize a vendor usage block into provider-neutral token counts.

    Returns ``{input_total, cached_read, cache_write, output}``, or None when the
    block carries nothing usable. The two vendors bucket input differently:
    OpenAI's ``prompt_tokens`` already counts the cached ones, while Anthropic's
    three input fields are disjoint buckets. Summing them makes ``input_total``
    the *full* prompt length in both cases, so ``cached_read / input_total`` is a
    cache hit rate that can be compared across vendors.
    """
    if not raw:
        return None

    if style == "anthropic":
        cached_read = _coerce_int(raw.get("cache_read_input_tokens"))
        cache_write = _coerce_int(raw.get("cache_creation_input_tokens"))
        input_total = _coerce_int(raw.get("input_tokens")) + cached_read + cache_write
        output = _coerce_int(raw.get("output_tokens"))
    else:
        cached_read = _coerce_int((raw.get("prompt_tokens_details") or {}).get("cached_tokens"))
        # Some OpenAI-compatible vendors report cache writes too (the Responses
        # API namesakes); absent elsewhere.
        cache_write = _coerce_int((raw.get("input_tokens_details") or {}).get("cache_write_tokens"))
        input_total = _coerce_int(raw.get("prompt_tokens"))
        output = _coerce_int(raw.get("completion_tokens"))

    if not input_total and not output:
        return None

    return {
        "input_total": input_total,
        "cached_read": cached_read,
        "cache_write": cache_write,
        "output": output,
    }


# ===== Message preprocessing (from take_out llm_api_adapter.py) =====

def _as_parts(content: Any) -> list[dict]:
    """Normalize a message content value into a multimodal part list.

    A plain string folds into a single text part — a shape both the Anthropic
    and OpenAI APIs accept — so merging a string message with a parts message
    (attached images) can concatenate uniformly.
    """
    if isinstance(content, list):
        return list(content)
    if content:
        return [{"type": "text", "text": content}]
    return []


def preprocess_messages(messages: list[dict], api_format: str) -> list[dict]:
    """Merge consecutive same-role messages, ensure first non-system is user."""
    m = messages

    # Merge consecutive same-role messages (skip tool/function messages)
    merged = []
    for msg in m:
        if msg.get("tool_calls") or msg.get("tool_call_id") or msg.get("role") in ("tool", "function"):
            merged.append(dict(msg))
            continue
        content = msg.get("content")
        if content is None:
            merged.append(dict(msg))
            continue
        if merged and merged[-1]["role"] == msg["role"]:
            prev_content = merged[-1].get("content", "")
            if isinstance(prev_content, list) or isinstance(content, list):
                # Multimodal parts (attached images): concatenate part lists.
                merged[-1]["content"] = _as_parts(prev_content) + _as_parts(content)
            else:
                if prev_content is None:
                    prev_content = ""
                merged[-1]["content"] = prev_content + "\n" + content
        else:
            merged.append(dict(msg))
    m = merged

    # openai_strict: cannot end with assistant
    if api_format == "openai_strict" and m and m[-1]["role"] == "assistant":
        m = m[:-1]

    # First non-system message must be user (Gemini etc. require this)
    non_system = [x for x in m if x["role"] != "system"]
    if non_system and non_system[0]["role"] != "user":
        idx = next(i for i, x in enumerate(m) if x["role"] != "system")
        m = m[:idx] + [{"role": "user", "content": ""}] + m[idx:]

    return m


# ===== Tool schema translation =====

def tools_for_style(tools: list[dict] | None, api_format: str) -> list[dict] | None:
    """Translate internal (OpenAI function-calling) tool schemas into the vendor's shape.

    Tools are always built OpenAI-style — `{type: "function", function: {name,
    description, parameters}}` (see `tools._raw_tool_to_schema`) — because that is what
    the OpenAI-compatible path sends. Anthropic's Messages API at the version we pin
    (2023-06-01) takes a *flat* client tool instead: `{name, description, input_schema}`
    and **no `type` tag** — the tag exists only on server tools (e.g. `web_search_*`).
    Handing the OpenAI shape to a spec-compliant Anthropic endpoint rejects the entire
    request (422, serde: "unknown variant `function`, expected `web_search_...`"), so
    every tool-using turn fails.
    """
    if not tools or api_format != "anthropic":
        return tools
    out: list[dict] = []
    for t in tools:
        # Already translated, or a plugin that supplied the Anthropic shape itself.
        if "input_schema" in t:
            out.append(dict(t))
            continue
        fn = t.get("function") or {}
        out.append({
            "name": fn.get("name") or t.get("name", ""),
            "description": fn.get("description", ""),
            "input_schema": fn.get("parameters") or {"type": "object", "properties": {}},
        })
    return out


# ===== LLM Client =====

class LLMClient:
    """LLM API client — api_style ("openai" / "anthropic") must be set in teahouse.yaml."""

    def __init__(self, config: LLMConfig, max_retries: int = 3) -> None:
        self.config = config
        self.api_style = config.api_style
        self.max_retries = max_retries

    def _headers(self) -> dict[str, str]:
        if self.api_style == "anthropic":
            return {
                "x-api-key": self.config.key,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            }
        return {
            "Authorization": f"Bearer {self.config.key}",
            "Content-Type": "application/json",
        }

    def _request_body(self, messages: list[dict], system: str | None, stream: bool, **kwargs: Any) -> dict:
        cfg = self.config

        # Translate our internal reasoning-effort (none|low|mid|high|max) onto
        # this API's native knob. It arrives as a plain internal enum through
        # kwargs and must NOT leak through as-is into the body.
        effort = kwargs.pop("reasoning_effort", None)

        body: dict[str, Any] = {
            "model": kwargs.pop("model", cfg.model),
            "max_tokens": kwargs.pop("max_tokens", cfg.max_tokens),
            "temperature": kwargs.pop("temperature", cfg.temperature),
            **kwargs,
        }
        if effort is not None:
            body.update(effort_kwargs(self.api_style, effort, self.config.capabilities))
        if stream:
            body["stream"] = True
            if self.api_style == "openai":
                body["stream_options"] = {"include_usage": True}

        # Include tools if provided via kwargs
        tools = kwargs.pop("tools", None)
        if tools:
            if self.api_style == "anthropic":
                # Flat {name, description, input_schema} — see tools_for_style.
                tools = [dict(t) for t in tools_for_style(tools, "anthropic")]
                # Prompt-cache breakpoint on the last tool. Tools render BEFORE
                # system and messages, so one breakpoint here caches the whole
                # tool block alongside the system prompt below. Anthropic caches
                # nothing without an explicit breakpoint, which would leave every
                # round reporting a 0% hit rate.
                tools[-1]["cache_control"] = {"type": "ephemeral"}
            body["tools"] = tools

        messages = preprocess_messages(messages, self.api_style)

        # Map internal reasoning onto the API's reasoning field and keep it.
        # Thinking-enabled models (e.g. DeepSeek-Reasoner) require the prior
        # assistant turn's reasoning to be echoed back in full, or they reject
        # the request with "reasoning_content must be passed back". For OpenAI
        # the field is `reasoning_content`; Anthropic keeps it as a thinking
        # block produced below. We only attach it when the message actually has
        # reasoning (a no-thinking turn must not fabricate one).
        if self.api_style == "openai":
            for m in messages:
                reasoning = m.pop("reasoning", None)
                m.pop("blocks", None)
                m.pop("status", None)
                m.pop("id", None)
                if m.get("role") == "assistant" and reasoning:
                    m["reasoning_content"] = reasoning
                # A tool-call turn with no prose must NOT carry a `content` key at
                # all. Gemini's OpenAI-compat layer turns a present-but-empty
                # content into an extra text part, and the functionCall beside it
                # then loses its thought_signature — the request 400s with
                # "Function call is missing a thought_signature in functionCall
                # parts". Omitting the key entirely is what the vendor's own
                # examples show. (OpenAI itself accepts either form.)
                if m.get("tool_calls") and not m.get("content"):
                    m.pop("content", None)
        else:
            # anthropic style: strip internal keys, thinking is represented via
            # content blocks (already handled by the caller upstream).
            for m in messages:
                m.pop("reasoning", None)
                m.pop("blocks", None)
                m.pop("status", None)
                m.pop("id", None)

        if self.api_style == "anthropic":
            body["messages"] = messages
            if system:
                # Block form (not a bare string) so the breakpoint can sit on the
                # end of the system prompt — the stable part of every request.
                body["system"] = [
                    {"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}
                ]
            return body

        # openai
        body["messages"] = messages
        if system:
            body["messages"].insert(0, {"role": "system", "content": system})
        return body

    @property
    def _api_url(self) -> str:
        return normalize_api_url(self.config.url, self.api_style)

    def _client(self, timeout: float | None = None) -> httpx.AsyncClient:
        """Shared httpx client with native connect/read retry.

        httpx's transport-level retry covers ConnectError/ConnectTimeout/ReadTimeout
        etc. (RETRYABLE_EXCEPTIONS), which also works inside streaming generators
        where a manual backoff loop can't be interleaved with body iteration.
        """
        transport = httpx.AsyncHTTPTransport(retries=self.max_retries)
        return httpx.AsyncClient(timeout=timeout, transport=transport)

    async def _retry_request(self, body: dict) -> httpx.Response:
        """Post with exponential backoff on transient network errors.

        Does NOT retry on HTTP errors (4xx/5xx) — those are logic/config errors.
        """
        last_exc: Exception | None = None
        for attempt in range(self.max_retries + 1):
            try:
                async with self._client(timeout=120) as client:
                    return await client.post(self._api_url, headers=self._headers(), json=body)
            except RETRYABLE_EXCEPTIONS as exc:
                last_exc = exc
                if attempt < self.max_retries:
                    delay = 2 ** attempt  # 1s, 2s, 4s, ...
                    logger.warning(
                        "LLM request failed (attempt %s/%s): %s — retrying in %ss",
                        attempt + 1, self.max_retries + 1, exc, delay,
                    )
                    await asyncio.sleep(delay)
        raise last_exc  # type: ignore[misc]

    async def send_message(
        self,
        messages: list[dict],
        system: str | None = None,
        **kwargs: Any,
    ) -> str:
        """Non-streaming call, returns the full response text."""
        body = self._request_body(messages, system, stream=False, **kwargs)
        resp = await self._retry_request(body)
        if resp.status_code >= 400:
            raise LLMError(f"LLM API error {resp.status_code}: {format_error_body(resp.text)}")
        data = resp.json()
        return _extract_text(data, self.api_style)

    async def send_message_full(
        self,
        messages: list[dict],
        system: str | None = None,
        **kwargs: Any,
    ) -> dict:
        """Non-streaming call, returns the full raw response dict (for tool use parsing).

        When tools are provided, skips preprocess_messages to preserve tool call structure.
        """
        cfg = self.config

        if kwargs.get("tools"):
            # Translate effort before building (mirrors _request_body).
            effort = kwargs.pop("reasoning_effort", None)
            body: dict[str, Any] = {
                "model": kwargs.get("model", cfg.model),
                "max_tokens": kwargs.get("max_tokens", cfg.max_tokens),
                "temperature": kwargs.get("temperature", cfg.temperature),
                "tools": tools_for_style(kwargs["tools"], self.api_style),
            }
            if effort is not None:
                body.update(effort_kwargs(self.api_style, effort, self.config.capabilities))
            if self.api_style == "anthropic":
                body["messages"] = messages
                if system:
                    body["system"] = system
            else:
                # Copy messages to avoid mutating original
                msgs = list(messages)
                if system:
                    msgs.insert(0, {"role": "system", "content": system})
                body["messages"] = msgs
        else:
            body = self._request_body(messages, system, stream=False, **kwargs)

        resp = await self._retry_request(body)
        if resp.status_code >= 400:
            raise LLMError(f"LLM API error {resp.status_code}: {format_error_body(resp.text)}")
        return resp.json()

    async def send_message_stream(
        self,
        messages: list[dict],
        system: str | None = None,
        **kwargs: Any,
    ) -> AsyncGenerator[dict, None]:
        """Streaming call, yields {"type": "reasoning"|"text", "text": str} chunks."""
        body = self._request_body(messages, system, stream=True, **kwargs)

        if self.api_style == "anthropic":
            async for chunk in self._stream_anthropic(body):
                yield chunk
        else:
            async for chunk in self._stream_openai(body):
                yield chunk

    async def _stream_openai(self, body: dict) -> AsyncGenerator[dict, None]:
        async with self._client() as client:
            async with client.stream("POST", self._api_url, headers=self._headers(), json=body) as resp:
                if resp.status_code >= 400:
                    text = await resp.aread()
                    raise LLMError(f"API error ({resp.status_code}): {format_error_body(text)}")
                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    payload = line[6:].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        data = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    choices = data.get("choices", [])
                    if choices:
                        delta = choices[0].get("delta", {})
                        reasoning = delta.get("reasoning_content", "")
                        if reasoning:
                            yield {"type": "reasoning", "text": reasoning}
                        text = delta.get("content", "")
                        if text:
                            yield {"type": "text", "text": text}

    async def _stream_anthropic(self, body: dict) -> AsyncGenerator[dict, None]:
        async with self._client() as client:
            async with client.stream("POST", self._api_url, headers=self._headers(), json=body) as resp:
                if resp.status_code >= 400:
                    text = await resp.aread()
                    raise LLMError(f"Anthropic API error ({resp.status_code}): {format_error_body(text)}")
                current_event = None
                # Track block types for content_block_delta routing
                block_types: dict[int, str] = {}
                block_index = -1
                async for line in resp.aiter_lines():
                    if line.startswith("event: "):
                        current_event = line[7:].strip()
                        continue
                    if not line.startswith("data: "):
                        continue
                    data = json.loads(line[6:])

                    if current_event == "content_block_start":
                        block_index = data.get("index", block_index + 1)
                        block_type = data.get("content_block", {}).get("type", "text")
                        block_types[block_index] = block_type

                    elif current_event == "content_block_delta":
                        idx = data.get("index", 0)
                        delta = data.get("delta", {})
                        delta_type = delta.get("type", "")
                        if delta_type == "text_delta":
                            text = delta.get("text", "")
                            if text:
                                block_type = block_types.get(idx, "text")
                                chunk_type = "reasoning" if block_type == "thinking" else "text"
                                yield {"type": chunk_type, "text": text}
                        elif delta_type == "thinking_delta":
                            text = delta.get("thinking", "")
                            if text:
                                yield {"type": "reasoning", "text": text}

                    elif current_event == "message_stop":
                        break

    async def send_message_stream_tools(
        self,
        messages: list[dict],
        system: str | None = None,
        **kwargs: Any,
    ) -> AsyncGenerator[dict, None]:
        """Streaming call that yields tool_call events as they arrive.

        Yields:
          {"type": "text", "text": str}      — text chunks (also sends empty text on first chunk for heartbeat)
          {"type": "tool_calls", "calls": [...]}  — once all tool call fragments are assembled (end of stream)
        """
        body = self._request_body(messages, system, stream=True, **kwargs)

        if self.api_style == "anthropic":
            async for event in self._stream_anthropic_tools(body):
                yield event
        else:
            async for event in self._stream_openai_tools(body):
                yield event

    async def _stream_openai_tools(self, body: dict) -> AsyncGenerator[dict, None]:
        """Stream OpenAI response, accumulating tool_call fragments. Yields text chunks and final tool_calls."""
        tool_call_acc: dict[int, dict] = {}
        # Last usage block seen this stream (see the choices guard below).
        usage: dict | None = None
        # Ordinals (0-based position among this round's tool calls) already
        # announced as complete. When a delta for a higher index shows up, every
        # lower index is necessarily finished — the caller may start executing
        # those while the rest of the round is still streaming.
        announced: set[int] = set()

        def _take_ready(upto: int | None) -> list[dict]:
            """Consume unannounced indexes below ``upto`` (None = all) as ready events."""
            out: list[dict] = []
            for j in sorted(tool_call_acc):
                if j in announced or (upto is not None and j >= upto):
                    continue
                announced.add(j)
                tc = tool_call_acc[j]
                out.append({
                    "type": "tool_call_ready",
                    "index": j,
                    "id": tc["id"],
                    "name": tc["function"]["name"],
                    # Raw fragment; the caller parses it and falls back to the
                    # end-of-round path when the JSON is not usable.
                    "arguments": tc["function"]["arguments"],
                    "extra": tc.get("extra"),
                })
            return out

        first_chunk = True

        async with self._client() as client:
            async with client.stream("POST", self._api_url, headers=self._headers(), json=body) as resp:
                if resp.status_code >= 400:
                    text = await resp.aread()
                    raise LLMError(f"API error ({resp.status_code}): {format_error_body(text)}")
                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    payload = line[6:].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        data = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    # Usage arrives on a trailing chunk whose `choices` is EMPTY,
                    # so it must be read before the guard below drops that chunk.
                    # (Some vendors instead attach it to a chunk that does carry
                    # choices — reading unconditionally covers both.)
                    _u = normalize_usage("openai", data.get("usage"))
                    if _u:
                        usage = _u

                    choices = data.get("choices", [])
                    if not choices:
                        continue
                    choice = choices[0]
                    delta = choice.get("delta", {})

                    # Send empty heartbeat on first chunk so frontend switches from waiting to generating
                    if first_chunk:
                        first_chunk = False
                        yield {"type": "text", "text": ""}

                    # Text content
                    text = delta.get("content", "")
                    if text:
                        yield {"type": "text", "text": text}

                    # Reasoning
                    reasoning = delta.get("reasoning_content", "")
                    if reasoning:
                        yield {"type": "reasoning", "text": reasoning}

                    # Tool call fragments
                    tc_deltas = delta.get("tool_calls", [])
                    _max_idx = None
                    for tc_delta in tc_deltas:
                        idx = tc_delta.get("index", 0)
                        if idx not in tool_call_acc:
                            tool_call_acc[idx] = {
                                "id": "", "function": {"name": "", "arguments": ""},
                                # Some vendors (Gemini's OpenAI-compat layer) attach
                                # provider metadata here — notably thought_signature,
                                # which MUST be echoed back on replay or the next
                                # request 400s. Opaque to us; carried verbatim.
                                "extra": None,
                            }
                        tc = tool_call_acc[idx]
                        if tc_delta.get("id"):
                            tc["id"] = tc_delta["id"]
                        if tc_delta.get("extra_content") is not None:
                            tc["extra"] = tc_delta["extra_content"]
                        if tc_delta.get("function", {}).get("name"):
                            tc["function"]["name"] += tc_delta["function"]["name"]
                        if tc_delta.get("function", {}).get("arguments"):
                            frag = tc_delta["function"]["arguments"]
                            tc["function"]["arguments"] += frag
                            # Yield as hidden text for frontend token counting only
                            yield {"type": "text", "text": frag, "tool_args": True}
                        _max_idx = idx if _max_idx is None else max(_max_idx, idx)
                    if _max_idx is not None:
                        # Everything below the highest index seen here is complete.
                        for ev in _take_ready(_max_idx):
                            yield ev

                if usage:
                    yield {"type": "usage", **usage}

                # Stream done — announce whatever is still pending, then yield the
                # assembled tool calls.
                if tool_call_acc:
                    for ev in _take_ready(None):
                        yield ev
                    calls = []
                    for _idx, tc in sorted(tool_call_acc.items()):
                        call = {"id": tc["id"], "type": "function", "function": tc["function"]}
                        if tc.get("extra") is not None:
                            call["extra"] = tc["extra"]
                        calls.append(call)
                    yield {"type": "tool_calls", "calls": calls}

    async def _stream_anthropic_tools(self, body: dict) -> AsyncGenerator[dict, None]:
        """Stream Anthropic response, accumulating tool_use blocks. Yields text chunks and final tool_calls."""
        tool_blocks: dict[int, dict] = {}
        # Content block indexes whose tool_use block already closed (that is the
        # protocol's per-tool "arguments are complete" signal).
        announced: set[int] = set()
        # Usage is split across two events: `message_start` carries the whole
        # input side (including both cache buckets), `message_delta` the running
        # output count. Accumulate both, normalize once at the end.
        usage_raw: dict = {}
        first_chunk = True

        def _ready_event(idx: int) -> dict:
            tb = tool_blocks[idx]
            # Ordinal among this round's tool calls — content block indexes also
            # count text/thinking blocks, so they are not the tool ordinal.
            ordinal = sum(1 for k in tool_blocks if k < idx)
            return {
                "type": "tool_call_ready",
                "index": ordinal,
                "id": tb["id"],
                "name": tb["name"],
                # Raw fragment; the caller parses it and falls back to the
                # end-of-round path when the JSON is not usable.
                "arguments": tb.get("input_json", ""),
            }

        async with self._client() as client:
            async with client.stream("POST", self._api_url, headers=self._headers(), json=body) as resp:
                if resp.status_code >= 400:
                    text = await resp.aread()
                    raise LLMError(f"Anthropic API error ({resp.status_code}): {format_error_body(text)}")
                current_event = None
                block_types: dict[int, str] = {}
                block_index = -1
                async for line in resp.aiter_lines():
                    if line.startswith("event: "):
                        current_event = line[7:].strip()
                        continue
                    if not line.startswith("data: "):
                        continue
                    data = json.loads(line[6:])

                    if first_chunk:
                        first_chunk = False
                        yield {"type": "text", "text": ""}

                    if current_event == "message_start":
                        usage_raw.update((data.get("message") or {}).get("usage") or {})
                    elif current_event == "message_delta":
                        usage_raw.update(data.get("usage") or {})

                    if current_event == "content_block_start":
                        block_index = data.get("index", block_index + 1)
                        block_type = data.get("content_block", {}).get("type", "text")
                        block_types[block_index] = block_type
                        if block_type == "tool_use":
                            block = data.get("content_block", {})
                            tool_blocks[block_index] = {
                                "id": block.get("id", ""),
                                "name": block.get("name", ""),
                                "input": {},
                            }

                    elif current_event == "content_block_delta":
                        idx = data.get("index", 0)
                        delta = data.get("delta", {})
                        delta_type = delta.get("type", "")
                        if delta_type == "text_delta":
                            text = delta.get("text", "")
                            if text:
                                block_type = block_types.get(idx, "text")
                                yield {"type": "reasoning" if block_type == "thinking" else "text", "text": text}
                        elif delta_type == "thinking_delta":
                            text = delta.get("thinking", "")
                            if text:
                                yield {"type": "reasoning", "text": text}
                        elif delta_type == "input_json_delta":
                            partial = delta.get("partial_json", "")
                            if idx in tool_blocks:
                                tool_blocks[idx]["input_json"] = (tool_blocks[idx].get("input_json", "") + partial)
                                # Yield as hidden text for frontend token counting only
                                # (mirrors OpenAI path), so long tool-arg generation keeps
                                # both the token counter and the elapsed timer moving.
                                yield {"type": "text", "text": partial, "tool_args": True}

                    elif current_event == "content_block_stop":
                        idx = data.get("index", 0)
                        if idx in tool_blocks and idx not in announced:
                            announced.add(idx)
                            yield _ready_event(idx)

                    elif current_event == "message_stop":
                        break

                _u = normalize_usage("anthropic", usage_raw)
                if _u:
                    yield {"type": "usage", **_u}

                if tool_blocks:
                    # Announce any tool block whose stop event never arrived.
                    for idx in sorted(tool_blocks):
                        if idx not in announced:
                            announced.add(idx)
                            yield _ready_event(idx)
                    calls = []
                    for idx in sorted(tool_blocks.keys()):
                        tb = tool_blocks[idx]
                        args = {}
                        if tb.get("input_json"):
                            try:
                                args = json.loads(tb["input_json"])
                            except json.JSONDecodeError:
                                pass
                        calls.append({
                            "id": tb["id"],
                            "type": "function",
                            "function": {"name": tb["name"], "arguments": json.dumps(args)},
                        })
                    yield {"type": "tool_calls", "calls": calls}


# ===== Text extraction helpers =====

def _extract_text(data: dict, style: str) -> str:
    """Extract final text from a non-streaming LLM response."""
    if style == "anthropic":
        blocks = data.get("content", [])
        text_blocks = [b["text"] for b in blocks if b.get("type") == "text"]
        if len(text_blocks) > 1:
            text_blocks = text_blocks[-1:]
        return "\n".join(text_blocks)
    # openai
    choices = data.get("choices", [])
    if choices:
        msg = choices[0].get("message", {})
        return msg.get("content", "")
    return ""


def _extract_tool_calls(data: dict, style: str) -> list[dict] | None:
    """Extract tool_calls from a non-streaming LLM response.

    Returns a list of {id, type, function: {name, arguments}} dicts,
    or None if no tool_calls present.
    """
    if style == "anthropic":
        blocks = data.get("content", [])
        tool_blocks = [b for b in blocks if b.get("type") == "tool_use"]
        if not tool_blocks:
            return None
        result = []
        for tb in tool_blocks:
            result.append({
                "id": tb["id"],
                "type": "function",
                "function": {
                    "name": tb["name"],
                    "arguments": json.dumps(tb["input"]) if not isinstance(tb["input"], str) else tb["input"],
                },
            })
        return result
    # openai
    choices = data.get("choices", [])
    if not choices:
        return None
    msg = choices[0].get("message", {})
    tool_calls = msg.get("tool_calls")
    if not tool_calls:
        return None
    # Normalize to our format
    result = []
    for tc in tool_calls:
        result.append({
            "id": tc.get("id", ""),
            "type": tc.get("type", "function"),
            "function": {
                "name": tc["function"]["name"],
                "arguments": tc["function"]["arguments"],
            },
        })
    return result
