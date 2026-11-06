"""Central authorization, validation and abuse-prevention helpers.

Everything that decides *who may do what* lives here so route modules stay
readable and no endpoint accidentally forgets a check.
"""
from __future__ import annotations

import os
import re
import threading
import time
from collections import defaultdict, deque
from typing import Any, Iterable
from urllib.parse import urlparse

from fastapi import HTTPException, Request

from auth_utils import get_current_user, client_ip

STAFF_ROLES = frozenset({"master", "admin"})
MANAGER_ROLES = frozenset({"owner", "sales_manager", "manager", "inventory_manager", "master", "admin"})
YARD_ADMIN_ROLES = frozenset({"owner", "sales_manager", "manager", "master", "admin"})
REP_ROLES = frozenset({"rep", "sales_rep"})
ALL_YARD_ROLES = frozenset({"owner", "sales_manager", "manager", "inventory_manager", "rep", "sales_rep"})

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def is_staff(user: dict[str, Any] | None) -> bool:
    return bool(user and user.get("role") in STAFF_ROLES)


def is_manager(user: dict[str, Any] | None) -> bool:
    return bool(user and user.get("role") in MANAGER_ROLES)


def user_org(user: dict[str, Any] | None) -> str:
    return (user or {}).get("org_id") or ""


def scoped_site_id(user: dict[str, Any], requested: Optional[str]) -> str:
    """Return the location a caller may view.

    Reps with an assigned location are locked to it.  Owners, sales managers,
    and inventory managers may choose all locations or one location.
    """
    if user and user.get("role") in REP_ROLES and user.get("site_id"):
        return str(user.get("site_id"))
    return str(requested or "").strip()


# Routes a user still on a starting/demo password may call while they choose a
# new one.  Everything else is blocked so a known weak credential cannot be
# used to read or change yard data.
PASSWORD_CHANGE_PATHS = frozenset({
    "/api/auth/me",
    "/api/auth/change-password",
    "/api/auth/logout",
    "/api/auth/stop-impersonating",
    "/api/auth/recover",
    "/api/auth/devices",
    "/api/me/mobile",
    "/api/me/theme",
    "/api/meta",
    "/api/branding",
    "/api/org/me",
})


def _enforce_password_change(user: dict[str, Any], request: Request) -> dict[str, Any]:
    if user.get("must_change_password") and not user.get("impersonator_id"):
        path = request.url.path
        if path not in PASSWORD_CHANGE_PATHS and not path.startswith("/api/auth/devices/"):
            raise HTTPException(
                status_code=403,
                detail="Choose a new password before continuing.",
            )
    return user


def require_authenticated(request: Request) -> dict[str, Any]:
    """FastAPI dependency: reject anonymous callers with 401."""
    return _enforce_password_change(get_current_user(request), request)


def require_staff(request: Request) -> dict[str, Any]:
    user = _enforce_password_change(get_current_user(request), request)
    if user.get("role") not in STAFF_ROLES:
        raise HTTPException(status_code=403, detail="Platform staff only")
    return user


def require_master(request: Request) -> dict[str, Any]:
    user = _enforce_password_change(get_current_user(request), request)
    if user.get("role") != "master":
        raise HTTPException(status_code=403, detail="Master admin only")
    return user


def require_manager(request: Request) -> dict[str, Any]:
    user = _enforce_password_change(get_current_user(request), request)
    if user.get("role") not in MANAGER_ROLES:
        raise HTTPException(status_code=403, detail="Manager access required")
    return user


def require_inventory(request: Request) -> dict[str, Any]:
    user = _enforce_password_change(get_current_user(request), request)
    if user.get("role") not in ("owner", "inventory_manager", "master", "admin", "manager", "sales_manager"):
        raise HTTPException(status_code=403, detail="Only Owners and Inventory Managers can manage yard inventory.")
    return user


def require_role(*roles: str):
    """Build a dependency that accepts any of ``roles``."""
    allowed = frozenset(roles)

    def _dependency(request: Request) -> dict[str, Any]:
        user = _enforce_password_change(get_current_user(request), request)
        if user.get("role") not in allowed:
            raise HTTPException(status_code=403, detail="You do not have permission to do that")
        return user

    return _dependency


def assert_same_org(user: dict[str, Any], org_id: str | None, *, staff_can_cross: bool = True) -> None:
    """Raise 403 unless ``user`` may touch a record owned by ``org_id``.

    Platform staff may cross tenant boundaries by design; yard users may only
    touch records belonging to their own yard.  Records with no org are treated
    as platform-owned and are staff-only.
    """
    if staff_can_cross and is_staff(user):
        return
    mine = user_org(user)
    if not mine:
        raise HTTPException(status_code=403, detail="Access denied")
    if not org_id or org_id != mine:
        raise HTTPException(status_code=403, detail="Access denied")


def assert_record_access(user: dict[str, Any], record: dict[str, Any], *, staff_can_cross: bool = True) -> None:
    assert_same_org(user, record.get("org_id"), staff_can_cross=staff_can_cross)


def resolve_write_org(user: dict[str, Any], requested_org_id: str | None = None) -> str:
    """Pick the org a new record should belong to.

    Staff may create records for any org (or platform-owned records when no org
    is given).  Everyone else is pinned to their own org and cannot spoof it.
    """
    if is_staff(user):
        return (requested_org_id or user_org(user) or "").strip()
    mine = user_org(user)
    if not mine:
        raise HTTPException(status_code=403, detail="Your account is not attached to a yard")
    if requested_org_id and requested_org_id != mine:
        raise HTTPException(status_code=403, detail="You cannot create records for another yard")
    return mine


def effective_org(user: dict[str, Any], requested_org_id: str | None = None) -> str | None:
    """Return the org filter a read endpoint must apply.

    ``None`` means "all orgs" and is only reachable for platform staff.  Yard
    users are always pinned to their own org; they cannot ask for another one.
    """
    if is_staff(user):
        return (requested_org_id or user_org(user) or "").strip() or None
    mine = user_org(user)
    if not mine:
        raise HTTPException(status_code=403, detail="Your account is not attached to a yard")
    if requested_org_id and requested_org_id != mine:
        raise HTTPException(status_code=403, detail="Access denied")
    return mine


def assert_call_access(user: dict[str, Any], call: dict[str, Any]) -> None:
    assert_same_org(user, call.get("org_id"))


def find_call(state: dict[str, Any], call_id: str) -> dict[str, Any] | None:
    for bucket in ("calls", "callbacks_open", "callbacks_resolved"):
        found = next((c for c in state.get(bucket, []) if c.get("id") == call_id), None)
        if found:
            return found
    return None


def safe_join(base: str, *parts: str) -> str:
    """Join paths and refuse anything that escapes ``base``."""
    base_real = os.path.realpath(base)
    candidate = os.path.realpath(os.path.join(base_real, *parts))
    if candidate != base_real and not candidate.startswith(base_real + os.sep):
        raise HTTPException(status_code=400, detail="Invalid file path")
    return candidate


ALLOWED_AUDIO_EXTENSIONS = frozenset({".wav", ".mp3", ".m4a", ".ogg", ".webm", ".flac", ".aac", ".mp4", ".mpeg"})
ALLOWED_IMAGE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".webp", ".gif"})


def validate_upload(
    content: bytes,
    filename: str,
    allowed_extensions: Iterable[str],
    *,
    max_bytes: int | None = None,
) -> str:
    """Validate an uploaded file and return its lowercase extension."""
    ext = os.path.splitext(filename or "")[1].lower()
    allowed = {e.lower() for e in allowed_extensions}
    if ext not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type. Allowed: {', '.join(sorted(allowed))}",
        )
    if not content:
        raise HTTPException(status_code=400, detail="The uploaded file is empty")
    limit = max_bytes or int(os.environ.get("MAX_UPLOAD_MB", "25")) * 1024 * 1024
    if len(content) > limit:
        raise HTTPException(status_code=413, detail=f"File is too large (max {limit // (1024 * 1024)} MB)")
    return ext


def can_manage_user(actor: dict[str, Any], target: dict[str, Any]) -> bool:
    """Whether ``actor`` may edit/disable/delete ``target``'s account."""
    if actor.get("id") == target.get("id"):
        return True
    if actor.get("role") == "master":
        return True
    if actor.get("role") != "admin":
        return False
    # Platform admins may manage yard users in any yard, never other staff.
    return target.get("role") not in STAFF_ROLES and user_org(target) != ""


def can_manage_yard_user(actor: dict[str, Any], target: dict[str, Any]) -> bool:
    """Role hierarchy for yard-level account management.

    Owners may manage everyone in their own yard; managers may manage reps but
    not other managers or the owner.  Platform staff retain their own rules.
    """
    if actor.get("id") == target.get("id"):
        return True
    if is_staff(actor):
        return can_manage_user(actor, target)
    if user_org(actor) == "" or user_org(actor) != user_org(target):
        return False
    actor_role = actor.get("role")
    target_role = target.get("role")
    if actor_role == "owner":
        return target_role not in STAFF_ROLES
    if actor_role in ("sales_manager", "manager"):
        return target_role in ("rep", "sales_rep", "inventory_manager")
    return False


def public_user(user: dict[str, Any]) -> dict[str, Any]:
    """Strip credential material before a user object leaves the server.

    Personal contact numbers are also removed from shared rep listings; each
    user can still read and edit their own through /api/auth/me and
    /api/me/mobile.
    """
    safe = dict(user)
    safe.pop("password_hash", None)
    safe.pop("password", None)
    safe.pop("phone", None)
    safe.pop("mobile", None)
    safe.pop("alt_phones", None)
    return safe



def validate_email(email: str) -> str:
    clean = (email or "").strip().lower()
    if not clean or len(clean) > 254 or not _EMAIL_RE.match(clean):
        raise HTTPException(status_code=400, detail="Enter a valid email address")
    return clean


def validate_password(password: str, *, min_length: int = 8) -> str:
    password = password or ""
    if len(password) < min_length:
        raise HTTPException(status_code=400, detail=f"Password must be at least {min_length} characters")
    if len(password) > 1024:
        raise HTTPException(status_code=400, detail="Password is too long")
    return password


# ---------------------------------------------------------------------------
# In-memory rate limiting (single-process deployments; swap for Redis later)
# ---------------------------------------------------------------------------
class SlidingWindowLimiter:
    def __init__(self, limit: int, window_seconds: float):
        self.limit = limit
        self.window = window_seconds
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def _prune(self, key: str, now: float) -> deque[float]:
        hits = self._hits[key]
        cutoff = now - self.window
        while hits and hits[0] <= cutoff:
            hits.popleft()
        return hits

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        with self._lock:
            hits = self._prune(key, now)
            if len(hits) >= self.limit:
                return False
            hits.append(now)
            return True

    def retry_after(self, key: str) -> int:
        now = time.monotonic()
        with self._lock:
            hits = self._prune(key, now)
            if not hits:
                return 0
            return max(1, int(self.window - (now - hits[0])))


AUTH_LIMITER = SlidingWindowLimiter(
    limit=int(os.environ.get("AUTH_RATE_LIMIT", "10")),
    window_seconds=float(os.environ.get("AUTH_RATE_WINDOW_SECONDS", "300")),
)
SIGNUP_LIMITER = SlidingWindowLimiter(
    limit=int(os.environ.get("SIGNUP_RATE_LIMIT", "5")),
    window_seconds=float(os.environ.get("SIGNUP_RATE_WINDOW_SECONDS", "3600")),
)


def enforce_rate_limit(limiter: SlidingWindowLimiter, key: str) -> None:
    if not limiter.allow(key):
        raise HTTPException(
            status_code=429,
            detail="Too many attempts. Please wait a few minutes and try again.",
            headers={"Retry-After": str(limiter.retry_after(key))},
        )


def request_origin_allowed(request: Request, allowed_origins: Iterable[str]) -> bool:
    """CSRF defence: a browser's Origin/Referer must match our own host."""
    raw = request.headers.get("origin") or request.headers.get("referer") or ""
    if not raw:
        return True  # non-browser client (curl, server-to-server)
    try:
        parsed = urlparse(raw)
    except ValueError:
        return False
    origin = f"{parsed.scheme}://{parsed.netloc}".lower()
    allowed = {o.lower().rstrip("/") for o in allowed_origins if o}
    host = (request.headers.get("host") or "").lower()
    if host:
        allowed.add(f"{parsed.scheme}://{host}".lower())
        allowed.add(f"http://{host}".lower())
        allowed.add(f"https://{host}".lower())
    return origin in allowed


def trusted_client_ip(request: Request) -> str:
    """Only honour forwarding headers when explicitly deployed behind a proxy."""
    if os.environ.get("TRUST_PROXY_HEADERS", "0").lower() in ("1", "true", "yes"):
        return client_ip(request)
    return request.client.host if request.client else "unknown"


def app_public_url(request: Request) -> str:
    """Return the canonical public base URL for links sent to users.

    ``APP_URL`` is authoritative.  Without it, only an allow-listed Host header
    (or a local/private address during development) is trusted, so an attacker
    cannot make us email a password-reset or invite link that points at their
    own site.
    """
    env_url = os.environ.get("APP_URL", "").strip().rstrip("/")
    if env_url:
        return env_url

    trust_proxy = os.environ.get("TRUST_PROXY_HEADERS", "0").lower() in ("1", "true", "yes")
    proto = (request.headers.get("x-forwarded-proto") if trust_proxy else "") or request.url.scheme or "https"
    host = (request.headers.get("x-forwarded-host") if trust_proxy else "") or request.headers.get("host") or ""
    allowed_hosts = {
        h.strip().lower()
        for h in os.environ.get("ALLOWED_HOSTS", "").split(",")
        if h.strip()
    }
    host_only = host.split(":")[0].lower()
    local = (
        host_only in ("localhost", "127.0.0.1", "::1")
        or host_only.startswith("10.")
        or host_only.startswith("192.168.")
        or host_only.startswith("172.")
    )
    if host and (host_only in allowed_hosts or local):
        return f"{proto}://{host}"
    return "https://app.salvagepulsepro.com"
