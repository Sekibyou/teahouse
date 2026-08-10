"""In-memory tracker of in-flight sandbox runTool background tasks, keyed by run_uuid.

Used by ``POST /instances/{id}/tools/run/{run_uuid}/cancel`` to cancel a
fire-and-forget runTool batch mid-execution (e.g. a long Generate step). Kept
entirely in memory — restarting the server clears it; already-completed side
effects (files already flushed) are untouched.
"""
from __future__ import annotations

import asyncio
from threading import Lock


class RunToolTracker:
    """Track active runTool batch tasks keyed by run_uuid (single str).

    ``run_instance_tools`` registers its spawned task here; ``_run_steps``
    unregisters in a ``finally`` so a failed/cancelled step still cleans up.
    Mirrors ``SessionTaskTracker`` in session_tracker.py, but keyed by the
    runTool batch's run_uuid instead of (instance, session).
    """

    def __init__(self) -> None:
        self._tasks: dict[str, asyncio.Task] = {}
        self._lock = Lock()

    def register(self, run_uuid: str, task: asyncio.Task) -> None:
        with self._lock:
            self._tasks[run_uuid] = task

    def unregister(self, run_uuid: str) -> None:
        with self._lock:
            self._tasks.pop(run_uuid, None)

    async def abort(self, run_uuid: str) -> bool:
        """Cancel and await the tracked batch for run_uuid, if any.

        Returns True if a live task was cancelled, False if the batch was
        already done/unknown (idempotent, never raises).
        """
        with self._lock:
            task = self._tasks.get(run_uuid)
        if task is None or task.done():
            with self._lock:
                self._tasks.pop(run_uuid, None)
            return False
        try:
            task.cancel()
            await asyncio.wait_for(task, timeout=5)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass
        finally:
            with self._lock:
                self._tasks.pop(run_uuid, None)
        return True


run_tool_tracker = RunToolTracker()
