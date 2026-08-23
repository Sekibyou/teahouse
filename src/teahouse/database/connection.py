"""
Database connection management.

Uses aiosqlite for async SQLite access.
Migration runner is built-in (versioned SQL files).
"""
from __future__ import annotations

import time
import uuid
from pathlib import Path
from typing import Optional

import aiosqlite


def current_timestamp() -> int:
    return int(time.time() * 1000)


def generate_uuid() -> str:
    return str(uuid.uuid4())


# ---------------------------------------------------------------------------
# Connection management
# ---------------------------------------------------------------------------

_db_path: Path = Path("data/teahouse.db")


_wal_initialized = False


def set_db_path(path: str | Path) -> None:
    global _db_path
    _db_path = Path(path) if isinstance(path, str) else path
    _db_path.parent.mkdir(parents=True, exist_ok=True)


async def get_db() -> aiosqlite.Connection:
    """Get a database connection (each call returns a new connection).

    WAL journal mode is persisted in the database file header on first use, so
    it only needs to be enabled once — subsequent connections inherit it. This
    avoids repeatedly touching the `-wal`/`-shm` sidecar files, which mounted
    phone scanners are most likely to flag.
    """
    global _wal_initialized
    conn = await aiosqlite.connect(str(_db_path))
    conn.row_factory = aiosqlite.Row
    if not _wal_initialized:
        await conn.execute("PRAGMA journal_mode=WAL")
        _wal_initialized = True
    await conn.execute("PRAGMA foreign_keys=ON")
    return conn


async def execute(sql: str, params: tuple = ()) -> aiosqlite.Cursor:
    conn = await get_db()
    try:
        cur = await conn.execute(sql, params)
        await conn.commit()
        return cur
    finally:
        await conn.close()


async def fetch_one(sql: str, params: tuple = ()) -> Optional[dict]:
    conn = await get_db()
    try:
        cur = await conn.execute(sql, params)
        row = await cur.fetchone()
        return dict(row) if row else None
    finally:
        await conn.close()


async def fetch_all(sql: str, params: tuple = ()) -> list[dict]:
    conn = await get_db()
    try:
        cur = await conn.execute(sql, params)
        rows = await cur.fetchall()
        return [dict(r) for r in rows]
    finally:
        await conn.close()
