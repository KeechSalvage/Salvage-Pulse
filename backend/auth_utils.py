from __future__ import annotations
import datetime as dt
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
        device_id = hashlib.sha1(f"{uid}|{browser}|{ip}".encode()).hexdigest()[:12]
        
        # Check if this user is a platform staff member (master or admin)
        user = st.get("users_by_id", {}).get(uid, {})
        is_staff = user.get("role") in ("master", "admin")
        
        # Check if this device has been seen before for this staff member
        is_new_device = False
        if is_staff:
            known_devices = {
                entry.get("device_id")
                for entry in meta.values()
                if entry.get("user_id") == uid
            }
            if device_id not in known_devices:
                is_new_device = True

        meta[token] = {
            "user_id": uid,
            "browser": browser,
            "ip": ip,
            "device_id": device_id,
            "first_seen": now,
            "last_seen": now,
        }
        store.save_state()

        if is_staff and is_new_device:
            # Trigger alert email asynchronously in a daemon thread so login is not delayed
            import threading
            from email_service import send_new_device_login_email

            staff_name = user.get("name", "Staff Member")
            staff_email = user.get("email", "")
            staff_role = user.get("role", "staff")

            threading.Thread(
                target=send_new_device_login_email,
                args=(staff_name, staff_email, staff_role, browser, ip, now),
                daemon=True,
            ).start()
    elif m.get("last_seen", "")[:16] != now[:16]:  # refresh at most once a minute, no disk write
        m["last_seen"] = now


MAX_INACTIVITY_SECONDS = 3600  # 1 hour auto-logout for inactivity


def get_current_user(request: Request) -> dict[str, Any]:
    st = store.get_state()
    cookie_token = request.cookies.get("sp_session")
    if cookie_token and cookie_token in st.get("sessions", {}):
        meta = st.get("session_meta", {}).get(cookie_token)
        if meta and meta.get("last_seen"):
            try:
                last_seen_dt = dt.datetime.fromisoformat(meta["last_seen"].replace("Z", "+00:00"))
                now_utc = dt.datetime.now(dt.timezone.utc)
                if (now_utc - last_seen_dt).total_seconds() > MAX_INACTIVITY_SECONDS:
                    # Session expired due to inactivity
                    st.get("sessions", {}).pop(cookie_token, None)
                    st.get("session_meta", {}).pop(cookie_token, None)
                    store.save_state()
                    raise HTTPException(status_code=401, detail="Session expired due to inactivity. Please sign in again.")
            except HTTPException:
                raise
            except Exception:
                pass

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
