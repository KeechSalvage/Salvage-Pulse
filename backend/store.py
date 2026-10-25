from __future__ import annotations

import copy
import datetime as dt
import io
import json
import math
import os
import struct
import threading
import uuid
import wave
from collections import Counter, defaultdict
from typing import Any

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("DATA_DIR") or (
    os.path.join(BACKEND_DIR, "data") if os.path.isdir(os.path.join(BACKEND_DIR, "data")) else BACKEND_DIR
)
os.makedirs(DATA_DIR, exist_ok=True)

SEED_PATH = os.path.join(BACKEND_DIR, "preview_seed.json")
STATE_PATH = os.path.join(DATA_DIR, "preview_state.json")


_LOCK = threading.RLock()
_STATE: dict[str, Any] | None = None


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
    with open(SEED_PATH, "r", encoding="utf-8") as fh:
        seed = json.load(fh)

    manager_user = seed["_me"]
    org_id = manager_user["org_id"]
    reps: list[dict[str, Any]] = seed.get("/users/reps?include_disabled=true") or seed.get("/users/reps") or []
    managers: list[dict[str, Any]] = seed.get("/sites/managers") or [manager_user]

    # Build users map (all managers + reps + platform master admin)
    users_by_id: dict[str, dict[str, Any]] = {}
    for u in managers + reps:
        users_by_id[u["id"]] = dict(u)
    if manager_user["id"] not in users_by_id:
        users_by_id[manager_user["id"]] = dict(manager_user)

    # Ensure Linda Carter also has access to Admin Console if needed, plus a dedicated master account
    master_user = {
        "id": "master-ben-keech",
        "email": "benkeech800@gmail.com",
        "name": "Ben Keech",
        "role": "master",
        "title": "Founder & Master Admin",
        "avatar_url": "",
        "org_id": org_id,
        "impersonated_by": "",
        "disabled": False,
        "site_id": "",
        "must_change_password": False,
    }
    users_by_id[master_user["id"]] = master_user

    # Sample yards & users for multi-yard management & sorting
    org_northside_id = "org-northside-salvage"
    org_apex_id = "org-apex-trucks"

    users_by_id["user-dave-miller"] = {
        "id": "user-dave-miller",
        "email": "dave@northsideauto.com",
        "name": "Dave Miller",
        "role": "manager",
        "title": "Yard Manager",
        "avatar_url": "",
        "org_id": org_northside_id,
        "impersonated_by": "",
        "disabled": False,
        "site_id": "",
        "must_change_password": False,
    }
    users_by_id["user-sarah-jenkins"] = {
        "id": "user-sarah-jenkins",
        "email": "sarah@northsideauto.com",
        "name": "Sarah Jenkins",
        "role": "rep",
        "title": "Inside Sales",
        "avatar_url": "",
        "org_id": org_northside_id,
        "impersonated_by": "",
        "disabled": False,
        "site_id": "",
        "must_change_password": False,
    }
    users_by_id["user-carlos-gomez"] = {
        "id": "user-carlos-gomez",
        "email": "carlos@northsideauto.com",
        "name": "Carlos Gomez",
        "role": "rep",
        "title": "Parts Specialist",
        "avatar_url": "",
        "org_id": org_northside_id,
        "impersonated_by": "",
        "disabled": False,
        "site_id": "",
        "must_change_password": False,
    }
    users_by_id["user-tom-bradley"] = {
        "id": "user-tom-bradley",
        "email": "tom@apextruckparts.com",
        "name": "Tom Bradley",
        "role": "manager",
        "title": "Operations Manager",
        "avatar_url": "",
        "org_id": org_apex_id,
        "impersonated_by": "",
        "disabled": False,
        "site_id": "",
        "must_change_password": False,
    }
    users_by_id["user-jake-evans"] = {
        "id": "user-jake-evans",
        "email": "jake@apextruckparts.com",
        "name": "Jake Evans",
        "role": "rep",
        "title": "Drivetrain Sales",
        "avatar_url": "",
        "org_id": org_apex_id,
        "impersonated_by": "",
        "disabled": False,
        "site_id": "",
        "must_change_password": False,
    }

    calls: list[dict[str, Any]] = seed.get("/calls", [])
    full_calls: dict[str, dict[str, Any]] = seed.get("_full_calls", {})

    # Enrich the first 15 calls so there are also "analyzed" audio/transcript calls with high visibility
    for idx, c in enumerate(calls[:15]):
        cid = c["id"]
        full_calls[cid] = synthesize_call_details(c, full_calls.get(cid))

    org_info = seed.get("/org/me", {})
    admin_org_default = {
        "id": org_id,
        "name": org_info.get("name", "Salvage Pulse Pro"),
        "plan": org_info.get("plan", "enterprise"),
        "status": org_info.get("status", "active"),
        "trial_ends_at": org_info.get("trial_ends_at"),
        "created_at": "2026-06-01T12:00:00Z",
        "users": len([u for u in users_by_id.values() if u.get("org_id") == org_id]),
        "calls": len(calls),
        "ringcentral_connected": True,
        "card_on_file": True,
        "blocked": False,
        "cancel_reason": "",
        "discount": None,
        "sites": 0,
        "max_sites": org_info.get("max_sites", 2),
        "extra_sites": org_info.get("extra_sites", 0),
    }
    admin_org_northside = {
        "id": org_northside_id,
        "name": "Northside Auto Salvage",
        "plan": "pro",
        "status": "active",
        "trial_ends_at": None,
        "created_at": "2026-07-15T10:00:00Z",
        "users": 3,
        "calls": 420,
        "ringcentral_connected": True,
        "card_on_file": True,
        "blocked": False,
        "cancel_reason": "",
        "discount": None,
        "sites": 1,
        "max_sites": 1,
        "extra_sites": 0,
    }
    admin_org_apex = {
        "id": org_apex_id,
        "name": "Apex Truck & Auto Parts",
        "plan": "starter",
        "status": "trialing",
        "trial_ends_at": "2026-11-01T23:59:59Z",
        "created_at": "2026-10-18T14:30:00Z",
        "users": 2,
        "calls": 115,
        "ringcentral_connected": False,
        "card_on_file": False,
        "blocked": False,
        "cancel_reason": "",
        "discount": None,
        "sites": 1,
        "max_sites": 1,
        "extra_sites": 0,
    }

    state: dict[str, Any] = {
        "seed": seed,
        "current_user_id": manager_user["id"],
        "sessions": {},
        "users_by_id": users_by_id,
        "org": org_info,
        "branding": seed.get("/branding", {
            "yard_name": "Salvage Pulse Pro",
            "accent": "",
            "default_mode": "dark",
            "logo_url": "",
            "user_mode": "dark",
            "mode": "dark",
        }),
        "calls": calls,
        "full_calls": full_calls,
        "full_customers": seed.get("_full_customers", {}),
        "customer_notes": {},
        "customer_tags": {},
        "arrivals": seed.get("/arrivals", []),
        "callbacks_open": seed.get("/callbacks?status=open", []),
        "callbacks_resolved": seed.get("/callbacks?status=resolved", []),
        "callback_lists": seed.get("/callback-lists", []),
        "keywords": seed.get("/keywords", []),
        "keyword_suggestions": seed.get("/keywords/suggestions", []),
        "watchlist": seed.get("/watchlist", []),
        "watchlist_email": seed.get("/watchlist/email", {"enabled": True, "recipient_email": "", "last_sent_at": None}),
        "roleplay_scenarios": seed.get("/roleplay/scenarios", []),
        "roleplay_sessions": seed.get("/roleplay/sessions", []),
        "roleplay_assignments": seed.get("/roleplay/assignments", []),
        "roleplay_scoreboard": seed.get("/roleplay/scoreboard", {"scenarios": [], "rows": []}),
        "sites_data": seed.get("/sites", {"sites": [], "limit": 2, "plan_name": "Enterprise", "my_site_id": ""}),
        "settings_business": seed.get("/settings/business", {"avg_order_value": None, "yard_name": None}),
        "settings_coverage": seed.get("/settings/coverage", {"max_away": 2, "warn_days_ahead": 3}),
        "settings_delivery_tips": seed.get("/settings/delivery-tips", {"date_given": "", "address_confirmed": "", "thanked": ""}),
        "settings_digest": seed.get("/settings/digest", {"recipient_email": "", "enabled": False}),
        "settings_monthly_report": seed.get("/settings/monthly-report", {"enabled": True, "user_ids": None, "extra_emails": [], "people": []}),
        "me_mobile": seed.get("/me/mobile", {
            "mobile": "",
            "days_off": [],
            "vacation_start": None,
            "vacation_end": None,
            "shift_start": "",
            "shift_end": "",
            "held": 0,
        }),
        "devices": seed.get("/auth/devices", []),
        "connect_status": seed.get("/connect/status", {
            "webhook_url": "https://recycler-call-scorer.preview.emergentagent.com/api/connect/webhook/jA9v51FOjGic1dNsqLoP0zzSE9Dd-8l-",
            "ringcentral": {
                "configured": False,
                "connected": False,
                "connected_by": "",
                "last_sync_at": None,
                "last_result": "",
            },
        }),
        "sms_status": seed.get("/sms/status", {
            "live": False,
            "from_number": "…3742",
            "problem": "The 'text from' number isn't a phone number on your Twilio account — buy or port a number in Twilio, then update it.",
        }),
        "layouts": {
            "dashboard": seed.get("/layouts/dashboard", {"page": "dashboard", "order": [], "source": "default"}),
            "performance": seed.get("/layouts/performance", {"page": "performance", "order": [], "source": "default"}),
            "reports": {"page": "reports", "order": [], "source": "default"},
        },
        "custom_layouts": {},
        "time_off": seed.get("/time-off?month=2026-04", []),
        "cover_requests": seed.get("/cover-requests", []),
        "contact_messages": seed.get("/contact/mine", []),
        "cleanup_batches": seed.get("/call-cleanup/batches", []),
        "cleanup_trash": seed.get("/call-cleanup/trash", []),
        "recent_uploads": seed.get("/calls/uploads/recent", []),
        "rep_login_log": seed.get("/users/reps/login-log", []),
        "demo_login_switch": {
            "enabled": True,
            "changed_by": "Ben Keech",
            "changed_at": "2026-10-01T12:00:00Z",
        },
        "admin_orgs": [admin_org_default, admin_org_northside, admin_org_apex],
        "admin_audit": [
            {"at": "2026-10-24T15:30:00Z", "actor": "Linda Carter", "action": "synced RingCentral call log", "target": "Salvage Pulse Pro"},
            {"at": "2026-10-22T10:15:00Z", "actor": "Ben Keech", "action": "enabled Enterprise plan", "target": "Salvage Pulse Pro"},
        ],
        "admin_staff": [
            {
                "id": "master-ben-keech",
                "email": "benkeech800@gmail.com",
                "name": "Ben Keech",
                "role": "master",
                "disabled": False,
                "must_change_password": False,
                "created_at": "2026-05-01T00:00:00Z",
                "you": True,
                "google_linked": True,
                "email_bounced_at": None,
                "email_bounce_reason": "",
            }
        ],
        "staff_lockdown": {
            "enabled": False,
            "you_signed_in_with_google": True,
            "staff_domain": "salvagepulse.com",
            "google_linked": 1,
            "staff_total": 1,
        },
        "trial_reminders": {
            "enabled": True,
            "upcoming": [],
        },
    }
    return state


def get_state() -> dict[str, Any]:
    global _STATE
    with _LOCK:
        if _STATE is None:
            if os.path.exists(STATE_PATH):
                try:
                    with open(STATE_PATH, "r", encoding="utf-8") as fh:
                        _STATE = json.load(fh)
                except Exception:
                    _STATE = _build_initial_state()
            else:
                _STATE = _build_initial_state()
        return _STATE


def save_state() -> None:
    with _LOCK:
        if _STATE is None:
            return
        # Save a lightweight snapshot excluding the static seed copy if needed, or full state
        try:
            with open(STATE_PATH, "w", encoding="utf-8") as fh:
                json.dump(_STATE, fh)
        except Exception:
            pass
