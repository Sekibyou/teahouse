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
is appended to ``<instance_dir>/.teahouse/event_log.jsonl`` so the developer
can cross-reference backend events with frontend-side observations.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from pathlib import Path

from . import sessions
from .session_tracker import task_tracker
from .state import state

_EVENT_LOG_ENABLED = os.environ.get("TEHOUSE_EVENT_LOG") == "1"


def _event_log(instance_dir: Path, session_id: str, event_type: str, data: dict) -> None:
    """Append a structured diagnostic record to the instance's event log."""
    if not _EVENT_LOG_ENABLED:
        return
    try:
        log_path = instance_dir / ".teahouse" / "event_log.jsonl"
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
        self._queue: asyncio.Queue[tuple[str, str]] = asyncio.Queue()
        self._interrupted = False
        self._task: asyncio.Task | None = None

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
        _event_log(self.instance_dir, self.session_id, "enqueue", {"queue_id": queue_id, "content": content[:200]})
        self._broadcast_user_queued(queue_id, content)
        self._queue.put_nowait((queue_id, content))

    def interrupt(self) -> None:
        """Set the interrupt flag and cancel the in-flight tool-loop task.

        The loop will pick up the flag on the next iteration, persist an
        interruption record, and then drain the queue.
        """
        self._interrupted = True
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
    def interrupt_session(cls, instance_dir_name: str, session_id: str) -> None:
        """Interrupt a running session loop by (instance_name, session_id)."""
        key = (instance_dir_name, session_id)
        loop = cls._loops.get(key)
        if loop is not None:
            loop.interrupt()

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------

    async def run(self) -> None:
        """Main execution loop. Blocks until queue is empty and no interrupt pending."""
        _event_log(self.instance_dir, self.session_id, "loop_start", {"qsize": self._queue.qsize()})
        while True:
            # 1. Handle interruption
            if self._interrupted:
                self._interrupted = False
                _event_log(self.instance_dir, self.session_id, "loop_interrupted", {})
                sessions.append_user(
                    self.instance_dir,
                    "[auto] user interrupted",
                    session_id=self.session_id,
                )
                self._broadcast_user_msg(None, "[auto] user interrupted")
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
            # event so the frontend can turn the grey bubble white.
            for queue_id, content in msgs:
                sessions.append_user(self.instance_dir, content, session_id=self.session_id)
                self._broadcast_user_msg(queue_id, content)

            # 3. Resolve LLM client
            client = await self._resolve_client()
            if client is None:
                _event_log(self.instance_dir, self.session_id, "loop_no_client", {})
                break

            # 5. Load tool permissions
            meta = sessions.load_meta(self.instance_dir, self.session_id)
            enabled_tools = meta.get("enabled_tools") or None

            # 6. Run tool loop
            task_tracker.stats_start(self.instance_dir.name, self.session_id)
            self._task = asyncio.create_task(
                self._run_tool_loop(client, enabled_tools)
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

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _run_tool_loop(self, client, enabled_tools: list[str] | None) -> None:
        """Consume _tool_use_loop generator, broadcasting every event as session_event."""
        from .app import _tool_use_loop

        _event_log(self.instance_dir, self.session_id, "tool_loop_start", {"enabled_tools": enabled_tools})
        event_count = 0
        async for event in _tool_use_loop(
            client,
            [],  # no new input — context rebuilt from jsonl
            self.instance_dir,
            self.user_id,
            self.instance_id,
            session_id=self.session_id,
            enabled_tools=enabled_tools,
        ):
            task_tracker.stats_tick(self.instance_dir.name, self.session_id)
            stats = task_tracker.get_stats(self.instance_dir.name, self.session_id)
            ev = dict(event)
            ev["instance_id"] = self.instance_dir.name
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

    def _drain_queue(self) -> list[tuple[str, str]]:
        """Pull all pending messages from the queue (non-blocking).

        Returns a list of (queue_id, content) tuples.
        """
        msgs: list[tuple[str, str]] = []
        while not self._queue.empty():
            try:
                msgs.append(self._queue.get_nowait())
            except asyncio.QueueEmpty:
                break
        return msgs

    def _broadcast_done(self) -> None:
        stats = task_tracker.get_stats(self.instance_dir.name, self.session_id)
        state.broadcast("session_event", {
            "instance_id": self.instance_dir.name,
            "session_id": self.session_id,
            "type": "done",
            "running": task_tracker.running_sessions(self.instance_dir.name),
            "stats": {
                "elapsed": stats.elapsed if stats else 0,
                "token_count": stats.token_count if stats else 0,
            },
        })

    def _broadcast_user_msg(self, queue_id: str | None, content: str) -> None:
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
            "count": count,
        })

    def _broadcast_user_queued(self, queue_id: str, content: str) -> None:
        """Tell the frontend a user message is queued in memory (grey bubble, not yet persisted)."""
        state.broadcast("session_user_queued", {
            "instance_id": self.instance_id or self.instance_dir.name,
            "session_id": self.session_id,
            "queue_id": queue_id,
            "content": content,
        })
