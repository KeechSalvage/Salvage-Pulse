from __future__ import annotations

import threading
import uuid
from typing import Any
from fastapi import APIRouter, Request
from auth_utils import get_current_user
import store
import email_service

router = APIRouter(tags=["billing"])


# ==========================================
# Billing, Connectors, Contact Support
# ==========================================
@router.get("/api/billing/plans")
def get_billing_plans() -> list[dict[str, Any]]:
    st = store.get_state()
    return st["seed"].get("/billing/plans", [])


@router.get("/api/billing/compare")
def get_billing_compare() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/billing/compare", {})


@router.post("/api/billing/checkout")
def post_billing_checkout(body: dict[str, Any]) -> dict[str, Any]:
    return {
        "checkout_url": body.get("origin_url", "/billing") + "?success=true",
        "session_id": "cs_" + uuid.uuid4().hex,
    }


@router.post("/api/billing/enterprise-preview")
@router.post("/api/billing/start-paid")
@router.post("/api/billing/switch-yearly")
def post_billing_tier_action() -> dict[str, Any]:
    st = store.get_state()
    return st["org"]


@router.post("/api/billing/extra-logins")
def post_billing_extra_logins(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    packs = int(body.get("packs") or 0)
    st["org"]["extra_rep_packs"] = packs
    st["org"]["max_reps"] = (st["org"]["max_reps"] or 5) + (packs * 5)
    store.save_state()
    return st["org"]


@router.post("/api/billing/extra-sites")
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


@router.post("/api/billing/upgrade-enterprise")
def post_billing_upgrade_enterprise() -> dict[str, Any]:
    st = store.get_state()
    st["org"]["plan"] = "enterprise"
    store.save_state()
    return {"upgraded": True, "checkout_url": ""}


@router.get("/api/payments/status/{sid}")
def get_payment_status(sid: str) -> dict[str, Any]:
    return {"session_id": sid, "status": "complete", "payment_status": "paid"}


@router.get("/api/connect/status")
def get_connect_status() -> dict[str, Any]:
    st = store.get_state()
    return st.get("connect_status", {})


@router.get("/api/connect/ringcentral/start")
def get_connect_ringcentral_start() -> dict[str, Any]:
    return {"authorize_url": "https://platform.devtest.ringcentral.com/restapi/oauth/authorize?response_type=code"}


@router.post("/api/connect/ringcentral/sync")
def post_connect_ringcentral_sync() -> dict[str, Any]:
    return {"imported": 0, "updated": 0, "skipped": 0}


@router.delete("/api/connect/ringcentral")
def delete_connect_ringcentral() -> dict[str, Any]:
    st = store.get_state()
    st.setdefault("connect_status", {}).setdefault("ringcentral", {})["connected"] = False
    store.save_state()
    return st["connect_status"]


@router.post("/api/connect/webhook/rotate")
def post_connect_webhook_rotate() -> dict[str, Any]:
    st = store.get_state()
    st.setdefault("connect_status", {})["webhook_url"] = f"https://salvagepulse.com/api/connect/webhook/{uuid.uuid4().hex}"
    store.save_state()
    return st["connect_status"]


@router.get("/api/sms/status")
def get_sms_status() -> dict[str, Any]:
    st = store.get_state()
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
