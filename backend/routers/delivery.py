"""Delivery Dashboard persistence and announcement calls.

The standalone dashboard used to talk to Supabase directly from the browser.
This router moves that data into the platform's SQLite database so it is
authenticated, yard-scoped, backed up with the rest of the platform, and no
longer depends on a publishable key with public write policies.
"""
from __future__ import annotations

import csv
import os
import re
import sqlite3
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request

import database
import store
from security import SlidingWindowLimiter, effective_org, require_authenticated

router = APIRouter(tags=["delivery"], dependencies=[Depends(require_authenticated)])

# The Delivery Dashboard is shown to every yard role except inventory managers
# (who are redirected to vehicles) and platform staff (who use the admin console).
DELIVERY_ROLES = frozenset({"owner", "sales_manager", "manager", "rep", "sales_rep"})
DELIVERY_MANAGER_ROLES = frozenset({"owner", "sales_manager", "manager"})

_SEED_PARTS = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "seed", "delivery_parts.csv"
)

# One announcement per number per ten minutes, across users and processes.
_CALL_LIMITER = SlidingWindowLimiter(limit=1, window_seconds=600)


def _delivery_user(request: Request) -> dict[str, Any]:
    user = require_authenticated(request)
    if user.get("role") not in DELIVERY_ROLES:
        raise HTTPException(status_code=403, detail="Delivery Dashboard access required")
    return user


def _org(user: dict[str, Any]) -> str:
    org_id = effective_org(user)
    if not org_id:
        raise HTTPException(status_code=400, detail="Your account is not attached to a yard")
    return org_id


def _text(value: Any, limit: int = 500) -> str:
    return str(value or "").strip()[:limit]


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return default


def _like(term: str) -> str:
    escaped = term.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _row(row: sqlite3.Row) -> dict[str, Any]:
    return {key: row[key] for key in row.keys()}


# ---------------------------------------------------------------------------
# Parts catalog
# ---------------------------------------------------------------------------
def _seed_parts_if_empty(conn: sqlite3.Connection, org_id: str) -> None:
    """Give a new yard the standard Hollander part map on first use."""
    count = conn.execute(
        "SELECT COUNT(*) FROM delivery_parts WHERE org_id = ?", (org_id,)
    ).fetchone()[0]
    if count:
        return
    path = os.environ.get("DELIVERY_PARTS_SEED", _SEED_PARTS)
    if not os.path.exists(path):
        return
    now = store.now_iso()
    with open(path, newline="", encoding="utf-8") as fh:
        for entry in csv.DictReader(fh):
            name = _text(entry.get("part_name"), 200)
            hollander_id = _text(entry.get("hollander_id"), 16)
            if not name or not hollander_id:
                continue
            conn.execute(
                "INSERT OR IGNORE INTO delivery_parts "
                "(org_id, hollander_id, part_name, updated_at) VALUES (?, ?, ?, ?)",
                (org_id, hollander_id, name, now),
            )


@router.get("/api/delivery/parts")
def list_parts(
    request: Request,
    q: str = Query("", max_length=120),
    limit: int = Query(0, ge=0, le=2000),
) -> list[dict[str, Any]]:
    user = _delivery_user(request)
    org_id = _org(user)
    term = q.strip()

    with database.get_db() as conn:
        _seed_parts_if_empty(conn, org_id)
        sql = "SELECT part_name, hollander_id FROM delivery_parts WHERE org_id = ?"
        params: list[Any] = [org_id]
        if term:
            sql += " AND (lower(part_name) LIKE ? ESCAPE '\\' OR hollander_id LIKE ? ESCAPE '\\')"
            params.extend([_like(term), _like(term)])
        sql += " ORDER BY part_name COLLATE NOCASE ASC"
        if limit:
            sql += " LIMIT ?"
            params.append(limit)
        return [_row(row) for row in conn.execute(sql, params).fetchall()]


@router.post("/api/delivery/parts")
def create_part(body: dict[str, Any], request: Request) -> dict[str, Any]:
    user = _delivery_user(request)
    org_id = _org(user)
    name = _text(body.get("part_name"), 200)
    hollander_id = _text(body.get("hollander_id"), 16)
    if not name or not hollander_id:
        raise HTTPException(status_code=400, detail="Part name and Hollander number are required.")
    if not hollander_id.isdigit() or len(hollander_id) > 6:
        raise HTTPException(status_code=400, detail="The Hollander number must be 1-6 digits.")

    try:
        with database.get_db() as conn:
            conn.execute(
                "INSERT INTO delivery_parts (org_id, hollander_id, part_name, updated_at) "
                "VALUES (?, ?, ?, ?)",
                (org_id, hollander_id, name, store.now_iso()),
            )
    except sqlite3.IntegrityError:
        raise HTTPException(
            status_code=409, detail="That part name or Hollander number already exists."
        ) from None
    return {"part_name": name, "hollander_id": hollander_id}


@router.patch("/api/delivery/parts/{hollander_id}")
def update_part(hollander_id: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    user = _delivery_user(request)
    org_id = _org(user)
    name = _text(body.get("part_name"), 200)
    new_id = _text(body.get("hollander_id"), 16)
    if not name or not new_id:
        raise HTTPException(status_code=400, detail="Part name and Hollander number are required.")
    if not new_id.isdigit() or len(new_id) > 6:
        raise HTTPException(status_code=400, detail="The Hollander number must be 1-6 digits.")

    try:
        with database.get_db() as conn:
            cursor = conn.execute(
                "UPDATE delivery_parts SET hollander_id = ?, part_name = ?, updated_at = ? "
                "WHERE org_id = ? AND hollander_id = ?",
                (new_id, name, store.now_iso(), org_id, hollander_id),
            )
            if cursor.rowcount == 0:
                raise HTTPException(status_code=404, detail="Part not found")
    except sqlite3.IntegrityError:
        raise HTTPException(
            status_code=409, detail="That part name or Hollander number already exists."
        ) from None
    return {"part_name": name, "hollander_id": new_id}


@router.delete("/api/delivery/parts/{hollander_id}")
def delete_part(hollander_id: str, request: Request) -> dict[str, Any]:
    user = _delivery_user(request)
    org_id = _org(user)
    with database.get_db() as conn:
        cursor = conn.execute(
            "DELETE FROM delivery_parts WHERE org_id = ? AND hollander_id = ?",
            (org_id, hollander_id),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Part not found")
    return {"ok": True}


# ---------------------------------------------------------------------------
# Customer directory
# ---------------------------------------------------------------------------
_CUSTOMER_COLUMNS = (
    "id", "shop_name", "main_contact", "address1", "address2",
    "city", "state", "zip", "phone", "notes",
)


def _customer_payload(body: dict[str, Any], base: Optional[dict[str, Any]] = None) -> dict[str, str]:
    current = base or {}

    def value(key: str, limit: int) -> str:
        if key in body:
            return _text(body.get(key), limit)
        return _text(current.get(key), limit)

    return {
        "shop_name": value("shop_name", 200),
        "main_contact": value("main_contact", 120),
        "address1": value("address1", 200),
        "address2": value("address2", 200),
        "city": value("city", 120),
        "state": value("state", 40).upper(),
        "zip": value("zip", 20),
        "phone": value("phone", 40),
        "notes": value("notes", 2000),
    }


@router.get("/api/delivery/customers")
def list_customers(
    request: Request,
    q: str = Query("", max_length=120),
    limit: int = Query(1000, ge=1, le=2000),
    offset: int = Query(0, ge=0),
) -> list[dict[str, Any]]:
    user = _delivery_user(request)
    org_id = _org(user)
    term = q.strip()

    sql = (
        "SELECT id, shop_name, main_contact, address1, address2, city, state, zip, phone, notes "
        "FROM delivery_customers WHERE org_id = ?"
    )
    params: list[Any] = [org_id]
    if term:
        like = _like(term)
        sql += (
            " AND (lower(shop_name) LIKE ? ESCAPE '\\'"
            " OR lower(main_contact) LIKE ? ESCAPE '\\'"
            " OR lower(phone) LIKE ? ESCAPE '\\'"
            " OR lower(city) LIKE ? ESCAPE '\\'"
            " OR lower(zip) LIKE ? ESCAPE '\\')"
        )
        params.extend([like, like, like, like, like])
    sql += " ORDER BY shop_name COLLATE NOCASE ASC LIMIT ? OFFSET ?"
    params.extend([limit, offset])

    with database.get_db() as conn:
        return [_row(row) for row in conn.execute(sql, params).fetchall()]


@router.post("/api/delivery/customers")
def create_customer(body: dict[str, Any], request: Request) -> dict[str, Any]:
    user = _delivery_user(request)
    org_id = _org(user)
    payload = _customer_payload(body)
    if not payload["shop_name"]:
        raise HTTPException(status_code=400, detail="Shop name is required.")

    identity = database.delivery_customer_identity(
        payload["shop_name"], payload["address1"], payload["phone"]
    )
    now = store.now_iso()
    try:
        with database.get_db() as conn:
            cursor = conn.execute(
                "INSERT INTO delivery_customers "
                "(org_id, shop_name, main_contact, address1, address2, city, state, zip, phone, notes, "
                "identity_key, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    org_id, payload["shop_name"], payload["main_contact"], payload["address1"],
                    payload["address2"], payload["city"], payload["state"], payload["zip"],
                    payload["phone"], payload["notes"], identity, now, now,
                ),
            )
            row = conn.execute(
                "SELECT id, shop_name, main_contact, address1, address2, city, state, zip, phone, notes "
                "FROM delivery_customers WHERE id = ? AND org_id = ?",
                (cursor.lastrowid, org_id),
            ).fetchone()
    except sqlite3.IntegrityError:
        raise HTTPException(
            status_code=409,
            detail="A customer with that shop name, address and phone already exists.",
        ) from None
    return _row(row)


@router.patch("/api/delivery/customers/{customer_id}")
def update_customer(customer_id: int, body: dict[str, Any], request: Request) -> dict[str, Any]:
    user = _delivery_user(request)
    org_id = _org(user)
    with database.get_db() as conn:
        current = conn.execute(
            "SELECT id, shop_name, main_contact, address1, address2, city, state, zip, phone, notes "
            "FROM delivery_customers WHERE id = ? AND org_id = ?",
            (customer_id, org_id),
        ).fetchone()
        if not current:
            raise HTTPException(status_code=404, detail="Customer not found")

        payload = _customer_payload(body, _row(current))
        if not payload["shop_name"]:
            raise HTTPException(status_code=400, detail="Shop name is required.")
        identity = database.delivery_customer_identity(
            payload["shop_name"], payload["address1"], payload["phone"]
        )
        try:
            conn.execute(
                "UPDATE delivery_customers SET shop_name = ?, main_contact = ?, address1 = ?, "
                "address2 = ?, city = ?, state = ?, zip = ?, phone = ?, notes = ?, "
                "identity_key = ?, updated_at = ? WHERE id = ? AND org_id = ?",
                (
                    payload["shop_name"], payload["main_contact"], payload["address1"],
                    payload["address2"], payload["city"], payload["state"], payload["zip"],
                    payload["phone"], payload["notes"], identity, store.now_iso(),
                    customer_id, org_id,
                ),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(
                status_code=409,
                detail="A customer with that shop name, address and phone already exists.",
            ) from None
        row = conn.execute(
            "SELECT id, shop_name, main_contact, address1, address2, city, state, zip, phone, notes "
            "FROM delivery_customers WHERE id = ? AND org_id = ?",
            (customer_id, org_id),
        ).fetchone()
    return _row(row)


@router.delete("/api/delivery/customers/{customer_id}")
def delete_customer(customer_id: int, request: Request) -> dict[str, Any]:
    user = _delivery_user(request)
    org_id = _org(user)
    with database.get_db() as conn:
        cursor = conn.execute(
            "DELETE FROM delivery_customers WHERE id = ? AND org_id = ?",
            (customer_id, org_id),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Customer not found")
    return {"ok": True}


# ---------------------------------------------------------------------------
# Upload activity
# ---------------------------------------------------------------------------
@router.get("/api/delivery/uploads")
def list_uploads(
    request: Request,
    limit: int = Query(1000, ge=1, le=5000),
    offset: int = Query(0, ge=0),
) -> list[dict[str, Any]]:
    user = _delivery_user(request)
    if user.get("role") not in DELIVERY_MANAGER_ROLES:
        raise HTTPException(status_code=403, detail="Manager access required for upload activity")
    org_id = _org(user)
    with database.get_db() as conn:
        rows = conn.execute(
            "SELECT id, user_id, uploader, uploaded_at, file_name, salesperson, report_date, "
            "row_count, matched_customers, matched_parts, source "
            "FROM delivery_uploads WHERE org_id = ? "
            "ORDER BY uploaded_at DESC, id DESC LIMIT ? OFFSET ?",
            (org_id, limit, offset),
        ).fetchall()
    return [_row(row) for row in rows]


@router.post("/api/delivery/uploads")
def create_upload(body: dict[str, Any], request: Request) -> dict[str, Any]:
    user = _delivery_user(request)
    org_id = _org(user)
    uploader = _text(user.get("name") or user.get("email") or "Unknown", 120)
    with database.get_db() as conn:
        cursor = conn.execute(
            "INSERT INTO delivery_uploads "
            "(org_id, user_id, uploader, uploaded_at, file_name, salesperson, report_date, "
            "row_count, matched_customers, matched_parts, source) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                org_id,
                _text(user.get("id"), 80),
                uploader,
                store.now_iso(),
                _text(body.get("file_name"), 500),
                _text(body.get("salesperson"), 200),
                _text(body.get("report_date"), 40),
                _as_int(body.get("row_count")),
                _as_int(body.get("matched_customers")),
                _as_int(body.get("matched_parts")),
                "dashboard",
            ),
        )
        row = conn.execute(
            "SELECT id, user_id, uploader, uploaded_at, file_name, salesperson, report_date, "
            "row_count, matched_customers, matched_parts, source "
            "FROM delivery_uploads WHERE id = ?",
            (cursor.lastrowid,),
        ).fetchone()
    return _row(row)


# ---------------------------------------------------------------------------
# Delivery announcement calls
# ---------------------------------------------------------------------------
def _test_mode() -> bool:
    return os.environ.get("DELIVERY_TEST_MODE", "true").strip().lower() in ("1", "true", "yes", "on")


def _allowed_numbers() -> set[str]:
    return {
        value.strip()
        for value in os.environ.get("DELIVERY_ALLOWED_TO", "").split(",")
        if value.strip()
    }


def _normalize_to(value: Any) -> str:
    digits = re.sub(r"\D", "", str(value or ""))
    if len(digits) == 10:
        return "+1" + digits
    if len(digits) == 11 and digits.startswith("1"):
        return "+" + digits
    return ""


def _yard_name(org_id: str) -> str:
    configured = os.environ.get("DELIVERY_YARD_NAME", "").strip()
    if configured:
        return configured
    state = store.get_state()
    org = state.get("org") or {}
    if org.get("id") == org_id:
        return str(org.get("yard_name") or org.get("name") or "").strip()
    for admin_org in state.get("admin_orgs", []):
        if admin_org.get("id") == org_id:
            return str(admin_org.get("yard_name") or admin_org.get("name") or "").strip()
    return ""


def _announcement_message(org_id: str) -> str:
    yard = _yard_name(org_id) or "our parts yard"
    callback = os.environ.get("DELIVERY_CALLBACK_NUMBER", "").strip()
    message = f"Hello! This is {yard} letting you know your delivery is expected today."
    if callback:
        message += f" Call us at {callback} if you have any questions."
    return message + " Thank you!"


def _escape_xml(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


@router.get("/api/delivery/announce/settings")
def announce_settings(request: Request) -> dict[str, Any]:
    user = _delivery_user(request)
    org_id = _org(user)
    sid = bool(os.environ.get("TWILIO_ACCOUNT_SID"))
    token = bool(os.environ.get("TWILIO_AUTH_TOKEN"))
    from_number = bool(os.environ.get("TWILIO_FROM_NUMBER"))
    return {
        "test_mode": _test_mode(),
        "configured": sid and token and from_number,
        "yard_name": _yard_name(org_id),
        "callback_number": os.environ.get("DELIVERY_CALLBACK_NUMBER", "").strip(),
        "allowed_numbers": len(_allowed_numbers()),
    }


@router.post("/api/delivery/announce")
def announce_delivery(body: dict[str, Any], request: Request) -> dict[str, Any]:
    user = _delivery_user(request)
    org_id = _org(user)
    to = _normalize_to(body.get("to"))
    if not to:
        raise HTTPException(
            status_code=400, detail="A valid 10-digit US phone number is required."
        )
    allowed = _allowed_numbers()
    if allowed and to not in allowed:
        raise HTTPException(status_code=403, detail="This number is not in the allowed list.")
    if not _CALL_LIMITER.allow(f"{org_id}:{to}"):
        retry = _CALL_LIMITER.retry_after(f"{org_id}:{to}")
        raise HTTPException(
            status_code=429,
            detail=f"This number was called recently. Try again in {max(1, retry // 60)} minutes.",
            headers={"Retry-After": str(retry)},
        )

    message = _announcement_message(org_id)
    test_mode = _test_mode()
    now = store.now_iso()

    def record(test: bool, status: str, sid: str = "", error: str = "") -> None:
        with database.get_db() as conn:
            conn.execute(
                "INSERT INTO delivery_announcements "
                "(org_id, user_id, to_number, test, status, sid, error, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (org_id, _text(user.get("id"), 80), to, 1 if test else 0, status, sid, error, now),
            )

    if test_mode:
        record(True, "test")
        return {"ok": True, "test": True, "to": to, "message": message}

    sid = os.environ.get("TWILIO_ACCOUNT_SID")
    token = os.environ.get("TWILIO_AUTH_TOKEN")
    from_number = os.environ.get("TWILIO_FROM_NUMBER")
    if not (sid and token and from_number):
        raise HTTPException(status_code=500, detail="Twilio credentials are not configured.")

    twiml = f"<Response><Say voice=\"alice\">{_escape_xml(message)}</Say></Response>"
    try:
        response = httpx.post(
            f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Calls.json",
            auth=(sid, token),
            data={"To": to, "From": from_number, "Twiml": twiml},
            timeout=15.0,
        )
        data = response.json() if response.content else {}
    except httpx.HTTPError as exc:
        record(False, "error", error=str(exc)[:500])
        raise HTTPException(status_code=502, detail="The call service is unreachable.") from None

    if response.status_code >= 400:
        error = str(data.get("message") or "Twilio rejected the call.")[:500]
        record(False, "error", error=error)
        raise HTTPException(status_code=502, detail=error)

    call_sid = str(data.get("sid") or "")
    record(False, str(data.get("status") or "queued"), sid=call_sid)
    return {
        "ok": True,
        "test": False,
        "to": to,
        "sid": call_sid,
        "status": data.get("status"),
    }
