"""Import RingCentral call-log exports into a yard's state.

The upload screen promises a real import: match reps by host email, create
logins for new hosts, dedupe by Interaction ID, classify each call, and report
what actually happened.  This module keeps that logic out of the route.
"""
from __future__ import annotations

import csv
import io
import re
import secrets
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from openpyxl import load_workbook

import store
from analyzer import extract_vehicle_and_part
from call_categories import classify_call_details, delivery_kind


_HEADER_ALIASES: dict[str, tuple[str, ...]] = {
    "interaction_id": ("interaction_id", "call_id", "session_id", "id"),
    "interaction_name": ("interaction_name", "call_name", "subject", "interaction"),
    "host_email": ("host_email", "user_email", "agent_email", "extension_email", "email"),
    "host_name": ("host_name", "user_name", "agent_name", "rep_name", "host"),
    "direction": ("inbound_outbound", "direction", "call_direction", "in_out"),
    "duration": ("duration", "duration_s", "call_duration", "duration_seconds"),
    "created_at": ("date_and_time", "start_time", "call_start_time", "date", "datetime", "time"),
    "category": ("interaction_category", "category", "call_category"),
    "topics": ("topics", "topic"),
    "trackers": ("trackers", "tracker"),
    "external": ("external_participants", "participants", "caller", "external"),
    "url": ("interaction_url", "url", "call_url", "recording_url"),
    "score": ("score", "call_score"),
}

_HEADER_HINTS = {
    "interaction_id",
    "host_name",
    "host_email",
    "date_and_time",
    "inbound_outbound",
    "interaction_category",
}

_QUEUE_PREFIX = re.compile(r"^(Wholesale\s*-\s*)?\d+\s*-\s*", re.I)
_PHONE_RE = re.compile(r"(\+?\d[\d\s().-]{6,})")
_EXT_RE = re.compile(r"Name:\s*([^;]+);.*?Phone:\s*([0-9+()\-\s]+)", re.I | re.S)


def _norm_header(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(value or "").strip().lower()).strip("_")


def _get(row: dict[str, Any], field: str) -> str:
    for alias in _HEADER_ALIASES.get(field, ()):
        value = row.get(alias)
        if value is not None and str(value).strip():
            return str(value).strip()
    return ""


def _matrix_rows(content: bytes, filename: str) -> list[list[Any]]:
    ext = filename.lower().rsplit(".", 1)[-1]
    if ext == "csv":
        if content.startswith((b"\xff\xfe", b"\xfe\xff")):
            text = content.decode("utf-16", errors="replace")
        else:
            text = content.decode("utf-8-sig", errors="replace")
        return [list(row) for row in csv.reader(io.StringIO(text))]
    if ext in ("xlsx", "xlsm"):
        wb = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
        ws = wb.active
        return [list(row) for row in ws.iter_rows(values_only=True)]
    raise ValueError("Upload a RingCentral CSV or XLSX file. Legacy .xls files should be saved as .xlsx or .csv first.")


def parse_rows(content: bytes, filename: str) -> list[dict[str, Any]]:
    matrix = _matrix_rows(content, filename)
    if not matrix:
        return []
    header_idx = 0
    for idx, row in enumerate(matrix[:25]):
        keys = {_norm_header(cell) for cell in row if cell not in (None, "")}
        if keys & _HEADER_HINTS:
            header_idx = idx
            break
    headers = [_norm_header(cell) for cell in matrix[header_idx]]
    if not (set(headers) & _HEADER_HINTS):
        raise ValueError(
            "This doesn't look like a RingCentral calls export. Expected columns like "
            "Interaction ID, Host Name, Host Email, Date and Time, and Inbound/Outbound."
        )
    rows: list[dict[str, Any]] = []
    for values in matrix[header_idx + 1:]:
        if not values or not any(value not in (None, "") for value in values):
            continue
        rows.append({headers[i]: values[i] for i in range(min(len(headers), len(values))) if headers[i]})
    return rows


def _parse_datetime(value: str) -> str:
    raw = (value or "").strip()
    if not raw:
        return store.now_iso()
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).isoformat()
    except ValueError:
        pass
    for fmt in (
        "%m/%d/%Y %I:%M %p",
        "%m/%d/%Y %H:%M",
        "%m/%d/%Y %H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%Y/%m/%d %H:%M",
        "%Y-%m-%d",
    ):
        try:
            return datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc).isoformat()
        except ValueError:
            continue
    return store.now_iso()


def _clean_customer(raw: str) -> tuple[str, str]:
    text = (raw or "").strip()
    match = _EXT_RE.search(text)
    if match:
        name = match.group(1).strip()
        phone = match.group(2).strip()
    else:
        phone_match = _PHONE_RE.search(text)
        phone = phone_match.group(1).strip() if phone_match else ""
        name = text if not phone or text != phone else ""
    name = _QUEUE_PREFIX.sub("", name).strip()
    if not name or name.lower().startswith("wireless caller"):
        name = phone or "Customer"
    return name[:160], phone[:40]


def _find_rep(state: dict[str, Any], org_id: str, email: str, name: str) -> Optional[dict[str, Any]]:
    users = state.get("users_by_id", {})
    if email:
        for user in users.values():
            if user.get("org_id") == org_id and str(user.get("email") or "").lower() == email.lower():
                return user
    if name:
        for user in users.values():
            if user.get("org_id") == org_id and str(user.get("name") or "").lower() == name.lower():
                return user
    return None


def _create_rep(
    state: dict[str, Any],
    org_id: str,
    email: str,
    name: str,
    rep_logins: list[dict[str, str]],
) -> Optional[dict[str, Any]]:
    email = (email or "").strip().lower()
    if not email or "@" not in email:
        return None
    users = state.setdefault("users_by_id", {})
    if any(str(u.get("email") or "").lower() == email for u in users.values()):
        return None
    temp_password = secrets.token_urlsafe(12)
    uid = f"user-{uuid.uuid4().hex[:10]}"
    display = (name or email.split("@", 1)[0]).strip()[:120] or "Sales Representative"
    user = {
        "id": uid,
        "email": email,
        "name": display,
        "role": "rep",
        "title": "Sales Representative",
        "avatar_url": "",
        "org_id": org_id,
        "disabled": False,
        "site_id": "",
        "must_change_password": True,
        "password_hash": store.hash_password(temp_password),
        "created_at": store.now_iso(),
    }
    users[uid] = user
    yard = next((o for o in state.get("admin_orgs", []) if o.get("id") == org_id), None)
    if yard and isinstance(yard.get("users"), int):
        yard["users"] += 1
    rep_logins.append({"name": display, "email": email, "temp_password": temp_password})
    return user


def _outcome_for(category_raw: str) -> str:
    low = category_raw.lower()
    if "order" in low:
        return "won"
    if "support" in low:
        return "n/a"
    if "supplier" in low or "vendor" in low:
        return "n/a"
    if "voicemail" in low:
        return "lost"
    return "pending"


def _duration_seconds(value: str) -> int:
    raw = (value or "").strip()
    if not raw:
        return 0
    if ":" in raw:
        try:
            parts = [float(part) for part in raw.split(":")]
            if len(parts) == 3:
                return int(round(parts[0] * 3600 + parts[1] * 60 + parts[2]))
            if len(parts) == 2:
                return int(round(parts[0] * 60 + parts[1]))
        except ValueError:
            return 0
    try:
        return int(round(float(raw)))
    except ValueError:
        return 0


def _score(value: str) -> int:
    try:
        number = float(value or 0)
    except (TypeError, ValueError):
        return 70
    if 0 < number <= 10:
        number *= 10
    return max(0, min(100, int(round(number))))


def _call_from_row(
    row: dict[str, Any],
    *,
    org_id: str,
    actor: dict[str, Any],
    state: dict[str, Any],
    rep_logins: list[dict[str, str]],
) -> Optional[dict[str, Any]]:
    interaction_id = _get(row, "interaction_id")
    interaction_name = _get(row, "interaction_name")
    host_email = _get(row, "host_email")
    host_name = _get(row, "host_name")
    if not interaction_id and not interaction_name and not _get(row, "external"):
        return None
    rep = _find_rep(state, org_id, host_email, host_name)
    if not rep:
        rep = _create_rep(state, org_id, host_email, host_name, rep_logins)
    if not rep:
        rep = actor
    cid = f"rc-{interaction_id}" if interaction_id else f"rc-{uuid.uuid4()}"
    customer_name, customer_phone = _clean_customer(_get(row, "external"))
    direction_raw = _get(row, "direction").lower()
    direction = "outbound" if direction_raw.startswith("out") else "inbound"
    duration = _duration_seconds(_get(row, "duration"))
    created_at = _parse_datetime(_get(row, "created_at"))
    category_raw = _get(row, "category")
    topics = [part.strip() for part in _get(row, "topics").split(";") if part.strip()]
    trackers = [part.strip() for part in _get(row, "trackers").split(";") if part.strip()]
    summary = f"{interaction_name}. Topics discussed: {', '.join(topics)}." if topics else interaction_name or f"RingCentral call with {customer_name}"
    category, confidence, caller_intent = classify_call_details(
        direction=direction,
        category=category_raw,
        topics=topics,
        trackers=trackers,
        summary=summary,
        interaction_name=interaction_name,
    )
    outcome = _outcome_for(category_raw)
    overall_score = _score(_get(row, "score"))
    warranty_pitched = 1 if any("warranty" in item.lower() for item in [*trackers, *topics]) else 0
    transcript = (
        f"Rep ({rep.get('name', 'Sales Rep')}): RingCentral call with {customer_name}. "
        f"[Transcript available on RingCentral player: {_get(row, 'url')}]"
    )
    vehicle = extract_vehicle_and_part(f"{interaction_name} {' '.join(topics)}", topics)
    vehicle_text = " ".join(
        str(value)
        for value in (vehicle.get("vehicle_year"), vehicle.get("vehicle_make"), vehicle.get("vehicle_model"))
        if value
    ).strip()
    part = vehicle.get("part_requested") or (topics[0] if topics else "")
    metrics = {
        "greeting": 80,
        "needs_discovery": overall_score,
        "product_knowledge": overall_score,
        "upsell_crosssell": 80 if warranty_pitched else 40,
        "objection_handling": 75,
        "closing": 85 if outcome == "won" else 65,
        "courtesy": 90,
    }
    call = {
        "id": cid,
        "org_id": org_id,
        "rep_id": rep.get("id", ""),
        "rep_name": rep.get("name", ""),
        "customer_name": customer_name,
        "customer_phone": customer_phone,
        "direction": direction,
        "duration_sec": duration,
        "status": "analyzed",
        "source": "ringcentral",
        "source_category": category_raw,
        "category": category,
        "category_source": "import",
        "category_confidence": confidence,
        "caller_intent": caller_intent,
        "outcome": outcome,
        "sentiment": "neutral",
        "overall_score": overall_score,
        "order_value": 0.0,
        "quoted_value": 0.0,
        "warranty_pitched": warranty_pitched,
        "summary": summary,
        "vehicle": vehicle_text,
        "vehicle_year": vehicle.get("vehicle_year"),
        "vehicle_make": vehicle.get("vehicle_make") or "",
        "vehicle_model": vehicle.get("vehicle_model") or "",
        "part_requested": part,
        "parts_sold": [],
        "topics": topics,
        "trackers": trackers,
        "external_id": interaction_id,
        "external_url": _get(row, "url"),
        "delivery_call": category == "Delivery",
        "delivery_kind": delivery_kind(summary=summary) if category == "Delivery" else None,
        "delivery_check": None,
        "lost_reason": "",
        "callback_done": False,
        "created_at": created_at,
    }
    full = {
        **call,
        "transcript": transcript,
        "turns": [
            {"speaker": "Rep", "text": f"RingCentral call with {customer_name}."},
            {"speaker": "Customer", "text": f"Calling regarding {part or 'vehicle parts'}."},
        ],
        "metrics": metrics,
        "coaching_feedback": "",
        "strengths": [],
        "improvements": [],
        "insights": [],
        "keyword_hits": [],
    }
    return {"summary": call, "full": full}


def import_ringcentral(
    *,
    content: bytes,
    filename: str,
    org_id: str,
    actor: dict[str, Any],
    replace_demo: bool = False,
) -> dict[str, Any]:
    rows = parse_rows(content, filename)
    if not rows:
        raise ValueError("No call rows were found in this file.")
    state = store.get_state()
    rep_logins: list[dict[str, str]] = []
    reps_created: list[str] = []
    org_calls = [c for c in state.get("calls", []) if c.get("org_id") == org_id]
    calls_by_id = {c.get("id"): c for c in org_calls}
    by_external = {str(c.get("external_id")): c for c in org_calls if c.get("external_id")}
    global_ids = {c.get("id") for c in state.get("calls", [])}
    full_calls = state.setdefault("full_calls", {})
    imported = 0
    updated = 0
    skipped = 0
    imported_ids: list[str] = []
    file_dates: list[str] = []

    for row in rows:
        parsed = _call_from_row(
            row,
            org_id=org_id,
            actor=actor,
            state=state,
            rep_logins=rep_logins,
        )
        if not parsed:
            skipped += 1
            continue
        summary = parsed["summary"]
        full = parsed["full"]
        interaction_id = str(summary.get("external_id") or "")
        existing = by_external.get(interaction_id) if interaction_id else None
        file_dates.append(str(summary.get("created_at") or "")[:10])
        if existing:
            cid = str(existing.get("id") or summary["id"])
            summary["id"] = cid
            full["id"] = cid
            existing.update(summary)
            full_calls[cid] = full
            updated += 1
        else:
            cid = str(summary["id"])
            if cid in global_ids:
                cid = f"{cid}-{org_id[-8:]}"
                summary["id"] = cid
                full["id"] = cid
            state.setdefault("calls", []).append(summary)
            calls_by_id[cid] = summary
            global_ids.add(cid)
            if interaction_id:
                by_external[interaction_id] = summary
            imported += 1
        imported_ids.append(cid)

    for login in rep_logins:
        reps_created.append(login["name"])

    demo_removed = False
    if replace_demo:
        removed_ids = set()
        kept = []
        for call in state.get("calls", []):
            call_id = str(call.get("id") or "")
            is_demo = (
                call.get("org_id") == org_id
                and (
                    call_id.startswith(("demo-", "hist-"))
                    or call.get("source") == "demo"
                    or call.get("is_demo")
                )
            )
            if is_demo:
                removed_ids.add(call_id)
            else:
                kept.append(call)
        if removed_ids:
            state["calls"] = kept
            for call_id in removed_ids:
                full_calls.pop(call_id, None)
            demo_removed = True
        yard = next((o for o in state.get("admin_orgs", []) if o.get("id") == org_id), None)
        if yard:
            yard["sample_data"] = False

    state["calls"].sort(key=lambda c: c.get("created_at") or "", reverse=True)
    store.save_state()

    imported_rows = [calls_by_id[cid] for cid in imported_ids if cid in calls_by_id]
    makes: dict[str, int] = {}
    for call in imported_rows:
        make = str(call.get("vehicle_make") or "").strip()
        if make:
            makes[make] = makes.get(make, 0) + 1
    matched = sum(1 for call in imported_rows if call.get("vehicle_make") and call.get("vehicle_model"))
    with_part = sum(1 for call in imported_rows if call.get("part_requested"))
    file_dates = [date for date in file_dates if date]
    return {
        "file_from": min(file_dates) if file_dates else None,
        "file_to": max(file_dates) if file_dates else None,
        "total_rows": len(rows),
        "imported": imported,
        "updated": updated,
        "skipped": skipped,
        "reps_created": reps_created,
        "rep_logins": rep_logins,
        "demo_data_removed": demo_removed,
        "vehicles": {
            "matched": matched,
            "newly_matched": matched,
            "with_part": with_part,
            "top_makes": [{"make": k, "calls": v} for k, v in sorted(makes.items(), key=lambda kv: -kv[1])[:5]],
            "untagged": len(imported_rows) - matched,
        },
    }
