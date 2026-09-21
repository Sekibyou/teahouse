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

from . import provider_caps
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


async def ensure_dm_effort(
    instance_dir: Path,
    user_id: str | None = None,
) -> str | None:
    """Initialize the DM session's effort by copying the director's, once.

    DM is an instance-level singleton with no explicit creation event — it
    materializes on its first message. Left unset, it falls through to the vendor
    default (heavy on reasoning-default models like DeepSeek) while the frontend
    renders the absence as "无". So on first use we snapshot what the director
    resolves to right now (the user-level default, same as the main session);
    later changes to that default do not propagate, and an explicit DM setting is
    never overwritten.

    Director unset → nothing is written, so DM keeps following the vendor default
    exactly like the director does. Returns the effort written, or ``None``.
    """
    from .sessions import DM_SESSION_ID, ensure_meta, meta_path

    if meta_path(instance_dir, DM_SESSION_ID).exists():
        return None
    effort = await resolve_session_effort(instance_dir, MAIN_SESSION_ID, user_id)
    if not effort:
        return None
    ensure_meta(instance_dir, DM_SESSION_ID, {"reasoning_effort": effort})
    return effort


def effort_kwargs(api_style: str, effort: str | None, capabilities: dict | None = None) -> dict:
    """Return the extra LLM body kwargs for an effort under an API style.

    ``None`` / invalid effort → ``{}`` (field omitted, model default).

    ``capabilities`` is the endpoint's capability set (see ``provider_caps``); it
    gates the non-standard fields per vendor. Merged over the conservative default
    set, so a caller that omits it (or passes a partial dict) still gets the
    default behaviour rather than accidentally disabling everything.
    """
    caps = {**provider_caps.DEFAULTS, **(capabilities or {})}
    effort = validate_effort(effort)
    if not effort or effort == "none":
        # "none" must turn thinking OFF, not just omit the knob — otherwise
        # reasoning-default models (e.g. DeepSeek-V4) keep their default chain
        # of thought. But only DeepSeek is known to expose the Anthropic-shaped
        # ``thinking: {type: "disabled"}`` on an OpenAI-compat endpoint; sending
        # it blind 400s on strict vendors (Gemini: 'Unknown name "thinking"').
        if api_style == "anthropic":
            return {"thinking": {"type": "disabled"}}
        if api_style == "openai" and caps.get("thinking"):
            return {"thinking": {"type": "disabled"}}
        return {}

    if api_style == "anthropic":
        # `thinking` is native to this API rather than a vendor extension, so it
        # is not capability-gated.
        tokens = _ANTHROPIC_BUDGET.get(effort)
        if tokens:
            return {"thinking": {"type": "enabled", "budget_tokens": tokens}}
        return {}

    if api_style == "openai":
        if not caps.get("reasoning_effort"):
            return {}
        mapped = _OPENAI_REASONING.get(effort)
        if mapped:
            return {"reasoning_effort": mapped}
        return {}

    # Unknown/plain API style — no native knob, ignore.
    return {}
