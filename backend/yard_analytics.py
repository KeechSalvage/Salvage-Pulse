"""Org-scoped analytics computed from each yard's own calls.

Every public helper takes an explicit ``org_id`` and only reads records that
belong to that yard (``org_id is None`` means "all yards" and is reserved for
platform staff).  Nothing in here reaches into ``state["seed"]``: the demo seed
belongs to Keech's yard and must never describe another customer's business.
"""
from __future__ import annotations

import re
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import HTTPException

from database import COMMON_PARTS, VEHICLE_CATALOG, infer_customer_tag, infer_vehicle_body, normalize_phone
from security import is_staff, user_org

REP_ROLES = ("rep", "sales_rep")

DEFAULT_KEYWORDS: list[dict[str, str]] = [
    {"id": "kw-warranty", "keyword": "Warranty", "group": "Assurance"},
    {"id": "kw-pricing", "keyword": "Pricing / Price", "group": "Negotiation"},
    {"id": "kw-trans", "keyword": "Transmission", "group": "Suggested"},
    {"id": "kw-vin", "keyword": "VIN", "group": "Fitment"},
    {"id": "kw-engine", "keyword": "Engine", "group": "Suggested"},
    {"id": "kw-delivery", "keyword": "Delivery / Shipping", "group": "Suggested"},
    {"id": "kw-core", "keyword": "Core", "group": "Financial"},
    {"id": "kw-oem", "keyword": "OEM", "group": "Quality"},
]

# Parts we are willing to report as demand.  Generic topics ("auto parts",
# "order status", ...) are intentionally absent.
_PART_ALIASES: dict[str, str] = {
    "alternator": "Alternator",
    "transmission": "Transmission",
    "tranny": "Transmission",
    "engine": "Engine",
    "motor": "Engine",
    "door": "Door",
    "front door": "Door",
    "rear door": "Door",
    "headlight": "Headlight",
    "head light": "Headlight",
    "headlight assembly": "Headlight",
    "bumper": "Bumper",
    "front bumper": "Bumper",
    "rear bumper": "Bumper",
    "bumper reinforcement": "Bumper",
    "wheel": "Wheel / Rim",
    "rim": "Wheel / Rim",
    "wheel / rim": "Wheel / Rim",
    "mirror": "Mirror",
    "side mirror": "Mirror",
    "fender": "Fender",
    "axle": "Axle",
    "rear axle": "Axle",
    "suspension": "Suspension",
    "radiator": "Radiator",
    "hood": "Hood",
    "tail light": "Tail Light",
    "taillight": "Tail Light",
    "tailgate": "Tailgate",
    "catalytic converter": "Catalytic Converter",
    "ac compressor": "AC Compressor",
    "a/c compressor": "AC Compressor",
    "steering rack": "Steering Rack",
    "transfer case": "Transfer Case",
    "seat": "Seat",
    "seats": "Seat",
    "grille": "Grille",
    "quarter panel": "Quarter Panel",
    "fuel pump": "Fuel Pump",
    "starter": "Starter",
    "differential": "Differential",
    "drive shaft": "Drive Shaft",
    "driveshaft": "Drive Shaft",
    "knuckle": "Knuckle",
    "spindle": "Spindle",
    "control arm": "Control Arm",
    "tie rod": "Tie Rod",
    "abs pump": "ABS Pump",
    "computer": "Computer",
    "ecm": "Computer",
}

_GENERIC_PARTS = {
    "",
    "auto parts",
    "auto part",
    "car parts",
    "car part",
    "vehicle parts",
    "vehicle part",
    "parts",
    "part",
    "parts order",
    "parts ordering",
    "parts inquiry",
    "part inquiry",
    "part pricing",
    "pricing",
    "pricing discussion",
    "order status",
    "order details",
    "order confirmation",
    "delivery",
    "delivery update",
    "delivery schedule",
    "customer service",
    "contact information",
    "vehicle details",
    "warranty",
    "warranty options",
    "warranty coverage",
    "availability check",
    "scheduling",
    "personal life",
    "gas prices",
    "health insurance",
}

_MODEL_PATTERNS: list[tuple[str, str, str, re.Pattern[str]]] = []
for _make, _models in VEHICLE_CATALOG.items():
    for _model, _body in _models:
        _MODEL_PATTERNS.append(
            (_make, _model, _body, re.compile(r"\b" + re.escape(_model.lower()) + r"\b", re.I))
        )
_MODEL_PATTERNS.sort(key=lambda item: len(item[1]), reverse=True)
_MAKE_PATTERNS = [
    (make, re.compile(r"\b" + re.escape(make.lower()) + r"\b", re.I))
    for make in VEHICLE_CATALOG
]
_YEAR_RE = re.compile(r"\b(19[7-9]\d|20[0-2]\d|203[0-5])\b")


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def today_str() -> str:
    return now_utc().strftime("%Y-%m-%d")


def current_month_str() -> str:
    return now_utc().strftime("%Y-%m")


def parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None


def month_of(value: Optional[str]) -> str:
    return (value or "")[:7] or current_month_str()


def _days_ago_iso(days: int) -> str:
    return (now_utc() - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")


def scoped_rep_id(user: dict[str, Any], requested: Optional[str], state: dict[str, Any]) -> Optional[str]:
    """Return the rep whose data the caller may see.

    Reps are pinned to themselves; managers may ask for any rep in their yard;
    platform staff may cross yards.
    """
    if user.get("role") in REP_ROLES:
        if requested and requested != user.get("id"):
            raise HTTPException(status_code=403, detail="You can only view your own performance")
        return user.get("id")

    if not requested:
        return None
    target = state.get("users_by_id", {}).get(requested)
    if not target:
        raise HTTPException(status_code=400, detail="Unknown team member")
    if not is_staff(user) and target.get("org_id") != user_org(user):
        raise HTTPException(status_code=403, detail="You cannot view another yard's team")
    return requested


def filter_calls_by_site(state: dict[str, Any], calls: list[dict[str, Any]], site_id: Optional[str]) -> list[dict[str, Any]]:
    if not site_id:
        return calls
    site_rep_ids = {
        uid for uid, u in state.get("users_by_id", {}).items() if u.get("site_id") == site_id
    }
    return [
        c for c in calls
        if c.get("site_id") == site_id or c.get("rep_id") in site_rep_ids
    ]


def org_calls(
    state: dict[str, Any],
    org_id: Optional[str],
    *,
    rep_id: Optional[str] = None,
    site_id: Optional[str] = None,
) -> list[dict[str, Any]]:
    calls = state.get("calls", [])
    if org_id is not None:
        calls = [c for c in calls if c.get("org_id") == org_id]
    if rep_id:
        calls = [c for c in calls if c.get("rep_id") == rep_id]
    return filter_calls_by_site(state, calls, site_id)


def org_users(state: dict[str, Any], org_id: Optional[str], *, roles: tuple[str, ...] = REP_ROLES) -> list[dict[str, Any]]:
    rows = [
        u for u in state.get("users_by_id", {}).values()
        if u.get("role") in roles and not u.get("disabled")
    ]
    if org_id is not None:
        rows = [u for u in rows if u.get("org_id") == org_id]
    return rows


def _call_full(state: dict[str, Any], call: dict[str, Any]) -> dict[str, Any]:
    return state.get("full_calls", {}).get(call.get("id"), {}) or {}


def _call_topics(call: dict[str, Any], full: dict[str, Any]) -> list[str]:
    topics = call.get("topics") or full.get("topics") or []
    return [str(t) for t in topics if t]


def _call_vehicle_text(call: dict[str, Any], full: dict[str, Any]) -> str:
    """Text that may describe a vehicle, excluding the customer's name.

    Customer names frequently contain dealer words ("GIRARD FORD",
    "EXECUTIVE HONDA") which are not the vehicle being asked about.
    """
    bits = _call_topics(call, full)
    summary = str(call.get("summary") or full.get("summary") or "")
    match = re.search(r"topics discussed:\s*(.+)$", summary, re.I)
    if match:
        bits.append(match.group(1))
    return " ".join(bits)


def extract_vehicle_from_text(text: str) -> dict[str, Any]:
    low = (text or "").lower()
    for make, model, body, rx in _MODEL_PATTERNS:
        if rx.search(low):
            return {"vehicle_make": make, "vehicle_model": model, "vehicle_body": body}
    for make, rx in _MAKE_PATTERNS:
        if rx.search(low):
            return {"vehicle_make": make, "vehicle_model": "", "vehicle_body": "other"}
    return {"vehicle_make": "", "vehicle_model": "", "vehicle_body": ""}


def canonical_part(text: Optional[str]) -> str:
    low = str(text or "").strip().lower()
    if not low or low in _GENERIC_PARTS:
        return ""
    for alias in sorted(_PART_ALIASES, key=len, reverse=True):
        if re.search(r"\b" + re.escape(alias) + r"\b", low):
            return _PART_ALIASES[alias]
    return ""


def _part_from_topics(call: dict[str, Any], full: dict[str, Any]) -> str:
    explicit = call.get("part_requested") or full.get("part_requested") or ""
    part = canonical_part(explicit)
    if part:
        return part
    for topic in _call_topics(call, full):
        part = canonical_part(topic)
        if part:
            return part
    summary = str(call.get("summary") or full.get("summary") or "")
    match = re.search(r"topics discussed:\s*(.+)$", summary, re.I)
    if match:
        return canonical_part(match.group(1))
    return ""


def parts_for_call(state: dict[str, Any], call: dict[str, Any]) -> set[str]:
    """Every canonical part a call mentions, not just the first one.

    A caller can ask about a door and a fender in the same conversation, so the
    seasonal chart and its drill-down both count that call under both parts.
    """
    full = _call_full(state, call)
    texts: list[str] = []
    explicit = call.get("part_requested") or full.get("part_requested") or ""
    if explicit:
        texts.append(str(explicit))
    texts.extend(_call_topics(call, full))
    summary = str(call.get("summary") or full.get("summary") or "")
    match = re.search(r"topics discussed:\s*(.+)$", summary, re.I)
    if match:
        texts.append(match.group(1))

    parts: set[str] = set()
    for text in texts:
        low = str(text or "").lower()
        for alias, canonical in _PART_ALIASES.items():
            if re.search(r"\b" + re.escape(alias) + r"\b", low):
                parts.add(canonical)
    return parts


def call_matches_part(state: dict[str, Any], call: dict[str, Any], part: str) -> bool:
    target = canonical_part(part)
    if not target:
        return False
    return target in parts_for_call(state, call)


def vehicle_for_call(state: dict[str, Any], call: dict[str, Any]) -> dict[str, Any]:
    """Best-effort year/make/model/body/part for a call.

    Uses normalized fields first, then the call's own topics/summary.  Ding's
    imported calls carry vehicle details in their topics rather than in the
    dedicated columns, so the fallback is what makes their demand real.
    """
    full = _call_full(state, call)
    year = call.get("vehicle_year") or full.get("vehicle_year")
    make = str(call.get("vehicle_make") or full.get("vehicle_make") or "").strip()
    model = str(call.get("vehicle_model") or full.get("vehicle_model") or "").strip()
    body = str(call.get("vehicle_body") or full.get("vehicle_body") or "").strip()

    if not make or not model:
        text = _call_vehicle_text(call, full)
        found = extract_vehicle_from_text(text)
        if not make:
            make = found["vehicle_make"]
        if not model:
            model = found["vehicle_model"]
        if not body:
            body = found["vehicle_body"]
        if not year:
            ym = _YEAR_RE.search(text)
            if ym:
                year = int(ym.group(1))

    if make and not body:
        body = infer_vehicle_body(make, model) if model else "other"

    part = _part_from_topics(call, full)
    return {
        "year": year,
        "make": make,
        "model": model,
        "body": body or "other",
        "part": part,
        "label": " ".join(str(x) for x in (year, make, model) if x).strip(),
    }


def _is_won(call: dict[str, Any]) -> bool:
    return call.get("outcome") == "won"


def _is_lost(call: dict[str, Any]) -> bool:
    return call.get("outcome") == "lost"


def _is_sales_call(call: dict[str, Any]) -> bool:
    return call.get("outcome") in ("won", "lost", "pending")


def _row_from_calls(
    calls: list[dict[str, Any]],
    vehicles: list[dict[str, Any]],
    *,
    make: str,
    model: str,
    body_type: str,
) -> dict[str, Any]:
    won = sum(1 for c in calls if _is_won(c))
    lost = sum(1 for c in calls if _is_lost(c))
    sales = sum(1 for c in calls if _is_sales_call(c))
    years = [v["year"] for v in vehicles if isinstance(v.get("year"), int)]
    parts = Counter(v["part"] for v in vehicles if v.get("part"))
    last_call = max((c.get("created_at") or "" for c in calls), default="")
    cutoff = _days_ago_iso(30)
    calls_30d = sum(1 for c in calls if (c.get("created_at") or "") >= cutoff)
    return {
        "make": make,
        "model": model,
        "calls": len(calls),
        "orders": won,
        "close_rate": round(won / sales * 100, 1) if sales else 0.0,
        "year_min": min(years) if years else None,
        "year_max": max(years) if years else None,
        "top_years": [y for y, _ in Counter(years).most_common(5)],
        "top_parts": [p for p, _ in parts.most_common(5)],
        "last_call": last_call or None,
        "calls_30d": calls_30d,
        "lost": lost,
        "body_type": body_type,
    }


def build_vehicle_demand(
    state: dict[str, Any],
    org_id: Optional[str],
    *,
    rank: str = "calls",
    body: Optional[str] = None,
    site_id: Optional[str] = None,
) -> dict[str, Any]:
    calls = org_calls(state, org_id, site_id=site_id)
    models: dict[tuple[str, str], list[tuple[dict[str, Any], dict[str, Any]]]] = defaultdict(list)
    makes: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]] = defaultdict(list)
    body_counts: Counter[str] = Counter()
    tracked = 0

    for call in calls:
        if call.get("delivery_call"):
            continue
        vehicle = vehicle_for_call(state, call)
        if not vehicle["make"]:
            continue
        tracked += 1
        body_counts[vehicle["body"] or "other"] += 1
        makes[vehicle["make"]].append((call, vehicle))
        if vehicle["model"]:
            models[(vehicle["make"], vehicle["model"])].append((call, vehicle))

    model_rows = [
        _row_from_calls(
            [c for c, _ in items],
            [v for _, v in items],
            make=key[0],
            model=key[1],
            body_type=items[0][1]["body"] or "other",
        )
        for key, items in models.items()
    ]
    make_rows = [
        _row_from_calls(
            [c for c, _ in items],
            [v for _, v in items],
            make=make,
            model="",
            body_type="",
        )
        for make, items in makes.items()
    ]

    if body and body != "all":
        model_rows = [r for r in model_rows if r["body_type"] == body]
        allowed = {r["make"] for r in model_rows}
        make_rows = [r for r in make_rows if r["make"] in allowed]

    sort_key = {
        "recent": lambda r: (r["calls_30d"], r["calls"]),
        "lost": lambda r: (r["lost"], r["calls"]),
    }.get(rank, lambda r: (r["calls"], r["calls_30d"]))
    model_rows.sort(key=sort_key, reverse=True)
    make_rows.sort(key=sort_key, reverse=True)

    return {
        "tracked_calls": tracked,
        "total_calls": len(calls),
        "makes": make_rows,
        "models": model_rows,
        "body_counts": dict(body_counts),
    }


def build_lost_vehicles(
    state: dict[str, Any],
    org_id: Optional[str],
    *,
    rank: str = "calls",
    body: Optional[str] = None,
    site_id: Optional[str] = None,
) -> list[dict[str, Any]]:
    calls = org_calls(state, org_id, site_id=site_id)
    groups: dict[tuple[str, str, str], list[tuple[dict[str, Any], dict[str, Any]]]] = defaultdict(list)
    for call in calls:
        if call.get("delivery_call"):
            continue
        vehicle = vehicle_for_call(state, call)
        if not vehicle["make"] or not vehicle["model"]:
            continue
        groups[(vehicle["make"], vehicle["model"], vehicle["part"] or "Unspecified")].append((call, vehicle))

    rows: list[dict[str, Any]] = []
    cutoff = _days_ago_iso(30)
    for (make, model, part), items in groups.items():
        lost = sum(1 for c, _ in items if _is_lost(c))
        if lost == 0:
            continue
        won = sum(1 for c, _ in items if _is_won(c))
        sales = sum(1 for c, _ in items if _is_sales_call(c))
        years = [v["year"] for _, v in items if isinstance(v.get("year"), int)]
        rows.append({
            "make": make,
            "model": model,
            "part": part,
            "asked": len(items),
            "lost": lost,
            "won": won,
            "close_rate": round(won / sales * 100, 1) if sales else 0.0,
            "years": f"{min(years)}–{max(years)}" if years else "",
            "last_asked": max((c.get("created_at") or "" for c, _ in items), default=""),
            "calls_30d": sum(1 for c, _ in items if (c.get("created_at") or "") >= cutoff),
            "body_type": items[0][1]["body"] or "other",
        })

    if body and body != "all":
        rows = [r for r in rows if r["body_type"] == body]
    sort_key = {
        "recent": lambda r: (r["calls_30d"], r["asked"]),
        "lost": lambda r: (r["lost"], r["asked"]),
    }.get(rank, lambda r: (r["asked"], r["lost"]))
    rows.sort(key=sort_key, reverse=True)
    return rows[:200]


def _month_key(value: Optional[str]) -> str:
    return (value or "")[:7]


def build_stock_alerts(
    state: dict[str, Any],
    org_id: Optional[str],
    *,
    rank: str = "calls",
    site_id: Optional[str] = None,
) -> list[dict[str, Any]]:
    calls = org_calls(state, org_id, site_id=site_id)
    groups: dict[tuple[str, str, str], list[tuple[dict[str, Any], dict[str, Any]]]] = defaultdict(list)
    for call in calls:
        if call.get("delivery_call"):
            continue
        vehicle = vehicle_for_call(state, call)
        if not vehicle["make"] or not vehicle["model"]:
            continue
        groups[(vehicle["make"], vehicle["model"], vehicle["part"] or "Unspecified")].append((call, vehicle))

    months = sorted({_month_key(c.get("created_at")) for c in calls if _month_key(c.get("created_at"))})
    if not months:
        return []
    this_month = current_month_str()
    if this_month not in months:
        this_month = months[-1]
    prior_months = [m for m in months if m < this_month][-3:]

    now = now_utc()
    days_in_month = (now.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    day_fraction = now.day / max(1, days_in_month.day) if this_month == current_month_str() else 1.0

    alerts: list[dict[str, Any]] = []
    for (make, model, part), items in groups.items():
        this_calls = [(c, v) for c, v in items if _month_key(c.get("created_at")) == this_month]
        if len(this_calls) < 2:
            continue
        baseline_counts = [
            sum(1 for c, _ in items if _month_key(c.get("created_at")) == m)
            for m in prior_months
        ]
        baseline = round(sum(baseline_counts) / len(baseline_counts), 1) if baseline_counts else 0.0
        projected = round(len(this_calls) / max(0.1, day_fraction))
        ratio = round(projected / max(1.0, baseline), 2) if baseline else float(projected)
        if ratio < 1.5:
            continue
        years = [v["year"] for _, v in items if isinstance(v.get("year"), int)]
        alerts.append({
            "make": make,
            "model": model,
            "part": part,
            "years": f"{min(years)}–{max(years)}" if years else "",
            "this_month": len(this_calls),
            "projected": projected,
            "baseline": baseline,
            "ratio": ratio,
            "lost": sum(1 for c, _ in this_calls if _is_lost(c)),
        })

    sort_key = {
        "recent": lambda r: (r["this_month"], r["ratio"]),
        "lost": lambda r: (r["lost"], r["ratio"]),
    }.get(rank, lambda r: (r["ratio"], r["this_month"]))
    alerts.sort(key=sort_key, reverse=True)
    return alerts[:20]


def customer_store_keys(org_id: Optional[str], key: str) -> list[str]:
    """All storage keys a customer may be saved under.

    The profile URL uses the latest raw phone or name, while the customer
    grouping code uses a normalized ``p:``/``n:`` key.  Writing and reading all
    variants keeps a tag attached when a newer call changes the display key.
    """
    raw = str(key or "").strip()
    candidates: list[str] = []
    if raw:
        candidates.append(raw)
        if raw.startswith(("p:", "n:")):
            candidates.append(raw[2:])
        digits = re.sub(r"\D", "", raw)
        phone = normalize_phone(raw)
        # Only add phone aliases for actual phone-shaped keys; a business name
        # like "86 Auto World" should not collide with a short phone fragment.
        if phone and (raw.startswith("p:") or len(digits) >= 7):
            candidates.append(f"p:{phone}")
            candidates.append(phone)
    seen: set[str] = set()
    keys: list[str] = []
    for candidate in candidates:
        if not candidate:
            continue
        stored = f"{org_id}:{candidate}" if org_id and org_id != "org-keech-salvage" else candidate
        if stored not in seen:
            seen.add(stored)
            keys.append(stored)
    return keys


def _manual_tag(state: dict[str, Any], org_id: Optional[str], key: str) -> str:
    tags = state.get("customer_tags", {}) or {}
    for store_key in customer_store_keys(org_id, key):
        value = tags.get(store_key)
        if value:
            return str(value)
    return ""


def _customer_profile(state: dict[str, Any], org_id: Optional[str], key: str) -> dict[str, Any]:
    profiles = state.get("customer_profiles", {}) or {}
    for store_key in customer_store_keys(org_id, key):
        value = profiles.get(store_key)
        if isinstance(value, dict):
            return value
    return {}


def _customer_group_key(call: dict[str, Any]) -> str:
    phone = normalize_phone(call.get("customer_phone"))
    if phone:
        return f"p:{phone}"
    name = str(call.get("customer_name") or "").strip().lower()
    return f"n:{name}" if name else ""


def build_customer_insights(
    state: dict[str, Any],
    org_id: Optional[str],
    *,
    rep_id: Optional[str] = None,
    tag: Optional[str] = None,
    include_all: bool = False,
    site_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
) -> dict[str, Any]:
    calls = org_calls(state, org_id, rep_id=rep_id, site_id=site_id)
    if date_from:
        calls = [c for c in calls if (c.get("created_at") or "")[:10] >= date_from]
    if date_to:
        calls = [c for c in calls if (c.get("created_at") or "")[:10] <= date_to]
    if not calls:
        return {
            "total_customers": 0,
            "repeat_customers": 0,
            "avg_order_value": 0.0,
            "avg_order_basis": "ai",
            "most_calls": [],
            "most_orders": [],
            "top_value": [],
            "win_back": [],
            "suggested": [],
            "type_breakdown": [],
            "all_customers": [],
            "untagged_customers": 0,
        }

    avg_order = 350.0
    basis = "default"
    business = (state.get("settings_business_by_org") or {}).get(org_id or "")
    if not business:
        business = state.get("settings_business") or {}
    configured = business.get("avg_order_value") if isinstance(business, dict) else None
    if isinstance(configured, (int, float)) and configured > 0:
        avg_order = float(configured)
        basis = "manager"

    marks = state.get("winback_marks", []) or []
    latest_mark: dict[str, dict[str, Any]] = {}
    for mark in marks:
        if org_id is not None and mark.get("org_id") != org_id:
            continue
        if rep_id and mark.get("rep_id") != rep_id:
            continue
        key = mark.get("customer_key") or ""
        if key and key not in latest_mark:
            latest_mark[key] = mark

    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for call in calls:
        key = _customer_group_key(call)
        if key:
            grouped[key].append(call)

    all_customers: list[dict[str, Any]] = []
    type_counts: dict[str, dict[str, float]] = defaultdict(lambda: {"customers": 0, "calls": 0, "orders": 0, "est_value": 0.0})

    for _group, group_calls in grouped.items():
        group_calls.sort(key=lambda c: c.get("created_at", ""), reverse=True)
        latest = group_calls[0]
        key = str(latest.get("customer_phone") or latest.get("customer_name") or "")
        profile = _customer_profile(state, org_id, key) or _customer_profile(state, org_id, _group)
        name = str(profile.get("name") or latest.get("customer_name") or key)
        phone = str(latest.get("customer_phone") or "")
        orders = [c for c in group_calls if _is_won(c) and not c.get("delivery_call")]
        ai_value = sum(float(c.get("order_value") or 0.0) for c in orders)
        unvalued = sum(1 for c in orders if not (float(c.get("order_value") or 0.0) > 0))
        est_value = ai_value + unvalued * avg_order
        if not orders:
            value_basis = ""
        elif unvalued == 0:
            value_basis = "ai"
        elif ai_value > 0:
            value_basis = "mixed"
        else:
            value_basis = "estimated"

        topics: Counter[str] = Counter()
        for call in group_calls:
            for topic in _call_topics(call, _call_full(state, call)):
                topics[topic] += 1
            part = canonical_part(call.get("part_requested"))
            if part:
                topics[part] += 1

        manual = _manual_tag(state, org_id, key) or _manual_tag(state, org_id, _group)
        if manual:
            customer_tag, tag_source = manual, "manual"
        else:
            customer_tag, tag_source = infer_customer_tag(name)

        mark = latest_mark.get(key) or {}
        stat = {
            "key": key,
            "name": name,
            "phone": phone,
            "calls": len(group_calls),
            "orders": len(orders),
            "talk_sec": round(sum(int(c.get("duration_sec") or 0) for c in group_calls), 1),
            "last_call_at": latest.get("created_at", ""),
            "last_call_id": latest.get("id", ""),
            "last_category": latest.get("category", "Sales Inquiry"),
            "top_topics": [t for t, _ in topics.most_common(5)] or ["Part Inquiry"],
            "rep_names": sorted({str(c.get("rep_name")) for c in group_calls if c.get("rep_name")}),
            "tag": customer_tag,
            "tag_source": tag_source,
            "email": str(profile.get("email") or ""),
            "text_ok": profile.get("text_ok", True) is not False,
            "est_value": round(est_value, 2),
            "value_basis": value_basis,
            "reason": f"Quoted {topics.most_common(1)[0][0] if topics else 'parts'} on {latest.get('created_at', '')[:10]} — follow up recommended",
            "priority": "high" if orders or len(group_calls) > 3 else "medium",
            "opener": "",
            "last_mark": str(mark.get("outcome") or ""),
        }
        all_customers.append(stat)

        bucket = customer_tag if customer_tag in {"body_shop", "mechanic", "fleet", "retail", "dealership", "regular"} else "untagged"
        type_counts[bucket]["customers"] += 1
        type_counts[bucket]["calls"] += len(group_calls)
        type_counts[bucket]["orders"] += len(orders)
        type_counts[bucket]["est_value"] += est_value

    all_customers.sort(key=lambda c: (c["orders"], c["calls"], c["est_value"]), reverse=True)
    filtered = all_customers
    if tag == "untagged":
        # The manager's untagged queue is "not manually confirmed yet".
        # Auto-suggested tags stay visible on the row but do not clear the
        # queue until someone saves a business type.
        filtered = [c for c in all_customers if c["tag_source"] != "manual"]
    elif tag and tag != "all":
        filtered = [c for c in all_customers if c["tag"] == tag]

    type_breakdown = [
        {
            "tag": tag_name,
            "customers": int(values["customers"]),
            "calls": int(values["calls"]),
            "orders": int(values["orders"]),
            "count": int(values["customers"]),
            "est_value": round(values["est_value"], 2),
        }
        for tag_name, values in sorted(type_counts.items(), key=lambda kv: -kv[1]["customers"])
    ]

    suggested = [c for c in filtered if c["calls"] >= 2 and c["orders"] == 0][:15] or filtered[:15]
    win_back = [c for c in filtered if c["orders"] > 0][:15]
    limit = 500 if include_all else 50

    return {
        "total_customers": len(filtered),
        "repeat_customers": sum(1 for c in filtered if c["calls"] > 1),
        "avg_order_value": round(avg_order, 2),
        "avg_order_basis": basis,
        "most_calls": sorted(filtered, key=lambda c: c["calls"], reverse=True)[:15],
        "most_orders": sorted(filtered, key=lambda c: c["orders"], reverse=True)[:15],
        "top_value": sorted(filtered, key=lambda c: c["est_value"], reverse=True)[:15],
        "win_back": win_back,
        "suggested": suggested,
        "type_breakdown": type_breakdown,
        "all_customers": filtered[:limit],
        "untagged_customers": sum(1 for c in all_customers if c["tag_source"] != "manual"),
    }


# ---------------------------------------------------------------------------
# Win-back
# ---------------------------------------------------------------------------

def _winback_marks(state: dict[str, Any], org_id: Optional[str], *, rep_id: Optional[str] = None, site_id: Optional[str] = None) -> list[dict[str, Any]]:
    marks = [m for m in (state.get("winback_marks", []) or []) if isinstance(m, dict)]
    if org_id is not None:
        marks = [m for m in marks if m.get("org_id") == org_id]
    if rep_id:
        marks = [m for m in marks if m.get("rep_id") == rep_id]
    if site_id:
        reps = {uid for uid, u in state.get("users_by_id", {}).items() if u.get("site_id") == site_id}
        marks = [m for m in marks if m.get("rep_id") in reps]
    return marks


def _winback_confirmation(state: dict[str, Any], mark: dict[str, Any]) -> tuple[bool, str, float]:
    org_id = mark.get("org_id")
    key = mark.get("customer_key") or ""
    created = mark.get("created_at") or ""
    best: Optional[dict[str, Any]] = None
    for call in state.get("calls", []):
        if org_id is not None and call.get("org_id") != org_id:
            continue
        if not _is_won(call) or call.get("delivery_call"):
            continue
        if (call.get("created_at") or "") <= created:
            continue
        if key and key not in {str(call.get("customer_phone") or ""), str(call.get("customer_name") or "")}:
            # Match normalized phone as well as the raw key.
            if not (normalize_phone(key) and normalize_phone(key) == normalize_phone(call.get("customer_phone"))):
                continue
        if best is None or (call.get("created_at") or "") < (best.get("created_at") or ""):
            best = call
    if best is None:
        return False, "", 0.0
    return True, str(best.get("id") or ""), float(best.get("order_value") or 0.0)


def build_winback_results(
    state: dict[str, Any],
    org_id: Optional[str],
    *,
    rep_id: Optional[str] = None,
    site_id: Optional[str] = None,
) -> dict[str, Any]:
    marks = _winback_marks(state, org_id, rep_id=rep_id, site_id=site_id)
    months: dict[str, dict[str, float]] = defaultdict(lambda: {
        "reached": 0, "ordered": 0, "no_interest": 0, "confirmed": 0, "confirmed_value": 0.0,
    })
    recent: list[dict[str, Any]] = []
    confirmed_total = 0
    for mark in sorted(marks, key=lambda m: m.get("created_at", ""), reverse=True):
        outcome = mark.get("outcome") or "reached"
        month = month_of(mark.get("created_at"))
        bucket = months[month]
        if outcome in bucket:
            bucket[outcome] += 1
        confirmed, call_id, value = _winback_confirmation(state, mark)
        if confirmed:
            confirmed_total += 1
            bucket["confirmed"] += 1
            bucket["confirmed_value"] += value
        if len(recent) < 25:
            recent.append({
                "id": mark.get("id", ""),
                "customer_key": mark.get("customer_key", ""),
                "customer_name": mark.get("customer_name", ""),
                "outcome": outcome,
                "rep_id": mark.get("rep_id", ""),
                "rep_name": mark.get("rep_name", ""),
                "created_at": mark.get("created_at", ""),
                "confirmed": confirmed,
                "confirmed_call_id": call_id,
                "confirmed_value": value,
            })

    return {
        "months": [
            {"month": month, **values}
            for month, values in sorted(months.items())
        ],
        "recent": recent,
        "total": len(marks),
        "confirmed": confirmed_total,
    }


def _winback_leaders(state: dict[str, Any], org_id: Optional[str], *, month: Optional[str] = None, site_id: Optional[str] = None) -> list[dict[str, Any]]:
    marks = _winback_marks(state, org_id, site_id=site_id)
    if month:
        marks = [m for m in marks if month_of(m.get("created_at")) == month]
    grouped: dict[str, dict[str, Any]] = {}
    for mark in marks:
        rep_id = mark.get("rep_id") or ""
        row = grouped.setdefault(rep_id, {
            "rep_id": rep_id,
            "rep_name": mark.get("rep_name") or "Rep",
            "marks": 0,
            "customers_won": 0,
            "won_value": 0.0,
        })
        row["marks"] += 1
        confirmed, _, value = _winback_confirmation(state, mark)
        if confirmed:
            row["customers_won"] += 1
            row["won_value"] += value
    rows = list(grouped.values())
    rows.sort(key=lambda r: (r["won_value"], r["customers_won"], r["marks"]), reverse=True)
    return rows


def build_winback_leaderboard(
    state: dict[str, Any],
    org_id: Optional[str],
    *,
    month: Optional[str] = None,
    site_id: Optional[str] = None,
) -> dict[str, Any]:
    marks = _winback_marks(state, org_id, site_id=site_id)
    months = sorted({month_of(m.get("created_at")) for m in marks}, reverse=True)
    selected = month or (months[0] if months else "")
    leaders = _winback_leaders(state, org_id, month=selected or None, site_id=site_id)
    return {"months": months, "month": selected, "leaders": leaders}


def _arrival_sales_by_month(state: dict[str, Any], org_id: Optional[str], *, site_id: Optional[str] = None) -> dict[str, dict[str, dict[str, Any]]]:
    """rep_id -> month -> {sales, contacted, hours, rep_name} from arrival callers."""
    arrivals = [a for a in (state.get("arrivals", []) or []) if isinstance(a, dict)]
    if org_id is not None:
        arrivals = [a for a in arrivals if a.get("org_id") == org_id]
    if site_id:
        reps = {uid for uid, u in state.get("users_by_id", {}).items() if u.get("site_id") == site_id}
    else:
        reps = None

    out: dict[str, dict[str, dict[str, Any]]] = defaultdict(lambda: defaultdict(lambda: {
        "sales": 0, "contacted": 0, "hours": [], "rep_name": "",
    }))
    for arrival in arrivals:
        created = parse_iso(arrival.get("created_at"))
        for caller in arrival.get("callers", []) or []:
            rep_id = caller.get("rep_id") or ""
            if not rep_id or (reps is not None and rep_id not in reps):
                continue
            month = month_of(caller.get("updated_at") or caller.get("last_asked") or arrival.get("created_at"))
            row = out[rep_id][month]
            row["rep_name"] = caller.get("rep_name") or row["rep_name"] or "Rep"
            if caller.get("status") in ("called", "sold", "ordered"):
                row["contacted"] += 1
            if caller.get("status") == "sold":
                row["sales"] += 1
                updated = parse_iso(caller.get("updated_at"))
                if created and updated:
                    row["hours"].append(max(0.0, (updated - created).total_seconds() / 3600))
    return out


def _arrival_board_for_month(state: dict[str, Any], org_id: Optional[str], month: str, site_id: Optional[str] = None) -> list[dict[str, Any]]:
    data = _arrival_sales_by_month(state, org_id, site_id=site_id)
    rows = []
    for rep_id, months in data.items():
        row = months.get(month)
        if not row:
            continue
        hours = row["hours"]
        rows.append({
            "rep_id": rep_id,
            "rep_name": row["rep_name"] or "Rep",
            "sales": row["sales"],
            "avg_hours_to_sale": round(sum(hours) / len(hours), 1) if hours else None,
            "contacted": row["contacted"],
        })
    rows.sort(
        key=lambda r: (
            r["sales"],
            -(r["avg_hours_to_sale"] if r["avg_hours_to_sale"] is not None else 1e9),
        ),
        reverse=True,
    )
    return rows


def build_arrivals_leaderboard(state: dict[str, Any], org_id: Optional[str], *, month: Optional[str] = None, site_id: Optional[str] = None) -> dict[str, Any]:
    data = _arrival_sales_by_month(state, org_id, site_id=site_id)
    months = sorted({m for months in data.values() for m in months}, reverse=True)
    selected = month or (months[0] if months else current_month_str())
    return {"month": selected, "leaders": _arrival_board_for_month(state, org_id, selected, site_id)}


def build_arrivals_winner(state: dict[str, Any], org_id: Optional[str], *, site_id: Optional[str] = None) -> dict[str, Any]:
    data = _arrival_sales_by_month(state, org_id, site_id=site_id)
    months = sorted({m for months in data.values() for m in months})
    previous = [m for m in months if m < current_month_str()]
    if not previous:
        return {"month": "", "winners": []}
    month = previous[-1]
    rows = [r for r in _arrival_board_for_month(state, org_id, month, site_id) if r["sales"] > 0]
    if not rows:
        return {"month": month, "winners": []}
    top = rows[0]["sales"]
    return {"month": month, "winners": [r for r in rows if r["sales"] == top]}


def build_arrivals_streak(state: dict[str, Any], org_id: Optional[str], *, user_id: str, site_id: Optional[str] = None) -> tuple[dict[str, Any], dict[str, Any]]:
    data = _arrival_sales_by_month(state, org_id, site_id=site_id)
    months = sorted({m for months in data.values() for m in months})
    if not months:
        return (
            {"show": False, "month": current_month_str(), "leader_name": "", "leader_streak": 0, "leader_sales": 0, "my_sales": 0},
            {"kind": "", "month": current_month_str(), "leader_name": "", "streak": 0, "breakers": [], "breaker_sales": 0, "leader_sales": 0},
        )
    this_month = current_month_str() if current_month_str() in months else months[-1]
    board = _arrival_board_for_month(state, org_id, this_month, site_id)
    if not board:
        return (
            {"show": False, "month": this_month, "leader_name": "", "leader_streak": 0, "leader_sales": 0, "my_sales": 0},
            {"kind": "", "month": this_month, "leader_name": "", "streak": 0, "breakers": [], "breaker_sales": 0, "leader_sales": 0},
        )
    leader = board[0]
    my_sales = next((r["sales"] for r in board if r["rep_id"] == user_id), 0)

    # Count consecutive months (ending with this month) where this rep led.
    streak = 0
    for month in reversed(months):
        if month > this_month:
            continue
        rows = [r for r in _arrival_board_for_month(state, org_id, month, site_id) if r["sales"] > 0]
        if rows and rows[0]["rep_id"] == leader["rep_id"]:
            streak += 1
        else:
            break

    chase = {
        "show": bool(my_sales and my_sales == leader["sales"] - 1),
        "month": this_month,
        "leader_name": leader["rep_name"],
        "leader_streak": streak,
        "leader_sales": leader["sales"],
        "my_sales": my_sales,
    }

    # A streak can only be broken by someone else, so look at the rep who led
    # through last month and compare their current-month sales with the field.
    previous_months = [m for m in months if m < this_month]
    streak_break = {
        "kind": "",
        "month": this_month,
        "leader_name": "",
        "streak": 0,
        "breakers": [],
        "breaker_sales": 0,
        "leader_sales": 0,
    }
    if previous_months:
        previous_month = previous_months[-1]
        previous_board = [r for r in _arrival_board_for_month(state, org_id, previous_month, site_id) if r["sales"] > 0]
        if previous_board:
            previous_leader = previous_board[0]
            previous_streak = 0
            for month in reversed(months):
                if month > previous_month:
                    continue
                rows = [r for r in _arrival_board_for_month(state, org_id, month, site_id) if r["sales"] > 0]
                if rows and rows[0]["rep_id"] == previous_leader["rep_id"]:
                    previous_streak += 1
                else:
                    break
            if previous_streak >= 2:
                current_leader = board[0] if board else None
                previous_this_month = next(
                    (r for r in board if r["rep_id"] == previous_leader["rep_id"]),
                    None,
                )
                if current_leader and current_leader["rep_id"] != previous_leader["rep_id"]:
                    kind = "breaking"
                elif not previous_this_month:
                    kind = "broken"
                else:
                    kind = ""
                if kind:
                    streak_break = {
                        "kind": kind,
                        "month": this_month,
                        "leader_name": previous_leader["rep_name"],
                        "streak": previous_streak,
                        "breakers": [current_leader["rep_name"]] if current_leader else [],
                        "breaker_sales": current_leader["sales"] if current_leader else 0,
                        "leader_sales": previous_this_month["sales"] if previous_this_month else 0,
                    }
    return chase, streak_break


def _winback_trophy_months(state: dict[str, Any], org_id: Optional[str], site_id: Optional[str] = None) -> list[dict[str, Any]]:
    marks = _winback_marks(state, org_id, site_id=site_id)
    months = sorted({month_of(m.get("created_at")) for m in marks})
    result = []
    for month in months:
        leaders = _winback_leaders(state, org_id, month=month, site_id=site_id)
        if not leaders:
            continue
        top_dollars = leaders[0] if leaders[0]["won_value"] > 0 else None
        top_customers = max(leaders, key=lambda r: r["customers_won"]) if any(r["customers_won"] for r in leaders) else None
        if top_customers and top_customers["customers_won"] <= 0:
            top_customers = None
        truck_rows = [r for r in _arrival_board_for_month(state, org_id, month, site_id) if r["sales"] > 0]
        result.append({
            "month": month,
            "top_dollars": top_dollars,
            "top_customers": top_customers,
            "truck": [{"rep_id": r["rep_id"], "rep_name": r["rep_name"], "sales": r["sales"]} for r in truck_rows],
        })
    return result


def _streak_stats(months: list[str], won: set[str], all_months: list[str]) -> tuple[int, int]:
    if not won:
        return 0, 0
    best = current = 0
    previous = None
    for month in all_months:
        if month in won:
            current = current + 1 if previous and _next_month(previous) == month else 1
            best = max(best, current)
            previous = month
        else:
            current = 0
            previous = None
    if all_months:
        last = all_months[-1]
        tail = 0
        for month in reversed(all_months):
            if month in won:
                tail += 1
            else:
                break
        current = tail if last in won else 0
    return current, best


def _next_month(month: str) -> str:
    try:
        year, mon = int(month[:4]), int(month[5:7])
        return f"{year + 1}-01" if mon == 12 else f"{year}-{mon + 1:02d}"
    except Exception:
        return ""


def build_winback_trophies(state: dict[str, Any], org_id: Optional[str], *, site_id: Optional[str] = None) -> dict[str, Any]:
    months = _winback_trophy_months(state, org_id, site_id)
    all_months = sorted({m["month"] for m in months})
    reps = org_users(state, org_id)
    dollars_months: dict[str, set[str]] = defaultdict(set)
    customer_months: dict[str, set[str]] = defaultdict(set)
    truck_months: dict[str, set[str]] = defaultdict(set)
    for row in months:
        if row["top_dollars"]:
            dollars_months[row["top_dollars"]["rep_id"]].add(row["month"])
        if row["top_customers"]:
            customer_months[row["top_customers"]["rep_id"]].add(row["month"])
        for champ in row["truck"]:
            truck_months[champ["rep_id"]].add(row["month"])

    rep_rows = []
    for user in reps:
        winback_months = dollars_months[user["id"]] | customer_months[user["id"]]
        current, best = _streak_stats(all_months, dollars_months[user["id"]], all_months)
        truck_current, truck_best = _streak_stats(all_months, truck_months[user["id"]], all_months)
        rep_rows.append({
            "rep_id": user["id"],
            "rep_name": user.get("name", "Rep"),
            "trophies": len(dollars_months[user["id"]]) + len(customer_months[user["id"]]) + len(truck_months[user["id"]]),
            "months_won": len(winback_months),
            "current_streak": current,
            "best_streak": best,
            "truck_trophies": len(truck_months[user["id"]]),
            "truck_streak": truck_current,
            "best_truck_streak": truck_best,
        })
    rep_rows.sort(key=lambda r: r["trophies"], reverse=True)
    return {"months": list(reversed(months)), "reps": rep_rows}


def build_winback_winners(state: dict[str, Any], org_id: Optional[str], *, site_id: Optional[str] = None) -> dict[str, Any]:
    months = _winback_trophy_months(state, org_id, site_id)
    if not months:
        return {"month": "", "top_dollars": None, "top_customers": None, "truck": []}
    return months[-1]


# ---------------------------------------------------------------------------
# Team, queue and leaderboards
# ---------------------------------------------------------------------------

def build_team_queue(state: dict[str, Any], org_id: Optional[str], *, site_id: Optional[str] = None) -> dict[str, Any]:
    reps = org_users(state, org_id)
    if site_id:
        reps = [r for r in reps if r.get("site_id") == site_id]
    open_callbacks = [c for c in (state.get("callbacks_open", []) or []) if org_id is None or c.get("org_id") == org_id]
    resolved = [c for c in (state.get("callbacks_resolved", []) or []) if org_id is None or c.get("org_id") == org_id]
    today = today_str()

    rows = []
    for rep in reps:
        remaining = sum(1 for c in open_callbacks if c.get("rep_id") == rep["id"])
        cleared = sum(
            1 for c in resolved
            if c.get("rep_id") == rep["id"]
            and (c.get("followed_up_at") or c.get("resolved_at") or c.get("updated_at") or c.get("created_at") or "")[:10] == today
        )
        total = cleared + remaining
        pct = round(cleared / total * 100) if total else 100
        rows.append({
            "rep_id": rep["id"],
            "rep_name": rep.get("name", "Rep"),
            "cleared_today": cleared,
            "remaining": remaining,
            "pct": pct,
            "behind": remaining > 0 and pct < 50,
        })
    rows.sort(key=lambda r: (r["behind"], r["remaining"]), reverse=True)
    return {"after_noon": now_utc().hour >= 12, "reps": rows}


def build_queue(state: dict[str, Any], org_id: Optional[str], *, user: dict[str, Any], site_id: Optional[str] = None) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    open_callbacks = [c for c in (state.get("callbacks_open", []) or []) if org_id is None or c.get("org_id") == org_id]
    if site_id:
        open_callbacks = filter_calls_by_site(state, open_callbacks, site_id)
    for call in open_callbacks:
        if call.get("rep_id") not in (None, "", user.get("id")) and user.get("role") in REP_ROLES:
            continue
        items.append({
            "kind": "callback",
            "id": call.get("id", ""),
            "title": f"{call.get('customer_name') or 'Customer'} — {call.get('part_requested') or 'callback'}",
            "detail": call.get("reason") or "Follow up with this customer",
            "phone": call.get("customer_phone", ""),
            "urgent": bool(call.get("list_overdue")),
            "link": "/calls",
            "at": call.get("created_at", ""),
        })

    arrivals = [a for a in (state.get("arrivals", []) or []) if org_id is None or a.get("org_id") == org_id]
    if site_id:
        reps = {uid for uid, u in state.get("users_by_id", {}).items() if u.get("site_id") == site_id}
    else:
        reps = None
    for arrival in arrivals:
        vehicle = " ".join(str(x) for x in (arrival.get("vehicle_year"), arrival.get("vehicle_make"), arrival.get("vehicle_model")) if x)
        for caller in arrival.get("callers", []) or []:
            if caller.get("status") != "to_call":
                continue
            if reps is not None and caller.get("rep_id") not in reps:
                continue
            if user.get("role") in REP_ROLES and caller.get("rep_id") not in (None, "", user.get("id")):
                continue
            items.append({
                "kind": "arrival",
                "id": f"{arrival.get('id')}:{caller.get('key')}",
                "title": f"{caller.get('customer_name') or 'Customer'} — {vehicle} just came in",
                "detail": f"Asked about {caller.get('vehicle') or vehicle} ({', '.join(caller.get('parts') or []) or 'parts'})",
                "phone": caller.get("customer_phone", ""),
                "urgent": True,
                "link": "/vehicles",
                "at": arrival.get("created_at", ""),
            })

    items.sort(key=lambda i: (not i["urgent"], i.get("at", "")), reverse=False)
    counts = Counter(i["kind"] for i in items)
    return {
        "items": items[:50],
        "counts": {"roleplay": counts.get("roleplay", 0), "arrival": counts.get("arrival", 0), "missed": counts.get("callback", 0)},
        "progress": None,
    }


def build_list_leaderboard(state: dict[str, Any], org_id: Optional[str], *, month: Optional[str] = None, site_id: Optional[str] = None) -> dict[str, Any]:
    lists = [l for l in (state.get("callback_lists", []) or []) if org_id is None or l.get("org_id") == org_id]
    if site_id:
        reps = {uid for uid, u in state.get("users_by_id", {}).items() if u.get("site_id") == site_id}
        lists = [l for l in lists if l.get("rep_id") in reps]
    months = sorted({month_of(l.get("created_at")) for l in lists}, reverse=True)
    selected = month or (months[0] if months else current_month_str())
    grouped: dict[str, dict[str, Any]] = {}
    for row in lists:
        if month_of(row.get("created_at")) != selected:
            continue
        rep_id = row.get("rep_id") or ""
        entry = grouped.setdefault(rep_id, {
            "rep_id": rep_id,
            "name": row.get("rep_name") or "Rep",
            "revenue": 0.0,
            "customers": 0,
            "lists": 0,
        })
        entry["lists"] += 1
        entry["revenue"] += float(row.get("revenue") or 0.0)
        entry["customers"] += int(row.get("sold") or 0)
    rows = list(grouped.values())
    rows.sort(key=lambda r: (r["revenue"], r["customers"], r["lists"]), reverse=True)
    return {"month": selected, "reps": rows}


def build_delivery_board(state: dict[str, Any], org_id: Optional[str], *, month: Optional[str] = None, site_id: Optional[str] = None) -> dict[str, Any]:
    calls = org_calls(state, org_id, site_id=site_id)
    calls = [c for c in calls if c.get("delivery_score") is not None or c.get("delivery_call") or c.get("delivery_check")]
    months = sorted({month_of(c.get("created_at")) for c in calls if month_of(c.get("created_at"))}, reverse=True)
    selected = month or (months[0] if months else current_month_str())
    grouped: dict[str, dict[str, Any]] = {}
    for call in calls:
        if month_of(call.get("created_at")) != selected:
            continue
        score = call.get("delivery_score")
        if score is None:
            continue
        rep_id = call.get("rep_id") or ""
        entry = grouped.setdefault(rep_id, {"rep_id": rep_id, "name": call.get("rep_name") or "Rep", "scores": []})
        entry["scores"].append(float(score))
    rows = [
        {
            "rep_id": rep_id,
            "name": entry["name"],
            "avg_score": round(sum(entry["scores"]) / len(entry["scores"])),
            "checked": len(entry["scores"]),
        }
        for rep_id, entry in grouped.items()
        if entry["scores"]
    ]
    rows.sort(key=lambda r: (r["avg_score"], r["checked"]), reverse=True)
    return {"month": selected, "reps": rows}


def build_team_player_board(state: dict[str, Any], org_id: Optional[str], *, month: Optional[str] = None, site_id: Optional[str] = None) -> dict[str, Any]:
    reps = org_users(state, org_id)
    if site_id:
        reps = [r for r in reps if r.get("site_id") == site_id]
    selected = month or current_month_str()
    resolved = [c for c in (state.get("callbacks_resolved", []) or []) if org_id is None or c.get("org_id") == org_id]
    rows = []
    for rep in reps:
        handled = sum(
            1 for c in resolved
            if c.get("rep_id") == rep["id"] and month_of(c.get("resolved_at") or c.get("followed_up_at") or c.get("created_at")) == selected
        )
        all_time = sum(1 for c in resolved if c.get("rep_id") == rep["id"])
        rows.append({
            "rep_id": rep["id"],
            "name": rep.get("name", "Rep"),
            "rep_name": rep.get("name", "Rep"),
            "handled": handled,
            "all_time": all_time,
        })
    rows.sort(key=lambda r: (r["handled"], r["all_time"]), reverse=True)
    return {"month": selected, "reps": rows}


def build_champions(state: dict[str, Any], org_id: Optional[str], *, site_id: Optional[str] = None) -> dict[str, Any]:
    calls = org_calls(state, org_id, site_id=site_id)
    months = sorted({month_of(c.get("created_at")) for c in calls if month_of(c.get("created_at"))})[-6:]
    champions: list[dict[str, Any]] = []
    totals: Counter[str] = Counter()
    totals_by_id: dict[str, str] = {}

    for month in months:
        month_calls = [c for c in calls if month_of(c.get("created_at")) == month]
        # Vehicle sales
        sales: Counter[str] = Counter()
        names: dict[str, str] = {}
        for call in month_calls:
            if _is_won(call) and not call.get("delivery_call") and call.get("rep_id"):
                sales[call["rep_id"]] += 1
                names[call["rep_id"]] = call.get("rep_name") or names.get(call["rep_id"], "Rep")
        if sales:
            top = max(sales.values())
            winners = [rid for rid, count in sales.items() if count == top]
            champions.append({
                "category": "vehicle_sales",
                "period": month,
                "names": [names.get(rid, "Rep") for rid in winners],
                "rep_ids": winners,
                "detail": f"{top} sales · {round(top / max(1, sum(1 for c in month_calls if c.get('rep_id') in winners and _is_sales_call(c))) * 100, 1)}% close rate",
                "site_ids": [],
            })
            for rid in winners:
                totals[names.get(rid, "Rep")] += 1
                totals_by_id[rid] = names.get(rid, "Rep")

        # Delivery
        delivery: dict[str, list[float]] = defaultdict(list)
        for call in month_calls:
            if call.get("delivery_score") is not None and call.get("rep_id"):
                delivery[call["rep_id"]].append(float(call["delivery_score"]))
        if delivery:
            best_id, scores = max(delivery.items(), key=lambda kv: (sum(kv[1]) / len(kv[1]), len(kv[1])))
            name = names.get(best_id) or next((c.get("rep_name") for c in month_calls if c.get("rep_id") == best_id), "Rep")
            champions.append({
                "category": "delivery_score",
                "period": month,
                "names": [name],
                "rep_ids": [best_id],
                "detail": f"{round(sum(scores) / len(scores), 1)} avg delivery score · {len(scores)} checked calls",
                "site_ids": [],
            })
            totals[name] += 1
            totals_by_id[best_id] = name

    # Win-back champions
    for row in _winback_trophy_months(state, org_id, site_id):
        if row["top_dollars"]:
            champ = row["top_dollars"]
            champions.append({
                "category": "winback_dollars",
                "period": row["month"],
                "names": [champ["rep_name"]],
                "rep_ids": [champ["rep_id"]],
                "detail": f"${champ['won_value']:,.0f} recovered · {champ['customers_won']} customers won back",
                "site_ids": [],
            })
            totals[champ["rep_name"]] += 1
            totals_by_id[champ["rep_id"]] = champ["rep_name"]
        if row["top_customers"]:
            champ = row["top_customers"]
            champions.append({
                "category": "winback_customers",
                "period": row["month"],
                "names": [champ["rep_name"]],
                "rep_ids": [champ["rep_id"]],
                "detail": f"{champ['customers_won']} customers won back",
                "site_ids": [],
            })
            totals[champ["rep_name"]] += 1
            totals_by_id[champ["rep_id"]] = champ["rep_name"]

    # Callback lists
    lists = [l for l in (state.get("callback_lists", []) or []) if org_id is None or l.get("org_id") == org_id]
    for month in months:
        month_lists = [l for l in lists if month_of(l.get("created_at")) == month and int(l.get("sold") or 0) > 0]
        if not month_lists:
            continue
        best = max(month_lists, key=lambda l: (float(l.get("revenue") or 0), int(l.get("sold") or 0)))
        name = best.get("rep_name") or "Rep"
        champions.append({
            "category": "callback_lists",
            "period": month,
            "names": [name],
            "rep_ids": [best.get("rep_id", "")],
            "detail": f"{int(best.get('sold') or 0)} customers sold · ${float(best.get('revenue') or 0):,.0f}",
            "site_ids": [],
        })
        totals[name] += 1

    champions.sort(key=lambda c: (c["period"], c["category"]), reverse=True)
    return {
        "champions": champions,
        "totals": [{"name": name, "trophies": count} for name, count in totals.most_common()],
    }


def build_keyword_rep_usage(state: dict[str, Any], org_id: Optional[str], *, site_id: Optional[str] = None) -> list[dict[str, Any]]:
    keywords = [k for k in (state.get("keywords", []) or []) if org_id is None or k.get("org_id") in (None, "", org_id)]
    if not keywords:
        keywords = DEFAULT_KEYWORDS
    reps = org_users(state, org_id)
    if site_id:
        reps = [r for r in reps if r.get("site_id") == site_id]
    calls = org_calls(state, org_id, site_id=site_id)
    rows = []
    for rep in reps:
        rep_calls = [c for c in calls if c.get("rep_id") == rep["id"]]
        tiles = []
        for keyword in keywords:
            words = [w.strip() for w in str(keyword.get("keyword", "")).split("/") if w.strip()]
            if not words:
                continue
            rx = re.compile(r"\b(?:" + "|".join(re.escape(w) for w in words) + r")\b", re.I)
            hits = 0
            for call in rep_calls:
                blob = " ".join([
                    str(call.get("summary") or ""),
                    " ".join(_call_topics(call, _call_full(state, call))),
                    str(call.get("part_requested") or ""),
                    str(call.get("vehicle") or ""),
                ])
                if rx.search(blob):
                    hits += 1
            tiles.append({
                "keyword_id": keyword.get("id", ""),
                "keyword": keyword.get("keyword", ""),
                "calls": hits,
                "pct": round(hits / len(rep_calls) * 100, 1) if rep_calls else 0.0,
            })
        rows.append({
            "rep_id": rep["id"],
            "rep_name": rep.get("name", "Rep"),
            "total_calls": len(rep_calls),
            "tiles": tiles,
        })
    rows.sort(key=lambda r: r["total_calls"], reverse=True)
    return rows


def build_keyword_alerts(state: dict[str, Any], org_id: Optional[str], *, site_id: Optional[str] = None) -> list[dict[str, Any]]:
    keywords = [k for k in (state.get("keywords", []) or []) if org_id is None or k.get("org_id") in (None, "", org_id)]
    if not keywords:
        keywords = DEFAULT_KEYWORDS
    calls = org_calls(state, org_id, site_id=site_id)
    months = sorted({month_of(c.get("created_at")) for c in calls if month_of(c.get("created_at"))})
    if not months:
        return []
    this_month = current_month_str() if current_month_str() in months else months[-1]
    prior = [m for m in months if m < this_month][-3:]
    alerts = []
    for keyword in keywords:
        words = [w.strip() for w in str(keyword.get("keyword", "")).split("/") if w.strip()]
        if not words:
            continue
        rx = re.compile(r"\b(?:" + "|".join(re.escape(w) for w in words) + r")\b", re.I)
        counts = Counter()
        for call in calls:
            month = month_of(call.get("created_at"))
            blob = " ".join([
                str(call.get("summary") or ""),
                " ".join(_call_topics(call, _call_full(state, call))),
                str(call.get("part_requested") or ""),
            ])
            if rx.search(blob):
                counts[month] += 1
        this_count = counts[this_month]
        if this_count < 2:
            continue
        baseline = sum(counts[m] for m in prior) / len(prior) if prior else 0.0
        ratio = round(this_count / max(1.0, baseline), 2) if baseline else float(this_count)
        if ratio < 1.5:
            continue
        alerts.append({
            "phrase": keyword.get("keyword", ""),
            "keyword_id": keyword.get("id", ""),
            "this_month": this_count,
            "projected": this_count,
            "baseline": round(baseline, 1),
            "ratio": ratio,
        })
    alerts.sort(key=lambda a: a["ratio"], reverse=True)
    return alerts


def build_keyword_calls(state: dict[str, Any], org_id: Optional[str], keyword: dict[str, Any], *, month: Optional[str] = None, site_id: Optional[str] = None) -> list[dict[str, Any]]:
    words = [w.strip() for w in str(keyword.get("keyword", "")).split("/") if w.strip()]
    if not words:
        return []
    rx = re.compile(r"\b(?:" + "|".join(re.escape(w) for w in words) + r")\b", re.I)
    calls = org_calls(state, org_id, site_id=site_id)
    if month:
        calls = [c for c in calls if month_of(c.get("created_at")) == month]
    matched = []
    for call in calls:
        blob = " ".join([
            str(call.get("summary") or ""),
            " ".join(_call_topics(call, _call_full(state, call))),
            str(call.get("part_requested") or ""),
            str(call.get("vehicle") or ""),
        ])
        if rx.search(blob):
            matched.append(call)
    matched.sort(key=lambda c: c.get("created_at", ""), reverse=True)
    return matched[:50]


# ---------------------------------------------------------------------------
# Tagging and delivery
# ---------------------------------------------------------------------------

def build_tagging_queue(state: dict[str, Any], org_id: Optional[str], *, site_id: Optional[str] = None) -> dict[str, Any]:
    calls = org_calls(state, org_id, site_id=site_id)
    # Resolve every vehicle once; the old per-call rescan made a large yard
    # quadratic and timed out the tagging page.
    vehicles = [vehicle_for_call(state, call) for call in calls]
    by_phone: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {}
    for call, vehicle in zip(calls, vehicles):
        if not (vehicle["make"] and vehicle["model"]):
            continue
        phone = normalize_phone(call.get("customer_phone"))
        if phone and phone not in by_phone:
            by_phone[phone] = (call, vehicle)

    queue = []
    for call, vehicle in zip(calls, vehicles):
        if call.get("tag_skipped") or call.get("delivery_call"):
            continue
        if vehicle["make"] and vehicle["model"]:
            continue
        suggestion = None
        if vehicle["make"]:
            suggestion = {
                "vehicle_year": vehicle["year"],
                "vehicle_make": vehicle["make"],
                "vehicle_model": vehicle["model"],
                "from_call_at": call.get("created_at", ""),
            }
        else:
            # Look for another call from the same customer that already has a vehicle.
            phone = normalize_phone(call.get("customer_phone"))
            match = by_phone.get(phone) if phone else None
            if match:
                other, other_vehicle = match
                suggestion = {
                    "vehicle_year": other_vehicle["year"],
                    "vehicle_make": other_vehicle["make"],
                    "vehicle_model": other_vehicle["model"],
                    "from_call_at": other.get("created_at", ""),
                }
        topics = _call_topics(call, _call_full(state, call))
        hint = ""
        if any(word in " ".join(topics).lower() for word in ("delivery", "shipping", "freight", "address")):
            hint = "Delivery call — confirm the address and date"
        queue.append({
            "id": call.get("id", ""),
            "customer_name": call.get("customer_name", ""),
            "customer_phone": call.get("customer_phone", ""),
            "rep_name": call.get("rep_name", ""),
            "created_at": call.get("created_at", ""),
            "direction": call.get("direction", ""),
            "duration_sec": call.get("duration_sec", 0),
            "topics": topics,
            "summary": call.get("summary", ""),
            "part_requested": call.get("part_requested", ""),
            "suggestion": suggestion,
            "delivery_hint": hint,
        })
    queue.sort(key=lambda c: c.get("created_at", ""), reverse=True)
    return {"total": len(queue), "items": queue[:200]}


def _week_start(value: Optional[str] = None) -> str:
    dt = parse_iso(value) or now_utc()
    dt = dt.astimezone(timezone.utc)
    start = dt - timedelta(days=dt.weekday())
    return start.strftime("%Y-%m-%dT00:00:00+00:00")


def build_tagging_leaderboard(state: dict[str, Any], org_id: Optional[str], *, site_id: Optional[str] = None, week_start: Optional[str] = None) -> dict[str, Any]:
    start = _week_start(week_start)
    end_dt = (parse_iso(start) or now_utc()) + timedelta(days=7)
    end = end_dt.strftime("%Y-%m-%dT00:00:00+00:00")
    calls = org_calls(state, org_id, site_id=site_id)
    grouped: dict[str, dict[str, Any]] = {}
    for call in calls:
        tagged_at = call.get("tagged_at") or ""
        if not (start <= tagged_at < end):
            continue
        user_id = call.get("tagged_by_id") or ""
        if not user_id:
            continue
        user = state.get("users_by_id", {}).get(user_id, {})
        row = grouped.setdefault(user_id, {
            "user_id": user_id,
            "name": user.get("name") or call.get("rep_name") or "Rep",
            "tagged": 0,
            "skipped": 0,
        })
        if call.get("tag_skipped"):
            row["skipped"] += 1
        else:
            row["tagged"] += 1
    leaders = list(grouped.values())
    leaders.sort(key=lambda r: (r["tagged"], -r["skipped"]), reverse=True)
    return {"week_start": start, "leaders": leaders, "total_tagged": sum(r["tagged"] for r in leaders)}


def build_tagging_champion(state: dict[str, Any], org_id: Optional[str], *, site_id: Optional[str] = None) -> dict[str, Any]:
    current_start = parse_iso(_week_start()) or now_utc()
    previous_start = (current_start - timedelta(days=7)).strftime("%Y-%m-%dT00:00:00+00:00")
    board = build_tagging_leaderboard(state, org_id, site_id=site_id, week_start=previous_start)
    leaders = [r for r in board["leaders"] if r["tagged"] > 0]
    if not leaders:
        return {"week_start": previous_start, "week_end": _week_start(), "winners": []}
    top = max(r["tagged"] for r in leaders)
    return {
        "week_start": previous_start,
        "week_end": _week_start(),
        "winners": [r for r in leaders if r["tagged"] == top],
    }


def build_tagging_parts(
    state: dict[str, Any],
    org_id: Optional[str],
    *,
    site_id: Optional[str] = None,
    make: str = "",
    model: str = "",
) -> dict[str, Any]:
    calls = org_calls(state, org_id, site_id=site_id)
    month = current_month_str()
    month_calls = [c for c in calls if month_of(c.get("created_at")) == month]
    if not month_calls:
        months = sorted({month_of(c.get("created_at")) for c in calls if month_of(c.get("created_at"))})
        month = months[-1] if months else month
        month_calls = [c for c in calls if month_of(c.get("created_at")) == month]

    model_calls = month_calls
    wanted = f"{make} {model}".strip().lower()
    if wanted:
        model_calls = []
        for call in month_calls:
            vehicle = vehicle_for_call(state, call)
            if f"{vehicle['make']} {vehicle['model']}".strip().lower() == wanted:
                model_calls.append(call)

    counts = Counter()
    model_counts = Counter()
    for call in month_calls:
        part = _part_from_topics(call, _call_full(state, call))
        if part:
            counts[part] += 1
    for call in model_calls:
        part = _part_from_topics(call, _call_full(state, call))
        if part:
            model_counts[part] += 1

    parts = [
        {"part": part, "calls": count, "model_calls": model_counts.get(part, 0)}
        for part, count in counts.most_common(20)
    ]
    return {"basis": "month", "month": month, "model": f"{make} {model}".strip(), "parts": parts}


def build_delivery_stats(state: dict[str, Any], org_id: Optional[str], *, rep_id: Optional[str] = None, site_id: Optional[str] = None) -> dict[str, Any]:
    calls = org_calls(state, org_id, rep_id=rep_id, site_id=site_id)
    delivery_calls = [c for c in calls if c.get("delivery_call") or c.get("delivery_check") or c.get("delivery_score") is not None]
    checked_calls = [c for c in delivery_calls if isinstance(c.get("delivery_check"), dict)]
    scores = [float(c.get("delivery_score")) for c in delivery_calls if c.get("delivery_score") is not None]
    steps = [
        {"key": "date_given", "label": "Delivery date given", "done": 0, "pct": 0},
        {"key": "address_confirmed", "label": "Address confirmed", "done": 0, "pct": 0},
        {"key": "thanked", "label": "Thanked the customer", "done": 0, "pct": 0},
    ]
    for call in checked_calls:
        check = call.get("delivery_check") or {}
        for step in steps:
            if check.get(step["key"]):
                step["done"] += 1
    for step in steps:
        step["pct"] = round(step["done"] / len(checked_calls) * 100) if checked_calls else 0
    weakest = ""
    if checked_calls:
        weakest = min(steps, key=lambda s: (s["pct"], s["key"]))["key"]
    return {
        "calls": len(delivery_calls),
        "checked": len(checked_calls),
        "avg_score": round(sum(scores) / len(scores)) if scores else None,
        "steps": steps,
        "weakest": weakest,
    }


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------

def build_report_summary(
    state: dict[str, Any],
    org_id: Optional[str],
    *,
    date_from: str,
    date_to: str,
    rep_id: Optional[str] = None,
    site_id: Optional[str] = None,
) -> dict[str, Any]:
    calls = org_calls(state, org_id, rep_id=rep_id, site_id=site_id)
    from_iso = f"{date_from}T00:00:00Z" if len(date_from) == 10 else date_from
    to_iso = f"{date_to}T23:59:59Z" if len(date_to) == 10 else date_to
    calls = [c for c in calls if from_iso <= (c.get("created_at") or "") <= to_iso]

    empty = {
        "date_from": date_from,
        "date_to": date_to,
        "totals": {
            "calls": 0, "inbound": 0, "outbound": 0, "voicemails": 0,
            "avg_score": 0.0, "avg_duration_sec": 0.0, "sales_calls": 0,
            "won": 0, "close_rate": 0.0, "revenue": 0.0,
        },
        "by_rep": [],
        "by_category": [],
        "top_parts": [],
        "top_vehicles": [],
        "daily": [],
        "arrivals": [],
        "avg_order_value": 0.0,
        "parts_sold": [],
        "price_missing": 0,
    }
    if not calls:
        return empty

    # Delivery calls are logged so the yard can see them, but they never count
    # as a sale or as vehicle demand.
    metric_calls = [c for c in calls if not c.get("delivery_call")]
    scored = [c for c in calls if c.get("overall_score")]
    avg_score = round(sum(c.get("overall_score", 0) for c in scored) / len(scored), 1) if scored else 0.0
    durations = [c.get("duration_sec", 0) for c in calls if c.get("duration_sec")]
    avg_dur = round(sum(durations) / len(durations), 1) if durations else 0.0
    inbound = sum(1 for c in calls if c.get("direction", "inbound") == "inbound")
    outbound = sum(1 for c in calls if c.get("direction") == "outbound")
    sales_calls = [c for c in metric_calls if _is_sales_call(c)]
    won = [c for c in metric_calls if _is_won(c)]
    revenue = sum(float(c.get("order_value") or 0.0) for c in won)
    close_rate = round(len(won) / max(len(sales_calls), 1) * 100, 1) if sales_calls else 0.0

    rep_map: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for call in calls:
        rep_map[call.get("rep_id") or "unassigned"].append(call)

    users = state.get("users_by_id", {})
    by_rep = []
    for rid, rcalls in rep_map.items():
        user = users.get(rid, {})
        rname = user.get("name") or (rcalls[0].get("rep_name") if rcalls else "Rep")
        r_scored = [c for c in rcalls if c.get("overall_score")]
        r_metric_calls = [c for c in rcalls if not c.get("delivery_call")]
        r_sales = [c for c in r_metric_calls if _is_sales_call(c)]
        r_won = [c for c in r_metric_calls if _is_won(c)]
        by_rep.append({
            "rep_id": rid,
            "name": rname,
            "calls": len(rcalls),
            "avg_score": round(sum(c.get("overall_score", 0) for c in r_scored) / len(r_scored), 1) if r_scored else 0.0,
            "sales_calls": len(r_sales),
            "won": len(r_won),
            "close_rate": round(len(r_won) / max(len(r_sales), 1) * 100, 1) if r_sales else 0.0,
            "revenue": round(sum(float(c.get("order_value") or 0.0) for c in r_won), 2),
        })
    by_rep.sort(key=lambda x: x["calls"], reverse=True)

    cat_map: dict[str, dict[str, int]] = defaultdict(lambda: {"calls": 0, "won": 0})
    for call in calls:
        entry = cat_map[call.get("category") or "Sales Inquiry"]
        entry["calls"] += 1
        if _is_won(call):
            entry["won"] += 1
    by_category = [
        {"label": label, "calls": values["calls"], "won": values["won"], "key": ""}
        for label, values in sorted(cat_map.items(), key=lambda kv: -kv[1]["calls"])
    ]

    part_map: dict[str, dict[str, int]] = defaultdict(lambda: {"calls": 0, "won": 0})
    for call in metric_calls:
        part = _part_from_topics(call, _call_full(state, call))
        if part:
            part_map[part]["calls"] += 1
            if _is_won(call):
                part_map[part]["won"] += 1
    top_parts = [
        {"label": part, "calls": values["calls"], "won": values["won"], "key": part.lower()}
        for part, values in sorted(part_map.items(), key=lambda kv: -kv[1]["calls"])[:10]
    ]

    vehicle_map: dict[str, dict[str, int]] = defaultdict(lambda: {"calls": 0, "won": 0})
    vehicle_keys: dict[str, str] = {}
    for call in metric_calls:
        vehicle = vehicle_for_call(state, call)
        if not vehicle["make"] or not vehicle["model"]:
            continue
        label = f"{vehicle['make']} {vehicle['model']}"
        vehicle_map[label]["calls"] += 1
        if _is_won(call):
            vehicle_map[label]["won"] += 1
        vehicle_keys[label] = f"{vehicle['make']}|{vehicle['model']}"
    top_vehicles = [
        {"label": label, "calls": values["calls"], "won": values["won"], "key": vehicle_keys[label]}
        for label, values in sorted(vehicle_map.items(), key=lambda kv: -kv[1]["calls"])[:10]
    ]

    daily_map: dict[str, dict[str, int]] = defaultdict(lambda: {"calls": 0, "won": 0})
    for call in calls:
        day = (call.get("created_at") or today_str())[:10]
        daily_map[day]["calls"] += 1
        if _is_won(call):
            daily_map[day]["won"] += 1
    daily = [{"date": day, "calls": values["calls"], "won": values["won"]} for day, values in sorted(daily_map.items())]

    # Parts sold, split evenly across the parts named on each won sale.
    parts_months: dict[str, dict[str, dict[str, float]]] = defaultdict(lambda: defaultdict(lambda: {"sales": 0, "revenue": 0.0}))
    price_missing = 0
    for call in won:
        value = float(call.get("order_value") or 0.0)
        if value <= 0:
            price_missing += 1
        parts = [canonical_part(p) for p in (call.get("parts_sold") or [])]
        parts = [p for p in parts if p]
        if not parts:
            part = _part_from_topics(call, _call_full(state, call))
            parts = [part] if part else []
        if not parts:
            continue
        month = month_of(call.get("created_at"))
        share = value / len(parts)
        for part in parts:
            parts_months[month][part]["sales"] += 1
            parts_months[month][part]["revenue"] += share
    parts_sold = [
        {
            "month": month,
            "parts": [
                {"part": part, "sales": int(values["sales"]), "revenue": round(values["revenue"], 2)}
                for part, values in sorted(parts_by_part.items(), key=lambda kv: -kv[1]["sales"])
            ],
        }
        for month, parts_by_part in sorted(parts_months.items())
    ]

    # Arrival profitability for this yard.
    arrivals_rows = []
    for arrival in state.get("arrivals", []) or []:
        if org_id is not None and arrival.get("org_id") != org_id:
            continue
        logged = arrival.get("created_at") or ""
        if not (from_iso <= logged <= to_iso):
            continue
        callers = arrival.get("callers", []) or []
        sold = [c for c in callers if c.get("status") == "sold"]
        revenue = sum(float(c.get("sold_price") or 0.0) for c in sold)
        cost = arrival.get("cost")
        arrivals_rows.append({
            "id": arrival.get("id", ""),
            "vehicle": " ".join(str(x) for x in (arrival.get("vehicle_year"), arrival.get("vehicle_make"), arrival.get("vehicle_model")) if x),
            "logged": logged,
            "cost": cost,
            "revenue": round(revenue, 2),
            "profit": round(revenue - float(cost or 0.0), 2),
            "sold": len(sold),
            "orders": len(sold),
        })

    avg_order = round(revenue / len(won), 1) if won else 350.0
    business = (state.get("settings_business_by_org") or {}).get(org_id or "")
    if not business:
        business = state.get("settings_business") or {}
    configured = business.get("avg_order_value") if isinstance(business, dict) else None
    if isinstance(configured, (int, float)) and configured > 0:
        avg_order = float(configured)

    return {
        "date_from": date_from,
        "date_to": date_to,
        "totals": {
            "calls": len(calls),
            "inbound": inbound,
            "outbound": outbound,
            "voicemails": sum(
                1
                for c in calls
                if c.get("direction") == "inbound" and int(c.get("duration_sec") or 0) < 30
            ),
            "avg_score": avg_score,
            "avg_duration_sec": avg_dur,
            "sales_calls": len(sales_calls),
            "won": len(won),
            "close_rate": close_rate,
            "revenue": round(revenue, 2),
        },
        "by_rep": by_rep,
        "by_category": by_category,
        "top_parts": top_parts,
        "top_vehicles": top_vehicles,
        "daily": daily,
        "arrivals": arrivals_rows,
        "avg_order_value": avg_order,
        "parts_sold": parts_sold,
        "price_missing": price_missing,
    }
