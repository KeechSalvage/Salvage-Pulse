"""One-time importer for Delivery Dashboard data.

The dashboard previously stored its Hollander part catalog, customer directory
and upload log in Supabase.  This script copies the exported parts/customers
into the platform's SQLite database for one yard.  It is idempotent, so it is
safe to run again after adding rows.  When the customer table is empty, call
history is used to seed name/phone entries first; the CSV then fills in
addresses and contacts without creating duplicates.

Run from the ``backend`` directory:

    .venv/bin/python scripts/import_delivery_data.py
    .venv/bin/python scripts/import_delivery_data.py --org-id org-keech \\
        --customers /path/to/customers.csv --parts /path/to/hollander_parts.csv

``--customers`` accepts the Supabase CSV export (shop_name, main_contact,
address1, address2, city, state, zip, phone, notes).  ``--parts`` accepts a CSV
with ``hollander_id, part_name`` columns.  ``--uploads`` accepts the Supabase
``report_uploads`` CSV export (uploader, uploaded_at, file_name, salesperson,
report_date, row_count, matched_customers, matched_parts).
"""
from __future__ import annotations

import argparse
import csv
import os
import sys

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND_DIR)

import database  # noqa: E402
import delivery_store  # noqa: E402
import store  # noqa: E402

DEFAULT_CUSTOMERS = os.path.join(BACKEND_DIR, "seed", "delivery_customers.csv")
DEFAULT_PARTS = os.path.join(BACKEND_DIR, "seed", "delivery_parts.csv")
DEFAULT_UPLOADS = os.path.join(BACKEND_DIR, "seed", "delivery_uploads.csv")


def _default_org() -> str:
    state = store.get_state()
    return (state.get("org") or {}).get("id") or store.KEECH_ORG_ID


def import_customers(conn, org_id: str, path: str) -> dict[str, int]:
    rows = []
    invalid = 0
    with open(path, newline="", encoding="utf-8-sig") as fh:
        for raw in csv.DictReader(fh):
            payload = delivery_store.customer_from_csv_row(raw)
            if payload:
                rows.append(payload)
            else:
                invalid += 1
    counts = delivery_store.import_customer_rows(conn, org_id, rows)
    counts["skipped"] += invalid
    return counts


def import_parts(conn, org_id: str, path: str) -> tuple[int, int]:
    inserted = updated = 0
    now = store.now_iso()
    with open(path, newline="", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            part_name = (row.get("part_name") or "").strip()
            hollander_id = (row.get("hollander_id") or "").strip()
            if not part_name or not hollander_id:
                continue
            existing = conn.execute(
                "SELECT part_name FROM delivery_parts WHERE org_id = ? AND hollander_id = ?",
                (org_id, hollander_id),
            ).fetchone()
            if existing:
                if existing["part_name"] != part_name:
                    conn.execute(
                        "UPDATE delivery_parts SET part_name = ?, updated_at = ? "
                        "WHERE org_id = ? AND hollander_id = ?",
                        (part_name, now, org_id, hollander_id),
                    )
                    updated += 1
                continue
            try:
                conn.execute(
                    "INSERT INTO delivery_parts (org_id, hollander_id, part_name, updated_at) "
                    "VALUES (?, ?, ?, ?)",
                    (org_id, hollander_id, part_name, now),
                )
                inserted += 1
            except Exception as exc:  # noqa: BLE001 - report the conflicting row
                print(f"  ! skipped part {hollander_id} {part_name!r}: {exc}")
    return inserted, updated


def import_uploads(conn, org_id: str, path: str) -> int:
    """Copy historical upload activity.  Re-running skips existing rows."""
    inserted = 0
    with open(path, newline="", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            uploader = (row.get("uploader") or "").strip()
            uploaded_at = (row.get("uploaded_at") or "").strip()
            if not uploader or not uploaded_at:
                continue
            file_name = (row.get("file_name") or "").strip()
            exists = conn.execute(
                "SELECT 1 FROM delivery_uploads WHERE org_id = ? AND uploader = ? "
                "AND uploaded_at = ? AND file_name = ? LIMIT 1",
                (org_id, uploader, uploaded_at, file_name),
            ).fetchone()
            if exists:
                continue

            def count(key: str) -> int:
                try:
                    return max(0, int(row.get(key) or 0))
                except (TypeError, ValueError):
                    return 0

            conn.execute(
                "INSERT INTO delivery_uploads "
                "(org_id, user_id, uploader, uploaded_at, file_name, salesperson, report_date, "
                "row_count, matched_customers, matched_parts, source) "
                "VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, 'import')",
                (
                    org_id,
                    uploader,
                    uploaded_at,
                    file_name,
                    (row.get("salesperson") or "").strip(),
                    (row.get("report_date") or "").strip(),
                    count("row_count"),
                    count("matched_customers"),
                    count("matched_parts"),
                ),
            )
            inserted += 1
    return inserted


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--org-id", default="", help="Yard/org to import into (default: current org)")
    parser.add_argument("--customers", default=DEFAULT_CUSTOMERS)
    parser.add_argument("--parts", default=DEFAULT_PARTS)
    parser.add_argument("--uploads", default=DEFAULT_UPLOADS)
    parser.add_argument("--skip-customers", action="store_true")
    parser.add_argument("--skip-parts", action="store_true")
    parser.add_argument("--skip-uploads", action="store_true")
    parser.add_argument(
        "--if-empty",
        action="store_true",
        help="Exit without importing when the yard already has customers.",
    )
    args = parser.parse_args()

    org_id = (args.org_id or _default_org()).strip()
    if not org_id:
        print("No org id could be determined. Pass --org-id.", file=sys.stderr)
        return 2

    database.init_schema()
    with database.get_db() as conn:
        if args.if_empty:
            count = conn.execute(
                "SELECT COUNT(*) FROM delivery_customers WHERE org_id = ?", (org_id,)
            ).fetchone()[0]
            if count:
                print(f"{org_id} already has {count} delivery customers; nothing to do.")
                return 0

        print(f"Importing Delivery Dashboard data for {org_id}")
        if not args.skip_parts:
            if not os.path.exists(args.parts):
                print(f"Parts file not found: {args.parts}", file=sys.stderr)
                return 2
            inserted, updated = import_parts(conn, org_id, args.parts)
            print(f"  parts: {inserted} added, {updated} updated")
        if not args.skip_customers:
            if not os.path.exists(args.customers):
                print(f"Customers file not found: {args.customers}", file=sys.stderr)
                return 2
            seeded = delivery_store.backfill_customers_from_calls(conn, org_id)
            if seeded:
                print(f"  customers: {seeded} seeded from call history")
            counts = import_customers(conn, org_id, args.customers)
            print(
                f"  customers: {counts['added']} added, {counts['updated']} updated, "
                f"{counts['skipped']} skipped"
            )
        if not args.skip_uploads and os.path.exists(args.uploads):
            inserted = import_uploads(conn, org_id, args.uploads)
            print(f"  uploads: {inserted} historical rows added")
    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
