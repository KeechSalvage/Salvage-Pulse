from __future__ import annotations

import copy
import datetime as dt
import hashlib
import io
import json
import math
import os
import secrets
import struct
import threading
import uuid
import wave
from collections import Counter, defaultdict
from typing import Any

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("DATA_DIR") or os.path.join(BACKEND_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)

SEED_PATH = os.path.join(BACKEND_DIR, "preview_seed.json")
STATE_PATH = os.path.join(DATA_DIR, "preview_state.json")

INITIAL_MASTER_EMAIL = os.environ.get("INITIAL_MASTER_EMAIL", "brettk@salvagepulsepro.com").strip().lower()
INITIAL_MASTER_NAME = os.environ.get("INITIAL_MASTER_NAME", "Brett K").strip()
INITIAL_MASTER_PASSWORD = os.environ.get("INITIAL_MASTER_PASSWORD", "").strip()


def hash_password(password: str) -> str:
    salt = secrets.token_hex(8)
    h = hashlib.sha256((salt + password).encode("utf-8")).hexdigest()
    return f"{salt}:{h}"


def verify_password(password: str, stored: str | None) -> bool:
    if not stored:
        return True
    if ":" in stored:
        salt, h = stored.split(":", 1)
        return hashlib.sha256((salt + password).encode("utf-8")).hexdigest() == h
    return password == stored


_LOCK = threading.RLock()
_STATE: dict[str, Any] | None = None
_STATE_MTIME: float = 0.0


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def today_str() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")


def current_month_str() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m")


def generate_wav_bytes(duration_sec: float = 4.0, sample_rate: int = 16000) -> bytes:
    """Generate a clean, pleasant two-tone telephone audio recording WAV."""
    buf = io.BytesIO()
    num_samples = int(duration_sec * sample_rate)
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        frames = bytearray()
        for i in range(num_samples):
            t = i / sample_rate
            envelope = math.sin(math.pi * min(1.0, (t % 1.0))) * 0.25
            freq = 440.0 if int(t * 2) % 2 == 0 else 523.25
            val = int(32767 * envelope * math.sin(2 * math.pi * freq * t))
            frames.extend(struct.pack("<h", val))
        wf.writeframes(bytes(frames))
    return buf.getvalue()


def synthesize_call_details(call_summary: dict[str, Any], full_existing: dict[str, Any] | None = None) -> dict[str, Any]:
    """Ensure a Call object has all fields required by the Call interface in types.ts."""
    base = dict(full_existing) if full_existing else {}
    merged = {**base, **call_summary}

    score = merged.get("overall_score") or 76
    rep_name = merged.get("rep_name") or "Sales Rep"
    cust_name = merged.get("customer_name") or "Customer"
    vehicle = merged.get("vehicle") or "2018 Ford F-150"
    part = merged.get("part_requested") or "Assembly"
    outcome = merged.get("outcome") or "n/a"
    cat = merged.get("category") or "Part Inquiry/Quote"

    if not merged.get("customer_phone"):
        # Deterministic phone from customer name
        h = abs(hash(cust_name)) % 9000000 + 1000000
        merged["customer_phone"] = f"+1555{h:07d}"

    if not merged.get("turns"):
        turns = [
            {
                "speaker": rep_name,
                "text": f"Thanks for calling Salvage Pulse Pro, this is {rep_name.split()[0]}. How can I help you today?",
            },
            {
                "speaker": cust_name,
                "text": f"Hi {rep_name.split()[0]}, this is {cust_name}. I'm looking for a {part.lower() if part else 'part'} for a {vehicle}."
                if vehicle
                else f"Hi {rep_name.split()[0]}, this is {cust_name} calling to check on availability and pricing.",
            },
            {
                "speaker": rep_name,
                "text": f"Let me pull that up in Hollander right now for your {vehicle or 'vehicle'}. Yes, we have an A-grade unit tested on the rack with a 90-day standard warranty.",
            },
            {
                "speaker": cust_name,
                "text": "Awesome, what's the price on it and when can we get it delivered?",
            },
            {
                "speaker": rep_name,
                "text": (
                    f"We're at ${int(merged.get('order_value') or merged.get('quoted_value') or 350)} delivered to your bay tomorrow morning, and we also have the extended 1-year parts & labor warranty option. Want me to put that on the truck for you?"
                ),
            },
            {
                "speaker": cust_name,
                "text": (
                    "Let's do it, put it on the truck for tomorrow morning. Thanks!"
                    if outcome == "won"
                    else "Let me check with my customer on the quote and call you right back."
                ),
            },
        ]
        merged["turns"] = turns
        merged["transcript"] = "\n".join(f"{t['speaker']}: {t['text']}" for t in turns)

    if not merged.get("metrics"):
        s = max(55, min(98, int(score) if score else 78))
        merged["metrics"] = {
            "greeting": min(100, s + 6),
            "needs_discovery": min(100, s + 4),
            "product_knowledge": min(100, s + 5),
            "upsell_crosssell": max(45, s - 8),
            "objection_handling": s,
            "closing": min(100, s + (8 if outcome == "won" else -4)),
            "compliance_warranty": max(50, s - 3),
            "tone_empathy": min(100, s + 7),
        }

    if not merged.get("strengths"):
        merged["strengths"] = [
            f"Clear yard greeting and fast Hollander lookup on {vehicle or 'the requested unit'}",
            "Confirmed part grade and testing notes clearly",
        ]
    if not merged.get("improvements"):
        merged["improvements"] = [
            "Offer companion parts or extended labor warranty earlier in the quote",
            "Confirm exact delivery window and bay address before hanging up",
        ]
    if not merged.get("insights"):
        merged["insights"] = [
            f"Category: {cat}",
            f"Customer inquired about {part or 'parts'} for {vehicle or 'vehicle'}.",
        ]
    if not merged.get("coaching_feedback"):
        merged["coaching_feedback"] = (
            f"Strong call handling by {rep_name} with {cust_name}. Keep pitching the 90-day/1-year warranty and companion parts on every quote."
        )
    if "keyword_hits" not in merged or merged["keyword_hits"] is None:
        merged["keyword_hits"] = [{"keyword": "Warranty", "count": 1}]
    if "has_audio" not in merged:
        merged["has_audio"] = True
    if "error" not in merged:
        merged["error"] = ""
    if "trackers" not in merged:
        merged["trackers"] = ["Warranty Mentioned", "Hollander Checked"]
    if "external_url" not in merged:
        merged["external_url"] = ""
    if "delivery_kind" not in merged:
        merged["delivery_kind"] = ""
    if "delivery_score" not in merged:
        merged["delivery_score"] = None
    return merged


def _build_initial_state() -> dict[str, Any]:
    seed: dict[str, Any] = {}
    if os.path.exists(SEED_PATH):
        try:
            with open(SEED_PATH, "r", encoding="utf-8") as fh:
                seed = json.load(fh)
        except Exception:
            seed = {}

    master_user = {
        "id": "master-brettk",
        "email": INITIAL_MASTER_EMAIL,
        "name": INITIAL_MASTER_NAME,
        "role": "master",
        "title": "Founder & Master Admin",
        "avatar_url": "",
        "org_id": "",
        "impersonated_by": "",
        "disabled": False,
        "site_id": "",
        "must_change_password": False,
        "password_hash": hash_password(INITIAL_MASTER_PASSWORD) if INITIAL_MASTER_PASSWORD else "",
    }

    users_by_id: dict[str, dict[str, Any]] = {
        master_user["id"]: master_user,
    }

    state: dict[str, Any] = {
        "seed": seed,
        "current_user_id": None,
        "sessions": {},
        "users_by_id": users_by_id,
        "org": {
            "id": "",
            "name": "Salvage Pulse",
            "plan": "enterprise",
            "status": "active",
            "access": True,
        },
        "branding": {
            "yard_name": "Salvage Pulse",
            "accent": "",
            "default_mode": "dark",
            "logo_url": "",
            "user_mode": "dark",
            "mode": "dark",
        },
        "calls": [],
        "full_calls": {},
        "full_customers": {},
        "customer_notes": {},
        "customer_tags": {},
        "arrivals": [],
        "callbacks_open": [],
        "callbacks_resolved": [],
        "callback_lists": [],
        "keywords": [],
        "keyword_suggestions": [],
        "watchlist": [],
        "watchlist_email": {"enabled": True, "recipient_email": "", "last_sent_at": None},
        "roleplay_scenarios": [],
        "roleplay_sessions": [],
        "roleplay_assignments": [],
        "roleplay_scoreboard": {"scenarios": [], "rows": []},
        "sites_data": {"sites": [], "limit": 2, "plan_name": "Enterprise", "my_site_id": ""},
        "settings_business": {"avg_order_value": None, "yard_name": None},
        "settings_coverage": {"max_away": 2, "warn_days_ahead": 3},
        "settings_delivery_tips": {"date_given": "", "address_confirmed": "", "thanked": ""},
        "settings_digest": {"recipient_email": "", "enabled": False},
        "settings_monthly_report": {"enabled": True, "user_ids": None, "extra_emails": [], "people": []},
        "me_mobile": {
            "mobile": "",
            "days_off": [],
            "vacation_start": None,
            "vacation_end": None,
            "shift_start": "",
            "shift_end": "",
            "held": 0,
        },
        "devices": [],
        "connect_status": {
            "webhook_url": "",
            "ringcentral": {
                "configured": False,
                "connected": False,
                "connected_by": "",
                "last_sync_at": None,
                "last_result": "",
            },
        },
        "sms_status": {
            "live": False,
            "from_number": "",
            "problem": "",
        },
        "layouts": {
            "dashboard": {"page": "dashboard", "order": [], "source": "default"},
            "performance": {"page": "performance", "order": [], "source": "default"},
            "reports": {"page": "reports", "order": [], "source": "default"},
        },
        "custom_layouts": {},
        "time_off": [],
        "cover_requests": [],
        "contact_messages": [],
        "cleanup_batches": [],
        "cleanup_trash": [],
        "recent_uploads": [],
        "rep_login_log": [],
        "demo_login_switch": {
            "enabled": False,
            "changed_by": master_user["name"],
            "changed_at": now_iso(),
        },
        "admin_orgs": [],
        "admin_audit": [
            {"at": now_iso(), "actor": master_user["name"], "action": "initialized fresh platform instance", "target": "Platform Console"},
        ],
        "admin_staff": [
            {
                "id": master_user["id"],
                "email": master_user["email"],
                "name": master_user["name"],
                "role": "master",
                "disabled": False,
                "must_change_password": False,
                "created_at": now_iso(),
                "you": True,
                "google_linked": True,
                "email_bounced_at": None,
                "email_bounce_reason": "",
            }
        ],
        "staff_lockdown": {
            "enabled": False,
            "you_signed_in_with_google": True,
            "staff_domain": master_user["email"].split("@")[-1] if "@" in master_user["email"] else "salvagepulsepro.com",
            "google_linked": 1,
            "staff_total": 1,
        },
        "trial_reminders": {
            "enabled": True,
            "upcoming": [],
        },
    }
    return state


def _migrate_roles(st: dict[str, Any]) -> dict[str, Any]:
    users = st.get("users_by_id", {})
    for uid, u in users.items():
        if u.get("role") == "manager":
            if "Owner" in u.get("title", ""):
                u["role"] = "owner"
            elif "Sales" in u.get("title", ""):
                u["role"] = "sales_manager"
            elif "Inventory" in u.get("title", ""):
                u["role"] = "inventory_manager"
            else:
                u["role"] = "sales_manager"
    return st


KEECH_ORG_ID = "org-keech-salvage"

KEECH_USERS: dict[str, dict[str, Any]] = {
    "user-keech-owner": {
        "id": "user-keech-owner",
        "email": "owner@keechauto.com",
        "name": "Dale Miller",
        "role": "owner",
        "title": "Yard Owner",
        "avatar_url": "",
        "org_id": KEECH_ORG_ID,
        "impersonated_by": "",
        "disabled": False,
        "site_id": "",
        "must_change_password": False,
        "password_hash": hash_password("owner"),
    },
    "user-keech-sales-mgr": {
        "id": "user-keech-sales-mgr",
        "email": "salesmanager@keechauto.com",
        "name": "Marcus Reed",
        "role": "sales_manager",
        "title": "Sales Manager",
        "avatar_url": "",
        "org_id": KEECH_ORG_ID,
        "impersonated_by": "",
        "disabled": False,
        "site_id": "",
        "must_change_password": False,
        "password_hash": hash_password("salesmanager"),
    },
    "user-keech-inv-mgr": {
        "id": "user-keech-inv-mgr",
        "email": "inventory@keechauto.com",
        "name": "Rick Martinez",
        "role": "inventory_manager",
        "title": "Inventory Manager",
        "avatar_url": "",
        "org_id": KEECH_ORG_ID,
        "impersonated_by": "",
        "disabled": False,
        "site_id": "",
        "must_change_password": False,
        "password_hash": hash_password("inventory"),
    },
    "user-keech-rep": {
        "id": "user-keech-rep",
        "email": "rep1@keechauto.com",
        "name": "Tyler Grant",
        "role": "rep",
        "title": "Sales Representative",
        "avatar_url": "",
        "org_id": KEECH_ORG_ID,
        "impersonated_by": "",
        "disabled": False,
        "site_id": "",
        "must_change_password": False,
        "password_hash": hash_password("rep1"),
    },
    "user-keech-rep-2": {
        "id": "user-keech-rep-2",
        "email": "rep2@keechauto.com",
        "name": "Cody Miller",
        "role": "rep",
        "title": "Sales Representative",
        "avatar_url": "",
        "org_id": KEECH_ORG_ID,
        "impersonated_by": "",
        "disabled": False,
        "site_id": "",
        "must_change_password": False,
        "password_hash": hash_password("rep2"),
    },
    "user-keech-rep-3": {
        "id": "user-keech-rep-3",
        "email": "rep3@keechauto.com",
        "name": "Jake Bradley",
        "role": "rep",
        "title": "Sales Representative",
        "avatar_url": "",
        "org_id": KEECH_ORG_ID,
        "impersonated_by": "",
        "disabled": False,
        "site_id": "",
        "must_change_password": False,
        "password_hash": hash_password("rep3"),
    },
    "user-keech-rep-4": {
        "id": "user-keech-rep-4",
        "email": "rep4@keechauto.com",
        "name": "Austin Davis",
        "role": "rep",
        "title": "Sales Representative",
        "avatar_url": "",
        "org_id": KEECH_ORG_ID,
        "impersonated_by": "",
        "disabled": False,
        "site_id": "",
        "must_change_password": False,
        "password_hash": hash_password("rep4"),
    },
    "user-keech-admin": {
        "id": "user-keech-admin",
        "email": "admin@keechauto.com",
        "name": "Brett Keech",
        "role": "master",
        "title": "Platform Master Admin",
        "avatar_url": "",
        "org_id": "",
        "impersonated_by": "",
        "disabled": False,
        "site_id": "",
        "must_change_password": False,
        "password_hash": hash_password("admin"),
    },
}

KEECH_ORG: dict[str, Any] = {
    "id": KEECH_ORG_ID,
    "name": "Keech's Auto Salvage",
    "yard_name": "Keech's Auto Salvage",
    "plan": "enterprise",
    "status": "active",
    "trial_ends_at": None,
    "created_at": "2026-09-01T00:00:00Z",
    "users": 8,
    "calls": 48,
    "ringcentral_connected": False,
    "card_on_file": True,
    "blocked": False,
    "cancel_reason": "",
    "discount": None,
    "sites": 1,
    "max_sites": 2,
    "extra_sites": 0,
}


def _ensure_demo_users(st: dict[str, Any]) -> dict[str, Any]:
    users = st.setdefault("users_by_id", {})
    for uid, udata in KEECH_USERS.items():
        if uid not in users:
            users[uid] = copy.deepcopy(udata)
        else:
            users[uid]["email"] = udata["email"]
            users[uid]["name"] = udata["name"]
            users[uid]["org_id"] = udata.get("org_id", "")
            users[uid]["password_hash"] = udata["password_hash"]
            if not users[uid].get("role"):
                users[uid]["role"] = udata["role"]

    admin_orgs = st.setdefault("admin_orgs", [])
    if not any(o.get("id") == KEECH_ORG_ID for o in admin_orgs):
        admin_orgs.insert(0, copy.deepcopy(KEECH_ORG))
    else:
        for o in admin_orgs:
            if o.get("id") == KEECH_ORG_ID:
                o["name"] = "Keech's Auto Salvage"
                o["yard_name"] = "Keech's Auto Salvage"
                o["users"] = 8

    st.setdefault("org", {})["name"] = "Keech's Auto Salvage"
    st.setdefault("branding", {})["yard_name"] = "Keech's Auto Salvage"

    # Legacy un-scoped calls belong to the Keech demo yard
    calls = st.setdefault("calls", [])
    if calls:
        generic = [
            c for c in calls
            if not str(c.get("id", "")).startswith("demo-") and not str(c.get("id", "")).startswith("hist-") and c.get("org_id") in (None, "", KEECH_ORG_ID)
        ]
        for c in generic:
            # Legacy test calls belong to the owner so they don't skew rep rankings
            c["org_id"] = KEECH_ORG_ID
            c["rep_id"] = "user-keech-owner"
            c["rep_name"] = "Dale Miller"

    # Seed 10 curated demo calls for each of the four reps (idempotent)
    from demo_tyler_calls import build_demo_calls
    from demo_team_calls import TEAM
    demo_sets = list(build_demo_calls())
    for member in TEAM:
        demo_sets += build_demo_calls(member["scenarios"], member["rep_id"], member["rep_name"], member["prefix"])
    existing_ids = {c.get("id"): c for c in calls}
    full_calls = st.setdefault("full_calls", {})
    for summary, full in demo_sets:
        dur = summary["duration_sec"]
        if summary["id"] in existing_ids:
            existing_ids[summary["id"]].update({"has_audio": True, "audio_mime": "audio/wav", "duration_sec": dur})
        else:
            calls.append(summary)
        full_calls.setdefault(summary["id"], full).update({"has_audio": True, "audio_mime": "audio/wav", "duration_sec": dur})
    from demo_extra_calls import build_extra_calls
    for summary, full in build_extra_calls():
        if summary["id"] not in existing_ids:
            calls.append(summary)
        full_calls.setdefault(summary["id"], full)
    calls.sort(key=lambda c: c.get("created_at") or "", reverse=True)

    st.setdefault("branding_by_org", {})[KEECH_ORG_ID] = {
        "yard_name": "Keech's Auto Salvage",
        "accent": "",
        "default_mode": "dark",
        "logo_url": "",
        "user_mode": "dark",
        "mode": "dark",
    }

    # Disable demo mode on login screen as requested
    st.setdefault("demo_login_switch", {})["enabled"] = False
    return st


def _ensure_roleplay_scenarios(st: dict[str, Any]) -> dict[str, Any]:
    if not st.get("roleplay_scenarios"):
        if os.path.exists(SEED_PATH):
            try:
                with open(SEED_PATH, "r", encoding="utf-8") as f:
                    seed = json.load(f)
                    scs = seed.get("/roleplay/scenarios", [])
                    if scs:
                        st["roleplay_scenarios"] = scs
            except Exception:
                pass
    return st


def get_state() -> dict[str, Any]:
    global _STATE, _STATE_MTIME
    with _LOCK:
        state_file = STATE_PATH
        legacy_path = os.path.join(BACKEND_DIR, "preview_state.json")
        if not os.path.exists(state_file) and os.path.exists(legacy_path):
            state_file = legacy_path
        file_mtime = os.path.getmtime(state_file) if os.path.exists(state_file) else 0.0
        if _STATE is None or (file_mtime > 0 and file_mtime > _STATE_MTIME):
            if os.path.exists(state_file):
                try:
                    with open(state_file, "r", encoding="utf-8") as fh:
                        _STATE = json.load(fh)
                        _STATE_MTIME = file_mtime
                except Exception:
                    if _STATE is None:
                        _STATE = _build_initial_state()
            else:
                _STATE = _build_initial_state()
            _migrate_roles(_STATE)
            _ensure_roleplay_scenarios(_STATE)
            _ensure_demo_users(_STATE)
        return _STATE


def save_state() -> None:
    global _STATE_MTIME
    with _LOCK:
        if _STATE is None:
            return
        # Save a lightweight snapshot excluding the static seed copy if needed, or full state
        try:
            with open(STATE_PATH, "w", encoding="utf-8") as fh:
                json.dump(_STATE, fh)
            _STATE_MTIME = os.path.getmtime(STATE_PATH) if os.path.exists(STATE_PATH) else 0.0
        except Exception:
            pass
