"""Shared persistence helpers for the Delivery Dashboard customer directory.

The customer directory is a yard-scoped address book used to enrich delivery
report rows.  Two things feed it:

* a one-time backfill from the yard's existing call profiles (name + phone)
* a CSV import from the old Supabase customer export (address + contact data)

Both paths use the same matching rules so importing the CSV updates a
backfilled row instead of creating a duplicate.
"""
from __future__ import annotations

import re
import sqlite3
from typing import Any, Iterable

import database
import store
import yard_analytics as ya

CUSTOMER_FIELDS = (
    "shop_name",
    "main_contact",
    "address1",
    "address2",
    "city",
    "state",
    "zip",
    "phone",
    "notes",
)

_HEADER_ALIASES = {
    "shop_name": ("shop_name", "shop", "customer", "customer_name", "name", "business", "business_name"),
    "main_contact": ("main_contact", "contact", "contact_name"),
    "address1": ("address1", "address_1", "address", "street", "street_address"),
    "address2": ("address2", "address_2", "suite", "unit"),
    "city": ("city", "town"),
    "state": ("state", "province", "region"),
    "zip": ("zip", "zip_code", "postal_code", "postcode"),
    "phone": ("phone", "phone_number", "telephone", "tel"),
    "notes": ("notes", "note", "comments"),
}


def normalize_header(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(value or "").strip().lower()).strip("_")


def customer_from_csv_row(row: dict[str, Any]) -> dict[str, str] | None:
    """Normalize one CSV row, accepting common header aliases.

    Returns ``None`` for rows without a shop name.
    """
    normalized = {normalize_header(key): value for key, value in row.items() if key}

    def pick(field: str, limit: int) -> str:
        for alias in _HEADER_ALIASES[field]:
            value = normalized.get(alias)
            if value is not None and str(value).strip():
                return str(value).strip()[:limit]
        return ""

    payload = {
        "shop_name": pick("shop_name", 200),
        "main_contact": pick("main_contact", 120),
        "address1": pick("address1", 200),
        "address2": pick("address2", 200),
        "city": pick("city", 120),
        "state": pick("state", 40).upper(),
        "zip": pick("zip", 20),
        "phone": pick("phone", 40),
        "notes": pick("notes", 2000),
    }
    if not payload["shop_name"]:
        return None
    return payload


def _name_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).strip()


_GENERIC_NAMES = {"customer", "unknown", "wireless caller", "wireless caller 1", "no name", "n/a"}


def _looks_like_phone(value: str) -> bool:
    text = str(value or "").strip()
    digits = re.sub(r"\D", "", text)
    letters = re.sub(r"[^A-Za-z]", "", text)
    return bool(digits) and not letters and len(digits) >= 7


def _clean_name(value: Any) -> str:
    name = str(value or "").strip()
    if not name or name.lower() in _GENERIC_NAMES or _looks_like_phone(name):
        return ""
    return name[:200]


def _call_name(call: dict[str, Any]) -> str:
    for key in ("customer_name", "customer", "caller_name", "name"):
        name = _clean_name(call.get(key))
        if name:
            return name
    return ""


def _full_customer_names(state: dict[str, Any]) -> dict[str, str]:
    """Phone digits -> name from the legacy full_customers cache."""
    names: dict[str, str] = {}
    for key, entry in (state.get("full_customers") or {}).items():
        stat = entry.get("stat") if isinstance(entry, dict) else None
        if not isinstance(stat, dict):
            continue
        name = _clean_name(stat.get("name"))
        digits = database.normalize_phone(stat.get("phone") or key)
        if name and len(digits) >= 10:
            names.setdefault(digits, name)
    return names


def _profile_name(state: dict[str, Any], org_id: str, digits: str) -> str:
    if len(digits) < 10:
        return ""
    profile = ya._customer_profile(state, org_id, f"p:{digits}") or {}
    return _clean_name(profile.get("name"))


def _latest_call_names(state: dict[str, Any], org_id: str) -> dict[str, str]:
    names: dict[str, str] = {}
    for call in state.get("calls", []):
        if call.get("org_id") != org_id:
            continue
        digits = database.normalize_phone(call.get("customer_phone"))
        name = _call_name(call)
        if len(digits) >= 10 and name:
            names[digits] = name
    return names


def backfill_customers_from_calls(conn, org_id: str, state: dict[str, Any] | None = None) -> int:
    """Seed the directory from the yard's call history when it is empty.

    Only name and phone are available from calls; address fields stay blank
    until the customer CSV is imported.  Calls with the same phone collapse
    into one directory entry, matching the platform's customer grouping.  The
    latest non-empty name wins, and an existing customer profile outranks the
    call transcript's parsed name.
    """
    count = conn.execute(
        "SELECT COUNT(*) FROM delivery_customers WHERE org_id = ?", (org_id,)
    ).fetchone()[0]
    if count:
        return 0

    state = state or store.get_state()
    calls = [c for c in state.get("calls", []) if c.get("org_id") == org_id]
    calls.sort(key=lambda c: c.get("created_at") or "")

    groups: dict[str, dict[str, str]] = {}
    for call in calls:
        phone = str(call.get("customer_phone") or "").strip()[:40]
        name = _call_name(call)
        if not name and not phone:
            continue
        digits = database.normalize_phone(phone)
        key = f"p:{digits}" if len(digits) >= 10 else f"n:{_name_key(name)}"
        group = groups.setdefault(key, {"phone": phone, "name": ""})
        if phone:
            group["phone"] = phone
        if name:
            group["name"] = name  # calls are oldest -> newest, so the latest name wins

    if not groups:
        return 0

    full_names = _full_customer_names(state)
    now = store.now_iso()
    inserted = 0
    for group in groups.values():
        digits = database.normalize_phone(group["phone"])
        name = _profile_name(state, org_id, digits) or group["name"] or full_names.get(digits, "")
        shop_name = name or group["phone"]
        identity = database.delivery_customer_identity(shop_name, "", group["phone"])
        cursor = conn.execute(
            "INSERT OR IGNORE INTO delivery_customers "
            "(org_id, shop_name, main_contact, address1, address2, city, state, zip, phone, notes, "
            "identity_key, created_at, updated_at) "
            "VALUES (?, ?, '', '', '', '', '', '', ?, '', ?, ?, ?)",
            (
                org_id,
                shop_name,
                group["phone"],
                identity,
                now,
                now,
            ),
        )
        inserted += cursor.rowcount
    return inserted


def repair_customer_names(conn, org_id: str, state: dict[str, Any] | None = None) -> int:
    """Replace phone-number display names with a real name from call data.

    Earlier builds could backfill ``shop_name = phone`` when the latest call
    had no parsed customer name.  This repairs those rows in place without
    touching names a user or CSV import already provided.
    """
    rows = conn.execute(
        "SELECT id, shop_name, address1, phone FROM delivery_customers WHERE org_id = ? "
        "AND (trim(shop_name) = '' OR shop_name = phone "
        "OR (shop_name GLOB '*[0-9]*' AND shop_name NOT GLOB '*[A-Za-z]*'))",
        (org_id,),
    ).fetchall()
    if not rows:
        return 0

    state = state or store.get_state()
    latest_names = _latest_call_names(state, org_id)
    full_names = _full_customer_names(state)
    updated = 0
    for row in rows:
        digits = database.normalize_phone(row["phone"])
        if len(digits) < 10:
            continue
        name = (
            _profile_name(state, org_id, digits)
            or latest_names.get(digits, "")
            or full_names.get(digits, "")
        )
        if not name:
            continue
        identity = database.delivery_customer_identity(name, row["address1"] or "", row["phone"] or "")
        try:
            conn.execute(
                "UPDATE delivery_customers SET shop_name = ?, identity_key = ?, updated_at = ? "
                "WHERE id = ? AND org_id = ?",
                (name, identity, store.now_iso(), row["id"], org_id),
            )
            updated += 1
        except sqlite3.IntegrityError:
            # A named row already exists for the same identity; leave this one.
            continue
    return updated


def import_customer_rows(conn, org_id: str, rows: Iterable[dict[str, str]]) -> dict[str, int]:
    """Insert or update customer rows, merging by identity or phone.

    The phone fallback is what lets a CSV import enrich a row that was
    backfilled from call history (which has no address yet).
    """
    existing = conn.execute(
        "SELECT id, identity_key, shop_name, phone FROM delivery_customers WHERE org_id = ?",
        (org_id,),
    ).fetchall()

    by_identity: dict[str, int] = {}
    by_phone: dict[str, int] = {}
    by_name: dict[str, list[int]] = {}
    for row in existing:
        customer_id = int(row["id"])
        by_identity[str(row["identity_key"])] = customer_id
        digits = database.normalize_phone(row["phone"])
        if len(digits) >= 10:
            by_phone.setdefault(digits, customer_id)
        by_name.setdefault(_name_key(row["shop_name"]), []).append(customer_id)

    added = updated = skipped = 0
    now = store.now_iso()

    for payload in rows:
        shop_name = (payload.get("shop_name") or "").strip()
        if not shop_name:
            skipped += 1
            continue

        address1 = (payload.get("address1") or "").strip()
        phone = (payload.get("phone") or "").strip()
        identity = database.delivery_customer_identity(shop_name, address1, phone)
        digits = database.normalize_phone(phone)

        target_id = by_identity.get(identity)
        if target_id is None and len(digits) >= 10:
            target_id = by_phone.get(digits)
        if target_id is None and len(digits) < 10:
            name_matches = by_name.get(_name_key(shop_name), [])
            if len(name_matches) == 1:
                target_id = name_matches[0]

        if target_id is not None:
            try:
                conn.execute(
                    "UPDATE delivery_customers SET "
                    "shop_name = ?, "
                    "main_contact = COALESCE(NULLIF(?, ''), main_contact), "
                    "address1 = COALESCE(NULLIF(?, ''), address1), "
                    "address2 = COALESCE(NULLIF(?, ''), address2), "
                    "city = COALESCE(NULLIF(?, ''), city), "
                    "state = COALESCE(NULLIF(?, ''), state), "
                    "zip = COALESCE(NULLIF(?, ''), zip), "
                    "phone = COALESCE(NULLIF(?, ''), phone), "
                    "notes = COALESCE(NULLIF(?, ''), notes), "
                    "identity_key = ?, updated_at = ? "
                    "WHERE id = ? AND org_id = ?",
                    (
                        shop_name,
                        (payload.get("main_contact") or "").strip(),
                        address1,
                        (payload.get("address2") or "").strip(),
                        (payload.get("city") or "").strip(),
                        (payload.get("state") or "").strip().upper(),
                        (payload.get("zip") or "").strip(),
                        phone,
                        (payload.get("notes") or "").strip(),
                        identity,
                        now,
                        target_id,
                        org_id,
                    ),
                )
                updated += 1
                by_identity[identity] = target_id
                if len(digits) >= 10:
                    by_phone[digits] = target_id
                by_name.setdefault(_name_key(shop_name), [])
                if target_id not in by_name[_name_key(shop_name)]:
                    by_name[_name_key(shop_name)].append(target_id)
            except sqlite3.IntegrityError:
                skipped += 1
            continue

        try:
            cursor = conn.execute(
                "INSERT INTO delivery_customers "
                "(org_id, shop_name, main_contact, address1, address2, city, state, zip, phone, notes, "
                "identity_key, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    org_id,
                    shop_name,
                    (payload.get("main_contact") or "").strip(),
                    address1,
                    (payload.get("address2") or "").strip(),
                    (payload.get("city") or "").strip(),
                    (payload.get("state") or "").strip().upper(),
                    (payload.get("zip") or "").strip(),
                    phone,
                    (payload.get("notes") or "").strip(),
                    identity,
                    now,
                    now,
                ),
            )
            added += 1
            new_id = int(cursor.lastrowid)
            by_identity[identity] = new_id
            if len(digits) >= 10:
                by_phone[digits] = new_id
            by_name.setdefault(_name_key(shop_name), []).append(new_id)
        except sqlite3.IntegrityError:
            skipped += 1

    return {"added": added, "updated": updated, "skipped": skipped}
