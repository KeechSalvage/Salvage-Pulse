from __future__ import annotations

import datetime as dt
import hashlib
import os
import re
import secrets
import uuid
from typing import Any

from fastapi import HTTPException, Request, Response

import store

SESSION_COOKIE = "sp_session"
SESSION_MAX_AGE_SECONDS = int(os.environ.get("SESSION_MAX_AGE_SECONDS", str(60 * 60 * 24 * 30)))
MAX_INACTIVITY_SECONDS = int(os.environ.get("SESSION_INACTIVITY_SECONDS", "3600"))
SECURITY_TOKEN_TTL_SECONDS = int(os.environ.get("SECURITY_TOKEN_TTL_SECONDS", "3600"))
TRUST_PROXY_HEADERS = os.environ.get("TRUST_PROXY_HEADERS", "0").lower() in ("1", "true", "yes")
_ENVIRONMENT = os.environ.get("ENVIRONMENT", "development").strip().lower()
_COOKIE_SECURE_DEFAULT = "1" if _ENVIRONMENT in ("production", "prod") else "0"
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", _COOKIE_SECURE_DEFAULT).lower() in ("1", "true", "yes")


def get_uploads_dir() -> str:
    d = os.environ.get("DATA_DIR")
    if d:
        up = os.path.join(d, "uploads")
    else:
        up = os.path.join(os.path.dirname(__file__), "uploads")
    os.makedirs(up, mode=0o700, exist_ok=True)
    try:
        os.chmod(up, 0o700)
    except OSError:
        pass
    return up


def describe_browser(ua: str) -> str:
    """Friendly 'Chrome on macOS' label from a User-Agent string."""
    ua = ua or ""
    if re.search(r"Edg/", ua):
        browser = "Edge"
    elif re.search(r"OPR/|Opera", ua):
        browser = "Opera"
    elif re.search(r"Firefox/", ua):
        browser = "Firefox"
    elif re.search(r"Chrome/|CriOS/", ua):
        browser = "Chrome"
    elif re.search(r"Safari/", ua):
        browser = "Safari"
    else:
        browser = "Browser"
    if re.search(r"iPhone|iPad|iOS", ua):
        os_name = "iOS"
    elif "Android" in ua:
        os_name = "Android"
    elif "Windows" in ua:
        os_name = "Windows"
    elif "Mac OS X" in ua or "Macintosh" in ua:
        os_name = "macOS"
    elif "CrOS" in ua:
        os_name = "ChromeOS"
    elif "Linux" in ua:
        os_name = "Linux"
    else:
        os_name = ""
    return f"{browser} on {os_name}" if os_name else browser


def client_ip(request: Request) -> str:
    """Return the caller IP.

    Forwarding headers are attacker-controlled unless a trusted reverse proxy
    overwrites them, so they are only honoured when ``TRUST_PROXY_HEADERS`` is
    explicitly enabled.
    """
    if TRUST_PROXY_HEADERS:
        fwd = request.headers.get("cf-connecting-ip") or request.headers.get("x-forwarded-for") or ""
        if fwd:
            return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def hash_token(token: str) -> str:
    """Session and reset tokens are stored hashed, never in clear text."""
    return hashlib.sha256((token or "").encode("utf-8")).hexdigest()


def _session_key(st: dict[str, Any], raw_token: str) -> str | None:
    """Look up a cookie token, supporting sessions created before hashing."""
    sessions = st.get("sessions", {})
    if not raw_token:
        return None
    hashed = hash_token(raw_token)
    if hashed in sessions:
        return hashed
    # Legacy sessions stored the raw token as the key.
    if raw_token in sessions:
        return raw_token
    return None


def _new_token(prefix: str = "sess") -> str:
    return f"{prefix}_{secrets.token_urlsafe(32)}"


def issue_security_token(
    st: dict[str, Any],
    kind: str,
    user_id: str,
    *,
    session_key: str | None = None,
    ttl_seconds: int = SECURITY_TOKEN_TTL_SECONDS,
) -> str:
    """Create a single-use token for password resets and security emails."""
    raw = _new_token("sec")
    now = dt.datetime.now(dt.timezone.utc)
    tokens = st.setdefault("security_tokens", {})
    # Opportunistically prune expired entries so the state file cannot grow forever.
    cutoff = (now - dt.timedelta(days=2)).isoformat()
    for key in [k for k, v in tokens.items() if (v.get("created_at") or "") < cutoff]:
        tokens.pop(key, None)
    tokens[hash_token(raw)] = {
        "kind": kind,
        "user_id": user_id,
        "session_key": session_key or "",
        "created_at": now.isoformat(),
        "expires_at": (now + dt.timedelta(seconds=ttl_seconds)).isoformat(),
        "used_at": None,
    }
    return raw


def consume_security_token(st: dict[str, Any], raw_token: str, kind: str) -> dict[str, Any]:
    tokens = st.get("security_tokens", {})
    key = hash_token(raw_token or "")
    record = tokens.get(key)
    if not record or record.get("kind") != kind or record.get("used_at"):
        raise HTTPException(status_code=400, detail="This link is invalid or has already been used.")
    try:
        expires = dt.datetime.fromisoformat(record["expires_at"])
    except (KeyError, ValueError):
        raise HTTPException(status_code=400, detail="This link is invalid or has expired.")
    if dt.datetime.now(dt.timezone.utc) > expires:
        tokens.pop(key, None)
        raise HTTPException(status_code=400, detail="This link has expired. Please request a new one.")
    record["used_at"] = store.now_iso()
    return record


def invalidate_user_sessions(st: dict[str, Any], user_id: str, *, keep: str | None = None) -> int:
    sessions = st.get("sessions", {})
    meta = st.get("session_meta", {})
    doomed = [k for k, uid in sessions.items() if uid == user_id and k != keep]
    for key in doomed:
        sessions.pop(key, None)
        meta.pop(key, None)
    return len(doomed)


def _cookie_is_secure(request: Request | None) -> bool:
    if COOKIE_SECURE:
        return True
    if request is None:
        return False
    if TRUST_PROXY_HEADERS:
        forwarded = (request.headers.get("x-forwarded-proto") or "").lower()
        if forwarded == "https":
            return True
    return request.url.scheme == "https"


def _track_session(st: dict[str, Any], token_key: str, uid: str, request: Request) -> None:
    """Remember which browser/IP each session belongs to (powers Trusted devices)."""
    meta = st.setdefault("session_meta", {})
    now = store.now_iso()
    m = meta.get(token_key)
    if m is None:
        ua = request.headers.get("user-agent", "")
        ip = client_ip(request)
        browser = describe_browser(ua)
        device_id = hashlib.sha256(f"{uid}|{browser}|{ip}".encode()).hexdigest()[:12]

        user = st.get("users_by_id", {}).get(uid, {})
        is_staff = user.get("role") in ("master", "admin")

        is_new_device = False
        if is_staff:
            known_devices = {
                entry.get("device_id")
                for entry in meta.values()
                if entry.get("user_id") == uid
            }
            if device_id not in known_devices:
                is_new_device = True

        meta[token_key] = {
            "user_id": uid,
            "browser": browser,
            "ip": ip,
            "device_id": device_id,
            "first_seen": now,
            "last_seen": now,
        }
        store.save_state()

        if is_staff and is_new_device:
            import threading

            from email_service import send_new_device_login_email

            # One token lets the recipient sign this device out; the other lets
            # them lock the account.  Both are single-use and short lived.
            not_me_token = issue_security_token(st, "not_me", uid, session_key=token_key)
            lock_token = issue_security_token(st, "lock_account", uid, session_key=token_key)
            store.save_state()

            threading.Thread(
                target=send_new_device_login_email,
                args=(
                    user.get("name", "Staff Member"),
                    user.get("email", ""),
                    user.get("role", "staff"),
                    browser,
                    ip,
                    now,
                    not_me_token,
                    lock_token,
                ),
                daemon=True,
            ).start()
    elif m.get("last_seen", "")[:16] != now[:16]:  # refresh at most once a minute
        m["last_seen"] = now


def get_current_user(request: Request) -> dict[str, Any]:
    st = store.get_state()
    cookie_token = request.cookies.get(SESSION_COOKIE)
    key = _session_key(st, cookie_token) if cookie_token else None
    if not key:
        raise HTTPException(status_code=401, detail="Not authenticated")

    meta = st.get("session_meta", {}).get(key)
    now_utc = dt.datetime.now(dt.timezone.utc)

    if meta:
        try:
            first_seen = dt.datetime.fromisoformat((meta.get("first_seen") or "").replace("Z", "+00:00"))
            if (now_utc - first_seen).total_seconds() > SESSION_MAX_AGE_SECONDS:
                raise HTTPException(status_code=401, detail="Session expired. Please sign in again.")
            last_seen = dt.datetime.fromisoformat((meta.get("last_seen") or "").replace("Z", "+00:00"))
            if (now_utc - last_seen).total_seconds() > MAX_INACTIVITY_SECONDS:
                raise HTTPException(status_code=401, detail="Session expired due to inactivity. Please sign in again.")
        except HTTPException:
            st.get("sessions", {}).pop(key, None)
            st.get("session_meta", {}).pop(key, None)
            store.save_state()
            raise
        except (ValueError, TypeError):
            pass

    uid = st.get("sessions", {}).get(key)
    user = st.get("users_by_id", {}).get(uid) if uid else None
    if not user or user.get("disabled"):
        raise HTTPException(status_code=401, detail="Not authenticated")
    if user.get("locked"):
        raise HTTPException(
            status_code=403,
            detail="This account is locked. Reset your password from the security email to unlock it.",
        )

    org_id = user.get("org_id")
    if org_id:
        yard = next((o for o in st.get("admin_orgs", []) if o.get("id") == org_id), None)
        if yard and (yard.get("blocked") or yard.get("status") == "canceled"):
            raise HTTPException(status_code=403, detail="Yard is disabled. Please contact platform support.")

    _track_session(st, key, uid, request)

    # Impersonation is a property of this session, never of the account record.
    if meta and meta.get("impersonator_id"):
        return {
            **user,
            "impersonated_by": meta.get("impersonated_by") or "Admin",
            "impersonator_id": meta["impersonator_id"],
        }
    return user


def set_session_cookie(
    response: Response,
    user_id: str,
    request: Request | None = None,
    *,
    impersonator_id: str | None = None,
    impersonated_by: str | None = None,
) -> str:
    """Start an authenticated session and return the raw cookie token."""
    token = _new_token("sess")
    key = hash_token(token)
    st = store.get_state()
    sessions = st.setdefault("sessions", {})
    sessions[key] = user_id
    if request is not None:
        _track_session(st, key, user_id, request)
    if impersonator_id:
        meta = st.setdefault("session_meta", {}).setdefault(key, {})
        meta["impersonator_id"] = impersonator_id
        meta["impersonated_by"] = impersonated_by or "Admin"
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        httponly=True,
        secure=_cookie_is_secure(request),
        samesite="lax",
        max_age=SESSION_MAX_AGE_SECONDS,
        path="/",
    )
    store.save_state()
    return token


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(key=SESSION_COOKIE, path="/")


def current_session_key(request: Request) -> str | None:
    st = store.get_state()
    token = request.cookies.get(SESSION_COOKIE)
    return _session_key(st, token) if token else None


def revoke_request_session(request: Request) -> None:
    st = store.get_state()
    token = request.cookies.get(SESSION_COOKIE)
    key = _session_key(st, token) if token else None
    if key:
        st.get("sessions", {}).pop(key, None)
        st.get("session_meta", {}).pop(key, None)
        store.save_state()
