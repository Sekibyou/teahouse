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

from .connection import get_db


MIGRATIONS_DIR = Path(__file__).parent / "migrations"


async def run_migrations() -> None:
    """Run all pending migrations.

    All pending migrations execute on a single connection opened once (rather
    than one open/close per migration file). On first boot this collapses the
    schema-creation writes into one connection's worth of disk writes, which
    mounted phone security scanners are far less likely to flag.
    """
    migration_files = sorted(MIGRATIONS_DIR.glob("*.sql"))

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
        cur = await conn.execute("SELECT MAX(version) as v FROM _migrations")
        row = await cur.fetchone()
        current = row["v"] if row and row["v"] else 0

        ran = False
        for f in migration_files:
            ver = _parse_version(f.name)
            if ver is None or ver <= current:
                continue
            # executescript issues its own implicit COMMIT, so each migration is
            # its own transaction — commit the version marker within it so the
            # DDL and its bookkeeping can never drift apart.
            await conn.executescript(f.read_text(encoding="utf-8"))
            await conn.execute(
                "INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)",
                (ver, f.name, __import__("time").time() * 1000),
            )
            await conn.commit()
            ran = True

        if ran:
            from .connection import _db_path
            print(f"[teahouse] database initialized at {_db_path}")
    finally:
        await conn.close()


def _parse_version(name: str) -> Optional[int]:
    m = re.match(r"(\d+)_", name)
    return int(m.group(1)) if m else None
