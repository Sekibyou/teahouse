"""
User CRUD operations.
"""
import json
import re
from typing import Optional

import bcrypt

from .connection import generate_uuid, current_timestamp, execute, fetch_one, fetch_all


# ===== Safe name utilities =====

def make_safe_name(name: str) -> str:
    """Generate a filesystem-safe name from a username."""
    safe = name.lower().strip()
    safe = re.sub(r"[^a-z0-9一-鿿_-]", "_", safe)
    safe = re.sub(r"_+", "_", safe)
    safe = safe.strip("_")
    return safe or f"user_{generate_uuid()[:8]}"


async def ensure_unique_safe_name(base: str) -> str:
    """Append suffix if safe_name already exists."""
    safe = make_safe_name(base)
    existing = await fetch_one("SELECT id FROM users WHERE safe_name = ?", (safe,))
    if not existing:
        return safe
    for i in range(1, 100):
        candidate = f"{safe}_{i}"
        existing = await fetch_one("SELECT id FROM users WHERE safe_name = ?", (candidate,))
        if not existing:
            return candidate
    return f"{safe}_{generate_uuid()[:8]}"


# ===== Password utilities =====

def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


# ===== CRUD =====

async def create_user(
    username: str,
    password: str,
    display_name: str = "",
) -> Optional[dict]:
    """Create a new user. Returns None if username already exists."""
    existing = await fetch_one("SELECT id FROM users WHERE username = ?", (username,))
    if existing:
        return None

    now = current_timestamp()
    user_id = generate_uuid()
    hashed = hash_password(password)
    safe_name = await ensure_unique_safe_name(username)

    await execute(
        "INSERT INTO users (id, username, safe_name, display_name, hashed_password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (user_id, username, safe_name, display_name, hashed, now, now),
    )

    # Auto-create default workspace for the new user
    ws_id = generate_uuid()
    await execute(
        "INSERT INTO workspaces (id, user_id, name, safe_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        (ws_id, user_id, "默认工作区", safe_name, now, now),
    )

    return await get_user_by_id(user_id)


async def get_user_by_username(username: str) -> Optional[dict]:
    return await fetch_one("SELECT * FROM users WHERE username = ?", (username,))


async def get_user_by_id(user_id: str) -> Optional[dict]:
    return await fetch_one("SELECT * FROM users WHERE id = ?", (user_id,))


async def get_user_by_safe_name(safe_name: str) -> Optional[dict]:
    return await fetch_one("SELECT * FROM users WHERE safe_name = ?", (safe_name,))


async def update_user(
    user_id: str,
    display_name: Optional[str] = None,
    password: Optional[str] = None,
    is_active: Optional[bool] = None,
) -> bool:
    """Update user fields. Only provided fields are changed."""
    fields = []
    values = []

    if display_name is not None:
        fields.append("display_name = ?")
        values.append(display_name)
    if password is not None:
        fields.append("hashed_password = ?")
        values.append(hash_password(password))
    if is_active is not None:
        fields.append("is_active = ?")
        values.append(1 if is_active else 0)

    if not fields:
        return False

    fields.append("updated_at = ?")
    values.append(current_timestamp())
    values.append(user_id)

    cur = await execute(
        f"UPDATE users SET {', '.join(fields)} WHERE id = ?",
        tuple(values),
    )
    return cur.rowcount > 0


async def get_preferences(user_id: str) -> dict:
    """Return the user's preferences JSON blob as a dict (``{}`` if none)."""
    row = await fetch_one("SELECT preferences FROM users WHERE id = ?", (user_id,))
    if not row or not row.get("preferences"):
        return {}
    try:
        parsed = json.loads(row["preferences"])
        return parsed if isinstance(parsed, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


async def set_preference(user_id: str, key: str, value) -> dict:
    """Set one key in the user's preferences and return the updated dict."""
    prefs = await get_preferences(user_id)
    prefs[key] = value
    await execute(
        "UPDATE users SET preferences = ?, updated_at = ? WHERE id = ?",
        (json.dumps(prefs, ensure_ascii=False), current_timestamp(), user_id),
    )
    return prefs


async def list_users() -> list[dict]:
    return await fetch_all("SELECT id, username, display_name, is_active, created_at FROM users ORDER BY created_at")


async def ensure_default_admin() -> None:
    """Create default admin account if no users exist."""
    users = await fetch_all("SELECT COUNT(*) as cnt FROM users")
    if users and users[0]["cnt"] > 0:
        return
    await create_user(
        username="admin",
        password="teahouse2025+.Aa",
        display_name="Admin",
    )
    print("[teahouse] default admin account created (admin / teahouse2025+.Aa)")
