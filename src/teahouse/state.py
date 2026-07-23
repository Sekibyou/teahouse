"""
In-memory application state.
"""
from __future__ import annotations

import asyncio
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
        payload = {"event": event, "data": data}
        stale: list[asyncio.Queue] = []
        for q in self._sse_queues:
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                stale.append(q)
        for q in stale:
            self._sse_queues.remove(q)


state = AppState()
