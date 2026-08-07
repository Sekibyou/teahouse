"""In-memory tracker of in-flight /v1/chat tool-loop tasks, keyed by session.

Used by ``sessionDestroy(abort=true)`` to cancel a child session's active
director conversation so a mid-run sub-task can be forcibly reclaimed. Kept
entirely in memory — restarting the server clears it; persisted session files
are untouched.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from threading import Lock


@dataclass
class SessionRunStats:
    """Per-session runtime statistics for the current tool-loop invocation.

    These are authoritative — the frontend consumes them via SSE ``stats``
    fields and the ``GET /sessions/status`` API, and does NOT maintain its own
    timers or token counters for the running phase.
    """

    started_at: float = 0.0  # asyncio.get_event_loop().time() when loop began
    token_count: int = 0     # cumulative tokens consumed this round
    elapsed: float = 0.0     # seconds since started_at (ticked per SSE event)


class SessionTaskTracker:
    def __init__(self) -> None:
        self._tasks: dict[tuple[str, str], asyncio.Task] = {}
        self._stats: dict[tuple[str, str], SessionRunStats] = {}
        self._lock = Lock()

    # ------------------------------------------------------------------
    # Task lifecycle (existing)
    # ------------------------------------------------------------------

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

    # ------------------------------------------------------------------
    # Runtime stats — authoritative elapsed / token_count per session
    # ------------------------------------------------------------------

    def stats_start(self, instance_dir_basename: str, session_id: str) -> None:
        """Begin tracking stats for a new tool-loop invocation."""
        key = (instance_dir_basename, session_id)
        with self._lock:
            self._stats[key] = SessionRunStats(
                started_at=time.monotonic(),
                token_count=0,
                elapsed=0.0,
            )

    def stats_add_tokens(self, instance_dir_basename: str, session_id: str, n: int) -> None:
        """Accumulate token count for the running session."""
        if not n:
            return
        key = (instance_dir_basename, session_id)
        with self._lock:
            s = self._stats.get(key)
            if s is not None:
                s.token_count += n

    def stats_tick(self, instance_dir_basename: str, session_id: str) -> None:
        """Update elapsed time for the running session.

        Called before each SSE broadcast so the frontend always has a fresh
        elapsed value. Uses ``time.monotonic()`` which is immune to system-
        clock adjustments and does not pause when the machine sleeps.
        """
        key = (instance_dir_basename, session_id)
        with self._lock:
            s = self._stats.get(key)
            if s is not None:
                s.elapsed = round(time.monotonic() - s.started_at, 1)

    def stats_clear(self, instance_dir_basename: str, session_id: str) -> None:
        """Remove stats for a finished session."""
        key = (instance_dir_basename, session_id)
        with self._lock:
            self._stats.pop(key, None)

    def get_stats(self, instance_dir_basename: str, session_id: str) -> SessionRunStats | None:
        """Return a snapshot of the current stats for (instance, session)."""
        key = (instance_dir_basename, session_id)
        with self._lock:
            s = self._stats.get(key)
            if s is None:
                return None
            return SessionRunStats(
                started_at=s.started_at,
                token_count=s.token_count,
                elapsed=s.elapsed,
            )

    def get_stats_map(self, instance_dir_basename: str) -> dict[str, dict]:
        """Return {session_id: {elapsed, token_count}} for all running sessions."""
        out: dict[str, dict] = {}
        with self._lock:
            for (inst, sid), s in self._stats.items():
                if inst == instance_dir_basename:
                    out[sid] = {"elapsed": s.elapsed, "token_count": s.token_count}
        return out


task_tracker = SessionTaskTracker()


async def abort_session_requests(instance_dir_basename: str, session_id: str) -> None:
    """Cancel in-flight director tool loops for a (instance, session)."""
    await task_tracker.abort(instance_dir_basename, session_id)
