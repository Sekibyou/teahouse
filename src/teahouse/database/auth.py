"""
JWT authentication service.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
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


# ---------------------------------------------------------------------------
# Login brute-force guard (in-memory; a restart clears all state)
# ---------------------------------------------------------------------------

# Policy (only failures are counted; a success clears the counter):
#   3 failures within 60s, OR 5 failures within 3600s -> locked for 3600s
_LOCK_FOR = 3600
_FAIL_WINDOW = 60
_FAIL_SOFT_LIMIT = 3
_FAIL_HARD_LIMIT = 5
_FAIL_HARD_WINDOW = 3600


@dataclass
class _LoginState:
    fails: list[float] = field(default_factory=list)  # timestamps of recent failures
    locked_until: float = 0.0


class LoginThrottle:
    """In-memory per-username login attempt limiter.

    Memory-only by design: a backend restart clears every counter and lock.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._states: dict[str, _LoginState] = {}

    def check(self, username: str) -> Optional[float]:
        """Return remaining lock seconds if currently frozen, else None."""
        with self._lock:
            state = self._states.get(username)
            if not state:
                return None
            if state.locked_until > time.time():
                return state.locked_until - time.time()
            return None

    def register_failure(self, username: str) -> None:
        """Record a failed login. Returns nothing; lock is implicit on next check."""
        with self._lock:
            state = self._states.setdefault(username, _LoginState())
            now = time.time()
            state.fails.append(now)
            # drop failures older than the hard window (they no longer count)
            cutoff = now - _FAIL_HARD_WINDOW
            if cutoff > 0:
                state.fails = [t for t in state.fails if t >= cutoff]
            state.locked_until = self._compute_lock(now, state.fails)

    def register_success(self, username: str) -> None:
        """A successful login resets the counter and clears any lock."""
        with self._lock:
            state = self._states.get(username)
            if not state:
                return
            state.fails.clear()
            state.locked_until = 0.0

    def _compute_lock(self, now: float, fails: list[float]) -> float:
        recent = [t for t in fails if now - t <= _FAIL_WINDOW]
        if len(recent) >= _FAIL_SOFT_LIMIT:
            return now + _LOCK_FOR
        if len(fails) >= _FAIL_HARD_LIMIT:
            return now + _LOCK_FOR
        return 0.0


login_throttle = LoginThrottle()


async def login(username: str, password: str) -> Optional[str]:
    """Verify credentials, return JWT token. Returns None on failure."""
    account = await get_user_by_username(username)
    if not account or not account["is_active"]:
        login_throttle.register_failure(username)
        return None
    if not verify_password(password, account["hashed_password"]):
        login_throttle.register_failure(username)
        return None

    login_throttle.register_success(username)

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
