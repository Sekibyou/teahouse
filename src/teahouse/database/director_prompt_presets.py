"""
Director Prompt Preset CRUD — YAML templates for Director system prompt assembly.
"""
from __future__ import annotations

from typing import Optional

from ..database.connection import generate_uuid, current_timestamp, execute, fetch_one, fetch_all


# Built-in director prompt preset.
#
# Deliberately language-neutral: XML-style section tags instead of prose delimiters,
# and no tutorial comments. The "how to write a preset" documentation lives in the
# frontend settings UI (Presets tab → format help panel) so it can be shown in all
# supported UI languages instead of being frozen as Chinese inside the payload.
# Director-facing *instructions* belong in director-system/behavior.md, not here.
BUILTIN_DEFAULT_YAML = """system: |
  <teahouse.md>
  {{teahouse.md}}
  </teahouse.md>

  <behavior>
  ${teahouse.behavior}
  </behavior>

  <tools_usage>
  ${teahouse.tools_usage}
  </tools_usage>

  <file_tree>
  ${teahouse.file_tree}
  </file_tree>

  <available_skills>
  ${teahouse.available_skills}
  </available_skills>
"""


async def ensure_builtin_preset(user_id: str) -> dict:
    """Ensure the user has a built-in default preset. Updates template_yaml if changed."""
    existing = await get_builtin_preset(user_id)
    if existing:
        if existing.get("template_yaml") != BUILTIN_DEFAULT_YAML:
            await execute(
                "UPDATE director_prompt_presets SET template_yaml = ?, updated_at = ? WHERE id = ?",
                (BUILTIN_DEFAULT_YAML, current_timestamp(), existing["id"]),
            )
            return await get_preset(existing["id"])
        return existing
    return await create_preset(user_id, "内置默认", BUILTIN_DEFAULT_YAML, is_builtin=True)


async def create_preset(
    user_id: str,
    name: str,
    template_yaml: str,
    is_builtin: bool = False,
    match_pattern: Optional[str] = None,
) -> dict:
    preset_id = generate_uuid()
    now = current_timestamp()

    await execute(
        """INSERT INTO director_prompt_presets
           (id, user_id, name, is_builtin, match_pattern, template_yaml, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (preset_id, user_id, name, int(is_builtin), match_pattern, template_yaml, now, now),
    )
    return await get_preset(preset_id)


async def get_preset(preset_id: str) -> Optional[dict]:
    row = await fetch_one("SELECT * FROM director_prompt_presets WHERE id = ?", (preset_id,))
    return dict(row) if row else None


async def list_presets(user_id: str) -> list[dict]:
    rows = await fetch_all(
        "SELECT * FROM director_prompt_presets WHERE user_id = ? ORDER BY is_builtin DESC, created_at",
        (user_id,),
    )
    return [dict(r) for r in rows]


async def update_preset(
    preset_id: str,
    name: Optional[str] = None,
    template_yaml: Optional[str] = None,
    match_pattern: Optional[str] = None,
) -> bool:
    preset = await get_preset(preset_id)
    if not preset:
        return False
    if preset.get("is_builtin"):
        return False

    fields = []
    values = []

    if name is not None:
        fields.append("name = ?"); values.append(name)
    if template_yaml is not None:
        fields.append("template_yaml = ?"); values.append(template_yaml)
    if match_pattern is not None:
        fields.append("match_pattern = ?"); values.append(match_pattern if match_pattern else None)

    if not fields:
        return False

    fields.append("updated_at = ?")
    values.append(current_timestamp())
    values.append(preset_id)

    cur = await execute(
        f"UPDATE director_prompt_presets SET {', '.join(fields)} WHERE id = ?",
        tuple(values),
    )
    return cur.rowcount > 0


async def delete_preset(preset_id: str) -> bool:
    preset = await get_preset(preset_id)
    if not preset:
        return False
    if preset.get("is_builtin"):
        return False

    # Nullify references in slot bindings
    await execute(
        "UPDATE llm_slot_bindings SET prompt_preset_id = NULL, updated_at = ? WHERE prompt_preset_id = ?",
        (current_timestamp(), preset_id),
    )
    cur = await execute("DELETE FROM director_prompt_presets WHERE id = ?", (preset_id,))
    return cur.rowcount > 0


async def ensure_director_preset_binding(user_id: str) -> dict:
    """Ensure the built-in director preset exists AND is bound to the director slot.

    The builtin preset is auto-created and auto-bound so that every user has an
    effective director prompt preset (there is no longer a code-level fallback
    assembler). If the user has already picked a different preset for the director
    slot, that explicit choice is preserved; only an empty/lacking preset binding is
    linked to the builtin. Other slot fields (model/profile) are never touched.

    Returns the effective preset dict. Raises if the resolved preset has no
    template_yaml (a linked-then-deleted preset) — the caller must treat this as an
    error, not silently fall back.
    """
    builtin = await ensure_builtin_preset(user_id)
    row = await fetch_one(
        "SELECT prompt_preset_id FROM llm_slot_bindings WHERE user_id = ? AND slot_id = 'director'",
        (user_id,),
    )
    if row and row.get("prompt_preset_id"):
        pid = row["prompt_preset_id"]
    else:
        pid = builtin["id"]
        now = current_timestamp()
        if row:
            await execute(
                "UPDATE llm_slot_bindings SET prompt_preset_id = ?, updated_at = ? WHERE user_id = ? AND slot_id = 'director'",
                (pid, now, user_id),
            )
        else:
            await execute(
                "INSERT INTO llm_slot_bindings (user_id, slot_id, prompt_preset_id, updated_at) VALUES (?, 'director', ?, ?)",
                (user_id, pid, now),
            )
    preset = await get_preset(pid)
    if not preset or not preset.get("template_yaml"):
        raise RuntimeError("director slot preset missing or empty template_yaml; cannot assemble system prompt")
    return preset


async def get_builtin_preset(user_id: str) -> Optional[dict]:
    row = await fetch_one(
        "SELECT * FROM director_prompt_presets WHERE user_id = ? AND is_builtin = 1 LIMIT 1",
        (user_id,),
    )
    return dict(row) if row else None
