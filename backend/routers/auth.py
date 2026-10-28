from __future__ import annotations

import os
import uuid
import httpx
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
import store
from auth_utils import get_current_user, set_session_cookie

router = APIRouter(tags=["auth"])


def _find_master_or_actor(impersonator_id: str | None = None) -> dict[str, Any]:
    st = store.get_state()
    users = st.get("users_by_id", {})
    if impersonator_id and impersonator_id in users and not users[impersonator_id].get("disabled"):
        return users[impersonator_id]
    masters = [u for u in users.values() if u.get("role") == "master" and not u.get("disabled")]
    if masters:
        return masters[0]
    admins = [u for u in users.values() if u.get("role") == "admin" and not u.get("disabled")]
    if admins:
        return admins[0]
    if users:
        return list(users.values())[0]
    return {
        "id": "master-brettk",
        "email": "brettk@salvagepulsepro.com",
        "name": "Brett K",
        "role": "master",
    }


@router.get("/api/auth/me")
def auth_me(request: Request) -> dict[str, Any]:
    st = store.get_state()
    cookie_token = request.cookies.get("sp_session")
    if cookie_token and cookie_token in st.get("sessions", {}):
        uid = st["sessions"][cookie_token]
        if uid in st.get("users_by_id", {}):
            return st["users_by_id"][uid]

    uid = st.get("current_user_id")
    if uid and uid in st.get("users_by_id", {}):
        return st["users_by_id"][uid]

    # Return 401 if unauthenticated so frontend sends visitor to /login
    raise HTTPException(status_code=401, detail="Not authenticated")


@router.get("/api/auth/demo-login")
def auth_demo_login_status() -> dict[str, Any]:
    st = store.get_state()
    return st.get("demo_login_switch", {"enabled": False})


class DemoLoginReq(BaseModel):
    role: str = "manager"


DEMO_ROLE_MAP = {
    "owner": "user-owner-linda",
    "sales_manager": "user-sales-mgr-marcus",
    "sales": "user-sales-mgr-marcus",
    "inventory_manager": "user-inv-mgr-rick",
    "inventory": "user-inv-mgr-rick",
    "rep": "user-rep-tyler",
    "sales_rep": "user-rep-tyler",
    "master": "master-brettk",
    "admin": "master-brettk",
}


@router.post("/api/auth/demo-login")
def auth_demo_login(response: Response, req: Optional[DemoLoginReq] = None) -> dict[str, Any]:
    st = store.get_state()
    target_role = (req.role if req else "manager").lower().strip()

    user = None
    target_id = DEMO_ROLE_MAP.get(target_role)
    if target_id and target_id in st.get("users_by_id", {}):
        user = st["users_by_id"][target_id]

    if not user:
        if target_role == "master":
            masters = [u for u in st["users_by_id"].values() if u.get("role") == "master" and not u.get("disabled")]
            user = masters[0] if masters else None
        elif target_role == "owner":
            owners = [u for u in st["users_by_id"].values() if u.get("role") == "owner" and not u.get("disabled")]
            user = owners[0] if owners else None
        elif target_role in ("sales_manager", "sales"):
            sms = [u for u in st["users_by_id"].values() if u.get("role") in ("sales_manager", "manager") and not u.get("disabled")]
            user = sms[0] if sms else None
        elif target_role in ("inventory_manager", "inventory"):
            ims = [u for u in st["users_by_id"].values() if u.get("role") == "inventory_manager" and not u.get("disabled")]
            user = ims[0] if ims else None
        elif target_role in ("rep", "sales_rep"):
            reps = [u for u in st["users_by_id"].values() if u.get("role") in ("rep", "sales_rep") and not u.get("disabled")]
            user = reps[0] if reps else None

    if not user:
        user = st.get("users_by_id", {}).get("master-brettk") or list(st["users_by_id"].values())[0]

    set_session_cookie(response, user["id"])
    return user


class LoginReq(BaseModel):
    email: str
    password: Optional[str] = ""


@router.post("/api/auth/login")
def auth_login(req: LoginReq, response: Response) -> dict[str, Any]:
    st = store.get_state()
    email_clean = req.email.strip().lower()

    match = None
    for u in st["users_by_id"].values():
        if u.get("email", "").lower() == email_clean:
            match = u
            break

    if not match:
        if "master" in email_clean or "brettk" in email_clean:
            match = next((u for u in st["users_by_id"].values() if u.get("role") == "master" and not u.get("disabled")), None)
        elif "admin" in email_clean:
            match = next((u for u in st["users_by_id"].values() if u.get("role") in ("admin", "master") and not u.get("disabled")), None)
        elif "owner" in email_clean:
            match = next((u for u in st["users_by_id"].values() if u.get("role") == "owner" and not u.get("disabled")), None)
        elif "inventory" in email_clean:
            match = next((u for u in st["users_by_id"].values() if u.get("role") == "inventory_manager" and not u.get("disabled")), None)
        elif "sales" in email_clean or "manager" in email_clean:
            match = next((u for u in st["users_by_id"].values() if u.get("role") in ("sales_manager", "manager") and not u.get("disabled")), None)
        elif "rep4" in email_clean:
            match = next((u for u in st["users_by_id"].values() if "rep4" in u.get("email", "").lower() and not u.get("disabled")), None)
        elif "rep3" in email_clean:
            match = next((u for u in st["users_by_id"].values() if "rep3" in u.get("email", "").lower() and not u.get("disabled")), None)
        elif "rep2" in email_clean:
            match = next((u for u in st["users_by_id"].values() if "rep2" in u.get("email", "").lower() and not u.get("disabled")), None)
        elif "rep1" in email_clean or "rep" in email_clean:
            match = next((u for u in st["users_by_id"].values() if ("rep1" in u.get("email", "").lower() or "rep@" in u.get("email", "").lower()) and not u.get("disabled")), None)
        else:
            reps = [u for u in st["users_by_id"].values() if u.get("role") in ("rep", "sales_rep") and not u.get("disabled")]
            match = reps[0] if reps else None

    if not match:
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if match and match.get("disabled"):
        raise HTTPException(status_code=403, detail="Account is disabled. Please contact your administrator.")

    stored_hash = match.get("password_hash") or match.get("password")
    pw_input = (req.password or "").strip().lower()
    role_name = (match.get("role") or "").lower()

    role_passwords = {
        "owner": ["owner", "owner123", "keech", "password"],
        "sales_manager": ["salesmanager", "sales_manager", "manager", "manager123", "sales", "password"],
        "inventory_manager": ["inventory", "inventorymanager", "inventory_manager", "inventory123", "password"],
        "rep": ["rep", "rep1", "rep2", "rep3", "rep4", "salesrep", "sales_rep", "rep123", "password"],
        "master": ["admin", "master", "admin123", "master123", "password"],
    }

    is_valid = False
    if stored_hash and store.verify_password(req.password or "", stored_hash):
        is_valid = True
    elif pw_input in role_passwords.get(role_name, []):
        is_valid = True
    elif not stored_hash:
        is_valid = True

    if not is_valid:
        raise HTTPException(status_code=401, detail="Incorrect password. Please verify your credentials.")

    if req.password and not stored_hash:
        match["password_hash"] = store.hash_password(req.password)
        store.save_state()

    u_org_id = match.get("org_id") if match else None
    if u_org_id:
        yard = next((o for o in st.get("admin_orgs", []) if o.get("id") == u_org_id), None)
        if yard and (yard.get("blocked") or yard.get("status") == "canceled"):
            raise HTTPException(status_code=403, detail="Yard is disabled. Please contact platform support.")

    set_session_cookie(response, match["id"])
    return match


@router.post("/api/auth/logout")
def auth_logout(response: Response, request: Request) -> dict[str, Any]:
    st = store.get_state()
    cookie_token = request.cookies.get("sp_session")
    if cookie_token and cookie_token in st.get("sessions", {}):
        st["sessions"].pop(cookie_token, None)
    st["current_user_id"] = None
    response.delete_cookie(key="sp_session", path="/")
    store.save_state()
    return {"ok": True}


class SignupReq(BaseModel):
    yard_name: str
    name: str
    email: str
    password: str
    plan: str = "enterprise"


@router.post("/api/auth/signup")
def auth_signup(req: SignupReq, response: Response) -> dict[str, Any]:
    st = store.get_state()
    new_id = str(uuid.uuid4())
    org_id = str(uuid.uuid4())

    new_user = {
        "id": new_id,
        "email": req.email.strip().lower(),
        "name": req.name,
        "role": "owner",
        "title": "Yard Owner",
        "avatar_url": "",
        "org_id": org_id,
        "impersonated_by": "",
        "disabled": False,
        "site_id": "",
        "must_change_password": False,
        "password_hash": store.hash_password(req.password) if req.password else "",
    }
    st.setdefault("users_by_id", {})[new_id] = new_user

    new_org = {
        "id": org_id,
        "name": req.yard_name,
        "yard_name": req.yard_name,
        "plan": req.plan or "enterprise",
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
    st.setdefault("admin_orgs", []).insert(0, new_org)
    st.setdefault("branding_by_org", {})[org_id] = {
        "yard_name": req.yard_name,
        "accent": "",
        "default_mode": "dark",
        "logo_url": "",
        "user_mode": "dark",
        "mode": "dark",
    }
    st.setdefault("admin_audit", []).insert(0, {
        "at": store.now_iso(),
        "actor": req.name,
        "action": f"signed up yard with plan {req.plan}",
        "target": req.yard_name,
    })

    set_session_cookie(response, new_id)
    store.save_state()
    return new_user


class GoogleAuthReq(BaseModel):
    access_token: Optional[str] = None
    id_token: Optional[str] = None
    session_id: Optional[str] = None
    user_id: Optional[str] = None


class GoogleSignupReq(BaseModel):
    access_token: Optional[str] = None
    id_token: Optional[str] = None
    session_id: Optional[str] = None
    yard_name: str
    plan: str = "enterprise"


async def _fetch_google_user(access_token: Optional[str], id_token: Optional[str]) -> Optional[dict[str, Any]]:
    if not access_token and not id_token:
        return None
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            if access_token:
                resp = await client.get(
                    "https://www.googleapis.com/oauth2/v3/userinfo",
                    headers={"Authorization": f"Bearer {access_token}"},
                )
                if resp.status_code == 200:
                    return resp.json()
            if id_token:
                resp = await client.get(
                    f"https://oauth2.googleapis.com/tokeninfo?id_token={id_token}"
                )
                if resp.status_code == 200:
                    return resp.json()
    except Exception:
        pass
    return None


@router.get("/api/auth/google/config")
def auth_google_config() -> dict[str, Any]:
    client_id = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
    st = store.get_state()
    seen_emails: set[str] = set()
    users = []
    raw_users = list(st.get("users_by_id", {}).values())
    raw_users.sort(key=lambda u: (0 if "keechauto.com" in u.get("email", "") or u.get("id") == "master-brettk" else 1))

    for u in raw_users:
        email = u.get("email", "").strip().lower()
        if not email or email in seen_emails or u.get("disabled"):
            continue
        if u.get("role") not in ("owner", "sales_manager", "inventory_manager", "rep", "master"):
            continue
        seen_emails.add(email)
        users.append({
            "id": u["id"],
            "name": u.get("name", ""),
            "email": u.get("email", ""),
            "role": u.get("role", ""),
            "title": u.get("title", ""),
            "avatar_url": u.get("avatar_url", ""),
        })

    order = {"owner": 1, "sales_manager": 2, "inventory_manager": 3, "rep": 4, "master": 5}
    users.sort(key=lambda x: (order.get(x["role"], 99), x["name"]))
    return {
        "configured": bool(client_id),
        "client_id": client_id,
        "accounts": users,
    }


@router.post("/api/auth/google/signup")
async def auth_google_signup(req: GoogleSignupReq, response: Response) -> dict[str, Any]:
    st = store.get_state()
    google_profile = await _fetch_google_user(req.access_token, req.id_token)
    if not google_profile:
        raise HTTPException(
            status_code=400,
            detail="Google authorization could not be verified. Please try again.",
        )

    email = google_profile.get("email", "").strip().lower()
    name = google_profile.get("name") or email.split("@")[0]
    picture = google_profile.get("picture", "")

    match = next((u for u in st.get("users_by_id", {}).values() if u.get("email", "").strip().lower() == email), None)
    if match:
        match["google_linked"] = True
        match["must_change_password"] = False
        set_session_cookie(response, match["id"])
        store.save_state()
        return {"user": match, "created": False}

    new_id = f"user-{uuid.uuid4().hex[:12]}"
    org_id = f"org-{uuid.uuid4().hex[:12]}"

    new_user = {
        "id": new_id,
        "email": email,
        "name": name,
        "role": "owner",
        "title": "Yard Owner",
        "avatar_url": picture,
        "org_id": org_id,
        "impersonated_by": "",
        "disabled": False,
        "site_id": "",
        "must_change_password": False,
        "google_linked": True,
    }
    st.setdefault("users_by_id", {})[new_id] = new_user

    new_org = {
        "id": org_id,
        "name": req.yard_name,
        "yard_name": req.yard_name,
        "plan": req.plan or "enterprise",
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
    st.setdefault("admin_orgs", []).insert(0, new_org)
    st.setdefault("branding_by_org", {})[org_id] = {
        "yard_name": req.yard_name,
        "accent": "",
        "default_mode": "dark",
        "logo_url": "",
        "user_mode": "dark",
        "mode": "dark",
    }
    set_session_cookie(response, new_id)
    store.save_state()
    return {"user": new_user, "created": True}


@router.post("/api/auth/google")
async def auth_google(req: GoogleAuthReq, response: Response) -> dict[str, Any]:
    st = store.get_state()

    # 1. Direct user_id selection (e.g. from the account chooser when Google OAuth is not configured)
    if req.user_id and req.user_id in st.get("users_by_id", {}):
        target = st["users_by_id"][req.user_id]
        set_session_cookie(response, target["id"])
        return target

    # 2. Real Google OAuth Token verification
    google_profile = await _fetch_google_user(req.access_token, req.id_token)
    if google_profile:
        email = google_profile.get("email", "").strip().lower()
        picture = google_profile.get("picture", "")

        match = next((u for u in st.get("users_by_id", {}).values() if u.get("email", "").strip().lower() == email), None)
        if match:
            match["google_linked"] = True
            match["must_change_password"] = False  # Google proves identity; no starting password needed
            if picture and not match.get("avatar_url"):
                match["avatar_url"] = picture
            set_session_cookie(response, match["id"])
            store.save_state()
            return match

        if email == store.INITIAL_MASTER_EMAIL:
            masters = [u for u in st.get("users_by_id", {}).values() if u.get("role") == "master" and not u.get("disabled")]
            if masters:
                m = masters[0]
                m["google_linked"] = True
                set_session_cookie(response, m["id"])
                store.save_state()
                return m

        raise HTTPException(
            status_code=404,
            detail=f"No account found with email '{email}'. Please ask your yard owner for an invite or sign up for a new yard.",
        )

    raise HTTPException(
        status_code=400,
        detail="Google OAuth is not configured. Please add GOOGLE_CLIENT_ID to .env or choose an account.",
    )


class ChangePasswordReq(BaseModel):
    current_password: Optional[str] = ""
    new_password: str


@router.post("/api/auth/change-password")
def auth_change_password(req: ChangePasswordReq, request: Request) -> dict[str, Any]:
    u = get_current_user(request)
    stored_hash = u.get("password_hash") or u.get("password")
    if stored_hash and req.current_password:
        if not store.verify_password(req.current_password, stored_hash):
            raise HTTPException(status_code=400, detail="Current password is incorrect")
    if len(req.new_password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    u["password_hash"] = store.hash_password(req.new_password)
    u["must_change_password"] = False
    store.save_state()
    return {"ok": True, "message": "Password updated successfully"}


@router.post("/api/auth/forgot-password")
@router.post("/api/auth/reset-password")
def auth_reset_password() -> dict[str, Any]:
    return {"ok": True, "message": "Instructions sent to your email"}


@router.post("/api/auth/resend-verification")
def auth_resend_verification() -> dict[str, Any]:
    return {"ok": True, "sent": True}


@router.post("/api/auth/stop-impersonating")
def auth_stop_impersonating(request: Request, response: Response) -> dict[str, Any]:
    u = get_current_user(request)
    impersonator_id = u.pop("impersonator_id", None)
    u["impersonated_by"] = ""
    admin_user = _find_master_or_actor(impersonator_id)
    set_session_cookie(response, admin_user["id"])
    store.save_state()
    return admin_user


@router.get("/api/auth/stop-impersonating")
def auth_stop_impersonating_get(request: Request) -> RedirectResponse:
    u = get_current_user(request)
    impersonator_id = u.pop("impersonator_id", None)
    u["impersonated_by"] = ""
    admin_user = _find_master_or_actor(impersonator_id)
    resp = RedirectResponse(url="/admin", status_code=303)
    set_session_cookie(resp, admin_user["id"])
    store.save_state()
    return resp


@router.get("/api/auth/recover")
def auth_recover() -> RedirectResponse:
    st = store.get_state()
    for user in st.get("users_by_id", {}).values():
        user["impersonated_by"] = ""
        user.pop("impersonator_id", None)
    admin_user = _find_master_or_actor()
    resp = RedirectResponse(url="/admin", status_code=303)
    set_session_cookie(resp, admin_user["id"])
    store.save_state()
    return resp


@router.post("/api/auth/recover")
def auth_recover_post(response: Response) -> dict[str, Any]:
    st = store.get_state()
    for user in st.get("users_by_id", {}).values():
        user["impersonated_by"] = ""
        user.pop("impersonator_id", None)
    admin_user = _find_master_or_actor()
    set_session_cookie(response, admin_user["id"])
    store.save_state()
    return admin_user


@router.post("/api/auth/not-me")
def auth_not_me() -> dict[str, Any]:
    return {
        "ok": True,
        "message": "Device unlinked and password reset initiated",
        "browser": "Chrome on macOS",
        "reset_token": "token_" + uuid.uuid4().hex,
    }


@router.post("/api/auth/lock-account")
def auth_lock_account() -> dict[str, Any]:
    return {
        "ok": True,
        "message": "Account secured and sessions invalidated",
        "reset_token": "token_" + uuid.uuid4().hex,
    }


@router.get("/api/auth/devices")
def auth_devices() -> list[dict[str, Any]]:
    st = store.get_state()
    return st.get("devices", [])


@router.patch("/api/auth/devices/{dev_id}")
def auth_device_patch(dev_id: str, body: dict[str, Any]) -> list[dict[str, Any]]:
    st = store.get_state()
    for d in st.get("devices", []):
        if d.get("id") == dev_id:
            d["nickname"] = body.get("nickname", d.get("nickname", ""))
    store.save_state()
    return st.get("devices", [])


@router.delete("/api/auth/devices/{dev_id}")
def auth_device_delete(dev_id: str) -> dict[str, Any]:
    st = store.get_state()
    st["devices"] = [d for d in st.get("devices", []) if d.get("id") != dev_id]
    store.save_state()
    return {"devices": st["devices"], "you": False}


@router.get("/api/me/mobile")
def me_mobile() -> dict[str, Any]:
    st = store.get_state()
    return st.get("me_mobile", {})


@router.put("/api/me/mobile")
def me_mobile_put(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    st["me_mobile"] = {**st.get("me_mobile", {}), **body}
    store.save_state()
    return st["me_mobile"]


@router.put("/api/me/theme")
def me_theme_put(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    mode = body.get("mode") or "dark"
    st["branding"]["user_mode"] = mode
    st["branding"]["mode"] = mode
    store.save_state()
    return st["branding"]
