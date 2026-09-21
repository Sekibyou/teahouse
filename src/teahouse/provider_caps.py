"""
Per-vendor request-field capabilities.

Which non-standard body fields an endpoint tolerates differs per vendor. The
``thinking`` knob is a DeepSeek extension; Gemini's OpenAI-compatibility layer
rejects it outright (400 ``Unknown name "thinking": Cannot find field``). Rather
than teach every call site about vendors, request assembly asks for the
capability set and emits only what this endpoint understands.

Resolution happens **at request time**, never snapshotted into the provider row
on save — an updated built-in table then reaches existing rows for free:

    provider.capabilities override  →  built-in host table  →  conservative default

The default is "standard OpenAI shape only": ``reasoning_effort`` is an official
field so it goes out; ``thinking`` is a vendor extension so it does not. Relax
that per vendor either by adding a ``HOST_RULES`` entry or by setting the
provider's own override (which is how a private relay hosting Gemini models, or
anything else we cannot know in advance, gets configured).
"""
from __future__ import annotations

import json
import logging

logger = logging.getLogger("teahouse.provider_caps")

# Flags the request builders consult. All boolean.
#   thinking          — may send {"thinking": {...}} (DeepSeek's extension)
#   reasoning_effort  — may send `reasoning_effort` (official OpenAI field)
DEFAULTS: dict[str, bool] = {"thinking": False, "reasoning_effort": True}

# First match wins. Substring test against the provider's api_url, mirroring the
# vendor sniffing already used for model listing (routes/llm_providers.py).
HOST_RULES: tuple[tuple[str, dict[str, bool]], ...] = (
    # DeepSeek's OpenAI-compat endpoint exposes the Anthropic-shaped thinking knob,
    # which is why "effort = none" needs to send it there at all.
    ("api.deepseek.com", {"thinking": True, "reasoning_effort": True}),
    # Strict field validation: rejects `thinking`, and we have not verified that
    # it accepts `reasoning_effort` either — so send neither.
    ("generativelanguage.googleapis.com", {"thinking": False, "reasoning_effort": False}),
)


def _coerce_flag(value) -> bool:
    """Coerce a flag value, including the string spellings a hand-edited blob might
    hold — ``bool("false")`` is ``True``, which would silently invert the intent."""
    if isinstance(value, str):
        return value.strip().lower() not in ("", "false", "0", "no")
    return bool(value)


def parse_overrides(raw: str | None) -> dict:
    """Parse a provider row's ``capabilities`` JSON into a flag dict.

    Tolerates anything a hand-edited value might hold — empty, malformed JSON,
    a non-object, unknown keys. The request path must never break on a bad
    stored value, so every failure mode degrades to "no override".
    """
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        logger.warning("ignoring malformed provider capabilities: %r", raw)
        return {}
    if not isinstance(parsed, dict):
        logger.warning("ignoring non-object provider capabilities: %r", raw)
        return {}
    return {k: (_coerce_flag(v) if k in DEFAULTS else v) for k, v in parsed.items()}


def resolve_capabilities(api_url: str, override: dict | None = None) -> dict:
    """Return the effective capability set for one endpoint.

    ``override`` comes from :func:`parse_overrides`; pass ``None``/``{}`` when the
    provider has no explicit setting.
    """
    caps = dict(DEFAULTS)
    url = api_url or ""
    for host, rule in HOST_RULES:
        if host in url:
            caps.update(rule)
            break
    if override:
        caps.update(override)
    return caps
