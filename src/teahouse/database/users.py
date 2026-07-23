"""
User CRUD operations.
"""
from typing import Optional

import bcrypt

from .connection import generate_uuid, current_timestamp, execute, fetch_one, fetch_all


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

    await execute(
        "INSERT INTO users (id, username, display_name, hashed_password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        (user_id, username, display_name, hashed, now, now),
    )
    return await get_user_by_id(user_id)


async def get_user_by_username(username: str) -> Optional[dict]:
    return await fetch_one("SELECT * FROM users WHERE username = ?", (username,))


async def get_user_by_id(user_id: str) -> Optional[dict]:
    return await fetch_one("SELECT * FROM users WHERE id = ?", (user_id,))


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
