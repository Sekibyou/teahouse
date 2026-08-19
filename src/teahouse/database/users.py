"""
User CRUD operations.
"""
import json
import re
from typing import Optional

import bcrypt

from .connection import generate_uuid, current_timestamp, execute, fetch_one, fetch_all


# ===== Roles =====

ROLE_SUPER = "super"
ROLE_ADMIN = "admin"
ROLE_USER = "user"
ROLES = (ROLE_SUPER, ROLE_ADMIN, ROLE_USER)

# A role is an admin if it can manage other users (admin hierarchy >= admin)
ADMIN_ROLES = (ROLE_SUPER, ROLE_ADMIN)


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
    role: str = ROLE_USER,
) -> Optional[dict]:
    """Create a new user. Returns None if username already exists."""
    if role not in ROLES:
        raise ValueError(f"invalid role: {role}")
    existing = await fetch_one("SELECT id FROM users WHERE username = ?", (username,))
    if existing:
        return None

    now = current_timestamp()
    user_id = generate_uuid()
    hashed = hash_password(password)
    safe_name = await ensure_unique_safe_name(username)

    await execute(
        "INSERT INTO users (id, username, safe_name, display_name, hashed_password, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (user_id, username, safe_name, display_name, hashed, role, now, now),
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
    role: Optional[str] = None,
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
    if role is not None:
        if role not in ROLES:
            raise ValueError(f"invalid role: {role}")
        fields.append("role = ?")
        values.append(role)

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
    return await fetch_all(
        "SELECT id, username, display_name, role, is_active, created_at FROM users ORDER BY role = 'super' DESC, role = 'admin' DESC, created_at"
    )


async def ensure_default_admin() -> None:
    """Legacy no-op kept for import compatibility; replaced by sync_super_admin."""
    return


async def sync_super_admin(password: Optional[str] = None) -> Optional[dict]:
    """Ensure the sole super admin (username 'admin') exists and is functional.

    The password passed here — sourced from teahouse.yaml — is the authoritative
    password for the super admin, so it is unconditionally applied to the stored
    hash on every startup. The account is also forced active so the system can
    never be left without a working recovery admin.

    Returns the super admin row, or None if it could not be created.
    """
    admin = await get_user_by_username("admin")

    if admin is None:
        if password is None:
            return None
        return await create_user(
            username="admin",
            password=password,
            display_name="Admin",
            role=ROLE_SUPER,
        )

    # Promote to super in case it was created/left at a lower role
    if admin["role"] != ROLE_SUPER:
        await update_user(admin["id"], role=ROLE_SUPER)

    # Always re-apply the yaml password (yaml is the single source of truth)
    if password is not None:
        await update_user(admin["id"], password=password)

    # Never leave the recovery account disabled
    if not admin["is_active"]:
        await update_user(admin["id"], is_active=True)

    return await get_user_by_id(admin["id"])
