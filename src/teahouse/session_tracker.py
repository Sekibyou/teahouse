"""In-memory tracker of in-flight /v1/chat tool-loop tasks, keyed by session.

Used by ``sessionDestroy(abort=true)`` to cancel a child session's active
director conversation so a mid-run sub-task can be forcibly reclaimed. Kept
entirely in memory — restarting the server clears it; persisted session files
are untouched.
"""
from __future__ import annotations

import asyncio
from threading import Lock


class SessionTaskTracker:
    def __init__(self) -> None:
        self._tasks: dict[tuple[str, str], asyncio.Task] = {}
        self._lock = Lock()

    def register(self, instance_dir_basename: str, session_id: str, task: asyncio.Task) -> None:
        """Track an active tool loop for (instance, session)."""
        key = (instance_dir_basename, session_id)
        with self._lock:
            self._tasks[key] = task

    def unregister(self, instance_dir_basename: str, session_id: str) -> None:
        key = (instance_dir_basename, session_id)
        with self._lock:
            self._tasks.pop(key, None)

    async def abort(self, instance_dir_basename: str, session_id: str) -> None:
        """Cancel and await the tracked tool loop for (instance, session), if any."""
        key = (instance_dir_basename, session_id)
        with self._lock:
            task = self._tasks.get(key)
        if task is None or task.done():
            with self._lock:
                self._tasks.pop(key, None)
            return
        try:
            task.cancel()
            await asyncio.wait_for(task, timeout=5)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass
        finally:
            with self._lock:
                self._tasks.pop(key, None)

    def running_sessions(self, instance_dir_basename: str) -> dict[str, bool]:
        """Authoritative "is this session's director loop running right now?" map.

        The session is considered running if it has a live, non-done task tracked
        for this instance. Main and child sessions both register here while their
        tool loop is active, and unregister on completion. So this is the single
        source of truth the frontend should render the submit/stop state from.
        """
        out: dict[str, bool] = {}
        with self._lock:
            for (inst, sid), task in self._tasks.items():
                if inst == instance_dir_basename:
                    out[sid] = not task.done()
        return out


task_tracker = SessionTaskTracker()


async def abort_session_requests(instance_dir_basename: str, session_id: str) -> None:
    """Cancel in-flight director tool loops for a (instance, session)."""
    await task_tracker.abort(instance_dir_basename, session_id)
