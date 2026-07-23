"""
Teahouse — LLM 请求封装

基于 take_out/01-ai-call 的经验重构。
"""
from __future__ import annotations

import json
from typing import Any, AsyncGenerator

import httpx

from .config import LLMConfig


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
        if "/messages" in url:
            return url
        if url.endswith("/v1"):
            return url + "/messages"
        return url + "/v1/messages"
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

    # Merge consecutive same-role messages
    merged = []
    for msg in m:
        if merged and merged[-1]["role"] == msg["role"]:
            merged[-1]["content"] += "\n" + msg["content"]
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

    def __init__(self, config: LLMConfig) -> None:
        self.config = config
        self.api_style = config.api_style

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

        messages = preprocess_messages(messages, self.api_style)

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

    async def send_message(
        self,
        messages: list[dict],
        system: str | None = None,
        **kwargs: Any,
    ) -> str:
        """Non-streaming call, returns the full response text."""
        body = self._request_body(messages, system, stream=False, **kwargs)
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(self._api_url, headers=self._headers(), json=body)
        if resp.status_code >= 400:
            raise LLMError(f"LLM API error {resp.status_code}: {resp.text[:500]}")
        data = resp.json()
        return _extract_text(data, self.api_style)

    async def send_message_stream(
        self,
        messages: list[dict],
        system: str | None = None,
        **kwargs: Any,
    ) -> AsyncGenerator[str, None]:
        """Streaming call, yields incremental text chunks."""
        body = self._request_body(messages, system, stream=True, **kwargs)

        if self.api_style == "anthropic":
            async for chunk in self._stream_anthropic(body):
                yield chunk
        else:
            async for chunk in self._stream_openai(body):
                yield chunk

    async def _stream_openai(self, body: dict) -> AsyncGenerator[str, None]:
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
                    # content text
                    choices = data.get("choices", [])
                    if choices:
                        delta = choices[0].get("delta", {})
                        text = delta.get("content", "")
                        if not text:
                            text = delta.get("reasoning_content", "")
                        if text:
                            yield text

    async def _stream_anthropic(self, body: dict) -> AsyncGenerator[str, None]:
        async with httpx.AsyncClient(timeout=300) as client:
            async with client.stream("POST", self._api_url, headers=self._headers(), json=body) as resp:
                if resp.status_code >= 400:
                    text = await resp.aread()
                    raise LLMError(f"Anthropic API error ({resp.status_code}): {text[:200]}")
                current_event = None
                async for line in resp.aiter_lines():
                    if line.startswith("event: "):
                        current_event = line[7:].strip()
                        continue
                    if not line.startswith("data: "):
                        continue
                    data = json.loads(line[6:])
                    if current_event == "content_block_delta":
                        delta = data.get("delta", {})
                        if delta.get("type") == "text_delta":
                            text = delta.get("text", "")
                            if text:
                                yield text
                    elif current_event == "message_stop":
                        break


# ===== Text extraction helpers =====

def _extract_text(data: dict, style: str) -> str:
    """Extract final text from a non-streaming LLM response."""
    if style == "anthropic":
        blocks = data.get("content", [])
        parts = [b["text"] for b in blocks if b.get("type") == "text"]
        return "\n".join(parts)
    # openai
    choices = data.get("choices", [])
    if choices:
        msg = choices[0].get("message", {})
        reasoning = msg.get("reasoning_content", "")
        if reasoning:
            return reasoning
        return msg.get("content", "")
    return ""
