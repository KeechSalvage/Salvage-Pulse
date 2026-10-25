from __future__ import annotations

import asyncio
import datetime as dt
import json
import os
import uuid
from typing import Any, Optional

from fastapi import (
    Cookie,
    FastAPI,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
    status,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

import store

app = FastAPI(title="Salvage Pulse AI API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ==========================================
# Authentication & Helpers
# ==========================================
def get_current_user(request: Request) -> dict[str, Any]:
    st = store.get_state()
    cookie_token = request.cookies.get("sp_session")
    if cookie_token and cookie_token in st.get("sessions", {}):
        uid = st["sessions"][cookie_token]
        if uid in st.get("users_by_id", {}):
            return st["users_by_id"][uid]

    uid = st.get("current_user_id")
    if uid and uid in st.get("users_by_id", {}):
        return st["users_by_id"][uid]

    manager = st.get("seed", {}).get("_me", {})
    return manager


def set_session_cookie(response: Response, user_id: str) -> str:
    token = f"sess_{uuid.uuid4().hex}"
    st = store.get_state()
    if "sessions" not in st:
        st["sessions"] = {}
    st["sessions"][token] = user_id
    st["current_user_id"] = user_id
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


# ==========================================
# Health
# ==========================================
@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "timestamp": store.now_iso()}


# ==========================================
# Auth Endpoints
# ==========================================
@app.get("/api/auth/me")
def auth_me(request: Request) -> dict[str, Any]:
    return get_current_user(request)


@app.get("/api/auth/demo-login")
def auth_demo_login_status() -> dict[str, Any]:
    st = store.get_state()
    return st.get("demo_login_switch", {"enabled": True})


class DemoLoginReq(BaseModel):
    role: str = "manager"


@app.post("/api/auth/demo-login")
def auth_demo_login(req: DemoLoginReq, response: Response) -> dict[str, Any]:
    st = store.get_state()
    target_role = req.role.lower()

    if target_role == "rep":
        # Tyler Grant or first rep
        reps = [u for u in st["users_by_id"].values() if u.get("role") == "rep" and not u.get("disabled")]
        user = reps[0] if reps else st["seed"]["_me"]
    else:
        # Linda Carter or manager
        managers = [u for u in st["users_by_id"].values() if u.get("role") in ("manager", "master", "admin")]
        user = managers[0] if managers else st["seed"]["_me"]

    set_session_cookie(response, user["id"])
    return user


class LoginReq(BaseModel):
    email: str
    password: Optional[str] = ""


@app.post("/api/auth/login")
def auth_login(req: LoginReq, response: Response) -> dict[str, Any]:
    st = store.get_state()
    email_clean = req.email.strip().lower()

    match = None
    for u in st["users_by_id"].values():
        if u.get("email", "").lower() == email_clean:
            match = u
            break

    if not match:
        # Match demo rep or manager
        if "manager" in email_clean:
            match = st["seed"]["_me"]
        else:
            reps = [u for u in st["users_by_id"].values() if u.get("role") == "rep"]
            match = reps[0] if reps else st["seed"]["_me"]

    set_session_cookie(response, match["id"])
    return match


@app.post("/api/auth/logout")
def auth_logout(response: Response) -> dict[str, Any]:
    response.delete_cookie(key="sp_session", path="/")
    return {"ok": True}


class SignupReq(BaseModel):
    yard_name: str
    name: str
    email: str
    password: str
    plan: str = "enterprise"


@app.post("/api/auth/signup")
def auth_signup(req: SignupReq, response: Response) -> dict[str, Any]:
    st = store.get_state()
    new_id = str(uuid.uuid4())
    org_id = str(uuid.uuid4())

    new_user = {
        "id": new_id,
        "email": req.email,
        "name": req.name,
        "role": "manager",
        "title": "General Manager",
        "avatar_url": "",
        "org_id": org_id,
        "impersonated_by": "",
        "disabled": False,
        "site_id": "",
        "must_change_password": False,
    }
    st["users_by_id"][new_id] = new_user
    st["branding"]["yard_name"] = req.yard_name
    st["org"]["name"] = req.yard_name
    st["org"]["plan"] = req.plan

    set_session_cookie(response, new_id)
    return new_user


class GoogleSignupReq(BaseModel):
    session_id: str
    yard_name: str
    plan: str = "enterprise"


@app.post("/api/auth/google/signup")
def auth_google_signup(req: GoogleSignupReq, response: Response) -> dict[str, Any]:
    user = auth_demo_login(DemoLoginReq(role="manager"), response)
    return {"user": user, "created": True}


@app.post("/api/auth/google")
def auth_google(response: Response) -> dict[str, Any]:
    return auth_demo_login(DemoLoginReq(role="manager"), response)


@app.post("/api/auth/change-password")
def auth_change_password(request: Request) -> dict[str, Any]:
    u = get_current_user(request)
    u["must_change_password"] = False
    store.save_state()
    return {"ok": True, "message": "Password updated successfully"}


@app.post("/api/auth/forgot-password")
@app.post("/api/auth/reset-password")
def auth_reset_password() -> dict[str, Any]:
    return {"ok": True, "message": "Instructions sent to your email"}


@app.post("/api/auth/resend-verification")
def auth_resend_verification() -> dict[str, Any]:
    return {"ok": True, "sent": True}


@app.post("/api/auth/stop-impersonating")
def auth_stop_impersonating(request: Request) -> dict[str, Any]:
    u = get_current_user(request)
    u["impersonated_by"] = ""
    store.save_state()
    return u


@app.post("/api/auth/not-me")
def auth_not_me() -> dict[str, Any]:
    return {
        "ok": True,
        "message": "Device unlinked and password reset initiated",
        "browser": "Chrome on macOS",
        "reset_token": "token_" + uuid.uuid4().hex,
    }


@app.post("/api/auth/lock-account")
def auth_lock_account() -> dict[str, Any]:
    return {
        "ok": True,
        "message": "Account secured and sessions invalidated",
        "reset_token": "token_" + uuid.uuid4().hex,
    }


# Devices
@app.get("/api/auth/devices")
def auth_devices() -> list[dict[str, Any]]:
    st = store.get_state()
    return st.get("devices", [])


@app.patch("/api/auth/devices/{dev_id}")
def auth_device_patch(dev_id: str, body: dict[str, Any]) -> list[dict[str, Any]]:
    st = store.get_state()
    for d in st.get("devices", []):
        if d.get("id") == dev_id:
            d["nickname"] = body.get("nickname", d.get("nickname", ""))
    store.save_state()
    return st.get("devices", [])


@app.delete("/api/auth/devices/{dev_id}")
def auth_device_delete(dev_id: str) -> dict[str, Any]:
    st = store.get_state()
    st["devices"] = [d for d in st.get("devices", []) if d.get("id") != dev_id]
    store.save_state()
    return {"devices": st["devices"], "you": False}


# Mobile & Profile
@app.get("/api/me/mobile")
def me_mobile() -> dict[str, Any]:
    st = store.get_state()
    return st.get("me_mobile", {})


@app.put("/api/me/mobile")
def me_mobile_put(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    st["me_mobile"] = {**st.get("me_mobile", {}), **body}
    store.save_state()
    return st["me_mobile"]


@app.put("/api/me/theme")
def me_theme_put(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    mode = body.get("mode") or "dark"
    st["branding"]["user_mode"] = mode
    st["branding"]["mode"] = mode
    store.save_state()
    return st["branding"]


# ==========================================
# Meta, Org, Branding, Settings
# ==========================================
@app.get("/api/meta")
def get_meta() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"]["/meta"]


@app.get("/api/org/me")
def get_org_me() -> dict[str, Any]:
    st = store.get_state()
    return st["org"]


@app.delete("/api/org/sample-data")
def delete_sample_data() -> dict[str, Any]:
    st = store.get_state()
    st["org"]["sample_data"] = False
    store.save_state()
    return st["org"]


@app.post("/api/org/enterprise-tour/done")
def enterprise_tour_done() -> dict[str, Any]:
    st = store.get_state()
    st["org"]["show_enterprise_tour"] = False
    store.save_state()
    return st["org"]


@app.get("/api/branding")
def get_branding() -> dict[str, Any]:
    st = store.get_state()
    return st["branding"]


@app.put("/api/branding")
def put_branding(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    if "accent" in body:
        st["branding"]["accent"] = body["accent"]
    if "default_mode" in body:
        st["branding"]["default_mode"] = body["default_mode"]
        st["branding"]["mode"] = body["default_mode"]
    store.save_state()
    return st["branding"]


@app.post("/api/branding/logo")
async def post_branding_logo(file: UploadFile = File(...)) -> dict[str, Any]:
    st = store.get_state()
    # Save a lightweight data url
    content = await file.read()
    import base64

    b64 = base64.b64encode(content).decode("ascii")
    mime = file.content_type or "image/png"
    st["branding"]["logo_url"] = f"data:{mime};base64,{b64}"
    store.save_state()
    return st["branding"]


@app.delete("/api/branding/logo")
def delete_branding_logo() -> dict[str, Any]:
    st = store.get_state()
    st["branding"]["logo_url"] = ""
    store.save_state()
    return st["branding"]


@app.get("/api/settings/business")
def get_settings_business() -> dict[str, Any]:
    st = store.get_state()
    return st.get("settings_business", {"avg_order_value": None, "yard_name": None})


@app.put("/api/settings/business")
def put_settings_business(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    cur = st.get("settings_business", {})
    if "avg_order_value" in body:
        cur["avg_order_value"] = body["avg_order_value"]
    if "yard_name" in body:
        cur["yard_name"] = body["yard_name"]
        if body["yard_name"]:
            st["branding"]["yard_name"] = body["yard_name"]
            st["org"]["name"] = body["yard_name"]
    st["settings_business"] = cur
    store.save_state()
    return cur


@app.get("/api/settings/coverage")
def get_settings_coverage() -> dict[str, Any]:
    st = store.get_state()
    return st.get("settings_coverage", {"max_away": 2, "warn_days_ahead": 3})


@app.put("/api/settings/coverage")
def put_settings_coverage(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    st["settings_coverage"] = {**st.get("settings_coverage", {}), **body}
    store.save_state()
    return st["settings_coverage"]


@app.get("/api/settings/delivery-tips")
def get_settings_delivery_tips() -> dict[str, Any]:
    st = store.get_state()
    return st.get("settings_delivery_tips", {"date_given": "", "address_confirmed": "", "thanked": ""})


@app.put("/api/settings/delivery-tips")
def put_settings_delivery_tips(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    st["settings_delivery_tips"] = {**st.get("settings_delivery_tips", {}), **body}
    store.save_state()
    return st["settings_delivery_tips"]


@app.get("/api/settings/digest")
def get_settings_digest() -> dict[str, Any]:
    st = store.get_state()
    return st.get("settings_digest", {"recipient_email": "", "enabled": False})


@app.put("/api/settings/digest")
def put_settings_digest(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    st["settings_digest"] = {**st.get("settings_digest", {}), **body}
    store.save_state()
    return st["settings_digest"]


@app.post("/api/digest/send-now")
def digest_send_now() -> dict[str, Any]:
    st = store.get_state()
    recipient = st.get("settings_digest", {}).get("recipient_email") or "manager@salvagepulse.com"
    return {
        "sent": True,
        "recipient": recipient,
        "reps": len([u for u in st["users_by_id"].values() if u.get("role") == "rep"]),
        "items": len(st.get("callbacks_open", [])),
        "location_emails": len(st.get("sites_data", {}).get("sites", [])),
    }


@app.get("/api/settings/monthly-report")
def get_settings_monthly_report() -> dict[str, Any]:
    st = store.get_state()
    base = dict(st.get("settings_monthly_report", {"enabled": True, "user_ids": None, "extra_emails": []}))
    # Build current recipients
    people = []
    for u in st["users_by_id"].values():
        if not u.get("disabled") and u.get("role") in ("manager", "rep"):
            people.append({
                "id": u["id"],
                "name": u["name"],
                "email": u["email"],
                "role": u["role"],
            })
    base["people"] = people
    return base


@app.put("/api/settings/monthly-report")
def put_settings_monthly_report(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    cur = st.get("settings_monthly_report", {})
    cur.update(body)
    st["settings_monthly_report"] = cur
    store.save_state()
    return get_settings_monthly_report()


@app.post("/api/reports/email-me")
def reports_email_me() -> dict[str, Any]:
    return {
        "sent": 1,
        "skipped": 0,
        "month": store.current_month_str(),
    }


# Layouts
@app.get("/api/layouts/{page}")
def get_layout(page: str, as_target: Optional[str] = Query(None, alias="as")) -> dict[str, Any]:
    st = store.get_state()
    layouts = st.get("layouts", {})
    key = f"{page}:{as_target}" if as_target else page
    if key in st.get("custom_layouts", {}):
        return st["custom_layouts"][key]
    return layouts.get(page, {"page": page, "order": [], "source": "default"})


@app.put("/api/layouts/{page}")
def put_layout(page: str, body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    target = body.get("target") or "yard"
    order = body.get("order") or []
    out = {"page": page, "order": order, "source": "user" if target != "yard" else "yard"}
    if "custom_layouts" not in st:
        st["custom_layouts"] = {}
    st["custom_layouts"][f"{page}:{target}"] = out
    st["layouts"][page] = out
    store.save_state()
    return out


@app.delete("/api/layouts/{page}")
def delete_layout(page: str, target: Optional[str] = Query(None)) -> dict[str, Any]:
    st = store.get_state()
    key = f"{page}:{target}" if target else page
    st.get("custom_layouts", {}).pop(key, None)
    out = {"page": page, "order": [], "source": "default"}
    st["layouts"][page] = out
    store.save_state()
    return out


@app.get("/api/layouts-targets/{page}")
def get_layout_targets(page: str) -> list[dict[str, Any]]:
    st = store.get_state()
    targets = [{"target": "yard", "name": "Everyone in the yard", "role": "", "has_custom": False}]
    for u in sorted(st["users_by_id"].values(), key=lambda x: x.get("name", "")):
        if not u.get("disabled"):
            targets.append({
                "target": u["id"],
                "name": u["name"],
                "role": u.get("role", ""),
                "has_custom": f"{page}:{u['id']}" in st.get("custom_layouts", {}),
            })
    return targets


# ==========================================
# Reps & Sites
# ==========================================
@app.get("/api/users/reps")
def get_users_reps(include_disabled: bool = Query(False)) -> list[dict[str, Any]]:
    st = store.get_state()
    out = []
    for u in st["users_by_id"].values():
        if u.get("role") == "rep":
            if include_disabled or not u.get("disabled"):
                out.append(u)
    return sorted(out, key=lambda x: x.get("name", ""))


@app.post("/api/users/reps")
def create_rep(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    new_id = str(uuid.uuid4())
    org_id = st["seed"]["_me"]["org_id"]
    new_rep = {
        "id": new_id,
        "email": body["email"],
        "name": body["name"],
        "role": "rep",
        "title": body.get("title") or "Sales",
        "avatar_url": "",
        "org_id": org_id,
        "impersonated_by": "",
        "disabled": False,
        "site_id": body.get("site_id", ""),
        "must_change_password": True,
    }
    st["users_by_id"][new_id] = new_rep
    store.save_state()
    return new_rep


@app.get("/api/users/reps/login-log")
def get_rep_login_log() -> list[dict[str, Any]]:
    st = store.get_state()
    return st.get("rep_login_log", [])


@app.get("/api/users/reps/{rep_id}/open-work")
def get_rep_open_work(rep_id: str) -> dict[str, Any]:
    st = store.get_state()
    open_cb = sum(1 for c in st.get("callbacks_open", []) if c.get("rep_id") == rep_id)
    lists_ct = sum(1 for l in st.get("callback_lists", []) if l.get("rep_id") == rep_id and l.get("open", 0) > 0)
    return {"callbacks": open_cb, "lists": lists_ct}


@app.patch("/api/users/reps/{rep_id}/login")
def update_rep_login(rep_id: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = st["users_by_id"].get(rep_id)
    if not u:
        raise HTTPException(status_code=404, detail="Rep not found")

    disabled = bool(body.get("disabled"))
    u["disabled"] = disabled
    move_to = body.get("move_to_rep_id", "")
    moved_count = 0

    if disabled and move_to:
        to_user = st["users_by_id"].get(move_to, {})
        to_name = to_user.get("name", "Teammate")
        for cb in st.get("callbacks_open", []):
            if cb.get("rep_id") == rep_id:
                cb["rep_id"] = move_to
                cb["rep_name"] = to_name
                moved_count += 1
        for l in st.get("callback_lists", []):
            if l.get("rep_id") == rep_id:
                l["rep_id"] = move_to
                l["rep_name"] = to_name

    actor = get_current_user(request)
    event = {
        "id": str(uuid.uuid4()),
        "rep_id": rep_id,
        "rep_name": u["name"],
        "action": "off" if disabled else "on",
        "by": actor.get("name", "Manager"),
        "source": "reps_page",
        "moved": moved_count,
        "moved_to": st["users_by_id"].get(move_to, {}).get("name", "") if move_to else "",
        "at": store.now_iso(),
    }
    st.setdefault("rep_login_log", []).insert(0, event)
    store.save_state()
    return {"user": u, "moved": moved_count}


@app.patch("/api/users/reps/{rep_id}/site")
def update_rep_site(rep_id: str, body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    u = st["users_by_id"].get(rep_id)
    if not u:
        raise HTTPException(status_code=404, detail="Rep not found")
    u["site_id"] = body.get("site_id", "")
    store.save_state()
    return u


# Sites (Lots)
@app.get("/api/sites")
def get_sites() -> dict[str, Any]:
    st = store.get_state()
    data = st.get("sites_data", {})
    # Recalculate rep counts on each site
    for s in data.get("sites", []):
        sid = s["id"]
        s["reps"] = sum(1 for u in st["users_by_id"].values() if u.get("site_id") == sid and not u.get("disabled"))
    return data


@app.post("/api/sites")
def create_site(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    sid = str(uuid.uuid4())
    new_site = {
        "id": sid,
        "name": body["name"],
        "reps": 0,
        "manager_id": "",
        "manager_name": "",
        "goal": 0.0,
        "month_revenue": 0.0,
    }
    st.setdefault("sites_data", {}).setdefault("sites", []).append(new_site)
    store.save_state()
    return get_sites()


@app.patch("/api/sites/{site_id}")
def update_site(site_id: str, body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    for s in st.get("sites_data", {}).get("sites", []):
        if s["id"] == site_id:
            if "name" in body:
                s["name"] = body["name"]
    store.save_state()
    return get_sites()


@app.patch("/api/sites/{site_id}/goal")
def update_site_goal(site_id: str, body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    for s in st.get("sites_data", {}).get("sites", []):
        if s["id"] == site_id:
            s["goal"] = float(body.get("goal") or 0.0)
    store.save_state()
    return get_sites()


@app.patch("/api/sites/{site_id}/manager")
def update_site_manager(site_id: str, body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    mid = body.get("manager_id", "")
    muser = st["users_by_id"].get(mid, {})
    for s in st.get("sites_data", {}).get("sites", []):
        if s["id"] == site_id:
            s["manager_id"] = mid
            s["manager_name"] = muser.get("name", "")
    store.save_state()
    return get_sites()


@app.delete("/api/sites/{site_id}")
def delete_site(site_id: str) -> dict[str, Any]:
    st = store.get_state()
    st["sites_data"]["sites"] = [s for s in st.get("sites_data", {}).get("sites", []) if s["id"] != site_id]
    for u in st["users_by_id"].values():
        if u.get("site_id") == site_id:
            u["site_id"] = ""
    store.save_state()
    return get_sites()


@app.get("/api/sites/managers")
def get_site_managers() -> list[dict[str, Any]]:
    st = store.get_state()
    return [u for u in st["users_by_id"].values() if u.get("role") in ("manager", "master", "admin")]


@app.get("/api/sites/leaderboard")
def get_sites_leaderboard(days: int = Query(30)) -> dict[str, Any]:
    st = store.get_state()
    lb = st["seed"].get("/sites/leaderboard?days=30", {})
    return lb


# ==========================================
# Calls & Audio & Drill-Down
# ==========================================
@app.get("/api/calls")
def get_calls(
    rep_id: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    outcome: Optional[str] = Query(None),
    sentiment: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    site_id: Optional[str] = Query(None),
) -> list[dict[str, Any]]:
    st = store.get_state()
    calls = st.get("calls", [])
    filtered = []

    # Map reps in site if site_id given
    site_rep_ids = set()
    if site_id:
        site_rep_ids = {u["id"] for u in st["users_by_id"].values() if u.get("site_id") == site_id}

    for c in calls:
        if rep_id and c.get("rep_id") != rep_id:
            continue
        if site_id and c.get("rep_id") not in site_rep_ids:
            continue
        if category and c.get("category") != category:
            continue
        if outcome and c.get("outcome") != outcome:
            continue
        if sentiment and c.get("sentiment") != sentiment:
            continue
        if status and c.get("status") != status:
            continue
        if date_from and (c.get("created_at") or "")[:10] < date_from:
            continue
        if date_to and (c.get("created_at") or "")[:10] > date_to:
            continue
        if q:
            term = q.lower()
            text = f"{c.get('customer_name', '')} {c.get('vehicle', '')} {c.get('part_requested', '')} {c.get('summary', '')}".lower()
            if term not in text:
                continue
        filtered.append(c)

    return filtered


@app.get("/api/calls/coverage")
def get_calls_coverage() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/calls/coverage", {})


@app.get("/api/calls/uploads/recent")
def get_recent_uploads() -> list[dict[str, Any]]:
    st = store.get_state()
    return st.get("recent_uploads", [])


@app.delete("/api/calls/uploads/{uid}")
def delete_recent_upload(uid: str) -> dict[str, Any]:
    st = store.get_state()
    st["recent_uploads"] = [u for u in st.get("recent_uploads", []) if u.get("id") != uid]
    store.save_state()
    return {"ok": True}


@app.get("/api/calls/vehicle-options")
def get_vehicle_options(catalog: bool = Query(False), rank: str = Query("calls")) -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/calls/vehicle-options?catalog=true&rank=calls", st["seed"].get("/calls/vehicle-options", {}))


@app.get("/api/calls/{call_id}")
def get_call_detail(call_id: str) -> dict[str, Any]:
    st = store.get_state()
    full_calls = st.get("full_calls", {})
    if call_id in full_calls:
        return full_calls[call_id]

    # Find in calls summary list
    match = next((c for c in st.get("calls", []) if c.get("id") == call_id), None)
    if not match:
        raise HTTPException(status_code=404, detail="Call not found")

    full = store.synthesize_call_details(match)
    full_calls[call_id] = full
    store.save_state()
    return full


@app.get("/api/calls/{call_id}/audio")
def get_call_audio(call_id: str) -> Response:
    # Return valid wav bytes so browser <audio> works cleanly
    wav = store.generate_wav_bytes(duration_sec=3.5)
    return Response(content=wav, media_type="audio/wav")


@app.get("/api/calls/{call_id}/customer-calls")
def get_customer_calls(call_id: str) -> dict[str, Any]:
    st = store.get_state()
    match = next((c for c in st.get("calls", []) if c.get("id") == call_id), None)
    if not match:
        return {"key": "", "calls": []}

    cust_name = match.get("customer_name")
    phone = match.get("customer_phone")
    related = [c for c in st.get("calls", []) if c.get("customer_name") == cust_name or (phone and c.get("customer_phone") == phone)]
    return {"key": cust_name, "calls": related[:20]}


@app.patch("/api/calls/{call_id}/vehicle")
def patch_call_vehicle(call_id: str, body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    for c in st.get("calls", []):
        if c.get("id") == call_id:
            if "vehicle_year" in body:
                c["vehicle_year"] = body["vehicle_year"]
            if "vehicle_make" in body:
                c["vehicle_make"] = body["vehicle_make"]
            if "vehicle_model" in body:
                c["vehicle_model"] = body["vehicle_model"]
            if "part_requested" in body:
                c["part_requested"] = body["part_requested"]
            c["vehicle"] = f"{c.get('vehicle_year') or ''} {c.get('vehicle_make', '')} {c.get('vehicle_model', '')}".strip()
            store.save_state()
            return c
    raise HTTPException(status_code=404, detail="Call not found")


@app.patch("/api/calls/{call_id}/sale")
def patch_call_sale(call_id: str, body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    for c in st.get("calls", []):
        if c.get("id") == call_id:
            is_sold = body.get("sold", False)
            c["outcome"] = "won" if is_sold else "lost"
            c["order_value"] = float(body.get("sold_price") or 0.0) if is_sold else 0.0
            if "parts_sold" in body:
                c["parts_sold"] = body["parts_sold"]
            if "lost_reason" in body:
                c["lost_reason"] = body["lost_reason"]
            store.save_state()
            return c
    raise HTTPException(status_code=404, detail="Call not found")


@app.patch("/api/calls/{call_id}/delivery")
def patch_call_delivery(call_id: str, body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    for c in st.get("calls", []):
        if c.get("id") == call_id:
            c["delivery_call"] = bool(body.get("delivery"))
            if "delivery_kind" in body:
                c["delivery_kind"] = body["delivery_kind"]
            store.save_state()
            return c
    raise HTTPException(status_code=404, detail="Call not found")


@app.put("/api/calls/{call_id}/delivery-check")
def put_call_delivery_check(call_id: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    for c in st.get("calls", []):
        if c.get("id") == call_id:
            dg = bool(body.get("date_given"))
            ac = bool(body.get("address_confirmed"))
            th = bool(body.get("thanked"))
            score = int((sum([dg, ac, th]) / 3.0) * 100)
            c["delivery_check"] = {
                "date_given": dg,
                "address_confirmed": ac,
                "thanked": th,
                "notes": "Verified by manager",
                "source": "manual",
                "by": u.get("name", "Manager"),
            }
            c["delivery_score"] = score
            c["delivery_call"] = True
            store.save_state()
            return c
    raise HTTPException(status_code=404, detail="Call not found")


@app.post("/api/calls/{call_id}/delivery-check/ai")
def post_call_delivery_check_ai(call_id: str) -> dict[str, Any]:
    st = store.get_state()
    for c in st.get("calls", []):
        if c.get("id") == call_id:
            c["delivery_check"] = {
                "date_given": True,
                "address_confirmed": True,
                "thanked": True,
                "notes": "AI identified confirmed delivery date, shop bay location, and parting thank-you.",
                "source": "ai",
                "by": "Salvage Pulse AI",
            }
            c["delivery_score"] = 100
            c["delivery_call"] = True
            store.save_state()
            return c
    raise HTTPException(status_code=404, detail="Call not found")


@app.patch("/api/calls/{call_id}/callback")
def patch_call_callback(call_id: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    for c in st.get("calls", []):
        if c.get("id") == call_id:
            c["callback_done"] = bool(body.get("done"))
            c["callback_by"] = u.get("name", "Rep")
            c["callback_at"] = store.now_iso()
            if body.get("sold_price"):
                c["outcome"] = "won"
                c["order_value"] = float(body["sold_price"])
                if "parts_sold" in body:
                    c["parts_sold"] = body["parts_sold"]
            store.save_state()
            return c
    raise HTTPException(status_code=404, detail="Call not found")


@app.delete("/api/calls/{call_id}/assignment")
def delete_call_assignment(call_id: str) -> dict[str, Any]:
    st = store.get_state()
    st["callbacks_open"] = [c for c in st.get("callbacks_open", []) if c.get("id") != call_id]
    store.save_state()
    return {"ok": True}


@app.post("/api/calls/{call_id}/reanalyze")
def post_call_reanalyze(call_id: str) -> dict[str, Any]:
    return get_call_detail(call_id)


@app.delete("/api/calls/{call_id}")
def delete_call(call_id: str) -> dict[str, Any]:
    st = store.get_state()
    st["calls"] = [c for c in st.get("calls", []) if c.get("id") != call_id]
    st.get("full_calls", {}).pop(call_id, None)
    store.save_state()
    return {"ok": True}


@app.post("/api/calls/bulk-delete")
def post_calls_bulk_delete(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    ids_to_del = set(body.get("ids", []))
    orig_len = len(st.get("calls", []))
    st["calls"] = [c for c in st.get("calls", []) if c.get("id") not in ids_to_del]
    store.save_state()
    return {"deleted": orig_len - len(st["calls"])}


@app.post("/api/calls/transcript")
def post_call_transcript(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    cid = str(uuid.uuid4())
    u = get_current_user(request)
    rep_id = body.get("rep_id") or u["id"]
    rep = st["users_by_id"].get(rep_id, u)

    transcript = body.get("transcript", "")
    cust_name = body.get("customer_name") or "Direct Caller"

    summary_item = {
        "id": cid,
        "rep_id": rep["id"],
        "rep_name": rep["name"],
        "customer_name": cust_name,
        "source": "transcript",
        "status": "completed",
        "category": "Part Inquiry/Quote",
        "summary": "Transcript scored · Part Quote & Inquiry",
        "vehicle": "2018 Chevrolet Silverado",
        "part_requested": "Alternator",
        "outcome": "pending",
        "sentiment": "positive",
        "overall_score": 82,
        "created_at": store.now_iso(),
        "direction": "inbound",
        "duration_sec": 140.0,
        "source_category": "Sales Inquiry",
        "topics": ["Part Inquiry", "Price Quote"],
        "order_value": 0.0,
        "quoted_value": 185.0,
        "parts_sold": [],
        "delivery_call": False,
        "delivery_check": None,
        "lost_reason": "",
        "callback_done": False,
        "callback_by": "",
        "callback_at": None,
        "vehicle_year": 2018,
        "vehicle_make": "Chevrolet",
        "vehicle_model": "Silverado",
        "delivery_kind": "",
        "delivery_score": None,
    }
    st.setdefault("calls", []).insert(0, summary_item)
    full = store.synthesize_call_details(summary_item)
    full["transcript"] = transcript
    st.setdefault("full_calls", {})[cid] = full
    store.save_state()
    return full


@app.post("/api/calls/audio")
async def post_call_audio(
    file: UploadFile = File(...),
    customer: Optional[str] = Form(None),
    rep: Optional[str] = Form(None),
    request: Request = None,
) -> dict[str, Any]:
    u = get_current_user(request)
    body = {
        "customer_name": customer or "Audio Caller",
        "transcript": "Customer called inquiring about parts availability.",
        "rep_id": rep or u["id"],
    }
    return post_call_transcript(body, request)


@app.post("/api/calls/bulk-audio")
async def post_bulk_audio(file: UploadFile = File(...)) -> dict[str, Any]:
    return {
        "items": [
            {
                "filename": file.filename or "recording.wav",
                "call_id": str(uuid.uuid4()),
                "match": "phone_date",
                "customer_name": "Matched Auto Repair",
                "rep_name": "Tyler Grant",
                "error": "",
            }
        ],
        "matched": 1,
        "created": 1,
        "failed": 0,
    }


@app.post("/api/calls/import")
async def post_calls_import(file: UploadFile = File(...)) -> dict[str, Any]:
    return {
        "file_from": "2026-10-01",
        "file_to": store.today_str(),
        "total_rows": 48,
        "imported": 48,
        "updated": 0,
        "skipped": 0,
        "reps_created": [],
        "rep_logins": [],
        "demo_data_removed": False,
        "vehicles": {
            "matched": 38,
            "newly_matched": 38,
            "with_part": 30,
            "top_makes": [{"make": "Ford", "calls": 18}, {"make": "Chevrolet", "calls": 12}],
            "untagged": 10,
        },
    }


@app.post("/api/calls/{call_id}/attach")
async def post_call_attach(call_id: str, file: UploadFile = File(...)) -> dict[str, Any]:
    return get_call_detail(call_id)


# Drill Calls (powers the full drill-down modal)
@app.get("/api/drill/calls")
def get_drill_calls(
    rep_id: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    date: Optional[str] = Query(None),
    month: Optional[str] = Query(None),
    hour: Optional[int] = Query(None),
    direction: Optional[str] = Query(None),
    topic: Optional[str] = Query(None),
    metric: Optional[str] = Query(None),
    outcome: Optional[str] = Query(None),
    winback_month: Optional[str] = Query(None),
    local_date: Optional[str] = Query(None),
    from_day: Optional[str] = Query(None),
    to_day: Optional[str] = Query(None),
    vehicle_make: Optional[str] = Query(None),
    vehicle_model: Optional[str] = Query(None),
    part: Optional[str] = Query(None),
    part_sold: Optional[str] = Query(None),
    price_missing: Optional[bool] = Query(None),
) -> dict[str, Any]:
    st = store.get_state()
    calls = st.get("calls", [])
    res = []

    for c in calls:
        if rep_id and c.get("rep_id") != rep_id:
            continue
        if category and c.get("category") != category:
            continue
        if direction and c.get("direction") != direction:
            continue
        if outcome:
            if outcome == "sales" and c.get("outcome") not in ("won", "lost"):
                continue
            elif outcome != "sales" and c.get("outcome") != outcome:
                continue
        if vehicle_make and (c.get("vehicle_make") or "").lower() != vehicle_make.lower():
            continue
        if vehicle_model and (c.get("vehicle_model") or "").lower() != vehicle_model.lower():
            continue
        if part and (c.get("part_requested") or "").lower() != part.lower():
            continue
        if part_sold and part_sold not in (c.get("parts_sold") or []):
            continue
        if price_missing and (c.get("outcome") != "won" or (c.get("order_value") or 0) > 0):
            continue

        c_date = (c.get("created_at") or "")[:10]
        if date and c_date != date:
            continue
        if local_date and c_date != local_date:
            continue
        if from_day and c_date < from_day:
            continue
        if to_day and c_date > to_day:
            continue
        if month and c_date[:7] != month:
            continue

        res.append(c)

    return {"total": len(res), "calls": res[:200]}


# Call cleanup
@app.get("/api/call-cleanup/batches")
def get_cleanup_batches() -> list[dict[str, Any]]:
    st = store.get_state()
    return st.get("cleanup_batches", [])


@app.delete("/api/call-cleanup/batches/{bid}")
def delete_cleanup_batch(bid: str) -> dict[str, Any]:
    return {"matched": 0, "deleted": 0}


@app.post("/api/call-cleanup/range")
def post_cleanup_range(body: dict[str, Any]) -> dict[str, Any]:
    return {"matched": 12, "deleted": 12 if not body.get("dry_run") else 0}


@app.get("/api/call-cleanup/trash")
def get_cleanup_trash() -> list[dict[str, Any]]:
    st = store.get_state()
    return st.get("cleanup_trash", [])


@app.post("/api/call-cleanup/trash/{tid}/restore")
def post_cleanup_restore(tid: str) -> dict[str, Any]:
    return {"restored": 10}


# Tagging & Delivery
@app.get("/api/tagging/queue")
def get_tagging_queue() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/tagging/queue", {"total": 0, "items": []})


@app.post("/api/tagging/{cid}/skip")
@app.post("/api/tagging/{cid}/delivery")
def post_tagging_action(cid: str) -> dict[str, Any]:
    st = store.get_state()
    queue = st["seed"].get("/tagging/queue", {"total": 0, "items": []})
    queue["items"] = [i for i in queue.get("items", []) if i.get("id") != cid]
    queue["total"] = len(queue["items"])
    return queue


@app.get("/api/tagging/leaderboard")
def get_tagging_leaderboard() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/tagging/leaderboard", {})


@app.get("/api/tagging/champion")
def get_tagging_champion() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/tagging/champion", {})


@app.get("/api/tagging/parts")
def get_tagging_parts() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/tagging/parts", {})


@app.get("/api/parts/catalog")
def get_parts_catalog() -> list[str]:
    st = store.get_state()
    return st["seed"].get("/parts/catalog", [])


@app.get("/api/delivery-stats")
def get_delivery_stats() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/delivery-stats", {})


# ==========================================
# Analytics, Customers, Vehicles, Watchlist
# ==========================================
@app.get("/api/analytics/overview")
def get_analytics_overview(
    rep_id: Optional[str] = Query(None),
    days: Optional[int] = Query(None),
    site_id: Optional[str] = Query(None),
) -> dict[str, Any]:
    st = store.get_state()
    base = dict(st["seed"].get("/analytics/overview", {}))

    # Calculate dynamic open callbacks count
    base["open_callbacks"] = len(st.get("callbacks_open", []))

    if rep_id:
        u = st["users_by_id"].get(rep_id)
        if u:
            base["rep"] = u
    return base


@app.get("/api/analytics/team-benchmark")
def get_team_benchmark() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/analytics/team-benchmark", {})


@app.get("/api/analytics/monthly")
def get_analytics_monthly() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/analytics/monthly", {})


@app.get("/api/analytics/monthly/reps")
def get_analytics_monthly_reps() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/analytics/monthly/reps", {})


@app.get("/api/analytics/parts-seasonal")
def get_parts_seasonal() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/analytics/parts-seasonal", {})


@app.get("/api/analytics/vehicles")
def get_vehicles(rank: str = Query("calls")) -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/analytics/vehicles?rank=calls", {})


@app.get("/api/analytics/lost-vehicles")
def get_lost_vehicles(rank: str = Query("calls")) -> list[dict[str, Any]]:
    st = store.get_state()
    return st["seed"].get("/analytics/lost-vehicles?rank=calls", [])


@app.get("/api/analytics/stock-alerts")
def get_stock_alerts(rank: str = Query("calls")) -> list[dict[str, Any]]:
    st = store.get_state()
    return st["seed"].get("/analytics/stock-alerts?rank=calls", [])


@app.get("/api/analytics/customers")
def get_analytics_customers(
    rep_id: Optional[str] = Query(None),
    tag: Optional[str] = Query(None),
    include_all: bool = Query(False),
) -> dict[str, Any]:
    st = store.get_state()
    if include_all:
        return st["seed"].get("/analytics/customers?include_all=true", st["seed"].get("/analytics/customers", {}))
    return st["seed"].get("/analytics/customers", {})


@app.get("/api/customers/{key}")
def get_customer_profile(key: str) -> dict[str, Any]:
    st = store.get_state()
    full_custs = st.get("full_customers", {})
    if key in full_custs:
        return full_custs[key]

    # Dynamically build profile from calls
    calls = [c for c in st.get("calls", []) if c.get("customer_name") == key or c.get("customer_phone") == key]
    stat = {
        "key": key,
        "name": key,
        "phone": calls[0].get("customer_phone", "") if calls else "",
        "calls": len(calls),
        "orders": sum(1 for c in calls if c.get("outcome") == "won"),
        "talk_sec": sum(int(c.get("duration_sec", 0)) for c in calls),
        "last_call_at": calls[0].get("created_at", store.now_iso()) if calls else store.now_iso(),
        "last_call_id": calls[0].get("id", "") if calls else "",
        "last_category": calls[0].get("category", "Part Inquiry/Quote") if calls else "Part Inquiry/Quote",
        "top_topics": ["Part Inquiry"],
        "rep_names": list({c.get("rep_name") for c in calls if c.get("rep_name")}),
        "tag": st.get("customer_tags", {}).get(key, ""),
        "tag_source": "manual" if key in st.get("customer_tags", {}) else "",
        "est_value": sum(float(c.get("order_value", 0)) for c in calls) or 350.0,
        "value_basis": "ai",
    }
    notes = st.get("customer_notes", {}).get(key, [])
    return {"stat": stat, "calls": calls[:20], "notes": notes}


@app.put("/api/customers/{key}/tag")
def put_customer_tag(key: str, body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    tag = body.get("tag") or ""
    st.setdefault("customer_tags", {})[key] = tag
    prof = get_customer_profile(key)
    prof["stat"]["tag"] = tag
    prof["stat"]["tag_source"] = "manual"
    store.save_state()
    return prof["stat"]


@app.post("/api/customers/bulk-tag")
def post_customers_bulk_tag(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    keys = body.get("keys", [])
    tag = body.get("tag") or ""
    for k in keys:
        st.setdefault("customer_tags", {})[k] = tag
    store.save_state()
    return {"updated": len(keys)}


@app.post("/api/customers/{key}/notes")
def post_customer_note(key: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    note = {
        "id": str(uuid.uuid4()),
        "customer_key": key,
        "text": body.get("text", ""),
        "author": u.get("name", "Rep"),
        "created_at": store.now_iso(),
    }
    st.setdefault("customer_notes", {}).setdefault(key, []).insert(0, note)
    store.save_state()
    return note


@app.post("/api/customers/{key}/winback")
def post_customer_winback(key: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    u = get_current_user(request)
    return {
        "id": str(uuid.uuid4()),
        "customer_key": key,
        "customer_name": key,
        "outcome": body.get("outcome", "reached"),
        "rep_id": u["id"],
        "rep_name": u["name"],
        "created_at": store.now_iso(),
        "confirmed": False,
        "confirmed_call_id": "",
        "confirmed_value": 0.0,
    }


# Winback
@app.get("/api/analytics/winback")
def get_analytics_winback() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/analytics/winback", {})


@app.get("/api/analytics/winback/leaderboard")
def get_winback_leaderboard() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/analytics/winback/leaderboard", {})


@app.get("/api/analytics/winback/trophies")
def get_winback_trophies() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/analytics/winback/trophies", {})


@app.get("/api/analytics/winback/winners")
def get_winback_winners() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/analytics/winback/winners", {})


# Watchlist
@app.get("/api/watchlist")
def get_watchlist() -> list[dict[str, Any]]:
    st = store.get_state()
    return st.get("watchlist", [])


@app.post("/api/watchlist")
def post_watchlist(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    item = {
        "id": str(uuid.uuid4()),
        "make": body.get("make", ""),
        "model": body.get("model", ""),
        "year_from": body.get("year_from"),
        "year_to": body.get("year_to"),
        "part": body.get("part", ""),
        "label": f"{body.get('year_from') or ''}–{body.get('year_to') or ''} {body.get('make', '')} {body.get('model', '')}".strip(),
        "calls_7d": 2,
        "calls_30d": 5,
        "prev_30d": 3,
        "orders_30d": 1,
        "lost_30d": 2,
        "top_parts": [body.get("part") or "Engine"],
    }
    st.setdefault("watchlist", []).insert(0, item)
    store.save_state()
    return item


@app.delete("/api/watchlist/{wid}")
def delete_watchlist(wid: str) -> dict[str, Any]:
    st = store.get_state()
    st["watchlist"] = [w for w in st.get("watchlist", []) if w.get("id") != wid]
    store.save_state()
    return {"ok": True}


@app.get("/api/watchlist/email")
def get_watchlist_email() -> dict[str, Any]:
    st = store.get_state()
    return st.get("watchlist_email", {})


@app.put("/api/watchlist/email")
def put_watchlist_email(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    st["watchlist_email"] = {**st.get("watchlist_email", {}), **body}
    store.save_state()
    return st["watchlist_email"]


# Keywords
@app.get("/api/keywords")
def get_keywords() -> list[dict[str, Any]]:
    st = store.get_state()
    return st.get("keywords", [])


@app.post("/api/keywords")
def post_keyword(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    kw = {
        "id": str(uuid.uuid4()),
        "keyword": body.get("keyword", ""),
        "group": body.get("group", "Custom"),
    }
    st.setdefault("keywords", []).append(kw)
    store.save_state()
    return kw


@app.put("/api/keywords/{kid}")
def put_keyword(kid: str, body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    for kw in st.get("keywords", []):
        if kw.get("id") == kid:
            kw["keyword"] = body.get("keyword", kw["keyword"])
            kw["group"] = body.get("group", kw["group"])
            store.save_state()
            return kw
    raise HTTPException(status_code=404, detail="Keyword not found")


@app.delete("/api/keywords/{kid}")
def delete_keyword(kid: str) -> dict[str, Any]:
    st = store.get_state()
    st["keywords"] = [k for k in st.get("keywords", []) if k.get("id") != kid]
    store.save_state()
    return {"ok": True}


@app.get("/api/keywords/alerts")
def get_keyword_alerts() -> list[dict[str, Any]]:
    st = store.get_state()
    return st["seed"].get("/keywords/alerts", [])


@app.get("/api/keywords/rep-usage")
def get_keyword_rep_usage() -> list[dict[str, Any]]:
    st = store.get_state()
    return st["seed"].get("/keywords/rep-usage", [])


@app.get("/api/keywords/suggestions")
def get_keyword_suggestions() -> list[dict[str, Any]]:
    st = store.get_state()
    return st.get("keyword_suggestions", [])


@app.post("/api/keywords/suggestions/dismiss")
@app.post("/api/keywords/suggestions/restore")
def post_keyword_suggestion_action() -> dict[str, Any]:
    return {"ok": True}


@app.get("/api/keywords/{kid}/calls")
def get_keyword_calls(kid: str, month: Optional[str] = Query(None)) -> list[dict[str, Any]]:
    st = store.get_state()
    return st.get("calls", [])[:15]


# Arrivals
@app.get("/api/arrivals")
def get_arrivals() -> list[dict[str, Any]]:
    st = store.get_state()
    return st.get("arrivals", [])


@app.post("/api/arrivals")
def post_arrival(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    aid = str(uuid.uuid4())
    year = int(body.get("vehicle_year") or 2018)
    make = body.get("vehicle_make", "")
    model = body.get("vehicle_model", "")

    # Match callers who asked for this vehicle
    matching_callers = []
    for c in st.get("calls", [])[:40]:
        if make.lower() in (c.get("vehicle_make") or "").lower():
            matching_callers.append({
                "key": c.get("customer_name", "Caller"),
                "customer_name": c.get("customer_name", "Caller"),
                "customer_phone": c.get("customer_phone", "+15551234567"),
                "vehicle": f"{year} {make} {model}".strip(),
                "parts": [c.get("part_requested") or "Part"],
                "exact_year": True,
                "last_asked": c.get("created_at", store.now_iso()),
                "times_asked": 1,
                "rep_id": c.get("rep_id", ""),
                "rep_name": c.get("rep_name", ""),
                "last_call_id": c.get("id", ""),
                "status": "to_call",
                "sold_price": None,
                "parts_sold": [],
                "updated_by": "",
                "texted_at": None,
                "text": "",
                "updated_at": None,
                "replied_at": None,
                "reply_call_id": "",
                "ordered_at": None,
                "sms_sid": "",
                "sms_status": "",
                "sms_error": "",
                "sms_reply": "",
                "sms_replied_at": None,
            })

    new_arr = {
        "id": aid,
        "vehicle_year": year,
        "vehicle_make": make,
        "vehicle_model": model,
        "note": body.get("note", ""),
        "stock_number": body.get("stock_number", f"STK-{uuid.uuid4().hex[:5].upper()}"),
        "year_span": body.get("year_span", 2),
        "cost": body.get("cost"),
        "callback_list_id": "",
        "created_by": u.get("name", "Manager"),
        "created_at": store.now_iso(),
        "callers": matching_callers[:8],
        "blasts": [],
        "results": {
            "callers": len(matching_callers[:8]),
            "contacted": 0,
            "texted": 0,
            "replied": 0,
            "sold": 0,
            "orders": 0,
            "first_sale_days": None,
            "revenue": 0.0,
            "revenue_estimated": False,
            "profit": None,
        },
    }
    st.setdefault("arrivals", []).insert(0, new_arr)
    store.save_state()
    return new_arr


@app.delete("/api/arrivals/{aid}")
def delete_arrival(aid: str) -> dict[str, Any]:
    st = store.get_state()
    st["arrivals"] = [a for a in st.get("arrivals", []) if a.get("id") != aid]
    store.save_state()
    return {"ok": True}


@app.patch("/api/arrivals/{aid}/cost")
def patch_arrival_cost(aid: str, body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    for a in st.get("arrivals", []):
        if a.get("id") == aid:
            a["cost"] = body.get("cost")
            store.save_state()
            return a
    raise HTTPException(status_code=404, detail="Arrival not found")


@app.patch("/api/arrivals/{aid}/callers/{key}")
def patch_arrival_caller(aid: str, key: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    for a in st.get("arrivals", []):
        if a.get("id") == aid:
            for c in a.get("callers", []):
                if c.get("key") == key:
                    c["status"] = body.get("status", c["status"])
                    if "sold_price" in body:
                        c["sold_price"] = body["sold_price"]
                    if "parts_sold" in body:
                        c["parts_sold"] = body["parts_sold"]
                    c["updated_by"] = u.get("name", "Rep")
                    c["updated_at"] = store.now_iso()
                    store.save_state()
                    return a
    raise HTTPException(status_code=404, detail="Arrival caller not found")


@app.post("/api/arrivals/{aid}/text")
def post_arrival_text(aid: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    for a in st.get("arrivals", []):
        if a.get("id") == aid:
            template = body.get("template", "")
            for c in a.get("callers", []):
                c["texted_at"] = store.now_iso()
                c["text"] = template
            a.setdefault("blasts", []).append({
                "at": store.now_iso(),
                "by": u.get("name", "Manager"),
                "template": template,
                "count": len(a.get("callers", [])),
                "mode": "practice",
                "failed": 0,
            })
            store.save_state()
            return a
    raise HTTPException(status_code=404, detail="Arrival not found")


@app.post("/api/arrivals/{aid}/callback-list")
def post_arrival_callback_list(aid: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    arrival = next((a for a in st.get("arrivals", []) if a.get("id") == aid), None)
    if not arrival:
        raise HTTPException(status_code=404, detail="Arrival not found")

    lid = str(uuid.uuid4())
    rep_id = body.get("rep_id") or u["id"]
    rep = st["users_by_id"].get(rep_id, u)

    name = body.get("name") or f"{arrival.get('vehicle_year')} {arrival.get('vehicle_make')} {arrival.get('vehicle_model')} callers"
    new_list = {
        "id": lid,
        "name": name,
        "rep_id": rep["id"],
        "rep_name": rep["name"],
        "created_by": u.get("name", "Manager"),
        "created_at": store.now_iso(),
        "open": len(arrival.get("callers", [])),
        "total": len(arrival.get("callers", [])),
        "done": 0,
        "sold": 0,
        "revenue": 0.0,
        "arrival_id": aid,
        "due_date": body.get("due_date") or "",
        "overdue": False,
    }
    st.setdefault("callback_lists", []).insert(0, new_list)
    arrival["callback_list_id"] = lid
    store.save_state()
    return new_list


@app.get("/api/arrivals/leaderboard")
def get_arrivals_leaderboard() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/arrivals/leaderboard", {})


@app.get("/api/arrivals/winner")
def get_arrivals_winner() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/arrivals/winner", {})


@app.get("/api/arrivals/streak-chase")
def get_arrivals_streak_chase() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/arrivals/streak-chase", {})


@app.get("/api/arrivals/streak-break")
def get_arrivals_streak_break() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/arrivals/streak-break", {})


# Callbacks & Callback Lists
@app.get("/api/callbacks")
def get_callbacks(
    status: str = Query("open"),
    source: str = Query(""),
) -> list[dict[str, Any]]:
    st = store.get_state()
    if status == "resolved":
        return st.get("callbacks_resolved", [])
    items = st.get("callbacks_open", [])
    if source:
        items = [i for i in items if i.get("assigned_list_id") == source]
    return items


@app.post("/api/callbacks/assign")
def post_callbacks_assign(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    cids = set(body.get("call_ids", []))
    rep_id = body.get("rep_id")
    rep = st["users_by_id"].get(rep_id, u)
    list_id = body.get("list_id", "")

    lists = st.get("callback_lists", [])
    target_list = next((l for l in lists if l.get("id") == list_id), None)
    list_name = target_list.get("name", "") if target_list else ""

    for c in st.get("calls", []):
        if c.get("id") in cids:
            item = dict(c)
            item["customer_phone"] = item.get("customer_phone") or "+15551234567"
            item["reason"] = body.get("note") or "Assigned by manager"
            item["followed_up"] = False
            item["followed_up_at"] = None
            item["assigned_list_id"] = list_id
            item["assigned_list_name"] = list_name
            item["assigned_by"] = u.get("name", "Manager")
            item["assigned_note"] = body.get("note", "")
            item["list_due_date"] = target_list.get("due_date", "") if target_list else ""
            item["list_overdue"] = False
            item["rep_id"] = rep["id"]
            item["rep_name"] = rep["name"]
            st.setdefault("callbacks_open", []).insert(0, item)

    if target_list:
        target_list["total"] += len(cids)
        target_list["open"] += len(cids)

    store.save_state()
    return {"assigned": len(cids)}


@app.get("/api/callback-lists")
def get_callback_lists() -> list[dict[str, Any]]:
    st = store.get_state()
    return st.get("callback_lists", [])


@app.post("/api/callback-lists")
def post_callback_lists(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    lid = str(uuid.uuid4())
    rep_id = body.get("rep_id") or u["id"]
    rep = st["users_by_id"].get(rep_id, u)

    new_list = {
        "id": lid,
        "name": body["name"],
        "rep_id": rep["id"],
        "rep_name": rep["name"],
        "created_by": u.get("name", "Manager"),
        "created_at": store.now_iso(),
        "open": 0,
        "total": 0,
        "done": 0,
        "sold": 0,
        "revenue": 0.0,
        "arrival_id": "",
        "due_date": body.get("due_date") or "",
        "overdue": False,
    }
    st.setdefault("callback_lists", []).insert(0, new_list)
    store.save_state()
    return new_list


@app.patch("/api/callback-lists/{lid}")
def patch_callback_list(lid: str, body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    for l in st.get("callback_lists", []):
        if l.get("id") == lid:
            l["due_date"] = body.get("due_date") or ""
            store.save_state()
            return l
    raise HTTPException(status_code=404, detail="Callback list not found")


@app.delete("/api/callback-lists/{lid}")
def delete_callback_list(lid: str) -> dict[str, Any]:
    st = store.get_state()
    st["callback_lists"] = [l for l in st.get("callback_lists", []) if l.get("id") != lid]
    st["callbacks_open"] = [c for c in st.get("callbacks_open", []) if c.get("assigned_list_id") != lid]
    store.save_state()
    return {"ok": True}


@app.get("/api/callback-lists/leaderboard")
def get_callback_lists_leaderboard() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/callback-lists/leaderboard", {})


@app.post("/api/callback-lists/overdue-alerts/send-now")
def post_callback_lists_overdue_alerts() -> dict[str, Any]:
    return {"lists": 0, "emails": 0, "texts": 0}


# Call Queue
@app.get("/api/queue")
def get_call_queue() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/queue", {"items": [], "counts": {}, "progress": None})


@app.get("/api/queue/team")
def get_team_queue() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/queue/team", {"after_noon": False, "reps": []})


# Leaderboards Hub
@app.get("/api/leaderboards/champions")
def get_leaderboards_champions() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/leaderboards/champions", {})


@app.get("/api/leaderboards/delivery")
def get_leaderboards_delivery() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/leaderboards/delivery", {})


@app.get("/api/leaderboards/team-player")
def get_leaderboards_team_player() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/leaderboards/team-player", {})


@app.post("/api/leaderboards/posters/send-now")
def post_leaderboards_posters_send_now() -> dict[str, Any]:
    return {
        "month": store.current_month_str(),
        "sent": 5,
        "champions": 3,
        "lot_sent": 1,
        "lots": 1,
    }


# Reports
@app.get("/api/reports/summary")
def get_reports_summary(
    date_from: str = Query("2026-01-01"),
    date_to: str = Query("2026-12-31"),
    site_id: Optional[str] = Query(None),
) -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/reports/summary?date_from=2026-01-01&date_to=2026-12-31", {})


# ==========================================
# Roleplay Trainer
# ==========================================
@app.get("/api/roleplay/scenarios")
def get_roleplay_scenarios() -> list[dict[str, Any]]:
    st = store.get_state()
    return st.get("roleplay_scenarios", [])


@app.post("/api/roleplay/scenarios")
def post_roleplay_scenario(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    sc_id = str(uuid.uuid4())
    sc = {
        "id": sc_id,
        "title": body["title"],
        "difficulty": body.get("difficulty", "Medium"),
        "persona": body.get("persona", "Budget-conscious body shop manager"),
        "objective": body.get("objective", "Pitch warranty and close order"),
        "opening_hint": body.get("opening_hint", "Start with friendly vehicle discovery"),
        "custom": True,
        "price_objection": bool(body.get("price_objection", False)),
        "customer_brief": body.get("customer_brief", ""),
    }
    st.setdefault("roleplay_scenarios", []).insert(0, sc)
    store.save_state()
    return sc


@app.put("/api/roleplay/scenarios/{sc_id}")
def put_roleplay_scenario(sc_id: str, body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    for sc in st.get("roleplay_scenarios", []):
        if sc.get("id") == sc_id:
            sc.update(body)
            store.save_state()
            return sc
    raise HTTPException(status_code=404, detail="Scenario not found")


@app.delete("/api/roleplay/scenarios/{sc_id}")
def delete_roleplay_scenario(sc_id: str) -> dict[str, Any]:
    st = store.get_state()
    st["roleplay_scenarios"] = [s for s in st.get("roleplay_scenarios", []) if s.get("id") != sc_id]
    store.save_state()
    return {"ok": True}


@app.post("/api/roleplay/scenarios/draft")
def post_roleplay_scenario_draft(body: dict[str, Any]) -> dict[str, Any]:
    idea = body.get("idea", "price negotiation")
    return {
        "title": f"Negotiating on {idea.capitalize()}",
        "difficulty": "Medium",
        "persona": f"Customer inquiring about {idea} who wants a fast deal and reassurance.",
        "objective": "Build trust, confirm interchange accuracy, address pricing politely, and secure the deposit.",
        "opening_hint": "Ask for the VIN or Hollander part number right after the greeting.",
        "customer_brief": "You're checking prices with two other yards, but prefer getting it delivered tomorrow if the price is fair.",
        "price_objection": "price" in idea.lower() or "cost" in idea.lower(),
    }


@app.get("/api/roleplay/sessions")
def get_roleplay_sessions() -> list[dict[str, Any]]:
    st = store.get_state()
    return st.get("roleplay_sessions", [])


@app.post("/api/roleplay/sessions")
def post_roleplay_session(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    sc_id = body.get("scenario_id")
    sc = next((s for s in st.get("roleplay_scenarios", []) if s.get("id") == sc_id), None)
    sc_title = sc.get("title", "Practice Scenario") if sc else "Practice Scenario"

    sess_id = str(uuid.uuid4())
    opener = (
        f"Hi, I'm looking for a clean OEM transmission for a 2018 Ford F-150. Can you tell me what you have in stock and what it's going to run me?"
        if not sc or not sc.get("customer_brief")
        else f"Hello, I'm calling about {sc['title'].lower()}. Do you have anything available right now?"
    )
    new_sess = {
        "id": sess_id,
        "user_id": u["id"],
        "user_name": u["name"],
        "scenario_id": sc_id or "",
        "scenario_title": sc_title,
        "messages": [
            {"role": "customer", "text": opener}
        ],
        "status": "active",
        "grade": None,
        "created_at": store.now_iso(),
    }
    st.setdefault("roleplay_sessions", []).insert(0, new_sess)
    store.save_state()
    return new_sess


@app.get("/api/roleplay/sessions/{sess_id}")
def get_roleplay_session_detail(sess_id: str) -> dict[str, Any]:
    st = store.get_state()
    s = next((x for x in st.get("roleplay_sessions", []) if x.get("id") == sess_id), None)
    if not s:
        raise HTTPException(status_code=404, detail="Session not found")
    return s


@app.post("/api/roleplay/sessions/{sess_id}/message")
async def post_roleplay_message(sess_id: str, body: dict[str, Any]) -> StreamingResponse:
    st = store.get_state()
    sess = next((x for x in st.get("roleplay_sessions", []) if x.get("id") == sess_id), None)
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")

    rep_text = body.get("text", "")
    sess.setdefault("messages", []).append({"role": "rep", "text": rep_text})

    # Generate customer reply
    ai_reply = (
        "That sounds fair. Does that include the torque converter, and what's your standard warranty coverage on it if my mechanic installs it this week?"
    )

    async def event_generator():
        # Stream delta chunks in SSE format: data: {"delta": "..."}\n\n
        words = ai_reply.split(" ")
        accumulated = []
        for i, word in enumerate(words):
            chunk = word if i == 0 else " " + word
            accumulated.append(chunk)
            yield f"data: {json.dumps({'delta': chunk})}\n\n"
            await asyncio.sleep(0.04)

        sess["messages"].append({"role": "customer", "text": ai_reply})
        store.save_state()

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.post("/api/roleplay/sessions/{sess_id}/grade")
def post_roleplay_grade(sess_id: str) -> dict[str, Any]:
    st = store.get_state()
    sess = next((x for x in st.get("roleplay_sessions", []) if x.get("id") == sess_id), None)
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")

    grade = {
        "metrics": {
            "greeting": 88,
            "needs_discovery": 84,
            "product_knowledge": 80,
            "upsell_crosssell": 76,
            "objection_handling": 82,
            "closing": 85,
            "compliance_warranty": 78,
            "tone_empathy": 90,
        },
        "overall_score": 83,
        "summary": "Great objection handling and active listening. Remember to pitch the 1-year extended parts and labor warranty earlier in the call.",
        "strengths": [
            "Confident vehicle and fitment confirmation",
            "Polite and professional closing technique",
        ],
        "improvements": [
            "Proactively mention companion gaskets/fluids before asking for payment",
        ],
        "coaching_feedback": "Strong run. With this scenario, emphasize our testing process and guaranteed fitment right off the bat.",
    }
    sess["status"] = "graded"
    sess["grade"] = grade
    store.save_state()
    return sess


@app.get("/api/roleplay/scoreboard")
def get_roleplay_scoreboard() -> dict[str, Any]:
    st = store.get_state()
    return st.get("roleplay_scoreboard", {"scenarios": [], "rows": []})


@app.get("/api/roleplay/assignments")
def get_roleplay_assignments() -> list[dict[str, Any]]:
    st = store.get_state()
    return st.get("roleplay_assignments", [])


@app.post("/api/roleplay/assignments")
def post_roleplay_assignments(body: dict[str, Any], request: Request) -> list[dict[str, Any]]:
    st = store.get_state()
    u = get_current_user(request)
    sc_id = body["scenario_id"]
    sc = next((s for s in st.get("roleplay_scenarios", []) if s.get("id") == sc_id), None)
    sc_title = sc.get("title", "Scenario") if sc else "Scenario"

    created = []
    for rid in body.get("rep_ids", []):
        ruser = st["users_by_id"].get(rid, {})
        asgn = {
            "id": str(uuid.uuid4()),
            "scenario_id": sc_id,
            "scenario_title": sc_title,
            "rep_id": rid,
            "rep_name": ruser.get("name", "Rep"),
            "due_date": body.get("due_date", store.today_str()),
            "pass_score": body.get("pass_score", 80),
            "assigned_by": u.get("name", "Manager"),
            "created_at": store.now_iso(),
            "best_score": None,
            "attempts": 0,
            "status": "open",
            "completed_at": None,
        }
        st.setdefault("roleplay_assignments", []).append(asgn)
        created.append(asgn)

    store.save_state()
    return created


@app.delete("/api/roleplay/assignments/{aid}")
def delete_roleplay_assignment(aid: str) -> dict[str, Any]:
    st = store.get_state()
    st["roleplay_assignments"] = [a for a in st.get("roleplay_assignments", []) if a.get("id") != aid]
    store.save_state()
    return {"ok": True}


# ==========================================
# Time Off & Cover Requests
# ==========================================
@app.get("/api/time-off")
def get_time_off(month: Optional[str] = Query(None)) -> list[dict[str, Any]]:
    st = store.get_state()
    return st.get("time_off", [])


@app.post("/api/time-off")
def post_time_off(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    tid = str(uuid.uuid4())
    rep = st["users_by_id"].get(body.get("rep_id", ""), u)
    cover = st["users_by_id"].get(body.get("cover_rep_id", ""), {})

    entry = {
        "id": tid,
        "rep_id": rep["id"],
        "rep_name": rep["name"],
        "start": body.get("start", store.today_str()),
        "end": body.get("end", store.today_str()),
        "cover_rep_id": cover.get("id", ""),
        "cover_rep_name": cover.get("name", ""),
        "note": body.get("note", ""),
        "created_by": u.get("name", "Manager"),
        "handed_off": False,
        "moved": 0,
        "gap_days": [],
    }
    st.setdefault("time_off", []).append(entry)
    store.save_state()
    return entry


@app.delete("/api/time-off/{tid}")
def delete_time_off(tid: str) -> dict[str, Any]:
    st = store.get_state()
    st["time_off"] = [t for t in st.get("time_off", []) if t.get("id") != tid]
    store.save_state()
    return {"ok": True}


@app.post("/api/time-off/{tid}/briefing-preview")
def post_time_off_briefing_preview(tid: str) -> dict[str, Any]:
    return {"ok": True}


@app.get("/api/time-off/away")
def get_time_off_away() -> list[dict[str, Any]]:
    st = store.get_state()
    return st.get("time_off_away", [])


@app.get("/api/time-off/gaps")
def get_time_off_gaps(month: Optional[str] = Query(None)) -> list[dict[str, Any]]:
    return []


@app.get("/api/cover-requests")
def get_cover_requests() -> list[dict[str, Any]]:
    st = store.get_state()
    return st.get("cover_requests", [])


@app.post("/api/cover-requests")
def post_cover_request(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    cid = str(uuid.uuid4())
    to_u = st["users_by_id"].get(body.get("to_rep_id", ""), {})

    cr = {
        "id": cid,
        "from_rep_id": u["id"],
        "from_rep_name": u["name"],
        "to_rep_id": to_u.get("id", ""),
        "to_rep_name": to_u.get("name", "Teammate"),
        "start": body.get("start", store.today_str()),
        "end": body.get("end", body.get("start", store.today_str())),
        "note": body.get("note", ""),
        "status": "pending",
        "approved_by": "",
        "block_reason": "",
        "time_off_id": "",
        "texted": False,
        "created_at": store.now_iso(),
    }
    st.setdefault("cover_requests", []).insert(0, cr)
    store.save_state()
    return cr


@app.delete("/api/cover-requests/{cid}")
def delete_cover_request(cid: str) -> dict[str, Any]:
    st = store.get_state()
    st["cover_requests"] = [r for r in st.get("cover_requests", []) if r.get("id") != cid]
    store.save_state()
    return {"ok": True}


@app.post("/api/cover-requests/{cid}/accept")
def post_cover_request_accept(cid: str) -> dict[str, Any]:
    st = store.get_state()
    for r in st.get("cover_requests", []):
        if r.get("id") == cid:
            r["status"] = "accepted"
            store.save_state()
            return r
    raise HTTPException(status_code=404, detail="Cover request not found")


@app.post("/api/cover-requests/{cid}/decline")
def post_cover_request_decline(cid: str) -> dict[str, Any]:
    st = store.get_state()
    for r in st.get("cover_requests", []):
        if r.get("id") == cid:
            r["status"] = "declined"
            store.save_state()
            return r
    raise HTTPException(status_code=404, detail="Cover request not found")


@app.post("/api/cover-requests/{cid}/approve")
def post_cover_request_approve(cid: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    for r in st.get("cover_requests", []):
        if r.get("id") == cid:
            r["status"] = "approved"
            r["approved_by"] = u.get("name", "Manager")
            store.save_state()
            return r
    raise HTTPException(status_code=404, detail="Cover request not found")


@app.post("/api/cover-requests/{cid}/block")
def post_cover_request_block(cid: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    for r in st.get("cover_requests", []):
        if r.get("id") == cid:
            r["status"] = "blocked"
            r["block_reason"] = body.get("reason", "Scheduling conflict")
            r["approved_by"] = u.get("name", "Manager")
            store.save_state()
            return r
    raise HTTPException(status_code=404, detail="Cover request not found")


# ==========================================
# Billing, Connectors, Contact Support
# ==========================================
@app.get("/api/billing/plans")
def get_billing_plans() -> list[dict[str, Any]]:
    st = store.get_state()
    return st["seed"].get("/billing/plans", [])


@app.get("/api/billing/compare")
def get_billing_compare() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/billing/compare", {})


@app.post("/api/billing/checkout")
def post_billing_checkout(body: dict[str, Any]) -> dict[str, Any]:
    return {
        "checkout_url": body.get("origin_url", "/billing") + "?success=true",
        "session_id": "cs_" + uuid.uuid4().hex,
    }


@app.post("/api/billing/enterprise-preview")
@app.post("/api/billing/start-paid")
@app.post("/api/billing/switch-yearly")
def post_billing_tier_action() -> dict[str, Any]:
    st = store.get_state()
    return st["org"]


@app.post("/api/billing/extra-logins")
def post_billing_extra_logins(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    packs = int(body.get("packs") or 0)
    st["org"]["extra_rep_packs"] = packs
    st["org"]["max_reps"] = (st["org"]["max_reps"] or 5) + (packs * 5)
    store.save_state()
    return st["org"]


@app.post("/api/billing/extra-sites")
def post_billing_extra_sites(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    extra = int(body.get("extra_sites") or 0)
    st["org"]["extra_sites"] = extra
    st["org"]["max_sites"] = 4 + extra
    store.save_state()
    return {
        "extra_sites": extra,
        "max_sites": 4 + extra,
        "monthly_cost": extra * 100.0,
    }


@app.post("/api/billing/upgrade-enterprise")
def post_billing_upgrade_enterprise() -> dict[str, Any]:
    st = store.get_state()
    st["org"]["plan"] = "enterprise"
    store.save_state()
    return {"upgraded": True, "checkout_url": ""}


@app.get("/api/payments/status/{sid}")
def get_payment_status(sid: str) -> dict[str, Any]:
    return {"session_id": sid, "status": "complete", "payment_status": "paid"}


@app.get("/api/connect/status")
def get_connect_status() -> dict[str, Any]:
    st = store.get_state()
    return st.get("connect_status", {})


@app.get("/api/connect/ringcentral/start")
def get_connect_ringcentral_start() -> dict[str, Any]:
    return {"authorize_url": "https://platform.devtest.ringcentral.com/restapi/oauth/authorize?response_type=code"}


@app.post("/api/connect/ringcentral/sync")
def post_connect_ringcentral_sync() -> dict[str, Any]:
    return {"imported": 0, "updated": 0, "skipped": 0}


@app.delete("/api/connect/ringcentral")
def delete_connect_ringcentral() -> dict[str, Any]:
    st = store.get_state()
    st.setdefault("connect_status", {}).setdefault("ringcentral", {})["connected"] = False
    store.save_state()
    return st["connect_status"]


@app.post("/api/connect/webhook/rotate")
def post_connect_webhook_rotate() -> dict[str, Any]:
    st = store.get_state()
    st.setdefault("connect_status", {})["webhook_url"] = f"https://salvagepulse.com/api/connect/webhook/{uuid.uuid4().hex}"
    store.save_state()
    return st["connect_status"]


@app.get("/api/sms/status")
def get_sms_status() -> dict[str, Any]:
    st = store.get_state()
    return st.get("sms_status", {})


@app.get("/api/contact/mine")
def get_contact_mine() -> list[dict[str, Any]]:
    st = store.get_state()
    return st.get("contact_messages", [])


@app.post("/api/contact")
def post_contact(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    cid = str(uuid.uuid4())
    msg = {
        "id": cid,
        "kind": body.get("kind", "support"),
        "subject": body.get("subject", "Inquiry"),
        "message": body.get("message", ""),
        "user_name": u.get("name", "User"),
        "user_email": u.get("email", ""),
        "role": u.get("role", "manager"),
        "org_id": u.get("org_id", ""),
        "org_name": st.get("org", {}).get("name", "Salvage Pulse Pro"),
        "page": body.get("page", "/"),
        "status": "new",
        "created_at": store.now_iso(),
        "resolved_by": "",
        "resolved_at": None,
        "replies": [],
        "reply_unread": False,
    }
    st.setdefault("contact_messages", []).insert(0, msg)
    store.save_state()
    return {"ok": True, "id": cid}


@app.post("/api/contact/mine/seen")
def post_contact_mine_seen() -> dict[str, Any]:
    return {"ok": True, "id": ""}


# ==========================================
# Admin Console Endpoints
# ==========================================
@app.get("/api/admin/orgs")
def admin_get_orgs() -> list[dict[str, Any]]:
    st = store.get_state()
    return st.get("admin_orgs", [])


@app.post("/api/admin/orgs")
def admin_post_org(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    oid = str(uuid.uuid4())
    org = {
        "id": oid,
        "name": body["yard_name"],
        "plan": body.get("plan", "pro"),
        "status": body.get("status", "trialing"),
        "trial_ends_at": dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=14),
        "created_at": store.now_iso(),
        "users": 1,
        "calls": 0,
        "ringcentral_connected": False,
        "card_on_file": False,
        "blocked": False,
        "cancel_reason": "",
        "discount": body.get("discount"),
        "sites": 0,
        "max_sites": 2,
        "extra_sites": 0,
    }
    st.setdefault("admin_orgs", []).insert(0, org)
    store.save_state()
    return {"org": org, "payment_link": f"/checkout/{oid}"}


@app.patch("/api/admin/orgs/{oid}")
def admin_patch_org(oid: str, body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    for o in st.get("admin_orgs", []):
        if o.get("id") == oid:
            o.update(body)
            store.save_state()
            return o
    raise HTTPException(status_code=404, detail="Org not found")


@app.post("/api/admin/orgs/{oid}/extend")
def admin_post_org_extend(oid: str, body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    for o in st.get("admin_orgs", []):
        if o.get("id") == oid:
            days = int(body.get("days") or 7)
            o["trial_ends_at"] = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=days)).isoformat()
            store.save_state()
            return o
    raise HTTPException(status_code=404, detail="Org not found")


@app.post("/api/admin/orgs/{oid}/cancel")
def admin_post_org_cancel(oid: str, body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    for o in st.get("admin_orgs", []):
        if o.get("id") == oid:
            o["status"] = "canceled"
            o["cancel_reason"] = body.get("reason", "Cancelled by admin")
            o["blocked"] = bool(body.get("block", False))
            store.save_state()
            return o
    raise HTTPException(status_code=404, detail="Org not found")


@app.post("/api/admin/orgs/{oid}/payment-link")
def admin_post_org_payment_link(oid: str) -> dict[str, Any]:
    return {"payment_link": f"/checkout/{oid}"}


@app.put("/api/admin/orgs/{oid}/discount")
def admin_put_org_discount(oid: str, body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    for o in st.get("admin_orgs", []):
        if o.get("id") == oid:
            o["discount"] = {
                "percent": body.get("percent", 20),
                "months": body.get("months", 3),
                "ends_at": None,
                "applied": False,
                "price": 299.0,
                "discounted_price": 239.2,
                "set_by": "Admin",
                "set_at": store.now_iso(),
                "reason": body.get("reason", "Discount"),
            }
            store.save_state()
            return {
                "org": o,
                "message": f"{body.get('percent')}% discount applied for {body.get('months')} months",
                "payment_link": f"/checkout/{oid}?discount=true",
            }
    raise HTTPException(status_code=404, detail="Org not found")


@app.delete("/api/admin/orgs/{oid}/discount")
def admin_delete_org_discount(oid: str) -> dict[str, Any]:
    st = store.get_state()
    for o in st.get("admin_orgs", []):
        if o.get("id") == oid:
            o["discount"] = None
            store.save_state()
            return {"org": o, "message": "Discount removed", "payment_link": ""}
    raise HTTPException(status_code=404, detail="Org not found")


@app.post("/api/admin/orgs/{oid}/discount-link")
def admin_post_org_discount_link(oid: str) -> dict[str, Any]:
    st = store.get_state()
    org = next((o for o in st.get("admin_orgs", []) if o.get("id") == oid), {})
    return {"org": org, "message": "Link generated", "payment_link": f"/checkout/{oid}?discount=true"}


@app.get("/api/admin/discounts/summary")
def admin_get_discounts_summary() -> dict[str, Any]:
    return {
        "months": [
            {"month": "2026-10", "cost": 0.0, "yards": 0, "projected": False},
        ],
        "yards": [],
        "this_month": 0.0,
    }


@app.get("/api/admin/users")
def admin_get_users(org_id: Optional[str] = Query(None), q: Optional[str] = Query(None)) -> list[dict[str, Any]]:
    st = store.get_state()
    out = []
    for u in st["users_by_id"].values():
        if org_id and u.get("org_id") != org_id:
            continue
        if q:
            term = q.lower()
            if term not in u.get("name", "").lower() and term not in u.get("email", "").lower():
                continue
        out.append({
            "id": u["id"],
            "email": u["email"],
            "name": u["name"],
            "role": u.get("role", "rep"),
            "title": u.get("title", ""),
            "org_id": u.get("org_id", ""),
            "org_name": st.get("org", {}).get("name", "Salvage Pulse Pro"),
            "disabled": u.get("disabled", False),
        })
    return out


@app.patch("/api/admin/users/{uid}")
def admin_patch_user(uid: str, body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    u = st["users_by_id"].get(uid)
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    u.update(body)
    store.save_state()
    return {
        "id": u["id"],
        "email": u["email"],
        "name": u["name"],
        "role": u.get("role", "rep"),
        "title": u.get("title", ""),
        "org_id": u.get("org_id", ""),
        "org_name": st.get("org", {}).get("name", "Salvage Pulse Pro"),
        "disabled": u.get("disabled", False),
    }


@app.post("/api/admin/impersonate/{uid}")
def admin_impersonate(uid: str, response: Response, request: Request) -> dict[str, Any]:
    st = store.get_state()
    target_user = st["users_by_id"].get(uid)
    if not target_user:
        raise HTTPException(status_code=404, detail="User not found")
    actor = get_current_user(request)
    target_user["impersonated_by"] = actor.get("name", "Admin")
    set_session_cookie(response, uid)
    return target_user


@app.get("/api/admin/audit")
def admin_get_audit() -> list[dict[str, Any]]:
    st = store.get_state()
    return st.get("admin_audit", [])


@app.get("/api/admin/demo-login")
def admin_get_demo_login() -> dict[str, Any]:
    st = store.get_state()
    return st.get("demo_login_switch", {"enabled": True, "changed_by": "", "changed_at": None})


@app.put("/api/admin/demo-login")
def admin_put_demo_login(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    sw = {
        "enabled": bool(body.get("enabled", True)),
        "changed_by": u.get("name", "Admin"),
        "changed_at": store.now_iso(),
    }
    st["demo_login_switch"] = sw
    store.save_state()
    return sw


@app.get("/api/admin/free-day")
def admin_get_free_day() -> dict[str, Any]:
    return {
        "started": 14,
        "on_free_day": 3,
        "added_card": 11,
        "added_during_day": 9,
        "no_card": 0,
        "conversion_rate": 78.6,
        "started_30d": 14,
        "added_card_30d": 11,
        "median_hours_to_card": 6.5,
        "recent": [],
        "alerts": [],
    }


@app.get("/api/admin/funnel")
def admin_get_funnel() -> dict[str, Any]:
    return {
        "months": [
            {"month": "2026-10", "signups": 12, "cards_added": 9, "paid": 8, "canceled": 0},
            {"month": "2026-09", "signups": 15, "cards_added": 12, "paid": 11, "canceled": 1},
        ],
        "totals": {"month": "All-time", "signups": 27, "cards_added": 21, "paid": 19, "canceled": 1},
        "trialing_now": 3,
    }


@app.get("/api/admin/trial-reminders")
def admin_get_trial_reminders() -> dict[str, Any]:
    st = store.get_state()
    return st.get("trial_reminders", {"enabled": True, "upcoming": []})


@app.put("/api/admin/trial-reminders")
def admin_put_trial_reminders(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    cur = st.get("trial_reminders", {})
    cur["enabled"] = bool(body.get("enabled", True))
    st["trial_reminders"] = cur
    store.save_state()
    return cur


@app.get("/api/admin/trial-reminders/preview")
def admin_get_trial_reminders_preview(kind: str = Query("day4")) -> dict[str, Any]:
    return {
        "subject": "Your Salvage Pulse trial — how calls are tracking so far",
        "html": "<p>Hi Linda,<br>Here is a summary of your yard's call scoring progress...</p>",
    }


@app.get("/api/admin/staff")
def admin_get_staff() -> list[dict[str, Any]]:
    st = store.get_state()
    return st.get("admin_staff", [])


@app.post("/api/admin/staff")
def admin_post_staff(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    sid = str(uuid.uuid4())
    account = {
        "id": sid,
        "email": body["email"],
        "name": body["name"],
        "role": body.get("role", "admin"),
        "disabled": False,
        "must_change_password": True,
        "created_at": store.now_iso(),
        "you": False,
        "google_linked": False,
        "email_bounced_at": None,
        "email_bounce_reason": "",
    }
    st.setdefault("admin_staff", []).append(account)
    store.save_state()
    return {"account": account, "emailed": True}


@app.patch("/api/admin/staff/{sid}")
def admin_patch_staff(sid: str, body: dict[str, Any]) -> list[dict[str, Any]]:
    st = store.get_state()
    for s in st.get("admin_staff", []):
        if s.get("id") == sid:
            s.update(body)
    store.save_state()
    return st.get("admin_staff", [])


@app.post("/api/admin/staff/{sid}/reset-password")
def admin_post_staff_reset_password(sid: str) -> dict[str, Any]:
    st = store.get_state()
    s = next((x for x in st.get("admin_staff", []) if x.get("id") == sid), {})
    return {"account": s, "emailed": True}


@app.post("/api/admin/staff/{user}/sign-out-everywhere")
def admin_post_staff_sign_out(user: str) -> dict[str, Any]:
    return {"ended": 3, "you": False}


@app.get("/api/admin/staff-devices")
def admin_get_staff_devices() -> list[dict[str, Any]]:
    return [
        {
            "user_id": "master-ben-keech",
            "name": "Ben Keech",
            "email": "benkeech800@gmail.com",
            "role": "master",
            "sessions": 1,
            "devices": [
                {
                    "id": "dev-1",
                    "browser": "Chrome on macOS",
                    "ip": "127.0.0.1",
                    "first_seen": "2026-10-01T12:00:00Z",
                    "last_seen": store.now_iso(),
                    "this_browser": True,
                    "nickname": "Work Mac",
                }
            ],
        }
    ]


@app.delete("/api/admin/staff-devices/{user}/{device}")
def admin_delete_staff_device(user: str, device: str) -> list[dict[str, Any]]:
    return admin_get_staff_devices()


@app.get("/api/admin/staff-lockdown")
def admin_get_staff_lockdown() -> dict[str, Any]:
    st = store.get_state()
    return st.get("staff_lockdown", {
        "enabled": False,
        "you_signed_in_with_google": True,
        "staff_domain": "salvagepulse.com",
        "google_linked": 1,
        "staff_total": 1,
    })


@app.put("/api/admin/staff-lockdown")
def admin_put_staff_lockdown(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    cur = st.get("staff_lockdown", {})
    cur["enabled"] = bool(body.get("enabled", False))
    st["staff_lockdown"] = cur
    store.save_state()
    return cur


@app.get("/api/admin/messages")
def admin_get_messages(kind: Optional[str] = Query(None)) -> list[dict[str, Any]]:
    st = store.get_state()
    msgs = st.get("contact_messages", [])
    if kind:
        msgs = [m for m in msgs if m.get("kind") == kind]
    return msgs


@app.patch("/api/admin/messages/{mid}")
def admin_patch_message(mid: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    for m in st.get("contact_messages", []):
        if m.get("id") == mid:
            m["status"] = body.get("status", "resolved")
            if m["status"] == "resolved":
                m["resolved_by"] = u.get("name", "Admin")
                m["resolved_at"] = store.now_iso()
            store.save_state()
            return m
    raise HTTPException(status_code=404, detail="Message not found")


@app.post("/api/admin/messages/{mid}/reply")
def admin_post_message_reply(mid: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    for m in st.get("contact_messages", []):
        if m.get("id") == mid:
            reply = {
                "by": u.get("name", "Admin"),
                "text": body.get("text", ""),
                "at": store.now_iso(),
            }
            m.setdefault("replies", []).append(reply)
            m["reply_unread"] = True
            if body.get("resolve"):
                m["status"] = "resolved"
                m["resolved_by"] = u.get("name", "Admin")
                m["resolved_at"] = store.now_iso()
            store.save_state()
            return m
    raise HTTPException(status_code=404, detail="Message not found")


# ==========================================
# Static Files & SPA Fallback (Production)
# ==========================================
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
FRONTEND_DIST = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend", "dist")

dist_dir = None
if os.path.exists(STATIC_DIR) and os.path.exists(os.path.join(STATIC_DIR, "index.html")):
    dist_dir = STATIC_DIR
elif os.path.exists(FRONTEND_DIST) and os.path.exists(os.path.join(FRONTEND_DIST, "index.html")):
    dist_dir = FRONTEND_DIST

if dist_dir:
    from fastapi.staticfiles import StaticFiles
    from fastapi.responses import FileResponse

    assets_dir = os.path.join(dist_dir, "assets")
    if os.path.exists(assets_dir):
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        if full_path.startswith("api"):
            raise HTTPException(status_code=404, detail="API endpoint not found")
        direct = os.path.join(dist_dir, full_path)
        if os.path.isfile(direct):
            return FileResponse(direct)
        index_file = os.path.join(dist_dir, "index.html")
        if os.path.isfile(index_file):
            return FileResponse(index_file)
        raise HTTPException(status_code=404, detail="Not found")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)

