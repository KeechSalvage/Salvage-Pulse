from __future__ import annotations

import datetime as dt
import os
import secrets
import uuid
from typing import Any, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel
from auth_utils import current_session_key, get_current_user, invalidate_user_sessions, set_session_cookie
import store
import email_service
from security import app_public_url, can_manage_user, public_user, require_staff, validate_email, validate_password

router = APIRouter(tags=["admin"], dependencies=[Depends(require_staff)])

YARD_ROLES = frozenset({"owner", "sales_manager", "inventory_manager", "rep", "sales_rep"})
STAFF_ROLES = frozenset({"master", "admin"})
ORG_PLANS = frozenset({"starter", "pro", "enterprise", "trial", "demo"})
ORG_STATUSES = frozenset({"trialing", "active", "demo", "past_due", "canceled", "incomplete"})


def _require_master(user: dict[str, Any]) -> None:
    if user.get("role") != "master":
        raise HTTPException(status_code=403, detail="Master admin only")


def _clean_org_id(st: dict[str, Any], org_id: str) -> str:
    if org_id and not any(o.get("id") == org_id for o in st.get("admin_orgs", [])):
        raise HTTPException(status_code=404, detail="Yard organization not found")
    return org_id



# ==========================================
# Admin Console Endpoints
# ==========================================
@router.get("/api/admin/orgs")
def admin_get_orgs() -> list[dict[str, Any]]:
    st = store.get_state()
    orgs = st.get("admin_orgs", [])
    calls = st.get("calls", [])
    users = st.get("users_by_id", {})

    # Compute real live counts and attached user list so Yards table has rich details
    for o in orgs:
        oid = o.get("id")
        if oid:
            o["calls"] = sum(1 for c in calls if c.get("org_id") == oid)
            attached_users = [
                {
                    "id": u.get("id"),
                    "name": u.get("name"),
                    "email": u.get("email"),
                    "role": u.get("role"),
                    "title": u.get("title") or "Sales Rep",
                    "disabled": bool(u.get("disabled")),
                }
                for u in users.values()
                if u.get("org_id") == oid
            ]
            o["users"] = len([u for u in attached_users if not u["disabled"]])
            o["user_list"] = attached_users

            # If billing contact isn't set, default to the yard owner or first manager
            if not o.get("billing_contact_name"):
                owner = next((u for u in attached_users if u.get("role") in ("owner", "manager", "sales_manager")), None)
                if owner:
                    o["billing_contact_name"] = owner.get("name")
                    o["billing_email"] = o.get("billing_email") or owner.get("email")
            if not o.get("phone"):
                o["phone"] = "(512) 555-0199"
        elif not o.get("calls"):
            o["calls"] = len(calls)
            o["user_list"] = []
    return orgs


@router.post("/api/admin/orgs")
def admin_post_org(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    actor = get_current_user(request)
    yard_name = str(body.get("yard_name") or "").strip()[:120]
    if not yard_name:
        raise HTTPException(status_code=400, detail="Enter the yard name")
    plan = str(body.get("plan") or "pro")
    if plan not in ORG_PLANS:
        raise HTTPException(status_code=400, detail="Invalid plan")
    status = str(body.get("status") or "trialing")
    if status not in ORG_STATUSES:
        raise HTTPException(status_code=400, detail="Invalid status")
    role = str(body.get("role") or "owner")
    if role not in YARD_ROLES:
        raise HTTPException(status_code=400, detail="Invalid yard role")
    email = validate_email(body.get("email")) if body.get("email") else ""
    if email and any((u.get("email") or "").strip().lower() == email for u in st.get("users_by_id", {}).values()):
        raise HTTPException(status_code=409, detail="A user with that email already exists")

    oid = str(uuid.uuid4())
    org = {
        "id": oid,
        "name": yard_name,
        "plan": plan,
        "status": status,
        "trial_ends_at": (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=14)).isoformat(),
        "created_at": store.now_iso(),
        "users": 1 if email else 0,
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
    if email:
        uid = f"user-{uuid.uuid4().hex[:8]}"
        temp_pw = secrets.token_urlsafe(12)
        st.setdefault("users_by_id", {})[uid] = {
            "id": uid,
            "email": email,
            "name": str(body.get("manager_name") or "Owner")[:120],
            "role": role,
            "title": str(body.get("title") or "Yard Owner")[:120],
            "avatar_url": "",
            "org_id": oid,
                "disabled": False,
            "site_id": "",
            "must_change_password": True,
            "password_hash": store.hash_password(temp_pw),
        }
        email_service.send_staff_welcome_email(
            to_email=email,
            name=st["users_by_id"][uid]["name"],
            temp_password=temp_pw,
            role=st["users_by_id"][uid]["title"],
            app_url=_get_app_url(request),
        )
    else:
        temp_pw = ""
    st.setdefault("admin_orgs", []).insert(0, org)
    st.setdefault("branding_by_org", {})[oid] = {
        "yard_name": yard_name,
        "accent": "",
        "default_mode": "dark",
        "logo_url": "",
        "user_mode": "dark",
        "mode": "dark",
    }
    st.setdefault("admin_audit", []).insert(0, {
        "at": store.now_iso(),
        "actor": actor.get("name", "Admin"),
        "action": f"created yard with plan {org['plan']}",
        "target": org["name"],
    })
    store.save_state()
    result = {"org": org, "payment_link": f"/checkout/{oid}"}
    if temp_pw:
        result["temporary_password"] = temp_pw
    return result


@router.patch("/api/admin/orgs/{oid}")
def admin_patch_org(oid: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    actor = get_current_user(request)
    for o in st.get("admin_orgs", []):
        if o.get("id") == oid:
            was_blocked = bool(o.get("blocked", False))
            was_canceled = o.get("status") == "canceled"
            was_disabled = was_blocked or was_canceled

            updates = {
                k: v for k, v in body.items()
                if k in {
                    "name", "yard_name", "plan", "status", "blocked", "cancel_reason",
                    "billing_contact_name", "billing_email", "phone", "discount",
                    "max_sites", "extra_sites", "card_on_file", "notes",
                }
            }
            if "plan" in updates and updates["plan"] not in ORG_PLANS:
                raise HTTPException(status_code=400, detail="Invalid plan")
            if "status" in updates and updates["status"] not in ORG_STATUSES:
                raise HTTPException(status_code=400, detail="Invalid status")
            if "name" in updates:
                updates["name"] = str(updates["name"] or "").strip()[:120]
                if not updates["name"]:
                    raise HTTPException(status_code=400, detail="Yard name cannot be empty")
            if "billing_email" in updates and updates["billing_email"]:
                updates["billing_email"] = validate_email(updates["billing_email"])

            was_status = o.get("status")
            o.update(updates)

            new_status = o.get("status")
            # If status becomes past_due, record when it went past due if not already recorded
            if new_status == "past_due":
                if not o.get("past_due_since"):
                    o["past_due_since"] = store.now_iso()
            elif was_status == "past_due" and new_status != "past_due":
                o.pop("past_due_since", None)

            # If a yard moves out of trial state into an active/demo/subscribed/past_due state,
            # clear trial_ends_at and ensure full access by clearing blocking flags.
            if was_status == "trialing" and new_status in ("active", "demo", "incomplete", "past_due"):
                o["trial_ends_at"] = None
                if new_status in ("active", "demo", "past_due"):
                    o["blocked"] = False
                    o["cancel_reason"] = ""
            elif "status" in body and body["status"] != "trialing":
                # Clear trial_ends_at whenever status is explicitly set to non-trialing
                o["trial_ends_at"] = None

            now_blocked = bool(o.get("blocked", False))
            now_canceled = o.get("status") == "canceled"
            now_disabled = now_blocked or now_canceled

            # Yard is being disabled (blocked or status canceled)
            if now_disabled and not was_disabled:
                affected = 0
                for u in st.get("users_by_id", {}).values():
                    if u.get("org_id") == oid and u.get("role") != "master":
                        if not u.get("disabled"):
                            u["disabled"] = True
                            u["disabled_by_yard"] = True
                            affected += 1
                st.setdefault("admin_audit", []).insert(0, {
                    "at": store.now_iso(),
                    "actor": actor.get("name", "Admin"),
                    "action": f"disabled yard and {affected} associated user(s)",
                    "target": o.get("name", oid),
                })

            # Yard is being reopened or unblocked
            elif (was_disabled and not now_disabled) or (was_blocked and body.get("blocked") is False):
                if o.get("status") == "canceled" and "status" not in body:
                    o["status"] = "active"
                reopened = 0
                for u in st.get("users_by_id", {}).values():
                    if u.get("org_id") == oid and u.get("role") != "master":
                        if u.get("disabled_by_yard") or u.get("disabled"):
                            u["disabled"] = False
                            u.pop("disabled_by_yard", None)
                            reopened += 1
                st.setdefault("admin_audit", []).insert(0, {
                    "at": store.now_iso(),
                    "actor": actor.get("name", "Admin"),
                    "action": f"reopened yard and re-enabled {reopened} associated user(s)",
                    "target": o.get("name", oid),
                })

            store.save_state()
            return o
    raise HTTPException(status_code=404, detail="Org not found")


@router.post("/api/admin/orgs/{oid}/extend")
def admin_post_org_extend(oid: str, body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    for o in st.get("admin_orgs", []):
        if o.get("id") == oid:
            days = int(body.get("days") or 7)
            o["trial_ends_at"] = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=days)).isoformat()
            store.save_state()
            return o
    raise HTTPException(status_code=404, detail="Org not found")


@router.post("/api/admin/orgs/{oid}/cancel")
def admin_post_org_cancel(oid: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    actor = get_current_user(request)
    for o in st.get("admin_orgs", []):
        if o.get("id") == oid:
            o["status"] = "canceled"
            reason = body.get("reason", "Cancelled by admin")
            o["cancel_reason"] = reason
            o["blocked"] = bool(body.get("block", True))

            affected = 0
            for u in st.get("users_by_id", {}).values():
                if u.get("org_id") == oid and u.get("role") != "master":
                    if not u.get("disabled"):
                        u["disabled"] = True
                        u["disabled_by_yard"] = True
                        affected += 1

            st.setdefault("admin_audit", []).insert(0, {
                "at": store.now_iso(),
                "actor": actor.get("name", "Admin"),
                "action": f"canceled yard and disabled {affected} associated user(s): {reason}",
                "target": o.get("name", oid),
            })
            store.save_state()
            return o
    raise HTTPException(status_code=404, detail="Org not found")


@router.post("/api/admin/orgs/{oid}/payment-link")
def admin_post_org_payment_link(oid: str) -> dict[str, Any]:
    return {"payment_link": f"/checkout/{oid}"}


@router.put("/api/admin/orgs/{oid}/discount")
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


@router.delete("/api/admin/orgs/{oid}/discount")
def admin_delete_org_discount(oid: str) -> dict[str, Any]:
    st = store.get_state()
    for o in st.get("admin_orgs", []):
        if o.get("id") == oid:
            o["discount"] = None
            store.save_state()
            return {"org": o, "message": "Discount removed", "payment_link": ""}
    raise HTTPException(status_code=404, detail="Org not found")


@router.post("/api/admin/orgs/{oid}/discount-link")
def admin_post_org_discount_link(oid: str) -> dict[str, Any]:
    st = store.get_state()
    org = next((o for o in st.get("admin_orgs", []) if o.get("id") == oid), {})
    return {"org": org, "message": "Link generated", "payment_link": f"/checkout/{oid}?discount=true"}


@router.get("/api/admin/discounts/summary")
def admin_get_discounts_summary() -> dict[str, Any]:
    return {
        "months": [
            {"month": "2026-10", "cost": 0.0, "yards": 0, "projected": False},
        ],
        "yards": [],
        "this_month": 0.0,
    }


class AdminCreateUserReq(BaseModel):
    org_id: str
    name: str
    email: str
    role: str = "rep"
    title: Optional[str] = None
    password: Optional[str] = None


@router.post("/api/admin/users")
def admin_create_user(req: AdminCreateUserReq, request: Request) -> dict[str, Any]:
    st = store.get_state()
    actor = get_current_user(request)

    if req.role not in YARD_ROLES:
        raise HTTPException(status_code=400, detail="Invalid yard role")

    org = next((o for o in st.get("admin_orgs", []) if o.get("id") == req.org_id), None)
    if not org:
        raise HTTPException(status_code=404, detail="Yard organization not found")

    email_clean = validate_email(req.email)
    existing = next((u for u in st.get("users_by_id", {}).values() if (u.get("email") or "").strip().lower() == email_clean), None)
    if existing:
        raise HTTPException(status_code=409, detail=f"User with email '{email_clean}' already exists")

    name = str(req.name or "").strip()[:120]
    if not name:
        raise HTTPException(status_code=400, detail="Enter the user's name")

    uid = f"user-{uuid.uuid4().hex[:12]}"
    if req.password and req.password.strip():
        temp_pw = validate_password(req.password.strip())
        must_change = False
    else:
        temp_pw = secrets.token_urlsafe(12)
        must_change = True

    role_title_map = {
        "owner": "Yard Owner",
        "sales_manager": "Sales Manager",
        "inventory_manager": "Inventory Manager",
        "rep": "Sales Representative",
        "sales_rep": "Sales Representative",
    }
    user_title = str(req.title or "").strip()[:120] or role_title_map.get(req.role, "Sales Representative")

    new_user = {
        "id": uid,
        "email": email_clean,
        "name": name,
        "role": req.role,
        "title": user_title,
        "avatar_url": "",
        "org_id": req.org_id,
        "disabled": False,
        "site_id": "",
        "must_change_password": must_change,
        "password_hash": store.hash_password(temp_pw),
    }

    st.setdefault("users_by_id", {})[uid] = new_user
    if isinstance(org.get("users"), int):
        org["users"] += 1

    st.setdefault("admin_audit", []).insert(0, {
        "at": store.now_iso(),
        "actor": actor.get("name", "Admin"),
        "action": f"added user {new_user['email']} ({new_user['role']}) to {org.get('name')}",
        "target": org.get("name", req.org_id),
    })

    # Send welcome email with credentials
    app_url = _get_app_url(request)
    emailed = email_service.send_staff_welcome_email(
        to_email=email_clean,
        name=new_user["name"],
        temp_password=temp_pw,
        role=user_title,
        app_url=app_url,
    )

    store.save_state()
    return {
        "id": new_user["id"],
        "email": new_user["email"],
        "name": new_user["name"],
        "role": new_user["role"],
        "title": new_user["title"],
        "org_id": new_user["org_id"],
        "org_name": org.get("name", "Yard"),
        "disabled": False,
        "temp_password": temp_pw,
        "emailed": emailed,
    }


@router.get("/api/admin/users")
def admin_get_users(
    org_id: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    include_staff: bool = Query(False),
) -> list[dict[str, Any]]:
    st = store.get_state()
    out = []
    org_map = {o["id"]: o.get("name", "Yard") for o in st.get("admin_orgs", [])}
    default_org_name = st.get("org", {}).get("name", "Salvage Pulse")

    for u in st["users_by_id"].values():
        is_staff = u.get("role") in ("master", "admin")
        if not include_staff and is_staff:
            continue
        u_org_id = u.get("org_id", "")
        if org_id and u_org_id != org_id:
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
            "org_id": u_org_id,
            "org_name": org_map.get(u_org_id, "Platform") if not u_org_id else org_map.get(u_org_id, default_org_name),
            "disabled": u.get("disabled", False),
        })
    return out


class AdminPasswordReq(BaseModel):
    password: str
    must_change_password: bool = False


@router.post("/api/admin/users/{uid}/password")
def admin_set_user_password(uid: str, req: AdminPasswordReq, request: Request) -> dict[str, Any]:
    st = store.get_state()
    actor = get_current_user(request)
    u = st["users_by_id"].get(uid)
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    if not can_manage_user(actor, u):
        raise HTTPException(status_code=403, detail="You cannot manage that account")

    password = validate_password(req.password)
    u["password_hash"] = store.hash_password(password)
    u["must_change_password"] = req.must_change_password
    invalidate_user_sessions(st, uid, keep=current_session_key(request) if uid == actor.get("id") else None)
    st.setdefault("admin_audit", []).insert(0, {
        "at": store.now_iso(),
        "actor": actor.get("name", "Admin"),
        "action": f"manually updated password for user {u.get('email')}",
        "target": u.get("name", uid),
    })
    store.save_state()
    return {"ok": True, "message": f"Password for {u['name']} updated successfully"}


@router.patch("/api/admin/users/{uid}")
def admin_patch_user(uid: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    actor = get_current_user(request)
    u = st["users_by_id"].get(uid)
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    if not can_manage_user(actor, u):
        raise HTTPException(status_code=403, detail="You cannot manage that account")

    changed_sensitive = False
    if "password" in body and body["password"]:
        pw = validate_password(str(body.pop("password")))
        u["password_hash"] = store.hash_password(pw)
        u["must_change_password"] = False
        changed_sensitive = True
        st.setdefault("admin_audit", []).insert(0, {
            "at": store.now_iso(),
            "actor": actor.get("name", "Admin"),
            "action": f"reset password for user {u.get('email')}",
            "target": u.get("name", uid),
        })

    allowed = {"name", "email", "role", "title", "org_id", "disabled", "site_id"}
    updates = {k: v for k, v in body.items() if k in allowed}
    if "email" in updates:
        email = validate_email(updates["email"])
        if any(
            other.get("id") != uid and (other.get("email") or "").strip().lower() == email
            for other in st["users_by_id"].values()
        ):
            raise HTTPException(status_code=409, detail="A user with that email already exists")
        updates["email"] = email
    if "role" in updates:
        new_role = str(updates["role"])
        if new_role not in YARD_ROLES | STAFF_ROLES:
            raise HTTPException(status_code=400, detail="Invalid role")
        if new_role in STAFF_ROLES and actor.get("role") != "master":
            raise HTTPException(status_code=403, detail="Only a master admin can grant staff roles")
        if u.get("role") == "master" and new_role != "master":
            remaining = [
                other for other in st["users_by_id"].values()
                if other.get("role") == "master" and not other.get("disabled") and other.get("id") != uid
            ]
            if not remaining:
                raise HTTPException(status_code=400, detail="Can't demote the last master account")
        if new_role != u.get("role"):
            changed_sensitive = True
    if "org_id" in updates:
        updates["org_id"] = _clean_org_id(st, str(updates["org_id"] or ""))
    if "name" in updates:
        updates["name"] = str(updates["name"] or "").strip()[:120]
        if not updates["name"]:
            raise HTTPException(status_code=400, detail="Name cannot be empty")
    if "disabled" in updates and bool(updates["disabled"]):
        if uid == actor.get("id"):
            raise HTTPException(status_code=400, detail="You cannot disable your own account")
        if u.get("role") == "master":
            remaining = [
                other for other in st["users_by_id"].values()
                if other.get("role") == "master" and not other.get("disabled") and other.get("id") != uid
            ]
            if not remaining:
                raise HTTPException(status_code=400, detail="Can't disable the last master account")
        changed_sensitive = True

    u.update(updates)
    if changed_sensitive:
        invalidate_user_sessions(st, uid, keep=current_session_key(request) if uid == actor.get("id") else None)
    store.save_state()
    org_map = {o["id"]: o.get("name", "Yard") for o in st.get("admin_orgs", [])}
    return {
        "id": u["id"],
        "email": u["email"],
        "name": u["name"],
        "role": u.get("role", "rep"),
        "title": u.get("title", ""),
        "org_id": u.get("org_id", ""),
        "org_name": org_map.get(u.get("org_id", ""), "Platform") if not u.get("org_id") else org_map.get(u.get("org_id", ""), "Yard"),
        "disabled": u.get("disabled", False),
    }


@router.delete("/api/admin/users/{uid}")
def admin_delete_user(uid: str, request: Request) -> dict[str, Any]:
    """Delete a login. Masters may delete staff and yard users; admins may delete yard users only.

    Only the account (login + sessions) is removed. Calls, sales and other records keep their
    rep_id / rep_name, and a tombstone is archived in `deleted_users` so history stays attributable.
    """
    st = store.get_state()
    actor = get_current_user(request)
    actor_role = actor.get("role")
    if actor_role not in ("master", "admin"):
        raise HTTPException(status_code=403, detail="Platform staff only")

    target = st.get("users_by_id", {}).get(uid)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if uid == actor.get("id"):
        raise HTTPException(status_code=400, detail="You can't delete your own account")

    target_is_staff = target.get("role") in ("master", "admin")
    if target_is_staff:
        if actor_role != "master":
            raise HTTPException(status_code=403, detail="Only master accounts can delete staff")
        remaining_masters = [
            u for u in st["users_by_id"].values()
            if u.get("role") == "master" and not u.get("disabled") and u.get("id") != uid
        ]
        if target.get("role") == "master" and not remaining_masters:
            raise HTTPException(status_code=400, detail="Can't delete the last master account")

    st.setdefault("deleted_users", {})[uid] = {
        "id": uid,
        "name": target.get("name", ""),
        "email": target.get("email", ""),
        "role": target.get("role", ""),
        "org_id": target.get("org_id", ""),
        "deleted_at": store.now_iso(),
        "deleted_by": actor.get("name", "Admin"),
    }
    del st["users_by_id"][uid]
    invalidate_user_sessions(st, uid)
    st["admin_staff"] = [s for s in st.get("admin_staff", []) if s.get("id") != uid]
    if st.get("current_user_id") == uid:
        st["current_user_id"] = None

    org_id = target.get("org_id")
    if org_id and not target_is_staff:
        for o in st.get("admin_orgs", []):
            if o.get("id") == org_id and isinstance(o.get("users"), int):
                o["users"] = max(0, o["users"] - 1)

    st.setdefault("admin_audit", []).insert(0, {
        "at": store.now_iso(),
        "actor": actor.get("name", "Admin"),
        "action": f"deleted {'staff' if target_is_staff else 'yard'} user {target.get('email')} (history kept)",
        "target": target.get("name", uid),
    })
    store.save_state()
    return {"ok": True, "message": f"{target.get('name', 'User')} deleted; their calls and sales were kept"}


@router.post("/api/admin/impersonate/{uid}")
def admin_impersonate(uid: str, response: Response, request: Request) -> dict[str, Any]:
    st = store.get_state()
    target_user = st["users_by_id"].get(uid)
    if not target_user:
        raise HTTPException(status_code=404, detail="User not found")
    if target_user.get("disabled"):
        raise HTTPException(status_code=400, detail="Cannot impersonate a disabled user")
    actor = get_current_user(request)
    if not can_manage_user(actor, target_user):
        raise HTTPException(status_code=403, detail="You cannot impersonate that account")
    actor_name = actor.get("name", "Admin")
    set_session_cookie(
        response,
        uid,
        request,
        impersonator_id=actor.get("id", ""),
        impersonated_by=actor_name,
    )
    return {**public_user(target_user), "impersonated_by": actor_name, "impersonator_id": actor.get("id", "")}


@router.get("/api/admin/audit")
def admin_get_audit() -> list[dict[str, Any]]:
    st = store.get_state()
    return st.get("admin_audit", [])


@router.get("/api/admin/demo-login")
def admin_get_demo_login() -> dict[str, Any]:
    st = store.get_state()
    return st.get("demo_login_switch", {"enabled": True, "changed_by": "", "changed_at": None})


@router.put("/api/admin/demo-login")
def admin_put_demo_login(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    _require_master(u)
    sw = {
        "enabled": bool(body.get("enabled", True)),
        "changed_by": u.get("name", "Admin"),
        "changed_at": store.now_iso(),
    }
    st["demo_login_switch"] = sw
    store.save_state()
    return sw


@router.get("/api/admin/free-day")
def admin_get_free_day() -> dict[str, Any]:
    st = store.get_state()
    orgs = st.get("admin_orgs", [])
    trialing = [o for o in orgs if o.get("status") == "trialing"]
    active = [o for o in orgs if o.get("status") in ("active", "demo")]
    total = len(orgs)
    with_card = sum(1 for o in orgs if o.get("card_on_file"))
    conv_rate = round((len(active) / total * 100), 1) if total else 0.0

    recent = []
    for o in orgs:
        outcome = "added_card" if o.get("card_on_file") or o.get("status") in ("active", "demo") else ("on_free_day" if o.get("status") == "trialing" else "no_card")
        recent.append({
            "org_id": o.get("id", ""),
            "name": o.get("name", "Yard"),
            "started_at": o.get("created_at") or store.now_iso(),
            "outcome": outcome,
            "card_added_at": o.get("created_at") if (o.get("card_on_file") or o.get("status") in ("active", "demo")) else None,
        })

    return {
        "started": total,
        "on_free_day": len(trialing),
        "added_card": with_card,
        "added_during_day": with_card,
        "no_card": total - with_card,
        "conversion_rate": conv_rate,
        "started_30d": total,
        "added_card_30d": with_card,
        "median_hours_to_card": 0.0 if with_card else None,
        "recent": recent,
        "alerts": [],
    }


@router.get("/api/admin/funnel")
def admin_get_funnel() -> dict[str, Any]:
    st = store.get_state()
    orgs = st.get("admin_orgs", [])
    total_signups = len(orgs)
    cards_added = sum(1 for o in orgs if o.get("card_on_file"))
    paid = sum(1 for o in orgs if o.get("status") in ("active", "demo"))
    canceled = sum(1 for o in orgs if o.get("status") == "canceled")
    trialing = sum(1 for o in orgs if o.get("status") == "trialing")
    month_str = store.current_month_str()

    return {
        "months": [
            {
                "month": month_str,
                "signups": total_signups,
                "cards_added": cards_added,
                "paid": paid,
                "canceled": canceled,
            }
        ],
        "totals": {
            "month": "All-time",
            "signups": total_signups,
            "cards_added": cards_added,
            "paid": paid,
            "canceled": canceled,
        },
        "trialing_now": trialing,
    }


@router.get("/api/admin/trial-reminders")
def admin_get_trial_reminders() -> dict[str, Any]:
    st = store.get_state()
    return st.get("trial_reminders", {"enabled": True, "upcoming": []})


@router.put("/api/admin/trial-reminders")
def admin_put_trial_reminders(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    cur = st.get("trial_reminders", {})
    cur["enabled"] = bool(body.get("enabled", True))
    st["trial_reminders"] = cur
    store.save_state()
    return cur


@router.get("/api/admin/trial-reminders/preview")
def admin_get_trial_reminders_preview(kind: str = Query("day4")) -> dict[str, Any]:
    return {
        "subject": "Your Salvage Pulse trial — how calls are tracking so far",
        "html": "<p>Hi Linda,<br>Here is a summary of your yard's call scoring progress...</p>",
    }


@router.get("/api/admin/staff")
def admin_get_staff(request: Request) -> list[dict[str, Any]]:
    st = store.get_state()
    current_u = get_current_user(request)
    current_uid = current_u.get("id") if current_u else None
    out = []
    # Onboarding status lives on the login record; mirror it so the list is always current.
    for s in st.get("admin_staff", []):
        item = dict(s)
        item.pop("password_hash", None)
        item.pop("password", None)
        u = st.get("users_by_id", {}).get(item.get("id"))
        if u:
            item["google_linked"] = bool(u.get("google_linked") or item.get("google_linked"))
            item["must_change_password"] = bool(u.get("must_change_password"))
        item["you"] = bool(current_uid and item.get("id") == current_uid)
        out.append(item)
    return out


def _get_app_url(request: Request) -> str:
    return app_public_url(request)


@router.post("/api/admin/staff")
def admin_post_staff(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    actor = get_current_user(request)
    role = str(body.get("role") or "admin")
    if role not in STAFF_ROLES:
        raise HTTPException(status_code=400, detail="Invalid staff role")
    if actor.get("role") != "master":
        raise HTTPException(status_code=403, detail="Only a master admin can add staff")

    email = validate_email(body.get("email") or "")
    if any((u.get("email") or "").strip().lower() == email for u in st.get("users_by_id", {}).values()):
        raise HTTPException(status_code=409, detail="A user with that email already exists")
    name = str(body.get("name") or "Staff Member").strip()[:120]
    if not name:
        raise HTTPException(status_code=400, detail="Enter the staff member's name")

    sid = str(uuid.uuid4())
    temp_pw = secrets.token_urlsafe(12)

    account = {
        "id": sid,
        "email": email,
        "name": name,
        "role": role,
        "disabled": False,
        "must_change_password": True,
        "created_at": store.now_iso(),
        "you": False,
        "google_linked": False,
        "email_bounced_at": None,
        "email_bounce_reason": "",
    }
    st.setdefault("admin_staff", []).append(account)
    st.setdefault("users_by_id", {})[sid] = {
        "id": sid,
        "email": email,
        "name": name,
        "role": role,
        "title": "Platform Staff",
        "avatar_url": "",
        "org_id": "",
        "disabled": False,
        "site_id": "",
        "must_change_password": True,
        "password_hash": store.hash_password(temp_pw),
    }
    store.save_state()
    app_url = _get_app_url(request)
    emailed = email_service.send_staff_welcome_email(
        to_email=email,
        name=name,
        temp_password=temp_pw,
        role="Master Admin" if role == "master" else "Admin",
        app_url=app_url,
    )
    return {"account": account, "emailed": emailed, "temp_password": temp_pw}


@router.patch("/api/admin/staff/{sid}")
def admin_patch_staff(sid: str, body: dict[str, Any], request: Request) -> list[dict[str, Any]]:
    st = store.get_state()
    actor = get_current_user(request)
    target = st.get("users_by_id", {}).get(sid)
    if not target:
        raise HTTPException(status_code=404, detail="Staff member not found")
    if not can_manage_user(actor, target):
        raise HTTPException(status_code=403, detail="Only a master admin can manage staff")

    updates = {k: v for k, v in body.items() if k in {"name", "role", "disabled"}}
    if "role" in updates:
        role = str(updates["role"])
        if role not in STAFF_ROLES:
            raise HTTPException(status_code=400, detail="Invalid staff role")
        # A platform admin must never be able to promote themselves (or anyone
        # else) to master; only an existing master may change staff roles.
        if actor.get("role") != "master":
            raise HTTPException(status_code=403, detail="Only a master admin can change staff roles")
        if target.get("role") == "master" and role != "master":
            remaining = [
                other for other in st["users_by_id"].values()
                if other.get("role") == "master" and not other.get("disabled") and other.get("id") != sid
            ]
            if not remaining:
                raise HTTPException(status_code=400, detail="Can't demote the last master account")
    if "name" in updates:
        updates["name"] = str(updates["name"] or "").strip()[:120]
        if not updates["name"]:
            raise HTTPException(status_code=400, detail="Name cannot be empty")
    if updates.get("disabled"):
        if sid == actor.get("id"):
            raise HTTPException(status_code=400, detail="You cannot disable your own account")
        if target.get("role") == "master":
            remaining = [
                other for other in st["users_by_id"].values()
                if other.get("role") == "master" and not other.get("disabled") and other.get("id") != sid
            ]
            if not remaining:
                raise HTTPException(status_code=400, detail="Can't disable the last master account")

    for s in st.get("admin_staff", []):
        if s.get("id") == sid:
            s.update(updates)
    target.update(updates)
    if {"role", "disabled"} & set(updates):
        invalidate_user_sessions(st, sid, keep=current_session_key(request) if sid == actor.get("id") else None)
    store.save_state()
    return st.get("admin_staff", [])


@router.post("/api/admin/staff/{sid}/reset-password")
def admin_post_staff_reset_password(sid: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    actor = get_current_user(request)
    s = next((x for x in st.get("admin_staff", []) if x.get("id") == sid), {})
    target = st.get("users_by_id", {}).get(sid)
    if not target:
        raise HTTPException(status_code=404, detail="Staff member not found")
    if not can_manage_user(actor, target):
        raise HTTPException(status_code=403, detail="Only a master admin can reset staff passwords")
    temp_pw = secrets.token_urlsafe(12)
    target["password_hash"] = store.hash_password(temp_pw)
    target["must_change_password"] = True
    invalidate_user_sessions(st, sid, keep=current_session_key(request) if sid == actor.get("id") else None)
    store.save_state()
    app_url = _get_app_url(request)
    emailed = False
    if s.get("email"):
        emailed = email_service.send_password_reset_email(
            to_email=s["email"],
            name=s.get("name", "Staff Member"),
            temp_password=temp_pw,
            app_url=app_url,
        )
    return {"account": s, "emailed": emailed, "temp_password": temp_pw}


def _drop_sessions(st: dict[str, Any], tokens: list[str]) -> None:
    for t in tokens:
        st.get("sessions", {}).pop(t, None)
        st.get("session_meta", {}).pop(t, None)


@router.post("/api/admin/staff/{user}/sign-out-everywhere")
def admin_post_staff_sign_out(user: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    actor = get_current_user(request)
    target = st.get("users_by_id", {}).get(user)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if not can_manage_user(actor, target):
        raise HTTPException(status_code=403, detail="You cannot manage that account")
    mine = current_session_key(request)
    ended = invalidate_user_sessions(st, user, keep=mine if user == actor.get("id") else None)
    store.save_state()
    return {"ended": ended, "you": bool(mine and user == actor.get("id"))}


@router.get("/api/admin/staff-devices")
def admin_get_staff_devices(request: Request) -> list[dict[str, Any]]:
    st = store.get_state()
    mine = current_session_key(request)
    sessions = st.get("sessions", {})
    meta = st.get("session_meta", {})
    out = []
    for u in st.get("users_by_id", {}).values():
        if u.get("role") not in ("master", "admin") or u.get("disabled"):
            continue
        devices: dict[str, dict[str, Any]] = {}
        live = 0
        for token, m in meta.items():
            if m.get("user_id") != u["id"] or token not in sessions:
                continue
            live += 1
            d = devices.setdefault(m["device_id"], {
                "id": m["device_id"],
                "browser": m.get("browser", "Browser"),
                "ip": m.get("ip", ""),
                "first_seen": m.get("first_seen"),
                "last_seen": m.get("last_seen"),
                "this_browser": False,
                "nickname": "",
            })
            d["first_seen"] = min(d["first_seen"] or m["first_seen"], m["first_seen"])
            d["last_seen"] = max(d["last_seen"] or m["last_seen"], m["last_seen"])
            if token == mine:
                d["this_browser"] = True
        out.append({
            "user_id": u["id"],
            "name": u.get("name", ""),
            "email": u.get("email", ""),
            "role": u.get("role", ""),
            "sessions": live,
            "devices": sorted(devices.values(), key=lambda d: d["last_seen"] or "", reverse=True),
        })
    return sorted(out, key=lambda x: (x["role"] != "master", x["name"]))


@router.delete("/api/admin/staff-devices/{user}/{device}")
def admin_delete_staff_device(user: str, device: str, request: Request) -> list[dict[str, Any]]:
    st = store.get_state()
    actor = get_current_user(request)
    target = st.get("users_by_id", {}).get(user)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if not can_manage_user(actor, target):
        raise HTTPException(status_code=403, detail="You cannot manage that account")
    tokens = [
        t for t, m in st.get("session_meta", {}).items()
        if m.get("user_id") == user and m.get("device_id") == device
    ]
    _drop_sessions(st, tokens)
    store.save_state()
    return admin_get_staff_devices(request)


@router.get("/api/admin/staff-lockdown")
def admin_get_staff_lockdown(request: Request) -> dict[str, Any]:
    st = store.get_state()
    current_u = get_current_user(request)
    lockdown = dict(st.get("staff_lockdown", {
        "enabled": False,
        "you_signed_in_with_google": True,
        "staff_domain": "salvagepulse.com",
        "google_linked": 1,
        "staff_total": 1,
    }))
    if current_u:
        lockdown["you_signed_in_with_google"] = bool(current_u.get("google_linked"))
    return lockdown


@router.put("/api/admin/staff-lockdown")
def admin_put_staff_lockdown(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    _require_master(u)
    cur = st.get("staff_lockdown", {})
    cur["enabled"] = bool(body.get("enabled", False))
    st["staff_lockdown"] = cur
    store.save_state()
    return cur


@router.get("/api/admin/messages")
def admin_get_messages(kind: Optional[str] = Query(None)) -> list[dict[str, Any]]:
    st = store.get_state()
    msgs = st.get("contact_messages", [])
    if kind:
        msgs = [m for m in msgs if m.get("kind") == kind]
    return msgs


@router.patch("/api/admin/messages/{mid}")
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


@router.post("/api/admin/messages/{mid}/reply")
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
            if m.get("user_email") and reply["text"]:
                email_service.send_support_reply_email(
                    m["user_email"], m.get("user_name", ""), m.get("subject", "your request"),
                    reply["text"], reply["by"],
                )
            if body.get("resolve"):
                m["status"] = "resolved"
                m["resolved_by"] = u.get("name", "Admin")
                m["resolved_at"] = store.now_iso()
            store.save_state()
            return m
    raise HTTPException(status_code=404, detail="Message not found")
