from __future__ import annotations
import hashlib
import os
import re
import uuid
from typing import Any
from fastapi import HTTPException, Request, Response
import store


def get_uploads_dir() -> str:
    d = os.environ.get("DATA_DIR")
    if d:
        up = os.path.join(d, "uploads")
    else:
        up = os.path.join(os.path.dirname(__file__), "uploads")
    os.makedirs(up, exist_ok=True)
    return up


def describe_browser(ua: str) -> str:
    """Friendly 'Chrome on macOS' label from a User-Agent string."""
    ua = ua or ""
    if re.search(r"Edg/", ua): browser = "Edge"
    elif re.search(r"OPR/|Opera", ua): browser = "Opera"
    elif re.search(r"Firefox/", ua): browser = "Firefox"
    elif re.search(r"Chrome/|CriOS/", ua): browser = "Chrome"
    elif re.search(r"Safari/", ua): browser = "Safari"
    else: browser = "Browser"
    if re.search(r"iPhone|iPad|iOS", ua): os_name = "iOS"
    elif "Android" in ua: os_name = "Android"
    elif "Windows" in ua: os_name = "Windows"
    elif "Mac OS X" in ua or "Macintosh" in ua: os_name = "macOS"
    elif "CrOS" in ua: os_name = "ChromeOS"
    elif "Linux" in ua: os_name = "Linux"
    else: os_name = ""
    return f"{browser} on {os_name}" if os_name else browser


def client_ip(request: Request) -> str:
    fwd = request.headers.get("cf-connecting-ip") or request.headers.get("x-forwarded-for") or ""
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else ""


def _track_session(st: dict[str, Any], token: str, uid: str, request: Request) -> None:
    """Remember which browser/IP each session belongs to (powers Trusted devices)."""
    meta = st.setdefault("session_meta", {})
    now = store.now_iso()
    m = meta.get(token)
    if m is None:
        ua = request.headers.get("user-agent", "")
        ip = client_ip(request)
        browser = describe_browser(ua)
        meta[token] = {
            "user_id": uid,
            "browser": browser,
            "ip": ip,
            "device_id": hashlib.sha1(f"{uid}|{browser}|{ip}".encode()).hexdigest()[:12],
            "first_seen": now,
            "last_seen": now,
        }
        store.save_state()
    elif m.get("last_seen", "")[:16] != now[:16]:  # refresh at most once a minute, no disk write
        m["last_seen"] = now


def get_current_user(request: Request) -> dict[str, Any]:
    st = store.get_state()
    cookie_token = request.cookies.get("sp_session")
    if cookie_token and cookie_token in st.get("sessions", {}):
        uid = st["sessions"][cookie_token]
        user = st.get("users_by_id", {}).get(uid)
        if user and not user.get("disabled"):
            _track_session(st, cookie_token, uid, request)
            return user

    raise HTTPException(status_code=401, detail="Not authenticated")


def set_session_cookie(response: Response, user_id: str, request: Request | None = None) -> str:
    token = f"sess_{uuid.uuid4().hex}"
    st = store.get_state()
    if "sessions" not in st:
        st["sessions"] = {}
    st["sessions"][token] = user_id
    st["current_user_id"] = user_id
    if request:
        _track_session(st, token, user_id, request)
    response.set_cookie(
        key="sp_session",
        value=token,
        httponly=True,
        samesite="lax",
        max_age=86400 * 30,
        path="/",
    )
    store.save_state()
    return token
