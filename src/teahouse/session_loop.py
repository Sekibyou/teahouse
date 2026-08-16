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

    def enqueue(self, content: str) -> None:
        """Push a user message into this session's queue.

        The message is NOT persisted here — it only goes into the in-memory
        queue and the frontend is notified via ``session_user_queued`` (grey
        bubble).  Persistence to jsonl + ``session_user_msg`` upgrade happens
        later, inside ``run()``, after the previous tool_loop has finished.
        This guarantees correct chronological order in the jsonl.
        """
        if not content:
            return
        queue_id = uuid.uuid4().hex[:12]
        order = self.next_order()
        _event_log(self.instance_dir, self.session_id, "enqueue", {"queue_id": queue_id, "content": content[:200]})
        self._broadcast_user_queued(queue_id, content, order)
        self._queue.put_nowait((queue_id, content, order))

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

            # 2. Drain queue. Messages are NOT yet persisted — enqueue() only
            #    put them in memory.  We persist them here, AFTER any previous
            #    tool_loop has finished, so chronological jsonl order is correct.
            msgs = self._drain_queue()
            if not msgs:
                _event_log(self.instance_dir, self.session_id, "loop_idle_exit", {})
                break  # session idle — loop exits

            _event_log(self.instance_dir, self.session_id, "loop_drain", {"count": len(msgs), "preview": [m[1][:100] for m in msgs]})

            # Persist each message to jsonl now, then broadcast the upgrade
            # event so the frontend can turn the grey bubble white. The order
            # comes from the reservation made at enqueue time (stored in the
            # queue entry), so the persisted order matches the queued bubble's
            # position and the upgrade by order succeeds.
            for queue_id, content, order in msgs:
                sessions.append_user(self.instance_dir, content, session_id=self.session_id, order=order)
                self._broadcast_user_msg(queue_id, content, order)

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
        compact_task = asyncio.create_task(
            run_compact(client, self.instance_dir, self.session_id, instance_id=self.instance_id)
        )
        self._task = compact_task
        task_tracker.stats_start(self.instance_dir.name, self.session_id)
        task_tracker.register(self.instance_dir.name, self.session_id, compact_task)
        try:
            await compact_task
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
