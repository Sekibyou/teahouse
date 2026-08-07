"""Per-session background execution loop.

Each session (main or child) runs its own asyncio execution loop, driven by a
message queue. The backend is the single source of truth for session execution
— the frontend only sends messages into the queue and consumes SSE broadcasts.

Architecture::

    SessionLoop.run()
      while True:
        1. Handle user_interrupted flag → append auto msg to jsonl, broadcast, clear
        2. Drain message queue → persist each user msg to jsonl, broadcast
           → if queue empty: break (session idle)
        3. Run _tool_use_loop → broadcast EVERY event as session_event
           → on completion: loop back to 1
           → on cancel: set _interrupted = True, loop back to 1

All events are broadcast via ``state.broadcast("session_event", ...)`` with the
exact same shape as ``_tool_use_loop`` yield events, plus ``instance_id``,
``session_id``, and ``running`` snapshot. The frontend consumes these events
uniformly — there is no separate "direct SSE" vs "background _drain" path.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from . import sessions
from .session_tracker import task_tracker
from .state import state


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
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._interrupted = False
        self._task: asyncio.Task | None = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def enqueue(self, content: str) -> None:
        """Push a user message into this session's queue.

        If the loop is idle (no running task), it is started immediately.
        """
        self._queue.put_nowait(content)

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
        while True:
            # 1. Handle interruption
            if self._interrupted:
                self._interrupted = False
                sessions.append_user(
                    self.instance_dir,
                    "[auto] user interrupted",
                    session_id=self.session_id,
                )
                self._broadcast_user_msg("[auto] user interrupted")
                self._broadcast_done()

            # 2. Drain queue
            msgs = self._drain_queue()
            if not msgs:
                break  # session idle — loop exits

            # 3. Persist user messages
            for msg in msgs:
                sessions.append_user(
                    self.instance_dir, msg, session_id=self.session_id
                )
                self._broadcast_user_msg(msg)

            # 4. Resolve LLM client
            client = await self._resolve_client()
            if client is None:
                break

            # 5. Load tool permissions
            meta = sessions.load_meta(self.instance_dir, self.session_id)
            enabled_tools = meta.get("enabled_tools") or None

            # 6. Run tool loop
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
                self._task = None

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _run_tool_loop(self, client, enabled_tools: list[str] | None) -> None:
        """Consume _tool_use_loop generator, broadcasting every event as session_event."""
        from .app import _tool_use_loop

        async for event in _tool_use_loop(
            client,
            [],  # no new input — context rebuilt from jsonl
            self.instance_dir,
            self.user_id,
            self.instance_id,
            session_id=self.session_id,
            enabled_tools=enabled_tools,
        ):
            ev = dict(event)
            ev["instance_id"] = self.instance_dir.name
            ev["session_id"] = self.session_id
            ev["running"] = task_tracker.running_sessions(self.instance_dir.name)
            state.broadcast("session_event", ev)

        # Final done event so the frontend knows the run completed.
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

    def _drain_queue(self) -> list[str]:
        """Pull all pending messages from the queue (non-blocking)."""
        msgs: list[str] = []
        while not self._queue.empty():
            try:
                msgs.append(self._queue.get_nowait())
            except asyncio.QueueEmpty:
                break
        return msgs

    def _broadcast_done(self) -> None:
        state.broadcast("session_event", {
            "instance_id": self.instance_dir.name,
            "session_id": self.session_id,
            "type": "done",
            "running": task_tracker.running_sessions(self.instance_dir.name),
        })

    def _broadcast_user_msg(self, content: str) -> None:
        """Tell the frontend a user message was persisted (so it can render it)."""
        from .sessions import _count_records
        count = _count_records(
            self.instance_dir / sessions.SESSION_DIR / f"{self.session_id}.jsonl"
        )
        state.broadcast("session_user_msg", {
            "instance_id": self.instance_id or self.instance_dir.name,
            "session_id": self.session_id,
            "content": content,
            "count": count,
        })
