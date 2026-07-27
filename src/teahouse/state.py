"""
In-memory application state.
"""
from __future__ import annotations

import asyncio
import json
from typing import Optional

from .config import Config


class AppState:
    def __init__(self) -> None:
        self.config: Optional[Config] = None
        self._sse_queues: list[asyncio.Queue] = []

    @property
    def workspace_base(self) -> str:
        if self.config:
            return self.config.db.workspace_base
        return "data"

    def broadcast(self, event: str, data: object) -> None:
        # Pre-serialize data to JSON string so EventSourceResponse yields valid JSON
        # (sse_starlette str() on dicts produces single-quoted non-JSON)
        payload = {"event": event, "data": json.dumps(data, ensure_ascii=False)}
        stale: list[asyncio.Queue] = []
        for q in self._sse_queues:
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                stale.append(q)
        for q in stale:
            self._sse_queues.remove(q)


state = AppState()
