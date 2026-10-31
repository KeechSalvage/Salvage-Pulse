from __future__ import annotations

import base64
import datetime as dt
import json
import uuid
from typing import Any, Optional
from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from auth_utils import get_current_user
import store
from database import METRICS, get_db, get_org_scoring_config, compute_weighted_overall_score

router = APIRouter(tags=["settings"])


def _get_yard_scoring(org_id: str) -> dict[str, Any]:
    """Helper to fetch custom scoring configuration strictly for a specific yard (org_id)."""
    defaults = {m["key"]: int(m["weight"]) for m in METRICS}
    if not org_id or org_id in ("", "5d4e9f0f-9147-4cd5-be02-e7239c74c462"):
        org_id = store.KEECH_ORG_ID

    # 1. Primary check: in-memory state / preview_state.json
    try:
        st = store.get_state()
        for yard in st.get("admin_orgs", []):
            if yard.get("id") == org_id:
                if yard.get("custom_scoring"):
                    mw = yard.get("metric_weights") or {}
                    w = dict(defaults)
                    for k in defaults:
                        if k in mw:
                            try:
                                w[k] = int(mw[k])
                            except (ValueError, TypeError):
                                pass
                    return {"custom_scoring": True, "weights": w, "defaults": defaults}
                elif yard.get("custom_scoring") is False and "metric_weights" in yard:
                    return {"custom_scoring": False, "weights": defaults, "defaults": defaults}

        if (st.get("org", {}).get("id") == org_id or org_id == store.KEECH_ORG_ID) and st.get("org", {}).get("custom_scoring"):
            mw = st.get("org", {}).get("metric_weights") or {}
            w = dict(defaults)
            for k in defaults:
                if k in mw:
                    try:
                        w[k] = int(mw[k])
                    except (ValueError, TypeError):
                        pass
            return {"custom_scoring": True, "weights": w, "defaults": defaults}
    except Exception:
        pass

    # 2. Check SQLite database
    cs, weights = get_org_scoring_config(org_id)
    return {"custom_scoring": cs, "weights": weights, "defaults": defaults}


# ==========================================
# Meta, Org, Branding, Settings
# ==========================================
@router.get("/api/meta")
def get_meta(request: Request = None) -> dict[str, Any]:
    st = store.get_state()
    base_meta = dict(st["seed"]["/meta"])
    metrics_list = [dict(m) for m in METRICS]

    org_id = None
    if request:
        try:
            u = get_current_user(request)
            org_id = u.get("org_id")
        except Exception:
            pass

    if org_id:
        scoring = _get_yard_scoring(org_id)
        if scoring["custom_scoring"]:
            weights = scoring["weights"]
            for m in metrics_list:
                if m["key"] in weights:
                    m["weight"] = weights[m["key"]]

    base_meta["metrics"] = metrics_list
    return base_meta


@router.get("/api/settings/scoring")
def get_scoring_settings(request: Request) -> dict[str, Any]:
    u = get_current_user(request)
    org_id = u.get("org_id")
    if not org_id or org_id in ("", "5d4e9f0f-9147-4cd5-be02-e7239c74c462"):
        st = store.get_state()
        org_id = st.get("org", {}).get("id") or store.KEECH_ORG_ID

    scoring = _get_yard_scoring(org_id)
    return {
        "custom_scoring": scoring["custom_scoring"],
        "weights": scoring["weights"],
        "defaults": scoring["defaults"],
        "metrics": METRICS,
    }


@router.put("/api/settings/scoring")
def update_scoring_settings(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    u = get_current_user(request)
    if u.get("role") not in ("owner", "sales_manager", "manager", "master", "admin"):
        raise HTTPException(status_code=403, detail="Only owners and sales managers can adjust scoring weights.")

    org_id = u.get("org_id")
    st = store.get_state()
    if not org_id or org_id in ("", "5d4e9f0f-9147-4cd5-be02-e7239c74c462"):
        org_id = st.get("org", {}).get("id") or store.KEECH_ORG_ID

    custom_scoring = bool(body.get("custom_scoring", False))
    raw_weights = body.get("weights") or {}
    defaults = {m["key"]: m["weight"] for m in METRICS}

    weights: dict[str, int] = {}
    for m in METRICS:
        k = m["key"]
        val = raw_weights.get(k, defaults[k])
        try:
            val_int = int(val)
        except (ValueError, TypeError):
            val_int = defaults[k]
        if val_int < 0:
            raise HTTPException(status_code=400, detail=f"Weight for {m['name']} cannot be negative.")
        weights[k] = val_int

    if custom_scoring:
        total = sum(weights.values())
        if total != 100:
            raise HTTPException(status_code=400, detail=f"Metric weights must total exactly 100%. Current total: {total}%.")

    # Update only the target yard in memory store
    for yard in st.get("admin_orgs", []):
        if yard.get("id") == org_id:
            yard["custom_scoring"] = custom_scoring
            yard["metric_weights"] = weights

    if st.get("org", {}).get("id") == org_id or org_id == store.KEECH_ORG_ID:
        st["org"]["custom_scoring"] = custom_scoring
        st["org"]["metric_weights"] = weights

    # Recalculate existing calls scored for this yard
    active_weights = weights if custom_scoring else defaults
    full_calls = st.get("full_calls", {})
    recalc_count = 0
    updated_calls_db = []

    for c in st.get("calls", []):
        c_org = c.get("org_id") or store.KEECH_ORG_ID
        if c_org == org_id:
            cid = c.get("id")
            m = full_calls.get(cid, {}).get("metrics") or c.get("metrics")
            if m and isinstance(m, dict):
                new_score = compute_weighted_overall_score(m, custom_weights=active_weights)
                c["overall_score"] = new_score
                if cid in full_calls:
                    full_calls[cid]["overall_score"] = new_score
                updated_calls_db.append((new_score, cid))
                recalc_count += 1

    store.save_state()

    # Persist in SQLite strictly isolated to this org_id
    try:
        with get_db() as conn:
            cur = conn.execute(
                """
                UPDATE orgs
                SET custom_scoring = ?, metric_weights_json = ?
                WHERE id = ?
                """,
                (1 if custom_scoring else 0, json.dumps(weights), org_id),
            )
            if cur.rowcount == 0:
                conn.execute(
                    """
                    INSERT INTO orgs (id, name, yard_name, plan, status, webhook_token, custom_scoring, metric_weights_json, created_at)
                    VALUES (?, ?, ?, 'enterprise', 'active', 'tok', ?, ?, ?)
                    """,
                    (org_id, "Keech's Auto Salvage", "Keech's Auto Salvage", 1 if custom_scoring else 0, json.dumps(weights), store.now_iso()),
                )
            # Batch update recalculated call scores in SQLite
            if updated_calls_db:
                conn.executemany(
                    "UPDATE calls SET overall_score = ? WHERE id = ?",
                    updated_calls_db,
                )
    except Exception as e:
        print(f"Error persisting scoring settings to SQLite: {e}")

    return {
        "ok": True,
        "custom_scoring": custom_scoring,
        "weights": weights,
        "defaults": defaults,
        "metrics": METRICS,
        "recalculated_calls": recalc_count,
    }


@router.get("/api/org/me")
def get_org_me(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    u_org_id = u.get("org_id")
    if u_org_id:
        yard = next((o for o in st.get("admin_orgs", []) if o.get("id") == u_org_id), None)
        if yard:
            is_past_due = yard.get("status") == "past_due"
            past_due_days = 0
            if is_past_due:
                since = yard.get("past_due_since")
                if since:
                    try:
                        p_dt = dt.datetime.fromisoformat(since.replace("Z", "+00:00"))
                        now = dt.datetime.now(dt.timezone.utc)
                        past_due_days = max(1, (now - p_dt).days)
                    except Exception:
                        past_due_days = 1
                else:
                    past_due_days = 1

            # Check if trial has ended
            trial_ended = False
            days_left = 7
            if yard.get("status") == "trialing":
                t_end_str = yard.get("trial_ends_at")
                if t_end_str:
                    try:
                        t_end_dt = dt.datetime.fromisoformat(t_end_str.replace("Z", "+00:00"))
                        now_utc = dt.datetime.now(dt.timezone.utc)
                        diff = (t_end_dt - now_utc).total_seconds()
                        days_left = max(0, int(round(diff / 86400)))
                        if diff <= 0:
                            trial_ended = True
                    except Exception:
                        pass

            return {
                "id": yard.get("id", ""),
                "name": yard.get("name", "Yard"),
                "plan": yard.get("plan", "pro"),
                "status": yard.get("status", "active"),
                "no_card_trial": yard.get("status") == "trialing" and not yard.get("card_on_file"),
                "email_verified": True,
                "trial_ends_at": yard.get("trial_ends_at"),
                "trial_ended": trial_ended,
                "days_left": days_left,
                "access": not bool(yard.get("blocked") or yard.get("status") == "canceled"),
                "past_due_days": past_due_days if is_past_due else 0,
                "past_due_since": yard.get("past_due_since"),
                "reps": yard.get("users", 1),
                "max_reps": 10,
                "card_on_file": bool(yard.get("card_on_file", False)),
                "trial_limited": False,
                "limited_starts_at": None,
                "locked_features": [],
                "roleplay_daily_cap": 25,
                "suggestion_cap": 50,
                "sample_data": False,
                "blocked": bool(yard.get("blocked", False)),
                "plan_locked": [],
                "extra_rep_packs": 0,
                "max_extra_packs": 5,
                "extra_pack_price": 50,
                "preview_ends_at": None,
                "preview_days_left": None,
                "preview_available": False,
                "preview_ending": False,
                "show_enterprise_tour": False,
                "billing_interval": "monthly",
                "discount": yard.get("discount"),
                "max_sites": yard.get("max_sites", 2),
                "extra_sites": yard.get("extra_sites", 0),
                "sites_used": 1,
            }
    return {
        "id": "",
        "name": "Salvage Pulse",
        "plan": "enterprise",
        "status": "active",
        "no_card_trial": False,
        "email_verified": True,
        "trial_ends_at": None,
        "days_left": None,
        "access": True,
        "reps": 1,
        "max_reps": 10,
        "card_on_file": True,
        "trial_limited": False,
        "limited_starts_at": None,
        "locked_features": [],
        "roleplay_daily_cap": 50,
        "suggestion_cap": 100,
        "sample_data": False,
        "blocked": False,
        "plan_locked": [],
        "extra_rep_packs": 0,
        "max_extra_packs": 5,
        "extra_pack_price": 50,
        "preview_ends_at": None,
        "preview_days_left": None,
        "preview_available": False,
        "preview_ending": False,
        "show_enterprise_tour": False,
        "billing_interval": "monthly",
        "discount": None,
        "max_sites": 2,
        "extra_sites": 0,
        "sites_used": 1,
    }


@router.delete("/api/org/sample-data")
def delete_sample_data() -> dict[str, Any]:
    st = store.get_state()
    st["org"]["sample_data"] = False
    store.save_state()
    return st["org"]


@router.post("/api/org/enterprise-tour/done")
def enterprise_tour_done() -> dict[str, Any]:
    st = store.get_state()
    st["org"]["show_enterprise_tour"] = False
    store.save_state()
@router.get("/api/org")
def get_org(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    if org_id:
        yard = next((o for o in st.get("admin_orgs", []) if o.get("id") == org_id), None)
        if yard:
            return yard
    return st.get("org", {})


@router.get("/api/branding")
def get_branding(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    if org_id:
        branding_map = st.setdefault("branding_by_org", {})
        if org_id in branding_map:
            return branding_map[org_id]
        yard = next((o for o in st.get("admin_orgs", []) if o.get("id") == org_id), None)
        yard_name = yard.get("name") or yard.get("yard_name") if yard else "Salvage Pulse"
        branding_map[org_id] = {
            "yard_name": yard_name or "Salvage Pulse",
            "accent": "",
            "default_mode": "dark",
            "logo_url": "",
            "user_mode": "dark",
            "mode": "dark",
        }
        return branding_map[org_id]
    return st.get("branding", {"yard_name": "Salvage Pulse", "mode": "dark"})


@router.put("/api/branding")
def put_branding(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id") or "default"
    branding_map = st.setdefault("branding_by_org", {})
    yard = next((o for o in st.get("admin_orgs", []) if o.get("id") == org_id), None)
    yard_name = yard.get("name") if yard else "Salvage Pulse"
    b = branding_map.setdefault(org_id, {
        "yard_name": yard_name or "Salvage Pulse",
        "accent": "",
        "default_mode": "dark",
        "logo_url": "",
        "user_mode": "dark",
        "mode": "dark",
    })
    if "accent" in body:
        b["accent"] = body["accent"]
    if "default_mode" in body:
        b["default_mode"] = body["default_mode"]
        b["mode"] = body["default_mode"]
    store.save_state()
    return b


@router.post("/api/branding/logo")
async def post_branding_logo(request: Request, file: UploadFile = File(...)) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id") or "default"
    content = await file.read()
    b64 = base64.b64encode(content).decode("ascii")
    mime = file.content_type or "image/png"
    branding_map = st.setdefault("branding_by_org", {})
    b = branding_map.setdefault(org_id, dict(st.get("branding", {})))
    b["logo_url"] = f"data:{mime};base64,{b64}"
    store.save_state()
    return b


@router.delete("/api/branding/logo")
def delete_branding_logo(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id") or "default"
    branding_map = st.setdefault("branding_by_org", {})
    b = branding_map.setdefault(org_id, dict(st.get("branding", {})))
    b["logo_url"] = ""
    store.save_state()
    return b


@router.get("/api/settings/business")
def get_settings_business(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    if org_id:
        return st.setdefault("settings_business_by_org", {}).setdefault(org_id, {"avg_order_value": None, "yard_name": None})
    return st.get("settings_business", {"avg_order_value": None, "yard_name": None})


@router.put("/api/settings/business")
def put_settings_business(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    if org_id:
        cur = st.setdefault("settings_business_by_org", {}).setdefault(org_id, {"avg_order_value": None, "yard_name": None})
    else:
        cur = st.setdefault("settings_business", {})
    if "avg_order_value" in body:
        cur["avg_order_value"] = body["avg_order_value"]
    if "yard_name" in body:
        cur["yard_name"] = body["yard_name"]
        if body["yard_name"] and org_id:
            st.setdefault("branding_by_org", {}).setdefault(org_id, {})["yard_name"] = body["yard_name"]
            yard = next((o for o in st.get("admin_orgs", []) if o.get("id") == org_id), None)
            if yard:
                yard["name"] = body["yard_name"]
                yard["yard_name"] = body["yard_name"]
    store.save_state()
    return cur


@router.get("/api/settings/coverage")
def get_settings_coverage() -> dict[str, Any]:
    st = store.get_state()
    return st.get("settings_coverage", {"max_away": 2, "warn_days_ahead": 3})


@router.put("/api/settings/coverage")
def put_settings_coverage(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    st["settings_coverage"] = {**st.get("settings_coverage", {}), **body}
    store.save_state()
    return st["settings_coverage"]


@router.get("/api/settings/delivery-tips")
def get_settings_delivery_tips() -> dict[str, Any]:
    st = store.get_state()
    return st.get("settings_delivery_tips", {"date_given": "", "address_confirmed": "", "thanked": ""})


@router.put("/api/settings/delivery-tips")
def put_settings_delivery_tips(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    st["settings_delivery_tips"] = {**st.get("settings_delivery_tips", {}), **body}
    store.save_state()
    return st["settings_delivery_tips"]


@router.get("/api/settings/digest")
def get_settings_digest() -> dict[str, Any]:
    st = store.get_state()
    return st.get("settings_digest", {"recipient_email": "", "enabled": False})


@router.put("/api/settings/digest")
def put_settings_digest(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    st["settings_digest"] = {**st.get("settings_digest", {}), **body}
    store.save_state()
    return st["settings_digest"]


@router.post("/api/digest/send-now")
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


@router.get("/api/settings/monthly-report")
def get_settings_monthly_report(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    base = dict(st.get("settings_monthly_report", {"enabled": True, "user_ids": None, "extra_emails": []}))
    people = []
    for usr in st["users_by_id"].values():
        if (not org_id or usr.get("org_id") == org_id) and not usr.get("disabled") and usr.get("role") in ("manager", "rep", "sales_manager"):
            people.append({
                "id": usr["id"],
                "name": usr["name"],
                "email": usr["email"],
                "role": usr["role"],
            })
    base["people"] = people
    return base


@router.put("/api/settings/monthly-report")
def put_settings_monthly_report(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    cur = st.get("settings_monthly_report", {})
    cur.update(body)
    st["settings_monthly_report"] = cur
    store.save_state()
    return get_settings_monthly_report(request)


@router.post("/api/reports/email-me")
def reports_email_me() -> dict[str, Any]:
    return {
        "sent": 1,
        "skipped": 0,
        "month": store.current_month_str(),
    }


# ==========================================
# Layouts
# ==========================================
@router.get("/api/layouts/{page}")
def get_layout(page: str, as_target: Optional[str] = Query(None, alias="as")) -> dict[str, Any]:
    st = store.get_state()
    layouts = st.get("layouts", {})
    key = f"{page}:{as_target}" if as_target else page
    if key in st.get("custom_layouts", {}):
        return st["custom_layouts"][key]
    return layouts.get(page, {"page": page, "order": [], "source": "default"})


@router.put("/api/layouts/{page}")
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


@router.delete("/api/layouts/{page}")
def delete_layout(page: str, target: Optional[str] = Query(None)) -> dict[str, Any]:
    st = store.get_state()
    key = f"{page}:{target}" if target else page
    st.get("custom_layouts", {}).pop(key, None)
    out = {"page": page, "order": [], "source": "default"}
    st["layouts"][page] = out
    store.save_state()
    return out


@router.get("/api/layouts-targets/{page}")
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
@router.get("/api/users/reps")
def get_users_reps(
    request: Request,
    include_disabled: bool = Query(False),
    include_managers: bool = Query(False),
) -> list[dict[str, Any]]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    allowed_roles = ("rep", "sales_rep", "sales_manager") if include_managers else ("rep", "sales_rep")
    out = []
    for usr in st["users_by_id"].values():
        if usr.get("role") in allowed_roles:
            if org_id and usr.get("org_id") != org_id:
                continue
            if include_disabled or not usr.get("disabled"):
                out.append(usr)
    return sorted(out, key=lambda x: x.get("name", ""))


@router.post("/api/users/reps")
def create_rep(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    new_id = str(uuid.uuid4())
    org_id = u.get("org_id") or body.get("org_id") or ""
    role = body.get("role") or "rep"
    role_titles = {
        "owner": "Yard Owner",
        "sales_manager": "Sales Manager",
        "inventory_manager": "Inventory Manager",
        "rep": "Sales Representative",
    }
    new_rep = {
        "id": new_id,
        "email": body["email"].strip().lower(),
        "name": body["name"],
        "role": role,
        "title": body.get("title") or role_titles.get(role, "Sales Representative"),
        "avatar_url": "",
        "org_id": org_id,
        "impersonated_by": "",
        "disabled": False,
        "site_id": body.get("site_id", ""),
        "must_change_password": False,
        "password_hash": store.hash_password(body.get("password") or "rep"),
    }
    st["users_by_id"][new_id] = new_rep
    store.save_state()
    return new_rep


@router.get("/api/users/reps/login-log")
def get_rep_login_log() -> list[dict[str, Any]]:
    st = store.get_state()
    return st.get("rep_login_log", [])


@router.get("/api/users/reps/{rep_id}/open-work")
def get_rep_open_work(rep_id: str) -> dict[str, Any]:
    st = store.get_state()
    open_cb = sum(1 for c in st.get("callbacks_open", []) if c.get("rep_id") == rep_id)
    lists_ct = sum(1 for l in st.get("callback_lists", []) if l.get("rep_id") == rep_id and l.get("open", 0) > 0)
    return {"callbacks": open_cb, "lists": lists_ct}


@router.patch("/api/users/reps/{rep_id}/login")
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


@router.patch("/api/users/reps/{rep_id}/site")
def update_rep_site(rep_id: str, body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    u = st["users_by_id"].get(rep_id)
    if not u:
        raise HTTPException(status_code=404, detail="Rep not found")
    u["site_id"] = body.get("site_id", "")
    store.save_state()
    return u


# Sites (Lots)
@router.get("/api/sites")
def get_sites() -> dict[str, Any]:
    st = store.get_state()
    data = st.get("sites_data", {})
    for s in data.get("sites", []):
        sid = s["id"]
        s["reps"] = sum(1 for u in st["users_by_id"].values() if u.get("site_id") == sid and not u.get("disabled"))
    return data


@router.post("/api/sites")
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


@router.patch("/api/sites/{site_id}")
def update_site(site_id: str, body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    for s in st.get("sites_data", {}).get("sites", []):
        if s["id"] == site_id:
            if "name" in body:
                s["name"] = body["name"]
    store.save_state()
    return get_sites()


@router.patch("/api/sites/{site_id}/goal")
def update_site_goal(site_id: str, body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    for s in st.get("sites_data", {}).get("sites", []):
        if s["id"] == site_id:
            s["goal"] = float(body.get("goal") or 0.0)
    store.save_state()
    return get_sites()


@router.patch("/api/sites/{site_id}/manager")
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


@router.delete("/api/sites/{site_id}")
def delete_site(site_id: str) -> dict[str, Any]:
    st = store.get_state()
    st["sites_data"]["sites"] = [s for s in st.get("sites_data", {}).get("sites", []) if s["id"] != site_id]
    for u in st["users_by_id"].values():
        if u.get("site_id") == site_id:
            u["site_id"] = ""
    store.save_state()
    return get_sites()


@router.get("/api/sites/managers")
def get_site_managers() -> list[dict[str, Any]]:
    st = store.get_state()
    return [
        u
        for u in st["users_by_id"].values()
        if u.get("role") in ("owner", "sales_manager", "inventory_manager", "manager", "master", "admin")
    ]


@router.get("/api/sites/leaderboard")
def get_sites_leaderboard(days: int = Query(30)) -> dict[str, Any]:
    st = store.get_state()
    lb = st["seed"].get("/sites/leaderboard?days=30", {})
    return lb
