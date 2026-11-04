from __future__ import annotations

import copy
import datetime as dt
import hashlib
import io
import json
import math
import os
import re
import secrets
import struct
import threading
import uuid
import wave
from collections import Counter, defaultdict
from typing import Any

import passwords
from call_categories import CATEGORIES, migrate_call_taxonomy

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("DATA_DIR") or os.path.join(BACKEND_DIR, "data")
os.makedirs(DATA_DIR, mode=0o700, exist_ok=True)
try:
    os.chmod(DATA_DIR, 0o700)
except OSError:
    pass

SEED_PATH = os.path.join(BACKEND_DIR, "preview_seed.json")
STATE_PATH = os.path.join(DATA_DIR, "preview_state.json")
BOOTSTRAP_PASSWORD_PATH = os.path.join(DATA_DIR, "initial_admin_password.txt")

# Platform master accounts.  ``INITIAL_MASTER_EMAILS`` is the authoritative,
# comma-separated list.  ``INITIAL_MASTER_EMAIL`` remains supported as the
# legacy single-account setting.  A fresh install with neither variable gets the
# three platform masters below.
DEFAULT_MASTER_EMAILS = (
    "brettk@salvagepulsepro.com",
    "benk@salvagepulsepro.com",
    "genk@salvagepulsepro.com",
)
_MASTER_NAMES = {
    "brettk@salvagepulsepro.com": "Brett K",
    "benk@salvagepulsepro.com": "Ben K",
    "genk@salvagepulsepro.com": "Gen K",
}
_MASTER_IDS = {
    "brettk@salvagepulsepro.com": "master-brettk",
    "benk@salvagepulsepro.com": "master-benk",
    "genk@salvagepulsepro.com": "master-genk",
}

INITIAL_MASTER_EMAILS = os.environ.get("INITIAL_MASTER_EMAILS", "").strip()
INITIAL_MASTER_NAMES = os.environ.get("INITIAL_MASTER_NAMES", "").strip()
_LEGACY_MASTER_EMAIL = os.environ.get("INITIAL_MASTER_EMAIL", "").strip().lower()
INITIAL_MASTER_EMAIL = (_LEGACY_MASTER_EMAIL or DEFAULT_MASTER_EMAILS[0]).strip().lower()
INITIAL_MASTER_NAME = os.environ.get("INITIAL_MASTER_NAME", "").strip()
INITIAL_MASTER_PASSWORD = os.environ.get("INITIAL_MASTER_PASSWORD", "").strip()
if "\n" in INITIAL_MASTER_PASSWORD or "\r" in INITIAL_MASTER_PASSWORD:
    # A newline would corrupt the credential file; fall back to generated ones.
    INITIAL_MASTER_PASSWORD = ""
SEED_DEMO_DATA = os.environ.get("SEED_DEMO_DATA", "0").lower() in ("1", "true", "yes")


def hash_password(password: str) -> str:
    return passwords.hash_password(password)


def verify_password(password: str, stored: str | None) -> bool:
    return passwords.verify_password(password, stored)


def needs_rehash(stored: str | None) -> bool:
    return passwords.needs_rehash(stored)


def _derive_master_name(email: str) -> str:
    local = (email.split("@", 1)[0] or "Master").strip()
    words = [part for part in re.split(r"[._+-]+", local) if part]
    return " ".join(word[:1].upper() + word[1:] for word in words) or "Master"


def _master_id_for_email(email: str, used: set[str]) -> str:
    known = _MASTER_IDS.get(email)
    if known and known not in used:
        used.add(known)
        return known
    local = (email.split("@", 1)[0] or "master").lower()
    slug = re.sub(r"[^a-z0-9]+", "-", local).strip("-") or "master"
    candidate = known or f"master-{slug}"
    if candidate in used:
        candidate = f"master-{slug}"
    suffix = 2
    while candidate in used:
        candidate = f"master-{slug}-{suffix}"
        suffix += 1
    used.add(candidate)
    return candidate


def _configured_master_accounts() -> list[dict[str, str]]:
    """Return the ordered platform-master accounts configured for this install.

    ``INITIAL_MASTER_EMAILS`` wins.  Otherwise an explicit legacy
    ``INITIAL_MASTER_EMAIL`` is honoured, and a fresh install falls back to the
    three platform masters.
    """
    if INITIAL_MASTER_EMAILS:
        raw_emails = INITIAL_MASTER_EMAILS.split(",")
    elif _LEGACY_MASTER_EMAIL:
        raw_emails = [_LEGACY_MASTER_EMAIL]
    else:
        raw_emails = list(DEFAULT_MASTER_EMAILS)

    emails: list[str] = []
    seen: set[str] = set()
    for raw in raw_emails:
        email = raw.strip().lower()
        if not email or "@" not in email or email in seen:
            continue
        seen.add(email)
        emails.append(email)
    if not emails:
        emails = [DEFAULT_MASTER_EMAILS[0]]

    names = [name.strip() for name in INITIAL_MASTER_NAMES.split(",")] if INITIAL_MASTER_NAMES else []
    used_ids: set[str] = set()
    accounts: list[dict[str, str]] = []
    for index, email in enumerate(emails):
        if index < len(names) and names[index]:
            name = names[index]
        elif len(emails) == 1 and INITIAL_MASTER_NAME:
            name = INITIAL_MASTER_NAME
        else:
            name = _MASTER_NAMES.get(email) or _derive_master_name(email)
        accounts.append(
            {
                "id": _master_id_for_email(email, used_ids),
                "email": email,
                "name": name,
            }
        )
    return accounts


def _read_bootstrap_credentials() -> dict[str, str]:
    """Read ``email -> password`` pairs from the first-run credential file."""
    credentials: dict[str, str] = {}
    try:
        with open(BOOTSTRAP_PASSWORD_PATH, "r", encoding="utf-8") as fh:
            current_email = ""
            for line in fh:
                stripped = line.strip()
                if stripped.lower().startswith("email:"):
                    current_email = stripped.split(":", 1)[1].strip().lower()
                elif stripped.lower().startswith("password:") and current_email:
                    credentials[current_email] = stripped.split(":", 1)[1].strip()
                    current_email = ""
    except OSError:
        return {}
    return credentials


def _write_bootstrap_credentials(credentials: dict[str, str]) -> None:
    """Persist generated first-run passwords for the operator to read."""
    try:
        fd = os.open(BOOTSTRAP_PASSWORD_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write("Salvage Pulse initial platform-master credentials\n")
            fh.write("Sign in and change each password immediately, then delete this file.\n\n")
            for email, password in credentials.items():
                fh.write(f"Email: {email}\n")
                fh.write(f"Password: {password}\n\n")
    except OSError:
        pass


def _bootstrap_credentials(emails: list[str] | None = None) -> dict[str, str]:
    """Return credentials for the requested masters, generating missing ones once.

    ``INITIAL_MASTER_PASSWORD`` applies to the first configured master only, so
    a multi-master deployment never shares one password across accounts.  Pass a
    specific list of emails when adding accounts to an existing state so the
    credential file does not advertise a new password for a master that already
    has a working one.
    """
    accounts = _configured_master_accounts()
    first_email = accounts[0]["email"] if accounts else ""
    if emails is None:
        targets = [account["email"] for account in accounts]
    else:
        targets = [email.strip().lower() for email in emails if email and email.strip()]

    credentials = _read_bootstrap_credentials()
    changed = False
    for email in targets:
        if email in credentials:
            continue
        if email == first_email and INITIAL_MASTER_PASSWORD:
            credentials[email] = INITIAL_MASTER_PASSWORD
        else:
            credentials[email] = secrets.token_urlsafe(18)
        changed = True
    if changed or (targets and not os.path.exists(BOOTSTRAP_PASSWORD_PATH)):
        _write_bootstrap_credentials(credentials)
    return credentials


def _initial_password_for(email: str) -> str:
    """Return a stable initial password for one account, generating it if needed."""
    email = (email or "").strip().lower()
    if not email:
        return secrets.token_urlsafe(18)
    accounts = _configured_master_accounts()
    if accounts and email == accounts[0]["email"] and INITIAL_MASTER_PASSWORD:
        return INITIAL_MASTER_PASSWORD
    credentials = _bootstrap_credentials([email])
    return credentials.get(email) or secrets.token_urlsafe(18)


def _bootstrap_master_password() -> str:
    """Return the first master's initial password, generating and storing it once."""
    accounts = _configured_master_accounts()
    return _initial_password_for(accounts[0]["email"])


def _fallback_seed() -> dict[str, Any]:
    """Minimal seed used on fresh installs where preview_seed.json is absent."""
    return {
        "/meta": {
            "categories": list(CATEGORIES),
            "metrics": [],
        },
        "/billing/plans": [],
        "/billing/compare": {},
    }


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


_METRIC_LABELS = {
    "greeting": "Greeting & Brand",
    "needs_discovery": "Needs Discovery",
    "product_knowledge": "Product Knowledge",
    "upsell_crosssell": "Upsell & Cross-sell",
    "objection_handling": "Objection Handling",
    "closing": "Closing & Next Steps",
    "compliance_warranty": "Warranty & Compliance",
    "courtesy": "Courtesy & Professionalism",
    "tone_empathy": "Courtesy & Professionalism",
}
_METRIC_TIPS = {
    "greeting": "Open with the yard name, your name, and a warm greeting.",
    "needs_discovery": "Ask for the VIN, trim, engine, or Hollander interchange before quoting.",
    "product_knowledge": "Explain condition, testing, mileage, and OEM vs aftermarket differences.",
    "upsell_crosssell": "Offer the matching companion part or extended warranty.",
    "objection_handling": "Acknowledge the price concern, then defend OEM fit and warranty value.",
    "closing": "Ask a direct closing question and confirm pickup or delivery.",
    "compliance_warranty": "State the 90-day warranty and return policy clearly.",
    "courtesy": "Keep a calm, helpful tone and thank the caller.",
    "tone_empathy": "Keep a calm, helpful tone and thank the caller.",
}
_METRIC_STRENGTHS = {
    "greeting": "Opened with a clear yard and rep introduction.",
    "needs_discovery": "Asked good fitment and discovery questions.",
    "product_knowledge": "Presented part condition and OEM quality clearly.",
    "upsell_crosssell": "Offered warranty or companion parts.",
    "objection_handling": "Handled price or quality objections well.",
    "closing": "Asked for the order and confirmed next steps.",
    "compliance_warranty": "Explained warranty or return terms clearly.",
    "courtesy": "Kept a courteous, professional tone.",
    "tone_empathy": "Kept a courteous, professional tone.",
}


def _metric_pct(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if 0 < number <= 10:
        number *= 10
    return max(0, min(100, int(round(number))))


def fill_coaching_fields(call_summary: dict[str, Any], full: dict[str, Any] | None = None) -> bool:
    """Fill empty coaching fields from the call's metrics, request, and outcome."""
    target = full if full is not None else call_summary
    metrics = target.get("metrics") or call_summary.get("metrics") or {}
    values = []
    for key, label in _METRIC_LABELS.items():
        if key in metrics:
            score = _metric_pct(metrics.get(key))
            if score is not None:
                values.append((key, label, score))
    # Prefer tone_empathy over courtesy when both are present.
    dedup: dict[str, tuple[str, str, int]] = {}
    for key, label, score in values:
        dedup[label] = (key, label, score)
    values = sorted(dedup.values(), key=lambda item: item[2], reverse=True)

    rep_name = str(target.get("rep_name") or call_summary.get("rep_name") or "The rep")
    cust_name = str(target.get("customer_name") or call_summary.get("customer_name") or "the customer")
    category = str(target.get("category") or call_summary.get("category") or "Sales Inquiry")
    vehicle = str(target.get("vehicle") or call_summary.get("vehicle") or "").strip()
    part = str(target.get("part_requested") or call_summary.get("part_requested") or "").strip()
    outcome = str(target.get("outcome") or call_summary.get("outcome") or "pending")
    topics = target.get("topics") or call_summary.get("topics") or []
    changed = False

    if not target.get("strengths"):
        strengths = []
        for key, label, score in values:
            if score >= 75:
                strengths.append(f"{_METRIC_STRENGTHS.get(key, 'Strong performance.')} ({label}: {score}/100)")
            if len(strengths) >= 2:
                break
        if not strengths and values:
            key, label, score = values[0]
            strengths.append(f"Best area: {label} ({score}/100). {_METRIC_STRENGTHS.get(key, '')}".strip())
        if not strengths:
            strengths.append("Handled the call and captured the customer's request.")
        target["strengths"] = strengths
        changed = True

    if not target.get("improvements"):
        improvements = []
        for key, label, score in reversed(values):
            if score < 75:
                improvements.append(f"Improve {label} ({score}/100): {_METRIC_TIPS.get(key, 'Keep coaching this skill.')}")
            if len(improvements) >= 3:
                break
        if not improvements:
            improvements.append("Keep reinforcing the 90-day warranty and a direct closing question on every call.")
        target["improvements"] = improvements
        changed = True

    if not target.get("insights"):
        insights = [f"Category: {category}"]
        if part or vehicle:
            insights.append(f"Requested: {part or 'parts'}{f' for a {vehicle}' if vehicle else ''}.")
        if topics:
            insights.append(f"Topics: {', '.join(str(t) for t in topics[:3])}.")
        if outcome == "won":
            value = float(target.get("order_value") or call_summary.get("order_value") or 0.0)
            insights.append(f"Outcome: won{f' at ${value:,.0f}' if value else ''}.")
        else:
            insights.append(f"Outcome: {outcome}.")
        if target.get("caller_intent"):
            insights.append(f"Caller intent: {str(target['caller_intent']).replace('_', ' ')}.")
        target["insights"] = insights
        changed = True

    if not target.get("coaching_feedback"):
        if values:
            strong_key, strong_label, strong_score = values[0]
            weak_key, weak_label, weak_score = values[-1]
            target["coaching_feedback"] = (
                f"{rep_name} handled this {category.lower()} with {cust_name}. "
                f"Strongest area: {strong_label} ({strong_score}/100). "
                f"Next focus: {weak_label} ({weak_score}/100) — {_METRIC_TIPS.get(weak_key, 'keep coaching this skill')}"
            )
        else:
            target["coaching_feedback"] = (
                f"{rep_name} handled this {category.lower()} with {cust_name}. "
                "Review the call and focus on fitment discovery, warranty terms, and a direct closing question."
            )
        changed = True

    return changed


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
    cat = merged.get("category") or "Sales Inquiry"

    if not merged.get("customer_phone"):
        # Deterministic phone from customer name (stable across processes)
        digest = hashlib.sha256(cust_name.encode("utf-8")).hexdigest()
        h = int(digest[:12], 16) % 9000000 + 1000000
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

    fill_coaching_fields(merged, merged)
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
    if not seed:
        seed = _fallback_seed()

    accounts = _configured_master_accounts()
    credentials = _bootstrap_credentials()
    master_users: list[dict[str, Any]] = []
    for account in accounts:
        master_users.append(
            {
                "id": account["id"],
                "email": account["email"],
                "name": account["name"],
                "role": "master",
                "title": "Platform Master Admin",
                "avatar_url": "",
                "org_id": "",
                "disabled": False,
                "site_id": "",
                "must_change_password": True,
                "password_hash": hash_password(credentials[account["email"]]),
            }
        )
    master_user = master_users[0]

    users_by_id: dict[str, dict[str, Any]] = {user["id"]: user for user in master_users}

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
        "form_library": [],
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
                "id": user["id"],
                "email": user["email"],
                "name": user["name"],
                "role": "master",
                "disabled": False,
                "must_change_password": True,
                "created_at": now_iso(),
                "you": index == 0,
                "google_linked": False,
                "email_bounced_at": None,
                "email_bounce_reason": "",
            }
            for index, user in enumerate(master_users)
        ],
        "staff_lockdown": {
            "enabled": False,
            "you_signed_in_with_google": False,
            "staff_domain": master_user["email"].split("@")[-1] if "@" in master_user["email"] else "salvagepulsepro.com",
            "google_linked": 0,
            "staff_total": len(master_users),
        },
        # Track the accounts this instance has already provisioned so a master
        # that an operator later deletes is not recreated on the next restart.
        "provisioned_master_emails": sorted(account["email"] for account in accounts),
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


def _clear_legacy_impersonation(st: dict[str, Any]) -> bool:
    """Impersonation is session-scoped; never trust flags stored on the user.

    Older builds wrote ``impersonated_by`` onto the target account and never
    removed it, which made that user look permanently impersonated (and, before
    this fix, bypassed the forced-password-change gate).
    """
    changed = False
    for user in st.get("users_by_id", {}).values():
        for field in ("impersonated_by", "impersonator_id"):
            if user.pop(field, None) is not None:
                changed = True
    return changed


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
    """Optionally seed the Keech demo yard.

    Disabled by default so a fresh deployment never inherits demo accounts or
    branding.  Even when enabled, existing passwords are left untouched.
    """
    if not SEED_DEMO_DATA:
        return st

    users = st.setdefault("users_by_id", {})
    for uid, udata in KEECH_USERS.items():
        if uid not in users:
            users[uid] = copy.deepcopy(udata)
        else:
            users[uid]["email"] = udata["email"]
            users[uid]["name"] = udata["name"]
            users[uid]["org_id"] = udata.get("org_id", "")
            if not users[uid].get("password_hash"):
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
    st.setdefault("org", {})["id"] = KEECH_ORG_ID
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
            existing_ids[summary["id"]] = summary
        full_calls.setdefault(summary["id"], full)
    from generate_history import build_history_calls
    for summary, full in build_history_calls():
        if summary["id"] not in existing_ids:
            calls.append(summary)
            existing_ids[summary["id"]] = summary
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

    # Seed demo arrivals for Keech's Auto Salvage across newly_arrived, yard_inventory, and to_be_crushed
    arrivals = st.setdefault("arrivals", [])
    if not arrivals or not any(a.get("org_id") == KEECH_ORG_ID for a in arrivals):
        seed_arrivals = st.get("seed", {}).get("/arrivals", [])
        if not seed_arrivals and os.path.exists(SEED_PATH):
            try:
                with open(SEED_PATH, "r", encoding="utf-8") as f:
                    seed_arrivals = json.load(f).get("/arrivals", [])
            except Exception:
                pass
        if seed_arrivals:
            now_dt = dt.datetime.now(dt.timezone.utc)
            for idx, a in enumerate(seed_arrivals[:5]):
                arr = copy.deepcopy(a)
                arr["org_id"] = KEECH_ORG_ID
                if not arr.get("stock_number"):
                    arr["stock_number"] = f"STK-{1080 + idx * 115}"
                if idx < 2:
                    # Newly arrived category
                    arr["inventory_status"] = "newly_arrived"
                    arr["checked_in_at"] = None
                    arr["checked_in_by"] = None
                    arr["queued_for_crush_at"] = None
                    arr["days_until_crushed"] = None
                    arr["crush_deadline"] = None
                elif idx < 4:
                    # Yard inventory category
                    arr["inventory_status"] = "yard_inventory"
                    arr["checked_in_at"] = (now_dt - dt.timedelta(days=(idx * 2 + 1))).isoformat()
                    arr["checked_in_by"] = "Dale Miller"
                    arr["queued_for_crush_at"] = None
                    arr["days_until_crushed"] = None
                    arr["crush_deadline"] = None
                else:
                    # To be crushed queue
                    arr["inventory_status"] = "to_be_crushed"
                    arr["checked_in_at"] = (now_dt - dt.timedelta(days=20)).isoformat()
                    arr["checked_in_by"] = "Dale Miller"
                    arr["queued_for_crush_at"] = (now_dt - dt.timedelta(days=6)).isoformat()
                    arr["days_until_crushed"] = 14
                    arr["crush_deadline"] = (now_dt + dt.timedelta(days=14)).isoformat()
                arrivals.append(arr)

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


DEMO_PASSWORDS = {
    "user-keech-owner": "owner",
    "user-keech-sales-mgr": "salesmanager",
    "user-keech-inv-mgr": "inventory",
    "user-keech-rep": "rep1",
    "user-keech-rep-2": "rep2",
    "user-keech-rep-3": "rep3",
    "user-keech-rep-4": "rep4",
    "user-keech-admin": "admin",
}


def _staff_record(user: dict[str, Any], *, you: bool = False) -> dict[str, Any]:
    return {
        "id": user.get("id", ""),
        "email": user.get("email", ""),
        "name": user.get("name", ""),
        "role": "master",
        "disabled": bool(user.get("disabled")),
        "must_change_password": bool(user.get("must_change_password", True)),
        "created_at": now_iso(),
        "you": you,
        "google_linked": bool(user.get("google_linked")),
        "email_bounced_at": None,
        "email_bounce_reason": "",
    }


def _ensure_configured_masters(st: dict[str, Any]) -> bool:
    """Add configured platform masters to an existing state exactly once.

    ``provisioned_master_emails`` records every account this instance has
    already created.  That makes the migration idempotent and, importantly,
    stops a master that an operator deliberately deletes from being recreated
    on the next restart.
    """
    accounts = _configured_master_accounts()
    users = st.setdefault("users_by_id", {})
    staff = st.setdefault("admin_staff", [])

    marker = st.get("provisioned_master_emails")
    first_run = marker is None
    provisioned = {
        str(email).strip().lower()
        for email in (marker or [])
        if isinstance(email, str) and email.strip()
    }
    # Any master that already exists was provisioned by an earlier build.
    for user in users.values():
        if user.get("role") == "master":
            email = str(user.get("email") or "").strip().lower()
            if email:
                provisioned.add(email)

    changed = False
    for account in accounts:
        email = account["email"]
        existing = next(
            (u for u in users.values() if str(u.get("email") or "").strip().lower() == email),
            None,
        )

        if existing is not None:
            if existing.get("role") == "master":
                # A previously provisioned (or operator-created) master: make
                # sure the Platform Console list has a matching staff row.
                if not any(str(entry.get("id") or "") == existing.get("id") for entry in staff):
                    staff.append(_staff_record(existing))
                    changed = True
                if email not in provisioned:
                    provisioned.add(email)
                    changed = True
            elif email not in provisioned:
                # The operator explicitly configured this address as a master.
                existing["role"] = "master"
                existing.setdefault("title", "Platform Master Admin")
                if not existing.get("password_hash") and not existing.get("google_linked"):
                    existing["password_hash"] = hash_password(_bootstrap_credentials([email])[email])
                    existing["must_change_password"] = True
                if not any(str(entry.get("id") or "") == existing.get("id") for entry in staff):
                    staff.append(_staff_record(existing))
                provisioned.add(email)
                changed = True
            # If the address was provisioned before but is now a non-master,
            # the operator deleted/demoted that master. Do not recreate it.
            continue

        # No account with this address exists. Only create one if it was never
        # provisioned, so a deleted master stays deleted.
        if email in provisioned:
            continue
        user_id = account["id"]
        if user_id in users:
            suffix = 2
            base = user_id
            while f"{base}-{suffix}" in users:
                suffix += 1
            user_id = f"{base}-{suffix}"
        user = {
            "id": user_id,
            "email": email,
            "name": account["name"],
            "role": "master",
            "title": "Platform Master Admin",
            "avatar_url": "",
            "org_id": "",
            "disabled": False,
            "site_id": "",
            "must_change_password": True,
            "password_hash": hash_password(_bootstrap_credentials([email])[email]),
        }
        users[user_id] = user
        staff.append(_staff_record(user))
        provisioned.add(email)
        changed = True

    if changed or first_run:
        st["provisioned_master_emails"] = sorted(provisioned)
        lockdown = dict(st.get("staff_lockdown", {}))
        lockdown["staff_total"] = len(
            [u for u in users.values() if u.get("role") == "master" and not u.get("disabled")]
        )
        st["staff_lockdown"] = lockdown
        changed = True
    return changed


def _ensure_master_password(st: dict[str, Any]) -> bool:
    """Make sure every master account has a usable credential.

    A state file created before secure hashing shipped can contain a master with
    an empty hash, which locks the operator out permanently.  Generate a
    one-time password (or use INITIAL_MASTER_PASSWORD for the primary master)
    and persist it to a root-only file in DATA_DIR.
    """
    changed = False
    for user in st.get("users_by_id", {}).values():
        if user.get("role") != "master" or user.get("disabled"):
            continue
        if user.get("password_hash") or user.get("google_linked"):
            continue
        email = str(user.get("email") or "").strip().lower()
        password = _initial_password_for(email) if email else secrets.token_urlsafe(18)
        user["password_hash"] = hash_password(password)
        user["must_change_password"] = True
        changed = True
    return changed


def _enforce_demo_password_rotation(st: dict[str, Any]) -> bool:
    """Force known demo credentials to be changed on production instances."""
    if SEED_DEMO_DATA:
        return False
    changed = False
    for uid, weak in DEMO_PASSWORDS.items():
        user = st.get("users_by_id", {}).get(uid)
        if not user or user.get("must_change_password") or user.get("disabled"):
            continue
        stored = user.get("password_hash") or user.get("password")
        if stored and verify_password(weak, stored):
            user["must_change_password"] = True
            changed = True
    return changed


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
            changed = _clear_legacy_impersonation(_STATE)
            changed = _ensure_configured_masters(_STATE) or changed
            changed = _ensure_master_password(_STATE) or changed
            changed = _enforce_demo_password_rotation(_STATE) or changed
            if _STATE.get("call_taxonomy_version") != 3:
                migrate_call_taxonomy(_STATE)
                _STATE["call_taxonomy_version"] = 3
                changed = True
            if SEED_DEMO_DATA:
                _ensure_demo_users(_STATE)
            if changed:
                save_state()
        return _STATE


def save_state() -> None:
    global _STATE_MTIME
    with _LOCK:
        if _STATE is None:
            return
        tmp_path = f"{STATE_PATH}.tmp.{os.getpid()}"
        try:
            os.makedirs(DATA_DIR, exist_ok=True)
            with open(tmp_path, "w", encoding="utf-8") as fh:
                json.dump(_STATE, fh)
                fh.flush()
                os.fsync(fh.fileno())
            os.chmod(tmp_path, 0o600)
            os.replace(tmp_path, STATE_PATH)
            _STATE_MTIME = os.path.getmtime(STATE_PATH) if os.path.exists(STATE_PATH) else 0.0
        except Exception:
            try:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
            except OSError:
                pass
