from __future__ import annotations

import threading
import uuid
from typing import Any
from urllib.parse import urlparse
from fastapi import APIRouter, Depends, HTTPException, Request
from auth_utils import get_current_user
import store
import email_service
from security import effective_org, is_manager, require_authenticated, require_manager

# Public pricing data (used by the marketing/signup pages).
public_router = APIRouter(tags=["billing"])

# Everything that touches an account or a yard is authenticated.
router = APIRouter(tags=["billing"], dependencies=[Depends(require_authenticated)])


def _require_manager(user: dict[str, Any]) -> None:
    if not is_manager(user):
        raise HTTPException(status_code=403, detail="Manager access required")


def _billing_org(st: dict[str, Any], user: dict[str, Any]) -> dict[str, Any]:
    org_id = effective_org(user)
    if org_id:
        yard = next((o for o in st.get("admin_orgs", []) if o.get("id") == org_id), None)
        if yard:
            return yard
    return st.setdefault("org", {})


def _connector_state(st: dict[str, Any], user: dict[str, Any]) -> dict[str, Any]:
    org_id = effective_org(user)
    if org_id and org_id != store.KEECH_ORG_ID:
        return st.setdefault("connect_status_by_org", {}).setdefault(org_id, {})
    return st.setdefault("connect_status", {})


def _safe_return_url(request: Request, raw: Any) -> str:
    candidate = str(raw or "").strip()
    if candidate.startswith("/") and not candidate.startswith("//"):
        return candidate
    if candidate:
        parsed = urlparse(candidate)
        host = (request.headers.get("host") or "").lower()
        if parsed.scheme in ("http", "https") and host and parsed.netloc.lower() == host:
            return candidate
    return "/billing"



# ==========================================
# Billing, Connectors, Contact Support
# ==========================================
@public_router.get("/api/billing/plans")
def get_billing_plans() -> list[dict[str, Any]]:
    st = store.get_state()
    return st["seed"].get("/billing/plans", [])


@public_router.get("/api/billing/compare")
def get_billing_compare() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/billing/compare", {})


@router.post("/api/billing/checkout")
def post_billing_checkout(body: dict[str, Any], request: Request) -> dict[str, Any]:
    u = get_current_user(request)
    _require_manager(u)
    return {
        "checkout_url": _safe_return_url(request, body.get("origin_url")) + "?success=true",
        "session_id": "cs_" + uuid.uuid4().hex,
    }


@router.post("/api/billing/enterprise-preview")
@router.post("/api/billing/start-paid")
@router.post("/api/billing/switch-yearly")
def post_billing_tier_action(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    _require_manager(u)
    return _billing_org(st, u)


@router.post("/api/billing/extra-logins")
def post_billing_extra_logins(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    _require_manager(u)
    org = _billing_org(st, u)
    try:
        packs = int(body.get("packs") or 0)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Pack count must be a number")
    if packs < 0 or packs > 5:
        raise HTTPException(status_code=400, detail="Extra login packs must be between 0 and 5")
    org["extra_rep_packs"] = packs
    org["max_reps"] = 5 + (packs * 5)
    store.save_state()
    return org


@router.post("/api/billing/extra-sites")
def post_billing_extra_sites(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    _require_manager(u)
    org = _billing_org(st, u)
    try:
        extra = int(body.get("extra_sites") or 0)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Site count must be a number")
    if extra < 0 or extra > 10:
        raise HTTPException(status_code=400, detail="Extra sites must be between 0 and 10")
    org["extra_sites"] = extra
    org["max_sites"] = 4 + extra
    store.save_state()
    return {
        "extra_sites": extra,
        "max_sites": 4 + extra,
        "monthly_cost": extra * 100.0,
    }


@router.post("/api/billing/upgrade-enterprise")
def post_billing_upgrade_enterprise(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    _require_manager(u)
    org = _billing_org(st, u)
    org["plan"] = "enterprise"
    store.save_state()
    return {"upgraded": True, "checkout_url": ""}


@router.get("/api/payments/status/{sid}")
def get_payment_status(sid: str, request: Request) -> dict[str, Any]:
    u = get_current_user(request)
    _require_manager(u)
    return {"session_id": sid, "status": "complete", "payment_status": "paid"}


@router.get("/api/connect/status")
def get_connect_status(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    _require_manager(u)
    return _connector_state(st, u)


@router.get("/api/connect/ringcentral/start")
def get_connect_ringcentral_start(request: Request) -> dict[str, Any]:
    u = get_current_user(request)
    _require_manager(u)
    return {"authorize_url": "https://platform.devtest.ringcentral.com/restapi/oauth/authorize?response_type=code"}


@router.post("/api/connect/ringcentral/sync")
def post_connect_ringcentral_sync(request: Request) -> dict[str, Any]:
    u = get_current_user(request)
    _require_manager(u)
    return {"imported": 0, "updated": 0, "skipped": 0}


@router.delete("/api/connect/ringcentral")
def delete_connect_ringcentral(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    _require_manager(u)
    state = _connector_state(st, u)
    state.setdefault("ringcentral", {})["connected"] = False
    store.save_state()
    return state


@router.post("/api/connect/webhook/rotate")
def post_connect_webhook_rotate(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    _require_manager(u)
    state = _connector_state(st, u)
    state["webhook_url"] = f"https://salvagepulse.com/api/connect/webhook/{uuid.uuid4().hex}"
    store.save_state()
    return state


@router.get("/api/sms/status")
def get_sms_status(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    _require_manager(u)
    org_id = effective_org(u)
    if org_id and org_id != store.KEECH_ORG_ID:
        return st.setdefault("sms_status_by_org", {}).setdefault(org_id, {})
    return st.get("sms_status", {})


@router.get("/api/contact/mine")
def get_contact_mine(request: Request) -> list[dict[str, Any]]:
    st = store.get_state()
    u = get_current_user(request)
    email = (u.get("email") or "").strip().lower()
    return [m for m in st.get("contact_messages", []) if (m.get("user_email") or "").strip().lower() == email]


@router.post("/api/contact")
def post_contact(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    subject = str(body.get("subject") or "Inquiry").strip()[:200]
    message = str(body.get("message") or "").strip()[:5000]
    if not message:
        raise HTTPException(status_code=400, detail="Enter a message")
    kind = str(body.get("kind") or "support")[:40]
    org_id = u.get("org_id", "")
    yard = next((o for o in st.get("admin_orgs", []) if o.get("id") == org_id), None)
    cid = str(uuid.uuid4())
    msg = {
        "id": cid,
        "kind": kind,
        "subject": subject,
        "message": message,
        "user_name": u.get("name", "User"),
        "user_email": u.get("email", ""),
        "role": u.get("role", "manager"),
        "org_id": org_id,
        "org_name": (yard or st.get("org", {})).get("name", "Salvage Pulse Pro"),
        "page": str(body.get("page") or "/")[:500],
        "status": "new",
        "created_at": store.now_iso(),
        "resolved_by": "",
        "resolved_at": None,
        "replies": [],
        "reply_unread": False,
    }
    st.setdefault("contact_messages", []).insert(0, msg)
    store.save_state()
    # Also deliver to the support inbox (off-thread so the request isn't held up by SMTP).
    threading.Thread(
        target=email_service.send_support_request_email,
        kwargs=dict(
            kind=msg["kind"], subject=msg["subject"], message=msg["message"],
            user_name=msg["user_name"], user_email=msg["user_email"], role=msg["role"],
            org_name=msg["org_name"], page=msg["page"],
        ),
        daemon=True,
    ).start()
    return {"ok": True, "id": cid}


@router.post("/api/contact/mine/seen")
def post_contact_mine_seen() -> dict[str, Any]:
    return {"ok": True, "id": ""}
