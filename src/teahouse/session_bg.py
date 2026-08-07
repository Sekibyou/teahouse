"""Run a session's director loop in the background (no SSE client).

Director tools ``StartSubSession`` / ``SendToSubSession`` push a message to a
child session and want the child to actually process it. This module lets a
session's director run as a fire-and-forget asyncio task — same ``_tool_use_loop``
as the SSE path, but with its yielded events drained (gone to nobody) so the
loop advances and persists assistant records to the session's jsonl.

Re-entrancy is guarded per (instance, session): if a background run is already
active, a new kick is a no-op (the session's pending message will be picked up on
the next poll of its file, or by the next explicit kick). Tasks are tracked in
``task_tracker`` so ``sessionDestroy(abort=true)`` can cancel them.

All sessions (main + child) share the same code path. Metadata (enabled_tools)
is loaded from ``.sessions/<sid>.meta.json`` inside ``kick_session_run``.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from threading import Lock

_active: set[tuple[str, str]] = set()
_active_lock = Lock()


async def _run_session_loop(
    instance_dir: Path,
    session_id: str,
    instance_id: str | None,
    user_id: str | None,
) -> None:
    """Resolve the director client and drain one session's tool loop to completion.

    ``enabled_tools`` is loaded from the session's metadata — None means unrestricted.
    """
    from .session_tracker import task_tracker
    from .app import _tool_use_loop, _resolve_slot_client
    from . import sessions

    key = (instance_dir.name, session_id)
    try:
        client = await _resolve_slot_client(user_id, "director") if user_id else None
        if client is None:
            return  # no usable director slot binding — nothing to run

        meta = sessions.load_meta(instance_dir, session_id)
        enabled_tools = meta.get("enabled_tools") or None

        task = asyncio.create_task(
            _drain(
                _tool_use_loop(
                    client,
                    [],
                    instance_dir,
                    user_id,
                    instance_id,
                    session_id=session_id,
                    enabled_tools=enabled_tools,
                ),
                instance_dir_name=instance_dir.name,
                session_id=session_id,
            )
        )
        task_tracker.register(instance_dir.name, session_id, task)
        try:
            await task
        finally:
            task_tracker.unregister(instance_dir.name, session_id)
        # The run completed: broadcast a final done event carrying the CURRENT running
        # snapshot (after unregister, so this session reads as stopped). Without this,
        # the frontend would keep the session "generating" forever — it only infers
        # stop from these snapshots, and there was never a trailing "{sid:false}".
        from .state import state
        state.broadcast("session_event", {
            "instance_id": instance_dir.name,
            "session_id": session_id,
            "type": "done",
            "running": task_tracker.running_sessions(instance_dir.name),
        })
    except asyncio.CancelledError:
        raise
    except Exception:
        # A background failure must not crash the server.
        pass
    finally:
        with _active_lock:
            _active.discard(key)


async def _drain(agen, *, instance_dir_name: str, session_id: str):
    """Consume the session's tool-loop generator, broadcasting real events.

    The generator's tool events normally go to an SSE client; here they are drained,
    but we fan them back out as ``session_event`` broadcasts (tagged with session_id)
    so the frontend can track the session's token count and generating state —
    without streaming the full text (coarse, count-only; no ticker).
    """
    from .state import state
    from .session_tracker import task_tracker
    async for ev in agen:
        t = ev.get("type")
        # Heuristic token estimates matching the frontend's main-session accounting.
        token = 0
        if t == "text":
            token = (len(ev.get("text") or "") + 3) // 4
        elif t == "reasoning":
            token = (len(ev.get("text") or "") + 3) // 4
        elif t == "tool_call":
            token = (len(ev.get("name") or "") + len(str(ev.get("args") or "")) + 3) // 4
        elif t == "tool_result":
            token = (len(ev.get("result") or "") + 3) // 4
        # Attach the authoritative current running-map so the frontend can update its
        # per-session state purely from this event (no separate polling needed).
        state.broadcast("session_event", {
            "instance_id": instance_dir_name,
            "session_id": session_id,
            "type": t,
            "delta": ev.get("text", "") if t in ("text", "reasoning") else None,
            "token_est": token,
            "running": task_tracker.running_sessions(instance_dir_name),
        })


def kick_session_run(
    instance_dir: Path,
    session_id: str,
    *,
    instance_id: str | None = None,
    user_id: str | None = None,
) -> None:
    """Start a background director run for a session, if not already running.

    Loads the session's ``enabled_tools`` from its ``.meta.json``. Main sessions
    have an empty meta → None (unrestricted). Child sessions have their allow-list.
    """
    key = (instance_dir.name, session_id)
    with _active_lock:
        if key in _active:
            return
        _active.add(key)
    asyncio.create_task(_run_session_loop(instance_dir, session_id, instance_id, user_id))
