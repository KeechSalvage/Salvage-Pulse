from __future__ import annotations

import base64
import datetime as dt
import json
import re
import secrets
import uuid
from typing import Any, Optional
from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from auth_utils import get_current_user
import store
import yard_analytics as ya
from database import CATEGORIES, METRICS, get_db, get_org_scoring_config, compute_weighted_overall_score
from scoring_config import resolve_scoring
from user_theme import DEFAULT_BRANDING, branding_for_user
from security import (
    ALLOWED_IMAGE_EXTENSIONS,
    assert_same_org,
    can_manage_yard_user,
    effective_org,
    is_manager,
    is_staff,
    public_user,
    require_authenticated,
    resolve_write_org,
    scoped_site_id,
    validate_email,
    validate_password,
    validate_upload,
)

router = APIRouter(tags=["settings"], dependencies=[Depends(require_authenticated)])


def _scoped_settings(st: dict[str, Any], key: str, org_id: str | None, default: dict[str, Any]) -> dict[str, Any]:
    """Return the settings bucket for a yard without mixing tenants together."""
    if org_id and org_id != store.KEECH_ORG_ID:
        return st.setdefault(f"{key}_by_org", {}).setdefault(org_id, dict(default))
    return st.setdefault(key, dict(default))


def _layout_key(org_id: str | None, page: str, target: str) -> str:
    if org_id and org_id != store.KEECH_ORG_ID:
        return f"{org_id}:{page}:{target}"
    return f"{page}:{target}"


def _site_org(site: dict[str, Any]) -> str:
    return site.get("org_id") or store.KEECH_ORG_ID


def _require_manager(user: dict[str, Any]) -> None:
    if not is_manager(user):
        raise HTTPException(status_code=403, detail="Manager access required")


def _site_in_org(st: dict[str, Any], site_id: str, org_id: str | None) -> dict[str, Any]:
    site = next((s for s in st.get("sites_data", {}).get("sites", []) if s.get("id") == site_id), None)
    if not site:
        raise HTTPException(status_code=404, detail="Site not found")
    if org_id and _site_org(site) != org_id:
        raise HTTPException(status_code=403, detail="Access denied")
    return site



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
    base_meta["categories"] = list(CATEGORIES)
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
def get_scoring_settings(
    request: Request,
    site_id: Optional[str] = Query(None),
) -> dict[str, Any]:
    u = get_current_user(request)
    st = store.get_state()
    org_id = effective_org(u)
    if not org_id:
        org_id = st.get("org", {}).get("id") or store.KEECH_ORG_ID
    if site_id:
        _site_in_org(st, site_id, org_id)

    scoring = resolve_scoring(st, org_id, site_id or None)
    return {
        **scoring,
        "metrics": METRICS,
    }


@router.put("/api/settings/scoring")
def update_scoring_settings(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    u = get_current_user(request)
    if u.get("role") not in ("owner", "sales_manager", "manager", "master", "admin"):
        raise HTTPException(status_code=403, detail="Only owners and sales managers can adjust scoring weights.")

    org_id = resolve_write_org(u, body.get("org_id"))
    st = store.get_state()
    if not org_id:
        org_id = st.get("org", {}).get("id") or store.KEECH_ORG_ID
    site_id = str(body.get("site_id") or "")
    if site_id:
        _site_in_org(st, site_id, org_id)

    custom_scoring = bool(body.get("custom_scoring", False))
    raw_weights = body.get("weights") or {}
    defaults = {m["key"]: m["weight"] for m in METRICS}
    current = resolve_scoring(st, org_id, site_id or None)

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

    raw_criteria = body.get("criteria")
    if raw_criteria is not None and not isinstance(raw_criteria, dict):
        raise HTTPException(status_code=400, detail="criteria must be an object keyed by metric")
    criteria = dict(current["criteria"])
    if isinstance(raw_criteria, dict):
        for m in METRICS:
            value = raw_criteria.get(m["key"])
            if isinstance(value, str) and value.strip():
                criteria[m["key"]] = value.strip()[:4000]
    instructions = body.get("instructions")
    if instructions is None:
        instructions = current["instructions"]
    if not isinstance(instructions, str):
        raise HTTPException(status_code=400, detail="instructions must be text")
    instructions = instructions.strip()[:4000]

    # Update only the selected location, or the yard default when no site is selected.
    if site_id:
        site = _site_in_org(st, site_id, org_id)
        site["scoring"] = {
            "custom_scoring": custom_scoring,
            "weights": weights,
            "criteria": criteria,
            "instructions": instructions,
        }
    else:
        for yard in st.get("admin_orgs", []):
            if yard.get("id") == org_id:
                yard["custom_scoring"] = custom_scoring
                yard["metric_weights"] = weights
                yard["metric_criteria"] = criteria
                yard["ai_instructions"] = instructions

        if st.get("org", {}).get("id") == org_id or org_id == store.KEECH_ORG_ID:
            st["org"]["custom_scoring"] = custom_scoring
            st["org"]["metric_weights"] = weights
            st["org"]["metric_criteria"] = criteria
            st["org"]["ai_instructions"] = instructions

    # Recalculate existing calls for this location (or the whole yard).
    active_weights = weights if custom_scoring else resolve_scoring(st, org_id, None)["weights"]
    full_calls = st.get("full_calls", {})
    rep_site = {
        uid: str(usr.get("site_id") or "")
        for uid, usr in st.get("users_by_id", {}).items()
        if not org_id or usr.get("org_id") == org_id
    }
    recalc_count = 0
    updated_calls_db = []

    for c in st.get("calls", []):
        c_org = c.get("org_id") or store.KEECH_ORG_ID
        if c_org != org_id:
            continue
        if site_id and str(c.get("site_id") or rep_site.get(c.get("rep_id"), "") or "") != site_id:
            continue
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

    # Persist yard-level weights in SQLite. Location overrides live in state.
    if not site_id:
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
                if updated_calls_db:
                    conn.executemany(
                        "UPDATE calls SET overall_score = ? WHERE id = ?",
                        updated_calls_db,
                    )
        except Exception as e:
            print(f"Error persisting scoring settings to SQLite: {e}")

    return {
        "ok": True,
        "site_id": site_id,
        "custom_scoring": custom_scoring,
        "weights": weights,
        "defaults": defaults,
        "criteria": criteria,
        "default_criteria": current["default_criteria"],
        "instructions": instructions,
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

            # Only a trial that has entered its limited phase gets a suggestion
            # cap. Active yards must not look like they are on a trial.
            trial_limited = False
            limited_start = yard.get("limited_starts_at")
            if yard.get("status") == "trialing" and limited_start and not yard.get("is_demo"):
                try:
                    start_dt = dt.datetime.fromisoformat(str(limited_start).replace("Z", "+00:00"))
                    trial_limited = dt.datetime.now(dt.timezone.utc) >= start_dt
                except Exception:
                    trial_limited = False

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
                "trial_limited": trial_limited,
                "limited_starts_at": limited_start,
                "locked_features": [],
                "roleplay_daily_cap": 1 if trial_limited else 25,
                "suggestion_cap": 3 if trial_limited else None,
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
        "suggestion_cap": None,
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
def delete_sample_data(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    _require_manager(u)
    org_id = effective_org(u)
    if org_id:
        yard = next((o for o in st.get("admin_orgs", []) if o.get("id") == org_id), None)
        if yard:
            yard["sample_data"] = False
    if not org_id or org_id == (st.get("org", {}).get("id") or store.KEECH_ORG_ID):
        st.setdefault("org", {})["sample_data"] = False
    store.save_state()
    return st.get("org", {})


@router.post("/api/org/enterprise-tour/done")
def enterprise_tour_done(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    _require_manager(u)
    org_id = effective_org(u)
    if org_id:
        yard = next((o for o in st.get("admin_orgs", []) if o.get("id") == org_id), None)
        if yard:
            yard["show_enterprise_tour"] = False
    if not org_id or org_id == (st.get("org", {}).get("id") or store.KEECH_ORG_ID):
        st.setdefault("org", {})["show_enterprise_tour"] = False
    store.save_state()
    return {"ok": True}
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
        if org_id not in branding_map:
            yard = next((o for o in st.get("admin_orgs", []) if o.get("id") == org_id), None)
            yard_name = (yard.get("name") or yard.get("yard_name")) if yard else "Salvage Pulse"
            branding_map[org_id] = {**DEFAULT_BRANDING, "yard_name": yard_name or "Salvage Pulse"}
    return branding_for_user(st, u)


@router.put("/api/branding")
def put_branding(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    _require_manager(u)
    org_id = u.get("org_id") or "default"
    branding_map = st.setdefault("branding_by_org", {})
    yard = next((o for o in st.get("admin_orgs", []) if o.get("id") == org_id), None)
    yard_name = yard.get("name") if yard else "Salvage Pulse"
    b = branding_map.setdefault(org_id, {
        **DEFAULT_BRANDING,
        "yard_name": yard_name or "Salvage Pulse",
    })
    if "accent" in body:
        accent = str(body.get("accent") or "").strip()
        if accent and not re.fullmatch(r"#[0-9a-fA-F]{3,8}", accent):
            raise HTTPException(status_code=400, detail="Accent must be a hex colour such as #1f6feb")
        b["accent"] = accent
    if "default_mode" in body:
        mode = str(body.get("default_mode") or "dark").lower()
        if mode not in ("dark", "light", "system"):
            raise HTTPException(status_code=400, detail="Invalid display mode")
        b["default_mode"] = mode
    store.save_state()
    return branding_for_user(st, u)


@router.post("/api/branding/logo")
async def post_branding_logo(request: Request, file: UploadFile = File(...)) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    _require_manager(u)
    org_id = u.get("org_id") or "default"
    content = await file.read(2 * 1024 * 1024 + 1)
    ext = validate_upload(content, file.filename or "", ALLOWED_IMAGE_EXTENSIONS, max_bytes=2 * 1024 * 1024)
    mime = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
    }[ext]
    b64 = base64.b64encode(content).decode("ascii")
    branding_map = st.setdefault("branding_by_org", {})
    b = branding_map.setdefault(org_id, dict(DEFAULT_BRANDING))
    b["logo_url"] = f"data:{mime};base64,{b64}"
    store.save_state()
    return branding_for_user(st, u)


@router.delete("/api/branding/logo")
def delete_branding_logo(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    _require_manager(u)
    org_id = u.get("org_id") or "default"
    branding_map = st.setdefault("branding_by_org", {})
    b = branding_map.setdefault(org_id, dict(DEFAULT_BRANDING))
    b["logo_url"] = ""
    store.save_state()
    return branding_for_user(st, u)


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
    _require_manager(u)
    org_id = u.get("org_id")
    if org_id:
        cur = st.setdefault("settings_business_by_org", {}).setdefault(org_id, {"avg_order_value": None, "yard_name": None})
    else:
        cur = st.setdefault("settings_business", {})
    if "avg_order_value" in body:
        raw = body.get("avg_order_value")
        if raw in (None, ""):
            cur["avg_order_value"] = None
        else:
            try:
                value = float(raw)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="Average order value must be a number")
            if value < 0 or value > 10_000_000:
                raise HTTPException(status_code=400, detail="Average order value is out of range")
            cur["avg_order_value"] = round(value, 2)
    if "yard_name" in body:
        yard_name = str(body.get("yard_name") or "").strip()[:120]
        cur["yard_name"] = yard_name
        if yard_name and org_id:
            st.setdefault("branding_by_org", {}).setdefault(org_id, {})["yard_name"] = yard_name
            yard = next((o for o in st.get("admin_orgs", []) if o.get("id") == org_id), None)
            if yard:
                yard["name"] = yard_name
                yard["yard_name"] = yard_name
    store.save_state()
    return cur


@router.get("/api/settings/coverage")
def get_settings_coverage(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    return _scoped_settings(st, "settings_coverage", org_id, {"max_away": 2, "warn_days_ahead": 3})


@router.put("/api/settings/coverage")
def put_settings_coverage(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    _require_manager(u)
    org_id = effective_org(u)
    cur = _scoped_settings(st, "settings_coverage", org_id, {"max_away": 2, "warn_days_ahead": 3})
    cur.update({k: v for k, v in body.items() if k in ("max_away", "warn_days_ahead")})
    store.save_state()
    return cur


@router.get("/api/settings/delivery-tips")
def get_settings_delivery_tips(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    return _scoped_settings(
        st, "settings_delivery_tips", org_id,
        {"date_given": "", "address_confirmed": "", "thanked": ""},
    )


@router.put("/api/settings/delivery-tips")
def put_settings_delivery_tips(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    _require_manager(u)
    org_id = effective_org(u)
    cur = _scoped_settings(
        st, "settings_delivery_tips", org_id,
        {"date_given": "", "address_confirmed": "", "thanked": ""},
    )
    cur.update({k: v for k, v in body.items() if k in ("date_given", "address_confirmed", "thanked")})
    store.save_state()
    return cur


@router.get("/api/settings/digest")
def get_settings_digest(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    return _scoped_settings(st, "settings_digest", org_id, {"recipient_email": "", "enabled": False})


@router.put("/api/settings/digest")
def put_settings_digest(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    _require_manager(u)
    org_id = effective_org(u)
    cur = _scoped_settings(st, "settings_digest", org_id, {"recipient_email": "", "enabled": False})
    if "recipient_email" in body:
        raw = str(body.get("recipient_email") or "").strip()
        cur["recipient_email"] = validate_email(raw) if raw else ""
    if "enabled" in body:
        cur["enabled"] = bool(body.get("enabled"))
    store.save_state()
    return cur


@router.post("/api/digest/send-now")
def digest_send_now(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    _require_manager(u)
    org_id = effective_org(u)
    digest = _scoped_settings(st, "settings_digest", org_id, {"recipient_email": "", "enabled": False})
    recipient = digest.get("recipient_email") or u.get("email") or "manager@salvagepulse.com"
    users = [usr for usr in st["users_by_id"].values() if usr.get("role") in ("rep", "sales_rep") and (not org_id or usr.get("org_id") == org_id)]
    callbacks = [c for c in st.get("callbacks_open", []) if not org_id or c.get("org_id") == org_id]
    sites = [s for s in st.get("sites_data", {}).get("sites", []) if not org_id or _site_org(s) == org_id]
    return {
        "sent": True,
        "recipient": recipient,
        "reps": len(users),
        "items": len(callbacks),
        "location_emails": len(sites),
    }


@router.get("/api/settings/monthly-report")
def get_settings_monthly_report(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    base = dict(_scoped_settings(
        st, "settings_monthly_report", org_id,
        {"enabled": True, "user_ids": None, "extra_emails": []},
    ))
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
    u = get_current_user(request)
    _require_manager(u)
    org_id = effective_org(u)
    cur = _scoped_settings(
        st, "settings_monthly_report", org_id,
        {"enabled": True, "user_ids": None, "extra_emails": []},
    )
    if "enabled" in body:
        cur["enabled"] = bool(body.get("enabled"))
    if "user_ids" in body:
        raw_ids = body.get("user_ids")
        if raw_ids is None:
            cur["user_ids"] = None
        else:
            if not isinstance(raw_ids, list):
                raise HTTPException(status_code=400, detail="user_ids must be a list")
            allowed = {
                uid for uid, usr in st["users_by_id"].items()
                if not org_id or usr.get("org_id") == org_id
            }
            ids = [str(uid) for uid in raw_ids if str(uid) in allowed]
            cur["user_ids"] = ids
    if "extra_emails" in body:
        raw_emails = body.get("extra_emails") or []
        if not isinstance(raw_emails, list) or len(raw_emails) > 25:
            raise HTTPException(status_code=400, detail="Too many extra email addresses")
        cur["extra_emails"] = [validate_email(str(e)) for e in raw_emails if str(e).strip()]
    store.save_state()
    return get_settings_monthly_report(request)


@router.post("/api/reports/email-me")
def reports_email_me(request: Request) -> dict[str, Any]:
    u = get_current_user(request)
    return {
        "sent": 1,
        "skipped": 0,
        "month": store.current_month_str(),
        "recipient": u.get("email", ""),
    }


# ==========================================
# Layouts
# ==========================================
@router.get("/api/layouts/{page}")
def get_layout(page: str, request: Request, as_target: Optional[str] = Query(None, alias="as")) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    target = as_target or ""
    if target:
        target_user = st["users_by_id"].get(target)
        if not target_user:
            raise HTTPException(status_code=404, detail="Team member not found")
        if org_id and target_user.get("org_id") != org_id:
            raise HTTPException(status_code=403, detail="Access denied")
    key = _layout_key(org_id, page, target) if target else _layout_key(org_id, page, "yard")
    custom = st.get("custom_layouts", {})
    if key in custom:
        return custom[key]
    if target:
        personal_key = _layout_key(org_id, page, target)
        if personal_key in custom:
            return custom[personal_key]
    if org_id in (None, store.KEECH_ORG_ID):
        return st.get("layouts", {}).get(page, {"page": page, "order": [], "source": "default"})
    return {"page": page, "order": [], "source": "default"}


@router.put("/api/layouts/{page}")
def put_layout(page: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    target = str(body.get("target") or "yard")
    if target == "yard":
        _require_manager(u)
    else:
        target_user = st["users_by_id"].get(target)
        if not target_user:
            raise HTTPException(status_code=404, detail="Team member not found")
        if org_id and target_user.get("org_id") != org_id:
            raise HTTPException(status_code=403, detail="Access denied")
        if target != u.get("id") and not is_manager(u):
            raise HTTPException(status_code=403, detail="You can only change your own layout")
    order = body.get("order") or []
    if not isinstance(order, list) or len(order) > 100 or not all(isinstance(x, str) for x in order):
        raise HTTPException(status_code=400, detail="Invalid layout order")
    out = {"page": page, "order": order, "source": "user" if target != "yard" else "yard"}
    st.setdefault("custom_layouts", {})[_layout_key(org_id, page, target)] = out
    if org_id in (None, store.KEECH_ORG_ID):
        st.setdefault("layouts", {})[page] = out
    store.save_state()
    return out


@router.delete("/api/layouts/{page}")
def delete_layout(page: str, request: Request, target: Optional[str] = Query(None)) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    tgt = target or "yard"
    if tgt == "yard":
        _require_manager(u)
    else:
        target_user = st["users_by_id"].get(tgt)
        if not target_user:
            raise HTTPException(status_code=404, detail="Team member not found")
        if org_id and target_user.get("org_id") != org_id:
            raise HTTPException(status_code=403, detail="Access denied")
        if tgt != u.get("id") and not is_manager(u):
            raise HTTPException(status_code=403, detail="You can only change your own layout")
    st.get("custom_layouts", {}).pop(_layout_key(org_id, page, tgt), None)
    out = {"page": page, "order": [], "source": "default"}
    if org_id in (None, store.KEECH_ORG_ID):
        st.setdefault("layouts", {})[page] = out
    store.save_state()
    return out


@router.get("/api/layouts-targets/{page}")
def get_layout_targets(page: str, request: Request) -> list[dict[str, Any]]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    targets = [{"target": "yard", "name": "Everyone in the yard", "role": "", "has_custom": False}]
    for usr in sorted(st["users_by_id"].values(), key=lambda x: x.get("name", "")):
        if org_id and usr.get("org_id") != org_id:
            continue
        if not usr.get("disabled"):
            targets.append({
                "target": usr["id"],
                "name": usr["name"],
                "role": usr.get("role", ""),
                "has_custom": _layout_key(org_id, page, usr["id"]) in st.get("custom_layouts", {}),
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
    org_id = effective_org(u)
    allowed_roles = ("rep", "sales_rep", "sales_manager") if include_managers else ("rep", "sales_rep")
    out = []
    for usr in st["users_by_id"].values():
        if usr.get("role") in allowed_roles:
            if org_id and usr.get("org_id") != org_id:
                continue
            if include_disabled or not usr.get("disabled"):
                out.append(public_user(usr))
    return sorted(out, key=lambda x: x.get("name", ""))


@router.post("/api/users/reps")
def create_rep(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    _require_manager(u)
    org_id = resolve_write_org(u, body.get("org_id"))

    role = str(body.get("role") or "rep")
    actor_role = u.get("role")
    allowed_roles = {"rep", "sales_rep"}
    if actor_role in ("master", "admin", "owner"):
        allowed_roles |= {"owner", "sales_manager", "inventory_manager"}
    if actor_role == "master":
        allowed_roles.add("master")
    if role not in allowed_roles:
        raise HTTPException(status_code=403, detail="You cannot create that role")

    email = validate_email(body.get("email") or "")
    if any((usr.get("email") or "").strip().lower() == email for usr in st["users_by_id"].values()):
        raise HTTPException(status_code=409, detail="A user with that email already exists")

    name = str(body.get("name") or "").strip()[:120]
    if not name:
        raise HTTPException(status_code=400, detail="Enter the team member's name")

    site_id = str(body.get("site_id") or "")
    if site_id:
        _site_in_org(st, site_id, org_id)

    temporary_password = ""
    password = body.get("password") or ""
    if password:
        validate_password(str(password))
    else:
        temporary_password = secrets.token_urlsafe(12)
        password = temporary_password

    role_titles = {
        "owner": "Yard Owner",
        "sales_manager": "Sales Manager",
        "inventory_manager": "Inventory Manager",
        "rep": "Sales Representative",
    }
    new_id = str(uuid.uuid4())
    new_rep = {
        "id": new_id,
        "email": email,
        "name": name,
        "role": role,
        "title": str(body.get("title") or role_titles.get(role, "Sales Representative"))[:120],
        "avatar_url": "",
        "org_id": org_id,
        "disabled": False,
        "site_id": site_id,
        "must_change_password": bool(temporary_password),
        "password_hash": store.hash_password(password),
    }
    st["users_by_id"][new_id] = new_rep
    store.save_state()
    result = public_user(new_rep)
    if temporary_password:
        result["temporary_password"] = temporary_password
    return result


@router.get("/api/users/reps/login-log")
def get_rep_login_log(request: Request) -> list[dict[str, Any]]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    if not org_id:
        return st.get("rep_login_log", [])
    org_users = {uid for uid, usr in st["users_by_id"].items() if usr.get("org_id") == org_id}
    return [e for e in st.get("rep_login_log", []) if e.get("rep_id") in org_users]


@router.get("/api/users/reps/{rep_id}/open-work")
def get_rep_open_work(rep_id: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    target = st["users_by_id"].get(rep_id)
    if not target:
        raise HTTPException(status_code=404, detail="Rep not found")
    assert_same_org(u, target.get("org_id"))
    if not is_manager(u) and u.get("id") != rep_id:
        raise HTTPException(status_code=403, detail="You can only view your own workload")
    open_cb = sum(1 for c in st.get("callbacks_open", []) if c.get("rep_id") == rep_id)
    lists_ct = sum(1 for l in st.get("callback_lists", []) if l.get("rep_id") == rep_id and l.get("open", 0) > 0)
    return {"callbacks": open_cb, "lists": lists_ct}


@router.patch("/api/users/reps/{rep_id}/login")
def update_rep_login(rep_id: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    actor = get_current_user(request)
    _require_manager(actor)
    target = st["users_by_id"].get(rep_id)
    if not target:
        raise HTTPException(status_code=404, detail="Rep not found")
    if not can_manage_yard_user(actor, target):
        raise HTTPException(status_code=403, detail="You cannot manage that account")
    if rep_id == actor.get("id") and bool(body.get("disabled")):
        raise HTTPException(status_code=400, detail="You cannot disable your own account")

    disabled = bool(body.get("disabled"))
    target["disabled"] = disabled
    move_to = str(body.get("move_to_rep_id") or "")
    moved_count = 0

    if disabled and move_to:
        to_user = st["users_by_id"].get(move_to)
        if not to_user:
            raise HTTPException(status_code=400, detail="Unknown team member to move work to")
        assert_same_org(actor, to_user.get("org_id"))
        if to_user.get("disabled"):
            raise HTTPException(status_code=400, detail="Cannot move work to a disabled account")
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

    event = {
        "id": str(uuid.uuid4()),
        "rep_id": rep_id,
        "rep_name": target["name"],
        "action": "off" if disabled else "on",
        "by": actor.get("name", "Manager"),
        "source": "reps_page",
        "moved": moved_count,
        "moved_to": st["users_by_id"].get(move_to, {}).get("name", "") if move_to else "",
        "at": store.now_iso(),
    }
    st.setdefault("rep_login_log", []).insert(0, event)
    store.save_state()
    return {"user": public_user(target), "moved": moved_count}


@router.patch("/api/users/reps/{rep_id}/site")
def update_rep_site(rep_id: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    actor = get_current_user(request)
    _require_manager(actor)
    target = st["users_by_id"].get(rep_id)
    if not target:
        raise HTTPException(status_code=404, detail="Rep not found")
    if not can_manage_yard_user(actor, target):
        raise HTTPException(status_code=403, detail="You cannot manage that account")
    site_id = str(body.get("site_id") or "")
    if site_id:
        _site_in_org(st, site_id, effective_org(actor))
    old_site = str(target.get("site_id") or "")
    if old_site and old_site != site_id:
        # Freeze past calls to the location the rep was working at when they
        # happened; new calls follow the new assignment.
        for call in st.get("calls", []):
            if call.get("rep_id") == rep_id and not call.get("site_id"):
                call["site_id"] = old_site
    target["site_id"] = site_id
    store.save_state()
    return public_user(target)


# Sites (Lots)
@router.get("/api/sites")
def get_sites(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    data = dict(st.get("sites_data", {}))
    sites = []
    for site in data.get("sites", []):
        if org_id and _site_org(site) != org_id:
            continue
        item = dict(site)
        sid = item["id"]
        item["reps"] = sum(
            1 for usr in st["users_by_id"].values()
            if usr.get("site_id") == sid and not usr.get("disabled")
            and (not org_id or usr.get("org_id") == org_id)
        )
        sites.append(item)
    data["sites"] = sites
    data["my_site_id"] = next(
        (
            s["id"]
            for s in sites
            if s.get("manager_id") == u.get("id")
            and u.get("role") not in ("owner", "sales_manager", "inventory_manager")
        ),
        "",
    )
    return data


@router.post("/api/sites")
def create_site(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    _require_manager(u)
    org_id = resolve_write_org(u, body.get("org_id"))
    name = str(body.get("name") or "").strip()[:120]
    if not name:
        raise HTTPException(status_code=400, detail="Give the site a name")
    sid = str(uuid.uuid4())
    new_site = {
        "id": sid,
        "org_id": org_id,
        "name": name,
        "reps": 0,
        "manager_id": "",
        "manager_name": "",
        "goal": 0.0,
        "month_revenue": 0.0,
    }
    st.setdefault("sites_data", {}).setdefault("sites", []).append(new_site)
    store.save_state()
    return get_sites(request)


@router.patch("/api/sites/{site_id}")
def update_site(site_id: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    _require_manager(u)
    org_id = effective_org(u)
    site = _site_in_org(st, site_id, org_id)
    if "name" in body:
        name = str(body.get("name") or "").strip()[:120]
        if not name:
            raise HTTPException(status_code=400, detail="Give the site a name")
        site["name"] = name
    store.save_state()
    return get_sites(request)


@router.patch("/api/sites/{site_id}/goal")
def update_site_goal(site_id: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    _require_manager(u)
    org_id = effective_org(u)
    site = _site_in_org(st, site_id, org_id)
    try:
        goal = float(body.get("goal") or 0.0)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Goal must be a number")
    if goal < 0 or goal > 1_000_000_000:
        raise HTTPException(status_code=400, detail="Goal is out of range")
    site["goal"] = goal
    store.save_state()
    return get_sites(request)


@router.patch("/api/sites/{site_id}/manager")
def update_site_manager(site_id: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    _require_manager(u)
    org_id = effective_org(u)
    site = _site_in_org(st, site_id, org_id)
    mid = str(body.get("manager_id") or "")
    if mid:
        muser = st["users_by_id"].get(mid)
        if not muser or muser.get("disabled"):
            raise HTTPException(status_code=400, detail="Unknown manager")
        assert_same_org(u, muser.get("org_id"))
        if muser.get("role") not in ("owner", "sales_manager", "inventory_manager", "manager", "master", "admin"):
            raise HTTPException(status_code=400, detail="That user is not a manager")
    else:
        muser = {}
    site["manager_id"] = mid
    site["manager_name"] = muser.get("name", "")
    store.save_state()
    return get_sites(request)


@router.delete("/api/sites/{site_id}")
def delete_site(site_id: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    _require_manager(u)
    org_id = effective_org(u)
    site = _site_in_org(st, site_id, org_id)
    st["sites_data"]["sites"] = [s for s in st.get("sites_data", {}).get("sites", []) if s.get("id") != site_id]
    for usr in st["users_by_id"].values():
        if usr.get("site_id") == site_id and (not org_id or usr.get("org_id") == org_id):
            usr["site_id"] = ""
    store.save_state()
    return get_sites(request)


@router.get("/api/sites/managers")
def get_site_managers(request: Request) -> list[dict[str, Any]]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    return [
        public_user(usr)
        for usr in st["users_by_id"].values()
        if usr.get("role") in ("owner", "sales_manager", "inventory_manager", "manager", "master", "admin")
        and (not org_id or usr.get("org_id") == org_id)
    ]


@router.get("/api/sites/leaderboard")
def get_sites_leaderboard(
    request: Request,
    days: int = Query(30),
    site_id: Optional[str] = Query(None),
) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    site_id = scoped_site_id(u, site_id)
    sites = [
        s for s in st.get("sites_data", {}).get("sites", [])
        if not org_id or _site_org(s) == org_id
    ]
    if site_id:
        sites = [s for s in sites if s.get("id") == site_id]
    now = dt.datetime.now(dt.timezone.utc)
    month = now.strftime("%Y-%m")
    cutoff = (now - dt.timedelta(days=max(1, days))).strftime("%Y-%m-%dT%H:%M:%SZ")
    all_calls = [
        c for c in st.get("calls", [])
        if not org_id or c.get("org_id") == org_id
    ]
    rep_site = {
        uid: str(usr.get("site_id") or "")
        for uid, usr in st.get("users_by_id", {}).items()
        if not org_id or usr.get("org_id") == org_id
    }

    def call_site(call: dict[str, Any]) -> str:
        return str(call.get("site_id") or rep_site.get(call.get("rep_id"), "") or "")

    def row_for(site: dict[str, Any] | None) -> dict[str, Any]:
        sid = str((site or {}).get("id") or "")
        name = str((site or {}).get("name") or "No location")
        site_calls = [c for c in all_calls if call_site(c) == sid and (c.get("created_at") or "") >= cutoff]
        sales = ya.sales_calls_only(st, site_calls)
        won = [c for c in sales if c.get("outcome") == "won"]
        month_calls = [c for c in all_calls if call_site(c) == sid and (c.get("created_at") or "")[:7] == month]
        month_sales = ya.sales_calls_only(st, month_calls)
        month_won = [c for c in month_sales if c.get("outcome") == "won"]
        reps = sum(
            1 for usr in st.get("users_by_id", {}).values()
            if str(usr.get("site_id") or "") == sid
            and usr.get("role") in ("rep", "sales_rep")
            and not usr.get("disabled")
            and (not org_id or usr.get("org_id") == org_id)
        )
        return {
            "site_id": sid,
            "name": name,
            "reps": reps,
            "calls": len(site_calls),
            "sales_calls": len(sales),
            "won": len(won),
            "close_rate": round(len(won) / max(1, len(sales)) * 100, 1) if sales else 0.0,
            "revenue": round(sum(float(c.get("order_value") or 0.0) for c in won), 2),
            "goal": float((site or {}).get("goal") or 0.0),
            "month_revenue": round(sum(float(c.get("order_value") or 0.0) for c in month_won), 2),
        }

    rows = [row_for(site) for site in sites]
    if not site_id:
        no_site = row_for(None)
        if no_site["calls"] or no_site["reps"]:
            rows.append(no_site)
    return {"days": days, "rows": rows, "month": month}
