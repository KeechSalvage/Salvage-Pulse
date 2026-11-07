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


def backfill_customers_from_calls(conn, org_id: str, state: dict[str, Any] | None = None) -> int:
    """Seed the directory from the yard's call history when it is empty.

    Only name and phone are available from calls; address fields stay blank
    until the customer CSV is imported.  Calls with the same phone collapse
    into one directory entry, matching the platform's customer grouping.
    """
    count = conn.execute(
        "SELECT COUNT(*) FROM delivery_customers WHERE org_id = ?", (org_id,)
    ).fetchone()[0]
    if count:
        return 0

    state = state or store.get_state()
    calls = [c for c in state.get("calls", []) if c.get("org_id") == org_id]
    calls.sort(key=lambda c: c.get("created_at") or "")

    by_key: dict[str, dict[str, str]] = {}
    for call in calls:
        name = str(call.get("customer_name") or "").strip()[:200]
        phone = str(call.get("customer_phone") or "").strip()[:40]
        if not name and not phone:
            continue
        digits = database.normalize_phone(phone)
        key = f"p:{digits}" if len(digits) >= 10 else f"n:{_name_key(name)}"
        by_key[key] = {
            "shop_name": name or phone,
            "phone": phone,
        }

    if not by_key:
        return 0

    now = store.now_iso()
    inserted = 0
    for payload in by_key.values():
        identity = database.delivery_customer_identity(
            payload["shop_name"], "", payload["phone"]
        )
        cursor = conn.execute(
            "INSERT OR IGNORE INTO delivery_customers "
            "(org_id, shop_name, main_contact, address1, address2, city, state, zip, phone, notes, "
            "identity_key, created_at, updated_at) "
            "VALUES (?, ?, '', '', '', '', '', '', ?, '', ?, ?, ?)",
            (
                org_id,
                payload["shop_name"],
                payload["phone"],
                identity,
                now,
                now,
            ),
        )
        inserted += cursor.rowcount
    return inserted


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
