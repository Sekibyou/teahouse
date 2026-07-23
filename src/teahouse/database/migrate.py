"""
Database migration runner.

Uses versioned SQL files in database/migrations/.
Each migration is a .sql file named 001_xxx.sql, 002_xxx.sql, etc.
A _migrations table tracks which have been applied.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Optional

from .connection import get_db, fetch_one


MIGRATIONS_DIR = Path(__file__).parent / "migrations"


async def ensure_migrations_table() -> None:
    conn = await get_db()
    try:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS _migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at INTEGER NOT NULL
            )
        """)
        await conn.commit()
    finally:
        await conn.close()


async def get_current_version() -> int:
    row = await fetch_one("SELECT MAX(version) as v FROM _migrations")
    return row["v"] if row and row["v"] else 0


async def run_migrations() -> None:
    """Run all pending migrations."""
    await ensure_migrations_table()
    current = await get_current_version()

    migration_files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    for f in migration_files:
        ver = _parse_version(f.name)
        if ver is None:
            continue
        if ver <= current:
            continue

        sql = f.read_text(encoding="utf-8")
        conn = await get_db()
        try:
            await conn.executescript(sql)
            await conn.execute(
                "INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)",
                (ver, f.name, __import__("time").time() * 1000),
            )
            await conn.commit()
        finally:
            await conn.close()

    if current == 0 and migration_files:
        from .connection import _db_path
        print(f"[teahouse] database initialized at {_db_path}")


def _parse_version(name: str) -> Optional[int]:
    m = re.match(r"(\d+)_", name)
    return int(m.group(1)) if m else None
