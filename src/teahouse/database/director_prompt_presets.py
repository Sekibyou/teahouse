"""
Director Prompt Preset CRUD — YAML templates for Director system prompt assembly.
"""
from __future__ import annotations

from typing import Optional

from ..database.connection import generate_uuid, current_timestamp, execute, fetch_one, fetch_all


BUILTIN_DEFAULT_YAML = """# 导演提示词预设模板
# 第一行注释（以 # 开头的行为 YAML 注释，不会被解析）
#
# system: 导演系统提示词模板，支持两种占位符：
#   {{path|切片}}          文件切片（teahouse.md 可写作 {{teahouse.md}}）
#   ${teahouse.xxx}        系统内部值：${teahouse.behavior} ${teahouse.tools_usage}
#                          ${teahouse.file_tree} ${teahouse.available_skills}
#   ${name}                实例沙盒变量引用（如 ${金币}，组装时为 no-cache 快照）
# 注意：teahouse. 前缀的系统内部值仅在此模板组装时注入，其余场景保持字面量（防内部泄露）。
#
# 预设对话历史（可选），两种写法：
#
# 写法 1 — messages 列表，与 Generate 配置文件格式相同：
#   messages:
#     - role: user
#       content: x+y=99
#     - role: assistant
#       content: 好的，收到。
#
# 写法 2 — user/assistant 简写，用于单轮对话：
#   user: |
#     x+y=99
#   assistant: |
#     好的，收到。

system: |
  ————根目录下 teahouse.md 内容开始————
  {{teahouse.md}}
  ————根目录下 teahouse.md 内容结束————
  *注意：如需修改 teahouse.md，你需调用 Read tool 来阅读原文。因为虽然它是实时注入的，但其变量、注释和切片占位符会被解析，你看到的是解析后的结果
  ————behavior 开始————
  ${teahouse.behavior}
  ————behavior 结束————
  ————工具使用指南开始————
  ${teahouse.tools_usage}
  ————工具使用指南结束————
  ————当前文件结构树开始————
  ${teahouse.file_tree}
  ————当前文件结构树结束————
  ————可用 Skill 列表开始————
  ${teahouse.available_skills}
  ————可用 Skill 列表结束————
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


async def get_builtin_preset(user_id: str) -> Optional[dict]:
    row = await fetch_one(
        "SELECT * FROM director_prompt_presets WHERE user_id = ? AND is_builtin = 1 LIMIT 1",
        (user_id,),
    )
    return dict(row) if row else None
