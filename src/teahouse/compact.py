"""
Session compact — summarise long director conversation history into a concise
continuation point so the context window doesn't overflow.

Only applies to the main session (``main``). Child sessions are one-shot tasks
with a short lifecycle and don't need compaction.
"""
from __future__ import annotations

import json
from pathlib import Path

from . import sessions
from .llm import LLMClient
from .session_tracker import task_tracker
from .state import state

COMPACT_SYSTEM_PROMPT = """\
你是一个会话压缩器。你的任务是将一段导演会话的完整历史总结为简洁的摘要，
供导演在下一段会话中继续未完成的工作。

请按以下结构输出总结：

## 用户意图
用户最初要求导演做什么？后续有哪些补充要求或方向调整？

## 已完成的工作
- 创建/修改了哪些文件？（楼层文件、设定文件、变量等）
- 完成了哪些关键操作？（Git 提交、工具调用等）
- 达成了哪些里程碑？

## 当前状态
- 当前楼层编号/进度
- 关键变量值（runtime_vars）
- 动态设定状态
- 分支状态

## 待完成的工作
用户还要求但尚未完成的事项。如果用户没有明确后续要求，
请说明"用户未指定后续工作，请询问用户下一步意图"。

## 委派的子会话（重要）
如果对话中开启过子会话（如 CreateSession / 委派任务），必须逐条记录并保持
完整，因为总结后这些委派细节会丢失：
- 指派了什么任务、目标是什么
- 若要它产出报告，约定好的产出文件路径 / 命名方式（或其编号 sid）
- 当前是否已完成、结论/报告落在 temp/ 的哪个具体文件
新会话的导演需要靠这些记录找回"我让它干什么，报告在哪儿"。
没有开启过子会话就写"无"。

## 重要约定与偏好
用户在对话中表达的风格偏好、命名约定、特殊要求等。
如果没有特别约定，写"无特殊约定"。

要求：
- 每个部分都必须填写，即使写"无"
- 使用中文
- 保持简洁但完整——这份总结将替代全部历史记录
- 不要执行任何工具调用，只输出总结文本
- 不要添加"我会继续完成"之类的表态，这是纯信息摘要"""


# Post-flight auto-compact trigger: fraction of max_context at which a completed
# work cycle compacts the session. The frontend usage bar treats this as the
# "full" mark, so it must stay in sync with session_loop's trigger.
POST_COMPACT_RATIO = 0.70

# Single-file / single-input defensive cap in CHARACTERS (~32k chars ≈ 10.7k
# tokens under the chars/3 estimate). Shared by:
#   - execute_read: an oversized file is truncated to this many chars and the
#     read reports its true total size.
#   - _scan_tree: files above this size are listed as a big-file warning with an
#     estimated token count, so the director knows a Read could be expensive.
#   - SessionLoop.enqueue: an oversized pending user message is spilled to a
#     temp/ file and replaced by a pointer message instead of flooding the round.
BIG_INPUT_CHAR_LIMIT = 32_000


def estimate_context_tokens(
    messages: list[dict], system_prompt: str = ""
) -> int:
    """Rough token count estimate (characters / 3).

    A coarse heuristic tuned for Chinese-heavy director conversations.
    Chinese text averages ~2-3 chars per token; English/code ~4 chars per
    token.  Dividing by 3 is slightly conservative for mixed content (it
    over-estimates), which is the safe direction for a compact threshold.
    """
    total = len(system_prompt) if system_prompt else 0
    for m in messages:
        total += len(json.dumps(m, ensure_ascii=False))
    return total // 3


async def run_compact(
    client: LLMClient,
    instance_dir: Path,
    session_id: str,
    tool_system: str = "",
    instance_id: str | None = None,
) -> str | None:
    """Summarise session history, truncate it, and write the summary.

    Returns the summary text on success, or ``None`` if there is nothing to
    compact (empty session).
    """
    sid = session_id or sessions.MAIN_SESSION_ID

    # Rebuild full context from persisted history
    messages = sessions.records_to_context(
        instance_dir, client.api_style, session_id=sid
    )
    if not messages:
        return None

    instance_name = instance_dir.name
    # Broadcast compact start
    state.broadcast("session_event", {
        "instance_id": instance_id or instance_name,
        "session_id": sid,
        "type": "compact_started",
        "running": task_tracker.running_sessions(instance_name),
    })

    try:
        # One-shot LLM call — no tools, no streaming
        summary = await client.send_message(
            messages, system=COMPACT_SYSTEM_PROMPT
        )
    except Exception:
        state.broadcast("session_event", {
            "instance_id": instance_id or instance_name,
            "session_id": sid,
            "type": "compact_done",
            "error": "compact LLM call failed",
            "running": task_tracker.running_sessions(instance_name),
        })
        raise

    if not summary or not summary.strip():
        # LLM returned nothing useful — don't truncate
        state.broadcast("session_event", {
            "instance_id": instance_id or instance_name,
            "session_id": sid,
            "type": "compact_done",
            "error": "compact produced empty summary",
            "running": task_tracker.running_sessions(instance_name),
        })
        return None

    summary = summary.strip()

    # Truncate session and write the compact marker
    sessions.truncate(instance_dir, session_id=sid)

    compact_msg = (
        "[compact] 此会话是由一个被总结的会话继续得来。"
        "之前没有完成的工作的总结：\n\n" + summary
    )
    sessions.append_user(instance_dir, compact_msg, session_id=sid)

    # Broadcast compact done
    preview = summary[:200] + ("..." if len(summary) > 200 else "")
    state.broadcast("session_event", {
        "instance_id": instance_id or instance_name,
        "session_id": sid,
        "type": "compact_done",
        "summary_preview": preview,
        "running": task_tracker.running_sessions(instance_name),
    })

    return summary
