from __future__ import annotations

import logging
import os
import re
import threading
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

import email_service
import store
from auth_utils import (
    clear_session_cookie,
    client_ip,
    consume_security_token,
    current_session_key,
    get_current_user,
    invalidate_user_sessions,
    issue_security_token,
    revoke_request_session,
    set_session_cookie,
)
from security import (
    AUTH_LIMITER,
    SIGNUP_LIMITER,
    app_public_url,
    enforce_rate_limit,
    validate_email,
    validate_password,
)
from user_theme import branding_for_user, normalize_user_theme

logger = logging.getLogger(__name__)

router = APIRouter(tags=["auth"])

DEMO_LOGIN_ENABLED = os.environ.get("DEMO_LOGIN_ENABLED", "0").lower() in ("1", "true", "yes")
ALLOWED_PLANS = {"starter", "pro", "enterprise", "trial"}


def _public_user(user: dict[str, Any]) -> dict[str, Any]:
    """Strip credential material before a user object leaves the server."""
    safe = dict(user)
    safe.pop("password_hash", None)
    safe.pop("password", None)
    return safe


_PHONE_RE = re.compile(r"^[0-9+()\-.\s]+$")


def _clean_phone(value: Any, label: str = "phone number") -> str:
    """Accept common US/international formatting and reject junk.

    Numbers are kept in the format the user typed so phone-system payloads and
    SMS providers see what the person expects; matching elsewhere strips
    punctuation and compares digits.
    """
    raw = str(value or "").strip()
    if not raw:
        return ""
    if len(raw) > 40 or not _PHONE_RE.fullmatch(raw):
        raise HTTPException(status_code=400, detail=f"Enter a valid {label}")
    digits = "".join(ch for ch in raw if ch.isdigit())
    if not 7 <= len(digits) <= 15:
        raise HTTPException(status_code=400, detail=f"Enter a valid {label}")
    return raw


def _app_url(request: Request) -> str:
    return app_public_url(request)


def _find_user_by_email(st: dict[str, Any], email: str) -> dict[str, Any] | None:
    return next(
        (u for u in st.get("users_by_id", {}).values() if (u.get("email") or "").strip().lower() == email),
        None,
    )


def _create_yard(st: dict[str, Any], *, yard_name: str, plan: str) -> dict[str, Any]:
    org_id = str(uuid.uuid4())
    plan = plan if plan in ALLOWED_PLANS else "enterprise"
    org = {
        "id": org_id,
        "name": yard_name,
        "yard_name": yard_name,
        "plan": plan,
        "status": "trialing",
        "trial_ends_at": (datetime.now(timezone.utc) + timedelta(days=14)).isoformat(),
        "created_at": store.now_iso(),
        "users": 1,
        "calls": 0,
        "ringcentral_connected": False,
        "card_on_file": False,
        "blocked": False,
        "cancel_reason": "",
        "discount": None,
        "sites": 0,
        "max_sites": 2,
        "extra_sites": 0,
    }
    st.setdefault("admin_orgs", []).insert(0, org)
    st.setdefault("branding_by_org", {})[org_id] = {
        "yard_name": yard_name,
        "accent": "",
        "default_mode": "dark",
        "logo_url": "",
        "user_mode": "",
        "user_accent": None,
        "mode": "dark",
    }
    return org


def _yard_disabled(st: dict[str, Any], org_id: str | None) -> bool:
    if not org_id:
        return False
    yard = next((o for o in st.get("admin_orgs", []) if o.get("id") == org_id), None)
    return bool(yard and (yard.get("blocked") or yard.get("status") == "canceled"))


@router.get("/api/auth/me")
def auth_me(request: Request) -> dict[str, Any]:
    return _public_user(get_current_user(request))


@router.get("/api/auth/demo-login")
def auth_demo_login_status() -> dict[str, Any]:
    st = store.get_state()
    sw = st.get("demo_login_switch", {})
    return {"enabled": bool(DEMO_LOGIN_ENABLED and store.SEED_DEMO_DATA and sw.get("enabled", False))}


class DemoLoginReq(BaseModel):
    role: str = "manager"


DEMO_ROLE_MAP = {
    "owner": "user-keech-owner",
    "sales_manager": "user-keech-sales-mgr",
    "sales": "user-keech-sales-mgr",
    "inventory_manager": "user-keech-inv-mgr",
    "inventory": "user-keech-inv-mgr",
    "rep": "user-keech-rep",
    "sales_rep": "user-keech-rep",
}


@router.post("/api/auth/demo-login")
def auth_demo_login(response: Response, request: Request, req: Optional[DemoLoginReq] = None) -> dict[str, Any]:
    st = store.get_state()
    sw = st.get("demo_login_switch", {})
    if not (DEMO_LOGIN_ENABLED and store.SEED_DEMO_DATA and sw.get("enabled", False)):
        raise HTTPException(status_code=403, detail="Demo login is disabled")

    target_role = (req.role if req else "manager").lower().strip()
    target_id = DEMO_ROLE_MAP.get(target_role)
    user = st.get("users_by_id", {}).get(target_id) if target_id else None
    if not user or user.get("disabled"):
        raise HTTPException(status_code=404, detail="That demo role is not available")

    set_session_cookie(response, user["id"], request)
    return _public_user(user)


class LoginReq(BaseModel):
    email: str
    password: Optional[str] = ""


@router.post("/api/auth/login")
def auth_login(req: LoginReq, response: Response, request: Request) -> dict[str, Any]:
    st = store.get_state()
    email_clean = (req.email or "").strip().lower()
    enforce_rate_limit(AUTH_LIMITER, f"login:{client_ip(request)}:{email_clean}")

    if not email_clean:
        raise HTTPException(status_code=400, detail="Email is required")

    match = _find_user_by_email(st, email_clean)
    stored_hash = (match.get("password_hash") or match.get("password")) if match else None

    # Always run a hash comparison so response timing does not reveal whether
    # the address exists.  A dummy PBKDF2 hash is used for unknown accounts.
    valid = store.verify_password(
        req.password or "",
        stored_hash or "pbkdf2_sha256$260000$00000000000000000000000000000000$" + "0" * 64,
    )
    if not match or not valid or match.get("disabled") or match.get("locked"):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if _yard_disabled(st, match.get("org_id")):
        raise HTTPException(status_code=403, detail="Yard is disabled. Please contact platform support.")

    if store.needs_rehash(stored_hash):
        match["password_hash"] = store.hash_password(req.password or "")
        match.pop("password", None)
        store.save_state()

    set_session_cookie(response, match["id"], request)
    return _public_user(match)


@router.post("/api/auth/logout")
def auth_logout(response: Response, request: Request) -> dict[str, Any]:
    revoke_request_session(request)
    clear_session_cookie(response)
    return {"ok": True}


class SignupReq(BaseModel):
    yard_name: str
    name: str
    email: str
    password: str
    plan: str = "enterprise"


@router.post("/api/auth/signup")
def auth_signup(req: SignupReq, response: Response, request: Request) -> dict[str, Any]:
    st = store.get_state()
    enforce_rate_limit(SIGNUP_LIMITER, f"signup:{client_ip(request)}")

    email_clean = validate_email(req.email)
    password = validate_password(req.password)
    name = (req.name or "").strip()
    yard_name = (req.yard_name or "").strip()
    if not name or len(name) > 120:
        raise HTTPException(status_code=400, detail="Enter your name")
    if not yard_name or len(yard_name) > 160:
        raise HTTPException(status_code=400, detail="Enter your yard name")
    if _find_user_by_email(st, email_clean):
        raise HTTPException(status_code=400, detail="An account with that email already exists")

    org = _create_yard(st, yard_name=yard_name, plan=req.plan)
    new_id = str(uuid.uuid4())
    new_user = {
        "id": new_id,
        "email": email_clean,
        "name": name,
        "role": "owner",
        "title": "Yard Owner",
        "avatar_url": "",
        "org_id": org["id"],
        "disabled": False,
        "site_id": "",
        "must_change_password": False,
        "password_hash": store.hash_password(password),
    }
    st.setdefault("users_by_id", {})[new_id] = new_user
    st.setdefault("admin_audit", []).insert(0, {
        "at": store.now_iso(),
        "actor": name,
        "action": f"signed up yard with plan {org['plan']}",
        "target": yard_name,
    })

    set_session_cookie(response, new_id, request)
    store.save_state()
    return _public_user(new_user)


class GoogleAuthReq(BaseModel):
    access_token: Optional[str] = None
    id_token: Optional[str] = None
    session_id: Optional[str] = None


class GoogleSignupReq(BaseModel):
    access_token: Optional[str] = None
    id_token: Optional[str] = None
    session_id: Optional[str] = None
    yard_name: str
    plan: str = "enterprise"


async def _fetch_google_user(access_token: Optional[str], id_token: Optional[str]) -> Optional[dict[str, Any]]:
    """Verify a Google token and return only verified profiles.

    The token must have been issued for this application.  Without an audience
    check, a token minted for any other Google OAuth client could be replayed
    here to sign in as its owner.
    """
    if not access_token and not id_token:
        return None
    expected_aud = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
    if not expected_aud:
        logger.warning("Google sign-in rejected because GOOGLE_CLIENT_ID is not configured")
        return None
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            profile: dict[str, Any] | None = None
            if id_token:
                resp = await client.get("https://oauth2.googleapis.com/tokeninfo", params={"id_token": id_token})
                if resp.status_code == 200:
                    profile = resp.json()
            elif access_token:
                resp = await client.get(
                    "https://oauth2.googleapis.com/tokeninfo",
                    params={"access_token": access_token},
                )
                if resp.status_code == 200:
                    profile = resp.json()

            if not profile:
                return None
            # ID tokens report ``aud``; access-token introspection has used
            # ``audience``/``issued_to`` over the years.  Accept any of them,
            # but still require an exact match against this deployment's client.
            token_aud = str(
                profile.get("aud")
                or profile.get("audience")
                or profile.get("issued_to")
                or ""
            ).strip()
            if token_aud != expected_aud:
                logger.warning(
                    "Rejected Google token with unexpected audience %r",
                    token_aud[:48],
                )
                return None
            verified = profile.get("email_verified")
            if verified is None:
                verified = profile.get("verified_email")
            if verified is not True and str(verified).lower() != "true":
                return None
            if not profile.get("email"):
                return None
            return profile
    except Exception as exc:
        logger.warning("Google token verification failed: %s", exc)
        return None


@router.get("/api/auth/google/config")
def auth_google_config() -> dict[str, Any]:
    """Public OAuth client configuration.  Never enumerate account emails."""
    client_id = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
    return {"configured": bool(client_id), "client_id": client_id, "accounts": []}


@router.post("/api/auth/google/signup")
async def auth_google_signup(req: GoogleSignupReq, response: Response, request: Request) -> dict[str, Any]:
    st = store.get_state()
    enforce_rate_limit(SIGNUP_LIMITER, f"google-signup:{client_ip(request)}")

    google_profile = await _fetch_google_user(req.access_token, req.id_token)
    if not google_profile:
        raise HTTPException(status_code=400, detail="Google authorization could not be verified. Please try again.")

    email = validate_email(str(google_profile.get("email", "")))
    name = (google_profile.get("name") or email.split("@")[0]).strip()[:120]
    picture = google_profile.get("picture", "")
    yard_name = (req.yard_name or "").strip()
    if not yard_name or len(yard_name) > 160:
        raise HTTPException(status_code=400, detail="Enter your yard name")

    match = _find_user_by_email(st, email)
    if match:
        if match.get("disabled") or match.get("locked") or _yard_disabled(st, match.get("org_id")):
            raise HTTPException(status_code=403, detail="This account is unavailable. Please contact support.")
        # Linking Google proves ownership of the email, but it must not silently
        # clear a forced rotation on a still-weak local password.
        match["google_linked"] = True
        set_session_cookie(response, match["id"], request)
        store.save_state()
        return {"user": _public_user(match), "created": False}

    org = _create_yard(st, yard_name=yard_name, plan=req.plan)
    new_id = f"user-{uuid.uuid4().hex[:12]}"
    new_user = {
        "id": new_id,
        "email": email,
        "name": name,
        "role": "owner",
        "title": "Yard Owner",
        "avatar_url": picture,
        "org_id": org["id"],
        "disabled": False,
        "site_id": "",
        "must_change_password": False,
        "google_linked": True,
    }
    st.setdefault("users_by_id", {})[new_id] = new_user
    set_session_cookie(response, new_id, request)
    store.save_state()
    return {"user": _public_user(new_user), "created": True}


@router.post("/api/auth/google")
async def auth_google(req: GoogleAuthReq, response: Response, request: Request) -> dict[str, Any]:
    st = store.get_state()
    enforce_rate_limit(AUTH_LIMITER, f"google:{client_ip(request)}")

    if req.session_id:
        raise HTTPException(
            status_code=400,
            detail="This Google sign-in flow is no longer supported. Please use the sign-in button again.",
        )

    google_profile = await _fetch_google_user(req.access_token, req.id_token)
    if not google_profile:
        raise HTTPException(status_code=400, detail="Google authorization could not be verified. Please try again.")

    email = validate_email(str(google_profile.get("email", "")))
    picture = google_profile.get("picture", "")
    match = _find_user_by_email(st, email)
    if not match:
        raise HTTPException(
            status_code=404,
            detail="No account found for that Google email. Ask your yard owner for an invite or sign up for a new yard.",
        )
    if match.get("disabled") or match.get("locked") or _yard_disabled(st, match.get("org_id")):
        raise HTTPException(status_code=403, detail="This account is unavailable. Please contact support.")

    # Do not clear must_change_password here: a weak local password stays valid
    # until the user actually sets a new one.
    match["google_linked"] = True
    if picture and not match.get("avatar_url"):
        match["avatar_url"] = picture
    set_session_cookie(response, match["id"], request)
    store.save_state()
    return _public_user(match)


class ChangePasswordReq(BaseModel):
    current_password: Optional[str] = ""
    new_password: str


@router.post("/api/auth/change-password")
def auth_change_password(req: ChangePasswordReq, request: Request) -> dict[str, Any]:
    u = get_current_user(request)
    if u.get("impersonator_id"):
        raise HTTPException(status_code=403, detail="Stop impersonating before changing a password.")
    stored_hash = u.get("password_hash") or u.get("password")
    new_password = validate_password(req.new_password)

    if stored_hash:
        if not req.current_password or not store.verify_password(req.current_password, stored_hash):
            raise HTTPException(status_code=400, detail="Current password is incorrect")

    u["password_hash"] = store.hash_password(new_password)
    u.pop("password", None)
    u["must_change_password"] = False
    u["locked"] = False
    # Changing a password signs out every other session.
    st = store.get_state()
    invalidate_user_sessions(st, u["id"], keep=current_session_key(request))
    store.save_state()
    return {"ok": True, "message": "Password updated successfully"}


class ForgotPasswordReq(BaseModel):
    email: str


RESET_MESSAGE = "If that email matches an account, a reset link is on its way. It works once, for 1 hour."


@router.post("/api/auth/forgot-password")
def auth_forgot_password(req: ForgotPasswordReq, request: Request) -> dict[str, Any]:
    st = store.get_state()
    email_clean = (req.email or "").strip().lower()
    enforce_rate_limit(AUTH_LIMITER, f"forgot:{client_ip(request)}:{email_clean}")

    if email_clean:
        user = _find_user_by_email(st, email_clean)
        if user and not user.get("disabled") and not _yard_disabled(st, user.get("org_id")):
            token = issue_security_token(st, "reset", user["id"])
            store.save_state()
            if email_service.is_smtp_configured():
                # Send off-thread so response timing does not reveal whether the
                # address exists (SMTP can take seconds).
                threading.Thread(
                    target=email_service.send_password_reset_link_email,
                    kwargs=dict(
                        to_email=user.get("email", ""),
                        name=user.get("name", ""),
                        token=token,
                        app_url=_app_url(request),
                    ),
                    daemon=True,
                ).start()
            else:
                # Local development without SMTP: never return the token in an
                # API response, but leave it where the operator can read it.
                logger.warning("SMTP not configured; password reset token for %s was generated but not emailed", email_clean)
                if os.environ.get("ENVIRONMENT", "").lower() not in ("production", "prod"):
                    try:
                        path = os.path.join(store.DATA_DIR, "last_reset_link.txt")
                        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                        with os.fdopen(fd, "w", encoding="utf-8") as fh:
                            fh.write(f"{_app_url(request)}/reset-password?token={token}\n")
                    except OSError:
                        pass

    return {"ok": True, "message": RESET_MESSAGE}


class PasswordResetReq(BaseModel):
    token: str
    password: str


@router.post("/api/auth/reset-password")
def auth_reset_password(req: PasswordResetReq, request: Request) -> dict[str, Any]:
    st = store.get_state()
    enforce_rate_limit(AUTH_LIMITER, f"reset:{client_ip(request)}")
    password = validate_password(req.password)
    record = consume_security_token(st, req.token, "reset")
    user = st.get("users_by_id", {}).get(record.get("user_id"))
    if not user:
        raise HTTPException(status_code=400, detail="This link is invalid or has expired.")
    if user.get("disabled") or _yard_disabled(st, user.get("org_id")):
        raise HTTPException(status_code=403, detail="This account is unavailable. Please contact support.")

    user["password_hash"] = store.hash_password(password)
    user.pop("password", None)
    user["must_change_password"] = False
    user["locked"] = False
    invalidate_user_sessions(st, user["id"])
    store.save_state()
    return {"ok": True, "message": "Password updated. You can sign in now."}


@router.post("/api/auth/resend-verification")
def auth_resend_verification(request: Request) -> dict[str, Any]:
    get_current_user(request)
    # This deployment does not gate access on email verification, but the
    # endpoint remains available for the UI without leaking account details.
    return {"ok": True, "sent": email_service.is_smtp_configured()}


def _stop_impersonating(request: Request, response: Response) -> dict[str, Any]:
    u = get_current_user(request)
    session_key = current_session_key(request)
    st = store.get_state()
    meta = st.get("session_meta", {}).get(session_key or "", {})
    impersonator_id = meta.get("impersonator_id") or u.get("impersonator_id")
    if not impersonator_id:
        raise HTTPException(status_code=400, detail="You are not impersonating anyone")
    actor = st.get("users_by_id", {}).get(impersonator_id)
    if not actor or actor.get("role") not in ("master", "admin") or actor.get("disabled"):
        raise HTTPException(status_code=403, detail="The original administrator account is unavailable")
    revoke_request_session(request)
    set_session_cookie(response, actor["id"], request)
    store.save_state()
    return _public_user(actor)


@router.post("/api/auth/stop-impersonating")
def auth_stop_impersonating(request: Request, response: Response) -> dict[str, Any]:
    return _stop_impersonating(request, response)


@router.get("/api/auth/stop-impersonating")
def auth_stop_impersonating_get(request: Request) -> RedirectResponse:
    resp = RedirectResponse(url="/admin", status_code=303)
    _stop_impersonating(request, resp)
    return resp


@router.get("/api/auth/recover")
def auth_recover(request: Request) -> RedirectResponse:
    try:
        get_current_user(request)
    except HTTPException:
        return RedirectResponse(url="/login", status_code=303)
    return RedirectResponse(url="/", status_code=303)


@router.post("/api/auth/recover")
def auth_recover_post(request: Request) -> dict[str, Any]:
    return _public_user(get_current_user(request))


class SecurityTokenReq(BaseModel):
    token: str


@router.post("/api/auth/not-me")
def auth_not_me(req: SecurityTokenReq, request: Request) -> dict[str, Any]:
    st = store.get_state()
    enforce_rate_limit(AUTH_LIMITER, f"not-me:{client_ip(request)}")
    record = consume_security_token(st, req.token, "not_me")
    user = st.get("users_by_id", {}).get(record.get("user_id"))
    if not user:
        raise HTTPException(status_code=400, detail="This link is invalid or has expired.")

    session_key = record.get("session_key") or ""
    meta = st.get("session_meta", {}).get(session_key, {})
    if session_key:
        st.get("sessions", {}).pop(session_key, None)
        st.get("session_meta", {}).pop(session_key, None)

    browser = meta.get("browser", "Unknown device")
    reset_token = issue_security_token(st, "reset", user["id"])
    store.save_state()
    return {
        "ok": True,
        "message": "That device has been signed out. Choose a new password to finish securing the account.",
        "browser": browser,
        "reset_token": reset_token,
    }


@router.post("/api/auth/lock-account")
def auth_lock_account(req: SecurityTokenReq, request: Request) -> dict[str, Any]:
    st = store.get_state()
    enforce_rate_limit(AUTH_LIMITER, f"lock:{client_ip(request)}")
    record = consume_security_token(st, req.token, "lock_account")
    user = st.get("users_by_id", {}).get(record.get("user_id"))
    if not user:
        raise HTTPException(status_code=400, detail="This link is invalid or has expired.")

    user["locked"] = True
    invalidate_user_sessions(st, user["id"])
    reset_token = issue_security_token(st, "reset", user["id"])
    store.save_state()
    return {
        "ok": True,
        "message": "Account locked and every device signed out. Choose a new password to unlock it.",
        "reset_token": reset_token,
    }


def _user_devices(st: dict[str, Any], uid: str, current_key: str | None) -> list[dict[str, Any]]:
    sessions = st.get("sessions", {})
    meta = st.get("session_meta", {})
    nicknames = st.get("device_nicknames", {}).get(uid, {})
    devices: dict[str, dict[str, Any]] = {}
    for key, m in meta.items():
        if m.get("user_id") != uid or key not in sessions:
            continue
        did = m.get("device_id") or key
        d = devices.setdefault(did, {
            "id": did,
            "browser": m.get("browser", "Browser"),
            "ip": m.get("ip", ""),
            "first_seen": m.get("first_seen"),
            "last_seen": m.get("last_seen"),
            "this_browser": False,
            "nickname": nicknames.get(did, ""),
        })
        if m.get("first_seen"):
            d["first_seen"] = min(filter(None, [d.get("first_seen"), m["first_seen"]]), default=m["first_seen"])
        if m.get("last_seen"):
            d["last_seen"] = max(filter(None, [d.get("last_seen"), m["last_seen"]]), default=m["last_seen"])
        if current_key and key == current_key:
            d["this_browser"] = True
    return sorted(devices.values(), key=lambda d: d.get("last_seen") or "", reverse=True)


@router.get("/api/auth/devices")
def auth_devices(request: Request) -> list[dict[str, Any]]:
    u = get_current_user(request)
    st = store.get_state()
    return _user_devices(st, u["id"], current_session_key(request))


@router.patch("/api/auth/devices/{dev_id}")
def auth_device_patch(dev_id: str, body: dict[str, Any], request: Request) -> list[dict[str, Any]]:
    u = get_current_user(request)
    st = store.get_state()
    nickname = str(body.get("nickname") or "")[:40]
    st.setdefault("device_nicknames", {}).setdefault(u["id"], {})[dev_id] = nickname
    store.save_state()
    return _user_devices(st, u["id"], current_session_key(request))


@router.delete("/api/auth/devices/{dev_id}")
def auth_device_delete(dev_id: str, request: Request) -> dict[str, Any]:
    u = get_current_user(request)
    st = store.get_state()
    current_key = current_session_key(request)
    doomed = [
        key for key, m in st.get("session_meta", {}).items()
        if m.get("user_id") == u["id"] and m.get("device_id") == dev_id
    ]
    you = current_key in doomed
    for key in doomed:
        st.get("sessions", {}).pop(key, None)
        st.get("session_meta", {}).pop(key, None)
    st.get("device_nicknames", {}).get(u["id"], {}).pop(dev_id, None)
    store.save_state()
    return {"devices": _user_devices(st, u["id"], current_key), "you": you}


@router.get("/api/me/mobile")
def me_mobile(request: Request) -> dict[str, Any]:
    u = get_current_user(request)
    st = store.get_state()
    cur = st.setdefault("me_mobile_by_user", {}).setdefault(u["id"], {
        "mobile": "",
        "days_off": [],
        "vacation_start": None,
        "vacation_end": None,
        "shift_start": "",
        "shift_end": "",
        "held": 0,
    })
    # The live user record is the source of truth for the number phone-system
    # webhooks use to match a call to this person.
    mobile = str(cur.get("mobile") or u.get("mobile") or "")
    return {
        **cur,
        "mobile": mobile,
        "direct_phone": str(u.get("phone") or cur.get("direct_phone") or ""),
        "alt_phones": list(u.get("alt_phones") or []),
    }


@router.put("/api/me/mobile")
def me_mobile_put(body: dict[str, Any], request: Request) -> dict[str, Any]:
    u = get_current_user(request)
    st = store.get_state()
    cur = st.setdefault("me_mobile_by_user", {}).setdefault(u["id"], {})
    user = st.get("users_by_id", {}).get(u["id"])
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    # Validate every number before mutating the shared state so a rejected
    # alternate number cannot leave a half-saved form behind.
    mobile_value: Optional[str] = None
    if "mobile" in body:
        mobile_value = _clean_phone(body.get("mobile"), "mobile number")
    direct_value: Optional[str] = None
    if "direct_phone" in body:
        direct_value = _clean_phone(body.get("direct_phone"), "direct phone number")
    alt_value: Optional[list[str]] = None
    if "alt_phones" in body:
        raw_alt = body.get("alt_phones")
        if raw_alt is None:
            raw_alt = []
        if not isinstance(raw_alt, list):
            raise HTTPException(status_code=400, detail="Alternate phone numbers must be a list")
        if len(raw_alt) > 5:
            raise HTTPException(status_code=400, detail="Add at most 5 alternate phone numbers")
        cleaned: list[str] = []
        seen: set[str] = set()
        for value in raw_alt:
            number = _clean_phone(value, "alternate phone number")
            if not number:
                continue
            digits = "".join(ch for ch in number if ch.isdigit())
            if digits in seen:
                continue
            seen.add(digits)
            cleaned.append(number)
        alt_value = cleaned

    if mobile_value is not None:
        cur["mobile"] = mobile_value
        user["mobile"] = mobile_value
    if direct_value is not None:
        user["phone"] = direct_value
    if alt_value is not None:
        user["alt_phones"] = alt_value

    cur.update({k: v for k, v in body.items() if k in {
        "days_off", "vacation_start", "vacation_end", "shift_start", "shift_end", "held"
    }})
    store.save_state()
    return {
        **cur,
        "mobile": str(cur.get("mobile") or user.get("mobile") or ""),
        "direct_phone": str(user.get("phone") or ""),
        "alt_phones": list(user.get("alt_phones") or []),
    }


@router.put("/api/me/theme")
def me_theme_put(body: dict[str, Any], request: Request) -> dict[str, Any]:
    """Save this user's own light/dark mode; it follows the account on every device."""
    u = get_current_user(request)
    if "accent" in body:
        raise HTTPException(status_code=403, detail="Only the yard owner can change the company accent colour.")
    st = store.get_state()
    themes = st.setdefault("theme_by_user", {})
    theme = normalize_user_theme(themes.get(u["id"]))

    if "mode" in body:
        mode = str(body.get("mode") or "").lower()
        if mode in ("dark", "light"):
            theme["mode"] = mode
        elif mode in ("", "system"):
            theme.pop("mode", None)
        else:
            raise HTTPException(status_code=400, detail="Invalid display mode")

    if theme:
        themes[u["id"]] = theme
    else:
        themes.pop(u["id"], None)
    store.save_state()
    return branding_for_user(st, u)
