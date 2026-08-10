"""
Reasoning-effort (思考强度) resolution and API mapping.

Internal effort values are ``none|low|mid|high|max`` (a session/user-level
concept independent of any one API). They are mapped onto each API's native
knob at request time (OpenAI ``reasoning_effort`` for o-series / Anthropic
``thinking`` budget), and ignored for plain models.

Read/write are kept separate: ``/think`` *writes* an effort (user default for
the main session, session meta for a child session); every LLM call *reads* it
at run time and resolves precedence (session meta > user default > none).
"""
from __future__ import annotations

from pathlib import Path

from .sessions import MAIN_SESSION_ID, load_meta

EFFORT_VALUES = ("none", "low", "mid", "high", "max")

# Internal → Anthropic thinking budget (tokens). Anthropic requires >= 1024.
_ANTHROPIC_BUDGET = {
    "low": 8000,
    "mid": 16000,
    "high": 24000,
    "max": 32000,
}

# Internal → OpenAI o-series reasoning_effort. OpenAI only supports 3 levels;
# middle values collapse onto them.
_OPENAI_REASONING = {
    "low": "low",
    "mid": "medium",
    "high": "high",
    "max": "high",
}


def validate_effort(value) -> str | None:
    """Return a canonical effort if ``value`` is valid, else ``None``."""
    if isinstance(value, str) and value in EFFORT_VALUES:
        return value
    return None


async def resolve_session_effort(
    instance_dir: Path,
    session_id: str,
    user_id: str | None = None,
) -> str | None:
    """Resolve the effective effort for a session.

    Precedence:
    1. Child session meta (``.sessions/<sid>.meta.json``).
    2. Main session → user-level default (users.preferences), shared across
       instances when ``user_id`` is known.
    3. Unset → ``None`` (caller omits the field, model default).
    """
    if session_id != MAIN_SESSION_ID:
        meta = load_meta(instance_dir, session_id)
        return validate_effort(meta.get("reasoning_effort"))

    if user_id:
        from .database.users import get_preferences
        prefs = await get_preferences(user_id) or {}
        return validate_effort(prefs.get("reasoning_effort"))

    return None


def effort_kwargs(api_style: str, effort: str | None) -> dict:
    """Return the extra LLM body kwargs for an effort under an API style.

    ``None`` / invalid effort → ``{}`` (field omitted, model default).
    """
    effort = validate_effort(effort)
    if not effort or effort == "none":
        # "none" must turn thinking OFF, not just omit the knob — otherwise
        # reasoning-default models (e.g. DeepSeek-V4) keep their default chain
        # of thought. DeepSeek's OpenAI-compat endpoint exposes the same
        # ``thinking: {type: "disabled"}`` as Anthropic.
        if api_style in ("openai", "anthropic"):
            return {"thinking": {"type": "disabled"}}
        return {}

    if api_style == "anthropic":
        tokens = _ANTHROPIC_BUDGET.get(effort)
        if tokens:
            return {"thinking": {"type": "enabled", "budget_tokens": tokens}}
        return {}

    if api_style == "openai":
        mapped = _OPENAI_REASONING.get(effort)
        if mapped:
            return {"reasoning_effort": mapped}
        return {}

    # Unknown/plain API style — no native knob, ignore.
    return {}
