"""
JWT authentication service.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Optional

import jwt

from .users import get_user_by_id, verify_password


# JWT config — key comes from teahouse.yaml, set at startup
JWT_SECRET: str = ""
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_DAYS = 7


@dataclass
class UserInfo:
    user_id: str
    username: str
    display_name: str
    role: str = "user"


def configure_jwt(secret_key: str) -> None:
    global JWT_SECRET
    JWT_SECRET = secret_key


async def login(username: str, password: str) -> Optional[str]:
    """Verify credentials, return JWT token. Returns None on failure."""
    account = await get_user_by_username(username)
    if not account or not account["is_active"]:
        return None
    if not verify_password(password, account["hashed_password"]):
        return None

    payload = {
        "user_id": account["id"],
        "username": account["username"],
        "iat": int(time.time()),
        "exp": int(time.time()) + JWT_EXPIRE_DAYS * 86400,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


async def validate_token(token: str) -> Optional[UserInfo]:
    """Validate JWT and return user info. Returns None if invalid/expired/disabled."""
    if not JWT_SECRET:
        return None
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except (jwt.ExpiredSignatureError, jwt.InvalidTokenError):
        return None

    user_id = payload.get("user_id")
    if not user_id:
        return None

    # Re-query DB to ensure account is still active
    account = await get_user_by_id(user_id)
    if not account or not account["is_active"]:
        return None

    return UserInfo(
        user_id=account["id"],
        username=account["username"],
        display_name=account["display_name"],
        role=account.get("role") or "user",
    )


async def get_user_by_username(username: str):
    """Local import helper — avoids circular import with users.py."""
    from .users import get_user_by_username as _get
    return await _get(username)
