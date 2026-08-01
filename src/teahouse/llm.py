"""
Teahouse — LLM 请求封装

基于 take_out/01-ai-call 的经验重构。
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, AsyncGenerator

import httpx

from .config import LLMConfig

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


# ===== URL normalization (from take_out model_config.py) =====

def normalize_api_url(url: str, api_format: str = "openai") -> str:
    """
    Intelligently complete API URL endpoint.

    OpenAI format:   append /v1/chat/completions
    Anthropic format: append /v1/messages
    Handles variants: bare domain, /v1, /v1/ already present, etc.
    """
    url = url.strip().rstrip("/")
    if api_format == "anthropic":
        if url.endswith("/messages"):
            return url
        return url + "/messages"
    else:
        if "/chat/completions" in url:
            return url
        if url.endswith("/v1"):
            return url + "/chat/completions"
        return url + "/v1/chat/completions"


# ===== Message preprocessing (from take_out llm_api_adapter.py) =====

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
        body: dict[str, Any] = {
            "model": kwargs.pop("model", cfg.model),
            "max_tokens": kwargs.pop("max_tokens", cfg.max_tokens),
            "temperature": kwargs.pop("temperature", cfg.temperature),
            **kwargs,
        }
        if stream:
            body["stream"] = True
            if self.api_style == "openai":
                body["stream_options"] = {"include_usage": True}

        # Include tools if provided via kwargs
        tools = kwargs.pop("tools", None)
        if tools:
            body["tools"] = tools

        messages = preprocess_messages(messages, self.api_style)

        # Strip internal frontend keys before sending to LLM API
        for m in messages:
            m.pop("blocks", None)
            m.pop("reasoning", None)
            m.pop("status", None)
            m.pop("id", None)

        if self.api_style == "anthropic":
            body["messages"] = messages
            if system:
                body["system"] = system
            return body

        # openai
        body["messages"] = messages
        if system:
            body["messages"].insert(0, {"role": "system", "content": system})
        return body

    @property
    def _api_url(self) -> str:
        return normalize_api_url(self.config.url, self.api_style)

    async def _retry_request(self, body: dict) -> httpx.Response:
        """Post with exponential backoff on transient network errors.

        Does NOT retry on HTTP errors (4xx/5xx) — those are logic/config errors.
        """
        last_exc: Exception | None = None
        for attempt in range(self.max_retries + 1):
            try:
                async with httpx.AsyncClient(timeout=120) as client:
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
            raise LLMError(f"LLM API error {resp.status_code}: {resp.text[:500]}")
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
            body: dict[str, Any] = {
                "model": kwargs.get("model", cfg.model),
                "max_tokens": kwargs.get("max_tokens", cfg.max_tokens),
                "temperature": kwargs.get("temperature", cfg.temperature),
                "tools": kwargs["tools"],
            }
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
            raise LLMError(f"LLM API error {resp.status_code}: {resp.text[:500]}")
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
        async with httpx.AsyncClient(timeout=300) as client:
            async with client.stream("POST", self._api_url, headers=self._headers(), json=body) as resp:
                if resp.status_code >= 400:
                    text = await resp.aread()
                    raise LLMError(f"API error ({resp.status_code}): {text[:200]}")
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
        async with httpx.AsyncClient(timeout=300) as client:
            async with client.stream("POST", self._api_url, headers=self._headers(), json=body) as resp:
                if resp.status_code >= 400:
                    text = await resp.aread()
                    raise LLMError(f"Anthropic API error ({resp.status_code}): {text[:200]}")
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
        first_chunk = True

        async with httpx.AsyncClient(timeout=300) as client:
            async with client.stream("POST", self._api_url, headers=self._headers(), json=body) as resp:
                if resp.status_code >= 400:
                    text = await resp.aread()
                    raise LLMError(f"API error ({resp.status_code}): {text[:200]}")
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
                    for tc_delta in tc_deltas:
                        idx = tc_delta.get("index", 0)
                        if idx not in tool_call_acc:
                            tool_call_acc[idx] = {"id": "", "function": {"name": "", "arguments": ""}}
                        tc = tool_call_acc[idx]
                        if tc_delta.get("id"):
                            tc["id"] = tc_delta["id"]
                        if tc_delta.get("function", {}).get("name"):
                            tc["function"]["name"] += tc_delta["function"]["name"]
                        if tc_delta.get("function", {}).get("arguments"):
                            frag = tc_delta["function"]["arguments"]
                            tc["function"]["arguments"] += frag
                            # Yield as hidden text for frontend token counting only
                            yield {"type": "text", "text": frag, "tool_args": True}

                # Stream done — yield assembled tool calls if any
                if tool_call_acc:
                    calls = [
                        {"id": tc["id"], "type": "function", "function": tc["function"]}
                        for tc in sorted(tool_call_acc.values(), key=lambda t: t.get("index", 0))
                    ]
                    yield {"type": "tool_calls", "calls": calls}

    async def _stream_anthropic_tools(self, body: dict) -> AsyncGenerator[dict, None]:
        """Stream Anthropic response, accumulating tool_use blocks. Yields text chunks and final tool_calls."""
        tool_blocks: dict[int, dict] = {}
        first_chunk = True

        async with httpx.AsyncClient(timeout=300) as client:
            async with client.stream("POST", self._api_url, headers=self._headers(), json=body) as resp:
                if resp.status_code >= 400:
                    text = await resp.aread()
                    raise LLMError(f"Anthropic API error ({resp.status_code}): {text[:200]}")
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

                    elif current_event == "message_stop":
                        break

                if tool_blocks:
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
