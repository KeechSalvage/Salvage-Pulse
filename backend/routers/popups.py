"""Incoming-call screen-pop feed.

Phone integrations write normalised events into the ingest log.  This router
turns the newest events into a caller card the dashboard can pop up: matched
customer, notes, and previous calls from any of that customer's numbers.

The feed is polled by the browser rather than streamed so it works behind
ordinary proxies and with the platform's existing cookie auth.
"""

from __future__ import annotations

import datetime as dt
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from auth_utils import get_current_user
from database import normalize_phone
import store
import yard_analytics as ya
from security import effective_org, is_manager, require_authenticated

router = APIRouter(tags=["call-popups"], dependencies=[Depends(require_authenticated)])

POPUP_MODES = {"popup", "queue", "off"}
FEED_STATUSES = {"waiting", "queued", "processing", "completed"}
POPUP_EVENT_LIMIT = 25


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _parse_since(value: str) -> dt.datetime:
    if not value:
        return _now() - dt.timedelta(seconds=15)
    try:
        parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.timezone.utc)
        return parsed.astimezone(dt.timezone.utc)
    except ValueError:
        raise HTTPException(status_code=400, detail="since must be an ISO timestamp")


def _event_time(event: dict[str, Any]) -> dt.datetime:
    raw = event.get("created_at") or event.get("updated_at") or ""
    try:
        parsed = dt.datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.timezone.utc)
        return parsed.astimezone(dt.timezone.utc)
    except ValueError:
        return _now()


def _phone_digits(value: Any) -> str:
    return "".join(ch for ch in str(value or "") if ch.isdigit())


def _line_for_number(st: dict[str, Any], org_id: str, number: str) -> dict[str, Any]:
    digits = _phone_digits(number)
    if not digits:
        return {"number": "", "label": "", "name": ""}
    text_prefs = st.get("me_mobile_by_user") or {}
    for user in (st.get("users_by_id") or {}).values():
        if user.get("org_id") != org_id or user.get("disabled"):
            continue
        values = [
            user.get("phone"), user.get("mobile"), user.get("cell"), user.get("direct_number"),
            user.get("extension"), user.get("rc_extension_id"), user.get("extension_number"),
        ]
        values.extend(user.get("alt_phones") or [])
        values.append((text_prefs.get(user.get("id")) or {}).get("mobile"))
        for value in values:
            candidate = _phone_digits(value)
            if candidate and candidate[-10:] == digits[-10:]:
                return {
                    "number": number,
                    "label": f"{user.get('name') or 'Rep'}'s line",
                    "name": str(user.get("name") or ""),
                }
    return {"number": number, "label": "Main line", "name": ""}


def _notes_for(st: dict[str, Any], org_id: str, keys: list[str]) -> list[dict[str, Any]]:
    notes_store = st.get("customer_notes") or {}
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for key in keys:
        if not key:
            continue
        store_keys = [f"{org_id}:{key}", key]
        for store_key in store_keys:
            for note in notes_store.get(store_key) or []:
                note_id = str(note.get("id") or note.get("created_at") or note.get("text"))
                if note_id in seen:
                    continue
                seen.add(note_id)
                out.append(
                    {
                        "id": note_id,
                        "text": str(note.get("text") or "")[:1000],
                        "author": str(note.get("author") or ""),
                        "created_at": str(note.get("created_at") or ""),
                    }
                )
        if out:
            break
    out.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
    return out[:5]


def _prior_call(call: dict[str, Any], full: dict[str, Any] | None) -> dict[str, Any]:
    return {
        "id": str(call.get("id") or ""),
        "created_at": str(call.get("created_at") or ""),
        "rep_name": str(call.get("rep_name") or ""),
        "direction": str(call.get("direction") or ""),
        "category": str(call.get("category") or ""),
        "outcome": str(call.get("outcome") or ""),
        "overall_score": int(call.get("overall_score") or 0),
        "summary": str(call.get("summary") or "")[:500],
        "duration_sec": float(call.get("duration_sec") or 0),
        "has_audio": bool(call.get("has_audio")),
        "has_transcript": bool((full or {}).get("transcript")),
        "delivery_call": bool(call.get("delivery_call")),
    }


def _popup_for_event(st: dict[str, Any], org_id: str, event: dict[str, Any]) -> dict[str, Any]:
    call_id = str(event.get("call_id") or "")
    call = next(
        (item for item in st.get("calls", []) if item.get("id") == call_id and item.get("org_id") == org_id),
        None,
    )
    direction = str((call or {}).get("direction") or event.get("direction") or "inbound")
    number = str(
        (call or {}).get("customer_phone")
        or event.get("customer_phone")
        or (event.get("from_number") if direction == "inbound" else event.get("to_number"))
        or ""
    )
    other_number = str(
        event.get("to_number") if direction == "inbound" else event.get("from_number")
    )
    name = str((call or {}).get("customer_name") or event.get("customer_name") or "")
    if name.lower() in ("caller", "unknown caller", "audio caller", "direct caller"):
        name = ""
    # NormalizedCall falls back to the phone number as the name. That is not a
    # real caller name, so treat it as an unknown caller until a profile match.
    name_digits = _phone_digits(name)
    number_digits = _phone_digits(number)
    if name and name_digits and number_digits and name_digits[-10:] == number_digits[-10:]:
        name = ""

    phone = normalize_phone(number)
    group_key = f"p:{phone}" if phone else ""
    if not group_key and name:
        group_key = f"n:{name.strip().lower()}"
    if not group_key and call:
        group_key = ya._customer_group_key(call)  # same grouping the call library uses
    related = ya.customer_group_calls(st, org_id, group_key) if group_key else []
    current_id = str((call or {}).get("id") or "")
    prior = [item for item in related if item.get("id") != current_id]
    prior.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)

    display_key = (
        ya.customer_group_display_key(st, org_id, group_key, related, fallback_key=name)
        if group_key
        else name
    )
    profile = (
        ya._customer_profile(st, org_id, display_key)
        or ya._customer_profile(st, org_id, group_key)
        or ya._customer_profile(st, org_id, name)
    )
    manual_tag = (
        ya._manual_tag(st, org_id, display_key)
        or ya._manual_tag(st, org_id, group_key)
        or ya._manual_tag(st, org_id, name)
    )
    notes = _notes_for(st, org_id, [display_key, group_key, name])
    has_customer_record = bool(profile or related)
    known = bool(profile or prior or name)
    if not name:
        name = str(profile.get("name") or "")

    full_calls = st.get("full_calls") or {}
    prior_cards = [
        _prior_call(item, full_calls.get(item.get("id")))
        for item in prior[:8]
    ]
    line_number = str(event.get("to_number") if direction == "inbound" else event.get("from_number") or "")
    line = _line_for_number(st, org_id, line_number)
    rep_name = str((call or {}).get("rep_name") or event.get("rep_name") or "")
    if line.get("label") == "Main line" and rep_name:
        line = {**line, "label": f"{rep_name}'s line", "name": rep_name}
    return {
        "event_id": str(event.get("id") or ""),
        "call_id": current_id,
        "external_id": str(event.get("external_id") or ""),
        "provider": str(event.get("provider") or ""),
        "direction": direction,
        "status": str(event.get("status") or ""),
        "number": number,
        "display_number": number,
        "other_number": other_number,
        "caller_name": name,
        "customer_name": name,
        "rep_id": str((call or {}).get("rep_id") or event.get("rep_id") or ""),
        "rep_name": rep_name,
        "started_at": str((call or {}).get("created_at") or event.get("started_at") or event.get("created_at") or ""),
        "known": known,
        "customer": {
            "key": display_key if has_customer_record else "",
            "name": name,
            "phone": str(profile.get("primary_phone") or number),
            "tag": manual_tag,
            "email": str(profile.get("email") or ""),
            "alt_phones": list(profile.get("alt_phones") or []),
        },
        "notes": notes,
        "prior_calls": prior_cards,
        "line": line,
        "has_audio": bool((call or {}).get("has_audio")),
    }


@router.get("/api/me/call-popups")
def get_call_popup_prefs(request: Request) -> dict[str, Any]:
    u = get_current_user(request)
    st = store.get_state()
    prefs = st.setdefault("call_popup_by_user", {}).setdefault(u["id"], {})
    return {
        "mode": prefs.get("mode") if prefs.get("mode") in POPUP_MODES else "popup",
        "updated_at": prefs.get("updated_at") or "",
    }


@router.put("/api/me/call-popups")
def put_call_popup_prefs(body: dict[str, Any], request: Request) -> dict[str, Any]:
    u = get_current_user(request)
    mode = str(body.get("mode") or "").strip().lower()
    if mode not in POPUP_MODES:
        raise HTTPException(status_code=400, detail="Choose popup, queue or off")
    st = store.get_state()
    prefs = st.setdefault("call_popup_by_user", {}).setdefault(u["id"], {})
    prefs["mode"] = mode
    prefs["updated_at"] = store.now_iso()
    store.save_state()
    return {"mode": mode, "updated_at": prefs["updated_at"]}


@router.get("/api/call-popups/events/{event_id}")
def call_popup_for_event(event_id: str, request: Request) -> dict[str, Any]:
    u = get_current_user(request)
    org_id = effective_org(u)
    if not org_id:
        raise HTTPException(status_code=404, detail="Call event not found")
    st = store.get_state()
    event = next(
        (item for item in st.get("ingest_events", []) if item.get("id") == event_id and item.get("org_id") == org_id),
        None,
    )
    if not event:
        raise HTTPException(status_code=404, detail="Call event not found")
    popup = _popup_for_event(st, org_id, event)
    if not is_manager(u) and popup.get("rep_id") and popup.get("rep_id") != u.get("id"):
        raise HTTPException(status_code=403, detail="This call belongs to another rep")
    return popup


@router.get("/api/call-popups/feed")
def call_popup_feed(
    request: Request,
    since: str = Query(""),
    limit: int = Query(10, ge=1, le=POPUP_EVENT_LIMIT),
) -> dict[str, Any]:
    u = get_current_user(request)
    org_id = effective_org(u)
    if not org_id:
        return {"popups": [], "server_time": store.now_iso()}
    st = store.get_state()
    cutoff = _parse_since(since)
    candidates = [
        event for event in st.get("ingest_events", [])
        if event.get("org_id") == org_id
        and event.get("status") in FEED_STATUSES
        and _event_time(event) >= cutoff
    ]
    # One popup per real call, even when a start event is followed by a
    # completion event. Prefer the event that already has a call record.
    grouped: dict[str, list[dict[str, Any]]] = {}
    for event in candidates:
        identity = str(event.get("external_id") or event.get("call_id") or event.get("id"))
        grouped.setdefault(identity, []).append(event)

    chosen: list[dict[str, Any]] = []
    for events in grouped.values():
        events.sort(
            key=lambda item: (
                1 if item.get("call_id") else 0,
                1 if item.get("status") in ("completed", "processing", "queued") else 0,
                item.get("created_at") or "",
            ),
            reverse=True,
        )
        chosen.append(events[0])
    chosen.sort(key=lambda item: item.get("created_at") or "")
    popups = [_popup_for_event(st, org_id, event) for event in chosen[:limit]]
    if not is_manager(u):
        # Reps see unassigned calls and calls credited to them. Managers keep
        # the whole-yard view.
        popups = [
            popup for popup in popups
            if not popup.get("rep_id") or popup.get("rep_id") == u.get("id")
        ]
    return {"popups": popups, "server_time": store.now_iso()}
