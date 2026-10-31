import hashlib
import json
import os
import re
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

DB_PATH = os.path.join(os.path.dirname(__file__), "salvage_pulse.db")

CATEGORIES = [
    "Part Inquiry/Quote",
    "Price Negotiation",
    "Order/Sale",
    "Shipping/Delivery",
    "Warranty/Return",
    "Core Return",
    "Vendor/Scrap Seller",
    "Other",
]

METRICS = [
    {
        "key": "greeting",
        "name": "Greeting & Brand",
        "weight": 10,
        "description": "Professional yard identification, rep name, warm tone.",
        "ai_criteria": "Evaluates whether the rep opens the call with clear yard identification, states their name, maintains a polite and welcoming tone, and establishes immediate credibility.",
    },
    {
        "key": "needs_discovery",
        "name": "Needs Discovery",
        "weight": 15,
        "description": "Year/Make/Model, engine/trim, VIN or Hollander interchange, mileage needs.",
        "ai_criteria": "Evaluates how thoroughly the rep clarifies vehicle fitment: asking for VIN or Hollander interchange, confirming year/make/model, engine, transmission, trim package, and customer mileage expectations before quoting.",
    },
    {
        "key": "product_knowledge",
        "name": "Product Knowledge",
        "weight": 15,
        "description": "Interchange accuracy, part grade/condition, testing notes, warranty terms.",
        "ai_criteria": "Evaluates the rep's explanation of part condition (Grade A/B), bench/run testing notes, mileage on the donor vehicle, interchange options, and clearly outlining what components are included with the assembly.",
    },
    {
        "key": "upsell_crosssell",
        "name": "Upsell & Cross-sell",
        "weight": 15,
        "description": "Companion parts, extended warranty, bundles, core incentives.",
        "ai_criteria": "Evaluates proactive recommendations for necessary companion items (gaskets, seals, hardware, fluid, matching wire harnesses, brackets) and presenting extended parts & labor warranty packages.",
    },
    {
        "key": "objection_handling",
        "name": "Objection Handling",
        "weight": 15,
        "description": "Price pushback, OEM used vs aftermarket, shipping concerns.",
        "ai_criteria": "Evaluates how effectively the rep counters price resistance, defends genuine OEM used fit & durability against cheap aftermarket alternatives, and resolves delivery or lead-time hesitations.",
    },
    {
        "key": "closing",
        "name": "Closing & Next Steps",
        "weight": 15,
        "description": "Asks for the sale/payment, sets pickup/freight, confirms invoice details.",
        "ai_criteria": "Evaluates asking directly for the order or credit card deposit, confirming delivery bay / shipping schedule or counter hold, and establishing clear follow-up expectations.",
    },
    {
        "key": "courtesy",
        "name": "Courtesy & Professionalism",
        "weight": 15,
        "description": "Active listening, clear language, no hold abuse, thanks the customer.",
        "ai_criteria": "Evaluates polite active listening, clean phone etiquette, minimal and courteous hold times, clear non-slang communication, and thanking the caller by name.",
    },
]

PLANS = [
    {
        "id": "starter",
        "name": "Starter",
        "price": 99.0,
        "price_yearly": 1089.0,
        "max_reps": 3,
        "features": [
            "Up to 3 rep logins",
            "Call scoring & categories",
            "RingCentral + webhook connectors",
            "Customer & win-back lists",
        ],
    },
    {
        "id": "pro",
        "name": "Pro",
        "price": 249.0,
        "price_yearly": 2739.0,
        "max_reps": 5,
        "features": [
            "5 rep logins (+2 more for $50/mo, up to $400/mo total)",
            "Everything in Starter",
            "AI role-play trainer",
            "Daily follow-up email",
            "Vehicle arrivals & call queue",
        ],
    },
    {
        "id": "pro_unlimited",
        "name": "Pro Unlimited",
        "price": 499.0,
        "price_yearly": 5489.0,
        "max_reps": None,
        "features": [
            "Unlimited rep logins",
            "Everything in Pro",
            "AI role-play trainer",
            "Daily follow-up email",
            "Vehicle arrivals & call queue",
        ],
    },
    {
        "id": "enterprise",
        "name": "Enterprise",
        "price": 649.0,
        "price_yearly": 7139.0,
        "max_reps": None,
        "features": [
            "Every tool included",
            "Unlimited rep logins",
            "Everything in Pro Unlimited",
            "Monthly trends & seasonal parts insights",
            "Inventory insights: vehicle demand, stock alerts, watchlist",
            "Multiple locations",
            "Priority setup & support",
        ],
    },
]

PLAN_COMPARE_ROWS = [
    {
        "group": "Team & Call Ingestion",
        "label": "Rep logins included",
        "values": {
            "starter": "Up to 3",
            "pro": "5 (+2 for $50/mo)",
            "pro_unlimited": "Unlimited",
            "enterprise": "Unlimited",
        },
    },
    {
        "group": "Team & Call Ingestion",
        "label": "AI call scoring (7 metrics) & 8 categories",
        "values": {"starter": True, "pro": True, "pro_unlimited": True, "enterprise": True},
    },
    {
        "group": "Team & Call Ingestion",
        "label": "RingCentral & universal webhook sync",
        "values": {"starter": True, "pro": True, "pro_unlimited": True, "enterprise": True},
    },
    {
        "group": "CRM & Follow-Ups",
        "label": "Customer profiles, auto-tagging & notes",
        "values": {"starter": True, "pro": True, "pro_unlimited": True, "enterprise": True},
    },
    {
        "group": "CRM & Follow-Ups",
        "label": "Missed-call callbacks queue & win-back list",
        "values": {"starter": True, "pro": True, "pro_unlimited": True, "enterprise": True},
    },
    {
        "group": "CRM & Follow-Ups",
        "label": "Vehicle arrivals & morning call queue",
        "values": {"starter": False, "pro": True, "pro_unlimited": True, "enterprise": True},
    },
    {
        "group": "CRM & Follow-Ups",
        "label": "Daily quote & callback follow-up email",
        "values": {"starter": False, "pro": True, "pro_unlimited": True, "enterprise": True},
    },
    {
        "group": "Coaching & Gamification",
        "label": "AI Role-Play Trainer & scenario builder",
        "values": {"starter": False, "pro": True, "pro_unlimited": True, "enterprise": True},
    },
    {
        "group": "Coaching & Gamification",
        "label": "Trophies, streaks & win-back leaderboards",
        "values": {"starter": False, "pro": True, "pro_unlimited": True, "enterprise": True},
    },
    {
        "group": "Enterprise Intelligence",
        "label": "Monthly trends & rep-by-rep close rate comparison",
        "values": {"starter": False, "pro": False, "pro_unlimited": False, "enterprise": True},
    },
    {
        "group": "Enterprise Intelligence",
        "label": "Seasonal parts insights & keyword trend alerts",
        "values": {"starter": False, "pro": False, "pro_unlimited": False, "enterprise": True},
    },
    {
        "group": "Enterprise Intelligence",
        "label": "Inventory insights: vehicle demand, stock alerts & watchlist",
        "values": {"starter": False, "pro": False, "pro_unlimited": False, "enterprise": True},
    },
]

VEHICLE_CATALOG: Dict[str, List[Tuple[str, str]]] = {
    "Ford": [
        ("F-150", "pickup"),
        ("F-250 Super Duty", "pickup"),
        ("Explorer", "suv"),
        ("Escape", "suv"),
        ("Edge", "suv"),
        ("Mustang", "car"),
        ("Fusion", "car"),
        ("Transit 250", "van"),
        ("Ranger", "pickup"),
    ],
    "Chevrolet": [
        ("Silverado 1500", "pickup"),
        ("Silverado 2500HD", "pickup"),
        ("Equinox", "suv"),
        ("Tahoe", "suv"),
        ("Suburban", "suv"),
        ("Malibu", "car"),
        ("Traverse", "suv"),
        ("Express 2500", "van"),
        ("Colorado", "pickup"),
    ],
    "Toyota": [
        ("Camry", "car"),
        ("RAV4", "suv"),
        ("Tacoma", "pickup"),
        ("Tundra", "pickup"),
        ("Corolla", "car"),
        ("Highlander", "suv"),
        ("4Runner", "suv"),
        ("Sienna", "van"),
    ],
    "Honda": [
        ("Civic", "car"),
        ("Accord", "car"),
        ("CR-V", "suv"),
        ("Pilot", "suv"),
        ("Odyssey", "van"),
        ("Ridgeline", "pickup"),
    ],
    "Ram": [
        ("1500", "pickup"),
        ("2500", "pickup"),
        ("ProMaster 2500", "van"),
    ],
    "Jeep": [
        ("Grand Cherokee", "suv"),
        ("Wrangler", "suv"),
        ("Cherokee", "suv"),
        ("Compass", "suv"),
    ],
    "GMC": [
        ("Sierra 1500", "pickup"),
        ("Acadia", "suv"),
        ("Terrain", "suv"),
        ("Yukon", "suv"),
        ("Savana 2500", "van"),
    ],
    "Nissan": [
        ("Altima", "car"),
        ("Rogue", "suv"),
        ("Sentra", "car"),
        ("Pathfinder", "suv"),
        ("Frontier", "pickup"),
    ],
    "Subaru": [
        ("Outback", "suv"),
        ("Forester", "suv"),
        ("Crosstrek", "suv"),
        ("Impreza", "car"),
    ],
    "Hyundai": [
        ("Elantra", "car"),
        ("Sonata", "car"),
        ("Tucson", "suv"),
        ("Santa Fe", "suv"),
    ],
    "Kia": [
        ("Sportage", "suv"),
        ("Sorento", "suv"),
        ("Optima", "car"),
        ("Telluride", "suv"),
    ],
    "BMW": [
        ("3 Series", "car"),
        ("X5", "suv"),
        ("X3", "suv"),
    ],
}

COMMON_PARTS = [
    "Alternator",
    "Transmission",
    "Engine Assembly",
    "Front Door",
    "Headlight Assembly",
    "Front Bumper",
    "Rear Axle",
    "Transfer Case",
    "Tailgate",
    "Side Mirror",
    "Fender",
    "AC Compressor",
    "Catalytic Converter",
    "Steering Rack",
    "Radiator",
    "Hood",
    "Tail Light",
    "Wheel / Rim",
]


def hash_password(password: str) -> str:
    return hashlib.sha256(f"sp_salt::{password}".encode("utf-8")).hexdigest()


def normalize_phone(phone: Optional[str]) -> str:
    if not phone:
        return ""
    digits = re.sub(r"\D", "", str(phone))
    return digits[-10:] if len(digits) >= 10 else digits


def make_customer_key(name: Optional[str], phone: Optional[str]) -> str:
    p = normalize_phone(phone)
    if len(p) == 10:
        return f"p:{p}"
    clean_name = re.sub(r"[^a-z0-9]+", "-", (name or "unknown").lower()).strip("-")
    return f"n:{clean_name or 'unknown'}"


def infer_customer_tag(name: Optional[str]) -> Tuple[str, str]:
    if not name:
        return ("untagged", "auto")
    low = name.lower()
    if any(w in low for w in ["collision", "body", "paint", "autobody", "fender", "restoration"]):
        return ("body_shop", "auto")
    if any(w in low for w in ["fleet", "transit", "plumbing", "hvac", "logistics", "delivery", "municipal", "county", "trucking"]):
        return ("fleet", "auto")
    if any(w in low for w in ["auto", "repair", "garage", "motors", "service", "tire", "automotive", "mechanic", "shop", "transmission", "imports"]):
        return ("mechanic", "auto")
    return ("retail", "auto")


def infer_vehicle_body(make: Optional[str], model: Optional[str]) -> str:
    if not make or not model:
        return "car"
    for m, models in VEHICLE_CATALOG.items():
        if m.lower() == make.lower():
            for mod_name, body in models:
                if mod_name.lower() in model.lower() or model.lower() in mod_name.lower():
                    return body
    low = model.lower()
    if any(k in low for k in ["150", "250", "350", "silverado", "sierra", "tacoma", "tundra", "ranger", "colorado", "frontier", "ridgeline"]):
        return "pickup"
    if any(k in low for k in ["transit", "promaster", "express", "savana", "odyssey", "sienna", "caravan"]):
        return "van"
    if any(k in low for k in ["explorer", "escape", "edge", "equinox", "tahoe", "suburban", "traverse", "rav4", "highlander", "4runner", "cr-v", "pilot", "cherokee", "wrangler", "compass", "acadia", "terrain", "yukon", "rogue", "pathfinder", "outback", "forester", "crosstrek", "tucson", "santa fe", "sportage", "sorento", "telluride", "x3", "x5"]):
        return "suv"
    return "car"


def compute_weighted_overall_score(metrics: Dict[str, Any], custom_weights: Optional[Dict[str, float]] = None) -> int:
    total = 0.0
    # Normalize courtesy vs tone_empathy if needed
    m_dict = dict(metrics) if metrics else {}
    if "courtesy" not in m_dict and "tone_empathy" in m_dict:
        m_dict["courtesy"] = m_dict["tone_empathy"]

    for m in METRICS:
        val = float(m_dict.get(m["key"], 0) or 0)
        # Normalize metric score: if 0-10 scale, convert to 0-100; if already 0-100, use as is
        val_pct = val * 10.0 if val <= 10.0 else val
        val_pct = max(0.0, min(100.0, val_pct))
        weight = float(custom_weights.get(m["key"], m["weight"])) if custom_weights else float(m["weight"])
        total += (val_pct * weight) / 100.0
    return int(round(max(0.0, min(100.0, total))))


def get_org_scoring_config(org_id: Optional[str]) -> Tuple[bool, Dict[str, int]]:
    """Returns (custom_scoring_enabled: bool, weights: dict[str, int]) for a specific yard/org.
    Isolated per org_id, never affecting any other yard on the platform.
    """
    defaults = {m["key"]: int(m["weight"]) for m in METRICS}
    if not org_id:
        return False, defaults

    try:
        with get_db() as conn:
            row = conn.execute(
                "SELECT custom_scoring, metric_weights_json FROM orgs WHERE id = ?",
                (org_id,),
            ).fetchone()
            if row:
                cs = bool(row["custom_scoring"])
                raw_json = row["metric_weights_json"] or "{}"
                mw = json.loads(raw_json)
                weights = dict(defaults)
                if cs and isinstance(mw, dict) and mw:
                    for k in defaults:
                        if k in mw:
                            try:
                                weights[k] = int(mw[k])
                            except (ValueError, TypeError):
                                pass
                return cs, weights
    except Exception:
        pass

    return False, defaults


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_schema():
    with get_db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS orgs (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                yard_name TEXT,
                avg_order_value REAL,
                plan TEXT NOT NULL DEFAULT 'pro',
                status TEXT NOT NULL DEFAULT 'trialing',
                billing_interval TEXT NOT NULL DEFAULT 'month',
                card_on_file INTEGER NOT NULL DEFAULT 0,
                no_card_trial INTEGER NOT NULL DEFAULT 1,
                email_verified INTEGER NOT NULL DEFAULT 1,
                trial_started_at TEXT,
                trial_ends_at TEXT,
                limited_starts_at TEXT,
                card_added_at TEXT,
                preview_ends_at TEXT,
                preview_used INTEGER NOT NULL DEFAULT 0,
                show_enterprise_tour INTEGER NOT NULL DEFAULT 0,
                extra_rep_packs INTEGER NOT NULL DEFAULT 0,
                blocked INTEGER NOT NULL DEFAULT 0,
                cancel_reason TEXT,
                accent TEXT NOT NULL DEFAULT '',
                default_mode TEXT NOT NULL DEFAULT 'dark',
                logo_url TEXT NOT NULL DEFAULT '',
                digest_email TEXT NOT NULL DEFAULT '',
                digest_enabled INTEGER NOT NULL DEFAULT 0,
                watchlist_email TEXT NOT NULL DEFAULT '',
                watchlist_email_enabled INTEGER NOT NULL DEFAULT 1,
                watchlist_last_sent_at TEXT,
                rc_connected INTEGER NOT NULL DEFAULT 0,
                rc_connected_by TEXT,
                rc_last_sync_at TEXT,
                rc_last_result TEXT,
                webhook_token TEXT NOT NULL,
                sample_data INTEGER NOT NULL DEFAULT 1,
                signup_network TEXT NOT NULL DEFAULT '198.51.100.0/24',
                is_demo INTEGER NOT NULL DEFAULT 0,
                custom_scoring INTEGER NOT NULL DEFAULT 0,
                metric_weights_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                org_id TEXT,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT 'Sales Rep',
                avatar_url TEXT NOT NULL DEFAULT '',
                theme_mode TEXT,
                disabled INTEGER NOT NULL DEFAULT 0,
                reset_token TEXT,
                reset_expires_at TEXT,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id, role);

            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                impersonated_by_id TEXT,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

            CREATE TABLE IF NOT EXISTS calls (
                id TEXT PRIMARY KEY,
                org_id TEXT NOT NULL,
                rep_id TEXT NOT NULL,
                rep_name TEXT NOT NULL,
                customer_key TEXT NOT NULL,
                customer_name TEXT NOT NULL,
                customer_phone TEXT NOT NULL DEFAULT '',
                phone_norm TEXT NOT NULL DEFAULT '',
                direction TEXT NOT NULL DEFAULT 'inbound',
                duration_sec INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'analyzed',
                source TEXT NOT NULL DEFAULT 'transcript',
                source_category TEXT NOT NULL DEFAULT '',
                external_id TEXT,
                external_url TEXT,
                category TEXT NOT NULL DEFAULT 'Part Inquiry/Quote',
                outcome TEXT NOT NULL DEFAULT 'pending',
                overall_score INTEGER NOT NULL DEFAULT 0,
                order_value REAL NOT NULL DEFAULT 0,
                quoted_value REAL NOT NULL DEFAULT 0,
                warranty_pitched INTEGER NOT NULL DEFAULT 0,
                loss_reason TEXT NOT NULL DEFAULT '',
                summary TEXT NOT NULL DEFAULT '',
                transcript TEXT NOT NULL DEFAULT '',
                turns_json TEXT NOT NULL DEFAULT '[]',
                metrics_json TEXT NOT NULL DEFAULT '{}',
                coaching_feedback TEXT NOT NULL DEFAULT '',
                strengths_json TEXT NOT NULL DEFAULT '[]',
                improvements_json TEXT NOT NULL DEFAULT '[]',
                insights_json TEXT NOT NULL DEFAULT '[]',
                topics_json TEXT NOT NULL DEFAULT '[]',
                trackers_json TEXT NOT NULL DEFAULT '[]',
                vehicle_year INTEGER,
                vehicle_make TEXT NOT NULL DEFAULT '',
                vehicle_model TEXT NOT NULL DEFAULT '',
                vehicle_body TEXT NOT NULL DEFAULT '',
                part_requested TEXT NOT NULL DEFAULT '',
                tag_skipped INTEGER NOT NULL DEFAULT 0,
                tagged_by_id TEXT,
                tagged_at TEXT,
                has_audio INTEGER NOT NULL DEFAULT 0,
                audio_path TEXT,
                callback_done INTEGER NOT NULL DEFAULT 0,
                callback_by TEXT,
                callback_at TEXT,
                is_sample INTEGER NOT NULL DEFAULT 0,
                month_bucket TEXT NOT NULL,
                error TEXT,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_calls_org_created ON calls(org_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_calls_org_rep ON calls(org_id, rep_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_calls_org_customer ON calls(org_id, customer_key);
            CREATE INDEX IF NOT EXISTS idx_calls_org_vehicle ON calls(org_id, vehicle_make, vehicle_model, vehicle_year);
            CREATE INDEX IF NOT EXISTS idx_calls_org_month ON calls(org_id, month_bucket);

            CREATE TABLE IF NOT EXISTS customers (
                org_id TEXT NOT NULL,
                customer_key TEXT NOT NULL,
                name TEXT NOT NULL,
                phone TEXT NOT NULL DEFAULT '',
                tag TEXT NOT NULL DEFAULT 'untagged',
                tag_source TEXT NOT NULL DEFAULT 'auto',
                updated_at TEXT NOT NULL,
                PRIMARY KEY (org_id, customer_key)
            );

            CREATE TABLE IF NOT EXISTS customer_notes (
                id TEXT PRIMARY KEY,
                org_id TEXT NOT NULL,
                customer_key TEXT NOT NULL,
                author TEXT NOT NULL,
                text TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_notes_cust ON customer_notes(org_id, customer_key, created_at DESC);

            CREATE TABLE IF NOT EXISTS winback_marks (
                id TEXT PRIMARY KEY,
                org_id TEXT NOT NULL,
                customer_key TEXT NOT NULL,
                customer_name TEXT NOT NULL,
                rep_id TEXT NOT NULL,
                rep_name TEXT NOT NULL,
                outcome TEXT NOT NULL,
                month_bucket TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_winback_org ON winback_marks(org_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS keywords (
                id TEXT PRIMARY KEY,
                org_id TEXT NOT NULL,
                keyword TEXT NOT NULL,
                group_name TEXT NOT NULL DEFAULT 'General',
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_keywords_org ON keywords(org_id);

            CREATE TABLE IF NOT EXISTS dismissed_suggestions (
                org_id TEXT NOT NULL,
                phrase TEXT NOT NULL,
                PRIMARY KEY (org_id, phrase)
            );

            CREATE TABLE IF NOT EXISTS arrivals (
                id TEXT PRIMARY KEY,
                org_id TEXT NOT NULL,
                vehicle_year INTEGER NOT NULL,
                vehicle_make TEXT NOT NULL,
                vehicle_model TEXT NOT NULL,
                year_span INTEGER NOT NULL DEFAULT 2,
                note TEXT NOT NULL DEFAULT '',
                created_by TEXT NOT NULL,
                blasts_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_arrivals_org ON arrivals(org_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS arrival_callers (
                id TEXT PRIMARY KEY,
                arrival_id TEXT NOT NULL,
                org_id TEXT NOT NULL,
                customer_key TEXT NOT NULL,
                customer_name TEXT NOT NULL,
                customer_phone TEXT NOT NULL DEFAULT '',
                rep_id TEXT NOT NULL,
                rep_name TEXT NOT NULL,
                vehicle TEXT NOT NULL DEFAULT '',
                exact_year INTEGER NOT NULL DEFAULT 0,
                parts_json TEXT NOT NULL DEFAULT '[]',
                last_asked TEXT NOT NULL,
                times_asked INTEGER NOT NULL DEFAULT 1,
                last_call_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'to_call',
                status_updated_at TEXT,
                status_by_id TEXT,
                texted_at TEXT,
                text_body TEXT,
                sms_status TEXT,
                sms_sid TEXT,
                sms_error TEXT,
                replied_at TEXT,
                sms_reply TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_arrival_callers_arr ON arrival_callers(arrival_id);
            CREATE INDEX IF NOT EXISTS idx_arrival_callers_org ON arrival_callers(org_id, status);

            CREATE TABLE IF NOT EXISTS watchlist (
                id TEXT PRIMARY KEY,
                org_id TEXT NOT NULL,
                make TEXT NOT NULL,
                model TEXT NOT NULL DEFAULT '',
                year_from INTEGER,
                year_to INTEGER,
                part TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_watchlist_org ON watchlist(org_id);

            CREATE TABLE IF NOT EXISTS roleplay_scenarios (
                id TEXT PRIMARY KEY,
                org_id TEXT,
                title TEXT NOT NULL,
                difficulty TEXT NOT NULL DEFAULT 'Medium',
                persona TEXT NOT NULL,
                objective TEXT NOT NULL,
                opening_hint TEXT NOT NULL DEFAULT '',
                customer_brief TEXT NOT NULL,
                price_objection INTEGER NOT NULL DEFAULT 0,
                custom INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS roleplay_assignments (
                id TEXT PRIMARY KEY,
                org_id TEXT NOT NULL,
                scenario_id TEXT NOT NULL,
                rep_id TEXT NOT NULL,
                due_date TEXT NOT NULL,
                pass_score INTEGER NOT NULL DEFAULT 70,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_rp_assign_org ON roleplay_assignments(org_id, rep_id);

            CREATE TABLE IF NOT EXISTS roleplay_sessions (
                id TEXT PRIMARY KEY,
                org_id TEXT NOT NULL,
                scenario_id TEXT NOT NULL,
                scenario_title TEXT NOT NULL,
                user_id TEXT NOT NULL,
                user_name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                messages_json TEXT NOT NULL DEFAULT '[]',
                grade_json TEXT,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_rp_sess_org ON roleplay_sessions(org_id, user_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS audit_logs (
                id TEXT PRIMARY KEY,
                actor TEXT NOT NULL,
                action TEXT NOT NULL,
                target TEXT NOT NULL,
                at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS platform_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )
