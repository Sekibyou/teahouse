"""Per-session background execution loop.

Each session (main or child) runs its own asyncio execution loop, driven by a
message queue. The backend is the single source of truth for session execution
— the frontend only sends messages into the queue and consumes SSE broadcasts.

Architecture::

    SessionLoop.run()
      while True:
        1. Handle user_interrupted flag → append auto msg to jsonl, broadcast, clear
        2. Drain message queue → persist each user msg to jsonl, broadcast upgrade
           → if queue empty: break (session idle)
        3. Run _tool_use_loop → broadcast EVERY event as session_event
           → on completion: loop back to 1
           → on cancel: set _interrupted = True, loop back to 1

    enqueue() only puts messages into the in-memory queue and broadcasts
    "session_user_queued" (so the frontend shows a grey "waiting" bubble).
    Persistence to jsonl + "session_user_msg" upgrade happens in run() step 2,
    AFTER the previous tool_loop has finished — this guarantees correct
    chronological order in the jsonl even when the user sends a message while
    the AI is still generating.

All events are broadcast via ``state.broadcast("session_event", ...)`` with the
exact same shape as ``_tool_use_loop`` yield events, plus ``instance_id``,
``session_id``, and ``running`` snapshot. The frontend consumes these events
uniformly — there is no separate "direct SSE" vs "background _drain" path.

Diagnostic event log
--------------------
When ``TEHOUSE_EVENT_LOG=1`` is set in the environment, every broadcast event
is appended to ``<instance_dir>/runtime/event_log.jsonl`` so the developer
can cross-reference backend events with frontend-side observations.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from pathlib import Path

from . import sessions
from .compact import POST_COMPACT_RATIO, estimate_context_tokens, run_compact
from .session_tracker import task_tracker
from .state import state

_EVENT_LOG_ENABLED = os.environ.get("TEHOUSE_EVENT_LOG") == "1"


def _event_log(instance_dir: Path, session_id: str, event_type: str, data: dict) -> None:
    """Append a structured diagnostic record to the instance's event log."""
    if not _EVENT_LOG_ENABLED:
        return
    try:
        log_path = instance_dir / "runtime" / "event_log.jsonl"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "ts": asyncio.get_event_loop().time(),
            "session_id": session_id,
            "event_type": event_type,
            "data": data,
        }
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        pass


class SessionLoop:
    """Per-session background execution loop.

    One loop per (instance_dir_name, session_id). Created lazily on first
    enqueue, destroyed when the loop exits due to an empty queue.
    """

    _loops: dict[tuple[str, str], "SessionLoop"] = {}

    def __init__(
        self,
        instance_dir: Path,
        session_id: str,
        instance_id: str | None,
        user_id: str | None,
    ):
        self.instance_dir = instance_dir
        self.session_id = session_id
        self.instance_id = instance_id
        self.user_id = user_id
        self._queue: asyncio.Queue[tuple[str, str, int]] = asyncio.Queue()
        self._interrupted = False
        self._interrupt_reason: str | None = None  # "user" | "endsession"
        self._task: asyncio.Task | None = None
        # Session-wide monotonic order watermark. Initialised from the current
        # on-disk record count and bumped by every append AND every in-memory
        # reservation (queued bubble / streaming round). This keeps the reserved
        # order of a queued-but-not-yet-persisted message distinct from the next
        # one, even when several are enqueued while the loop is busy.
        self._order = sessions._count_records(
            instance_dir / sessions.SESSION_DIR / f"{session_id}.jsonl"
        )

    def next_order(self) -> int:
        """Allocate the next order for this session (monotonic, not persisted)."""
        self._order += 1
        return self._order - 1

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def enqueue(self, content: str, pastes: list[dict] | None = None) -> None:
        """Push user messages into this session's queue.

        The messages are NOT persisted here — they only go into the in-memory
        queue and the frontend is notified via ``session_user_queued`` (grey
        bubble).  Persistence to jsonl + ``session_user_msg`` upgrade happens
        later, inside ``run()``, after the previous tool_loop has finished.
        This guarantees correct chronological order in the jsonl.

        ``pastes`` is the frontend's "paste blocks" — flat list of ``{id, content}``
        for oversized pasted chunks, kept separate from what the user typed by
        hand (``content``). One enqueue may expand to TWO independent user
        records: the first is the raw hand-typed text, the second is an ``[auto]``
        notice describing the spilled/inlined pasted content (the frontend renders
        it as a centred system badge). When the pasted bodies exceed
        BIG_INPUT_CHAR_LIMIT chars they are spilled together to a single temp/
        file and the notice points at it, so a giant paste cannot flood the next
        generation round's context.

        Internal backend messages (sub-session tasks, [auto]/[director] wake-ups)
        pass ``content`` only (``pastes`` defaults to None) and are left as-is.
        """
        if not content and not pastes:
            return
        try:
            msgs = self._compose_messages(content, pastes)
        except Exception:
            # If composing/spilling fails for any reason, fall back to as-is.
            if content:
                msgs = [content]
            else:
                return
        for msg in msgs:
            queue_id = uuid.uuid4().hex[:12]
            order = self.next_order()
            _event_log(self.instance_dir, self.session_id, "enqueue", {"queue_id": queue_id, "content": msg[:200]})
            self._broadcast_user_queued(queue_id, msg, order)
            self._queue.put_nowait((queue_id, msg, order))

    def _compose_messages(self, content: str, pastes: list[dict] | None) -> list[str]:
        """Build the message(s) for a user enqueue — paste blocks become a
        separate ``[auto]`` record rather than being merged into the manual text.

        Returns a list in send order:
        - Without pastes: ``[content]``; if content alone exceeds the cap it is
          spilled wholesale (defensive backstop) and ``[spill pointer]`` is returned.
        - With pastes: ``[manual_text]`` (omitted when empty) then an ``[auto]``
          notice carrying either the inline pasted bodies or — when they exceed
          ``PASTE_SPILL_CHAR_LIMIT`` — a pointer to the single spill file.
        """
        from .compact import PASTE_SPILL_CHAR_LIMIT, BIG_INPUT_CHAR_LIMIT
        paste_texts = [p.get("content") for p in (pastes or []) if p.get("content")]
        if not paste_texts:
            if len(content) > BIG_INPUT_CHAR_LIMIT:
                return [self._spill_oversized(content)]
            return [content]

        out: list[str] = []
        if content:
            out.append(content)

        joined = "\n\n".join(paste_texts)
        intro = "用户在本次输入时粘贴了长文本，内容是："
        # Spill once the pasted bodies alone exceed the cap (~3000 chars) — the
        # threshold is about the paste itself, not the notice's total length.
        if len(joined) <= PASTE_SPILL_CHAR_LIMIT:
            out.append(f"[auto] {intro}\n\n{joined}")
        else:
            rel = self._spill_pastes(joined)
            out.append(f"[auto] {intro}\n文本过长，已被暂存至 {rel}，请阅读")
        return out

    def _spill_pastes(self, body: str) -> str:
        """Write pasted bodies to ``temp/pasted-<uuid>.md`` and return the relative
        path. Paste-only spill; the manual text stays as its own inline record.
        Broadcasts ``file_changed`` so the frontend tree / director sees the new
        file land (mirrors how Read/Report surface writes)."""
        rel = f"temp/pasted-{uuid.uuid4().hex[:8]}.md"
        full = self.instance_dir / rel
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(body, encoding="utf-8")
        state.broadcast("file_changed", {
            "path": rel,
            "tool": "PasteSpill",
            "instance_id": self.instance_id or self.instance_dir.name,
        })
        _event_log(self.instance_dir, self.session_id, "spill_pastes", {"rel": rel, "chars": len(body)})
        return rel

    def _spill_oversized(self, content: str) -> str:
        """Write an oversized user message body to ``temp/pasted-<uuid>.md`` and
        return the pointer message that replaces it in the queue. Backstop for
        pasteless messages that alone exceed the cap; the paste path composes its
        own spill inside ``_compose_messages``. Returns the pointer text.
        """
        from .compact import BIG_INPUT_CHAR_LIMIT
        rel = self._spill_pastes(content)
        return (
            f"[auto] 用户发送消息过长（{len(content):,} 字符），已在完整阅读前落盘为 "
            f"`{rel}`（原始文本）。请用 Read 读取并自行处理。"
        )

    def interrupt(self, reason: str = "user") -> None:
        """Set the interrupt flag and cancel the in-flight tool-loop task.

        The loop will pick up the flag on the next iteration, persist an
        interruption record, and then drain the queue.
        """
        self._interrupted = True
        self._interrupt_reason = reason
        if self._task is not None and not self._task.done():
            self._task.cancel()

    @classmethod
    def get_or_create(
        cls,
        instance_dir: Path,
        session_id: str,
        instance_id: str | None = None,
        user_id: str | None = None,
    ) -> "SessionLoop":
        """Get or create a SessionLoop for (instance_dir, session_id).

        If the existing loop's task is done (idle), a new loop replaces it.
        The loop's ``run()`` is spawned as a background asyncio task.
        """
        key = (instance_dir.name, session_id)
        loop = cls._loops.get(key)
        if loop is None or loop._task is None or loop._task.done():
            loop = cls(instance_dir, session_id, instance_id, user_id)
            cls._loops[key] = loop
            asyncio.create_task(loop.run())
        return loop

    @classmethod
    def interrupt_session(cls, instance_dir_name: str, session_id: str, reason: str = "user") -> None:
        """Interrupt a running session loop by (instance_name, session_id)."""
        key = (instance_dir_name, session_id)
        loop = cls._loops.get(key)
        if loop is not None:
            loop.interrupt(reason)

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------

    async def run(self) -> None:
        """Main execution loop. Blocks until queue is empty and no interrupt pending."""
        _event_log(self.instance_dir, self.session_id, "loop_start", {"qsize": self._queue.qsize()})
        while True:
            # 1. Handle interruption
            if self._interrupted:
                reason = self._interrupt_reason or "user"
                self._interrupted = False
                self._interrupt_reason = None
                _event_log(self.instance_dir, self.session_id, "loop_interrupted", {})
                order = self.next_order()
                interrupted_msg = (
                    "[auto] interrupted by EndSession tool"
                    if reason == "endsession"
                    else "[auto] user interrupted"
                )
                sessions.append_user(
                    self.instance_dir,
                    interrupted_msg,
                    session_id=self.session_id,
                    order=order,
                )
                self._broadcast_user_msg(None, interrupted_msg, order)
                self._broadcast_done()

            # 2. Drain queue (fallback). Mid-loop rounds already consume pending
            #    user messages via check_pending_user() (see _tool_use_loop), so
            #    this only catches messages queued in the short window between
            #    the last mid-loop check and loop exit. Idempotent — nothing to
            #    drain is a normal no-op.
            msgs = self._drain_and_persist()
            if not msgs:
                _event_log(self.instance_dir, self.session_id, "loop_idle_exit", {})
                break  # session idle — loop exits

            _event_log(self.instance_dir, self.session_id, "loop_drain", {"count": len(msgs), "preview": [m[1][:100] for m in msgs]})

            # 3. Resolve LLM client
            client = await self._resolve_client()
            if client is None:
                _event_log(self.instance_dir, self.session_id, "loop_no_client", {})
                break

            # ── Pre-flight compact check (85% of max_context) ──
            # Only for the main session. If we're already close to the limit,
            # compact before running the tool loop so it doesn't overflow mid-run.
            if self.session_id == sessions.MAIN_SESSION_ID:
                max_ctx = client.config.max_context
                msgs_for_check = sessions.records_to_context(
                    self.instance_dir, client.api_style, session_id=self.session_id
                )
                est = estimate_context_tokens(msgs_for_check)
                if est > max_ctx * 0.85:
                    _event_log(self.instance_dir, self.session_id, "compact_preflight", {"est": est, "max": max_ctx})
                    ok = await self._run_compact_task(client)
                    if not ok:
                        self._broadcast_done()
                        break

            # ── Manual compact command detection ──
            # If the user sent [compact], run compact instead of the tool loop.
            is_manual_compact = any(
                m[1].strip().startswith("[compact]") for m in msgs
            ) if msgs else False
            if is_manual_compact and self.session_id == sessions.MAIN_SESSION_ID:
                _event_log(self.instance_dir, self.session_id, "compact_manual", {})
                await self._run_compact_task(client)
                self._broadcast_done()
                continue  # loop back, queue likely empty

            # 5. Load tool permissions
            meta = sessions.load_meta(self.instance_dir, self.session_id)
            enabled_tools = meta.get("enabled_tools") or None
            reasoning_effort = meta.get("reasoning_effort") or None

            # 6. Run tool loop
            task_tracker.stats_start(self.instance_dir.name, self.session_id)
            self._task = asyncio.create_task(
                self._run_tool_loop(client, enabled_tools, reasoning_effort)
            )
            task_tracker.register(self.instance_dir.name, self.session_id, self._task)
            try:
                await self._task
            except asyncio.CancelledError:
                self._interrupted = True
                # loop back to step 1
            finally:
                task_tracker.unregister(self.instance_dir.name, self.session_id)
                task_tracker.stats_clear(self.instance_dir.name, self.session_id)
                self._task = None

            # ── Post-flight compact check (70% of max_context) ──
            # After a full work cycle, compact if we crossed the threshold.
            # Auto-enqueue a continuation so the director picks up where it left off.
            if self.session_id == sessions.MAIN_SESSION_ID and not self._interrupted:
                max_ctx = client.config.max_context
                msgs_for_check = sessions.records_to_context(
                    self.instance_dir, client.api_style, session_id=self.session_id
                )
                est = estimate_context_tokens(msgs_for_check)
                if est > max_ctx * POST_COMPACT_RATIO:
                    _event_log(self.instance_dir, self.session_id, "compact_postflight", {"est": est, "max": max_ctx})
                    ok = await self._run_compact_task(client)
                    if not ok:
                        self._broadcast_done()
                        break
                    # Auto-continue: enqueue a synthetic message so the loop
                    # picks it up in step 2 on the next iteration.
                    self.enqueue("[auto] 会话已压缩。请基于上述总结继续未完成的工作。")
                    continue  # loop back, drain will pick up the enqueued message

    # ------------------------------------------------------------------
    # Compact helper — cancellable like the tool loop
    # ------------------------------------------------------------------

    async def _run_compact_task(self, client) -> bool:
        """Run ``run_compact`` as a cancellable task. Returns True on success.

        Wraps the compact call in a tracked asyncio Task so that
        ``interrupt()`` (which cancels ``self._task``) can stop an
        in-flight compact the same way it stops a tool loop.
        """
        # Persist any user messages queued mid-generation BEFORE compact runs.
        # They are drained as normal history records (persisted + upgraded),
        # so `run_compact`'s records_to_context reads them and folds them into
        # the summary. This keeps them durable (a failed/interrupted compact
        # never loses them — they are already on disk) and avoids them becoming
        # stray records carrying a stale pre-compact order after the truncate.
        # (Use _drain_and_persist, not _drain_queue, so nothing is left in
        # limbo held only in memory.)
        self._drain_and_persist()

        compact_task = asyncio.create_task(
            run_compact(
                client,
                self.instance_dir,
                self.session_id,
                instance_id=self.instance_id,
            )
        )
        self._task = compact_task
        task_tracker.stats_start(self.instance_dir.name, self.session_id)
        task_tracker.register(self.instance_dir.name, self.session_id, compact_task)
        try:
            await compact_task
            # Compact truncated the jsonl (only the [compact] marker remains).
            # Reset the in-memory order watermark to the post-compact on-disk
            # count; otherwise the next enqueue / streaming round inherits the
            # pre-compact sequence (38, 39, ...) and its records render out of
            # chronological order (they sort after the much-lower orders of
            # records written after the next loop rebuild).
            self._order = sessions._count_records(
                self.instance_dir / sessions.SESSION_DIR / f"{self.session_id}.jsonl"
            )
            return True
        except asyncio.CancelledError:
            _event_log(self.instance_dir, self.session_id, "compact_interrupted", {})
            state.broadcast("session_event", {
                "instance_id": self.instance_id or self.instance_dir.name,
                "session_id": self.session_id,
                "type": "compact_done",
                "error": "interrupted",
                "running": task_tracker.running_sessions(self.instance_dir.name),
            })
            self._interrupted = True
            return False
        except Exception:
            _event_log(self.instance_dir, self.session_id, "compact_error", {})
            state.broadcast("session_event", {
                "instance_id": self.instance_id or self.instance_dir.name,
                "session_id": self.session_id,
                "type": "compact_done",
                "error": "compact LLM call failed",
                "running": task_tracker.running_sessions(self.instance_dir.name),
            })
            return False
        finally:
            task_tracker.unregister(self.instance_dir.name, self.session_id)
            task_tracker.stats_clear(self.instance_dir.name, self.session_id)
            self._task = None

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _run_tool_loop(self, client, enabled_tools: list[str] | None, reasoning_effort: str | None = None) -> None:
        """Consume _tool_use_loop generator, broadcasting every event as session_event."""
        from .app import _tool_use_loop

        _event_log(self.instance_dir, self.session_id, "tool_loop_start", {"enabled_tools": enabled_tools, "reasoning_effort": reasoning_effort})
        event_count = 0
        async for event in _tool_use_loop(
            client,
            [],  # no new input — context rebuilt from jsonl
            self.instance_dir,
            self.user_id,
            self.instance_id,
            session_id=self.session_id,
            enabled_tools=enabled_tools,
            order_allocator=self.next_order,
            reasoning_effort=reasoning_effort,
            pending_check=self.check_pending_user,
        ):
            task_tracker.stats_tick(self.instance_dir.name, self.session_id)
            stats = task_tracker.get_stats(self.instance_dir.name, self.session_id)
            ev = dict(event)
            ev["instance_id"] = self.instance_id or self.instance_dir.name
            ev["session_id"] = self.session_id
            ev["running"] = task_tracker.running_sessions(self.instance_dir.name)
            ev["stats"] = {
                "elapsed": stats.elapsed if stats else 0,
                "token_count": stats.token_count if stats else 0,
            }
            event_count += 1
            _event_log(self.instance_dir, self.session_id, "broadcast", {
                "seq": event_count,
                "type": ev.get("type"),
                "name": ev.get("name", ""),
                "id": ev.get("id", ""),
                "text_len": len(ev.get("text") or ""),
                "running": ev["running"],
            })
            state.broadcast("session_event", ev)

        # Final done event so the frontend knows the run completed.
        _event_log(self.instance_dir, self.session_id, "tool_loop_done", {"total_events": event_count})
        self._broadcast_done()

    async def _resolve_client(self):
        """Resolve the director slot client. Returns None if unconfigured."""
        from .app import _resolve_slot_client

        if not self.user_id:
            return None
        try:
            return await _resolve_slot_client(self.user_id, "director")
        except Exception:
            return None

    def _drain_queue(self) -> list[tuple[str, str, int]]:
        """Pull all pending messages from the queue (non-blocking).

        Returns a list of (queue_id, content, order) tuples — the order was
        reserved at enqueue time and is used to persist + broadcast the message.
        """
        msgs: list[tuple[str, str, int]] = []
        while not self._queue.empty():
            try:
                msgs.append(self._queue.get_nowait())
            except asyncio.QueueEmpty:
                break
        return msgs

    def _drain_and_persist(self) -> list[tuple[str, str, int]]:
        """Drain queued user messages, persist them to jsonl, and broadcast the
        queued→done upgrade (grey bubble → white).

        Shared by the mid-loop ``check_pending_user`` hook and run()'s step-2
        fallback, so persistence + broadcast live in exactly one place and the
        two paths are idempotent (a second call with an empty queue is a no-op).
        """
        msgs = self._drain_queue()
        for queue_id, content, order in msgs:
            sessions.append_user(self.instance_dir, content, session_id=self.session_id, order=order)
            self._broadcast_user_msg(queue_id, content, order)
        return msgs

    def check_pending_user(self) -> list[tuple[str, str, int]] | None:
        """Cooperative hook consumed by ``_tool_use_loop`` before each API round.

        Drains + persists any user message queued mid-generation, so the message
        is sent to the LLM on the very next round instead of waiting for the
        whole tool loop to finish. Returns ``None`` when nothing is pending.
        """
        msgs = self._drain_and_persist()
        return msgs or None

    def _broadcast_done(self) -> None:
        stats = task_tracker.get_stats(self.instance_dir.name, self.session_id)
        running = task_tracker.running_sessions(self.instance_dir.name)
        # The final done event must signal this session as idle — the
        # task_tracker still has it registered until run()'s finally block
        # fires, so we explicitly flip it here.
        running[self.session_id] = False
        state.broadcast("session_event", {
            "instance_id": self.instance_id or self.instance_dir.name,
            "session_id": self.session_id,
            "type": "done",
            "running": running,
            "force_close_incomplete": True,
            "stats": {
                "elapsed": stats.elapsed if stats else 0,
                "token_count": stats.token_count if stats else 0,
            },
        })

    def _broadcast_user_msg(self, queue_id: str | None, content: str, order: int) -> None:
        """Tell the frontend a user message was persisted to jsonl (upgrade from queued→done)."""
        from .sessions import _count_records
        count = _count_records(
            self.instance_dir / sessions.SESSION_DIR / f"{self.session_id}.jsonl"
        )
        state.broadcast("session_user_msg", {
            "instance_id": self.instance_id or self.instance_dir.name,
            "session_id": self.session_id,
            "queue_id": queue_id,
            "content": content,
            "order": order,
            "count": count,
        })

    def _broadcast_user_queued(self, queue_id: str, content: str, order: int) -> None:
        """Tell the frontend a user message is queued in memory (grey bubble, not yet persisted).

        ``order`` is reserved at enqueue time from this session's monotonic
        watermark; the later ``session_user_msg`` (after drain persists it with
        the same order) upgrades the grey bubble by ``order``.
        """
        state.broadcast("session_user_queued", {
            "instance_id": self.instance_id or self.instance_dir.name,
            "session_id": self.session_id,
            "queue_id": queue_id,
            "content": content,
            "order": order,
        })
