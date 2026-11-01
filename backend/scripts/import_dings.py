"""
Import Ding's Auto Parts calls and demo users from Google Sheets into Salvage Pulse.
Creates organization 'org-dings-auto', adds Brandon Cocksucker (owner) and the team with @dings.com,
and populates all 8,270 calls into both salvage_pulse.db and the in-memory state.
"""
import copy
import csv
import json
import logging
import os
import re
import sqlite3
import sys
import urllib.request
import uuid
from datetime import datetime

# Add backend dir to sys.path
backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, backend_dir)

import database
import store

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("import_dings")

DINGS_ORG_ID = "org-dings-auto"
DINGS_ORG_NAME = "Ding's Auto Parts"
SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/1Qv_3NHdPU_DeK-oa_Fd0GQmJ-QmvG08O7ApXU37HbpE/export?format=csv"

# Pre-define user roster
# Owner: Brandon Cocksucker (cocksucker@dings.com)
# Sales Reps: Ericka Light, Rich Brauns, Joel Chouinard, Cam Mastrangelo
# Sales Manager: Ben Keech
DINGS_USERS = {
    "user-dings-owner": {
        "id": "user-dings-owner",
        "email": "cocksucker@dings.com",
        "name": "Brandon Cocksucker",
        "role": "owner",
        "title": "Owner / General Manager",
        "org_id": DINGS_ORG_ID,
        "avatar_url": "",
        "disabled": False,
        "password_hash": store.hash_password("owner"),
        "created_at": "2026-10-01T00:00:00Z",
    },
    "user-dings-sales-mgr": {
        "id": "user-dings-sales-mgr",
        "email": "benkeech@dings.com",
        "name": "Ben Keech",
        "role": "sales_manager",
        "title": "Sales Manager",
        "org_id": DINGS_ORG_ID,
        "avatar_url": "",
        "disabled": False,
        "password_hash": store.hash_password("manager"),
        "created_at": "2026-10-01T00:00:00Z",
    },
    "user-dings-rep-ericka": {
        "id": "user-dings-rep-ericka",
        "email": "ericka@dings.com",
        "name": "Ericka Light",
        "role": "rep",
        "title": "Sales Representative",
        "org_id": DINGS_ORG_ID,
        "avatar_url": "",
        "disabled": False,
        "password_hash": store.hash_password("rep1"),
        "created_at": "2026-10-01T00:00:00Z",
    },
    "user-dings-rep-rich": {
        "id": "user-dings-rep-rich",
        "email": "rich@dings.com",
        "name": "Rich Brauns",
        "role": "rep",
        "title": "Sales Representative",
        "org_id": DINGS_ORG_ID,
        "avatar_url": "",
        "disabled": False,
        "password_hash": store.hash_password("rep2"),
        "created_at": "2026-10-01T00:00:00Z",
    },
    "user-dings-rep-joel": {
        "id": "user-dings-rep-joel",
        "email": "joel@dings.com",
        "name": "Joel Chouinard",
        "role": "rep",
        "title": "Sales Representative",
        "org_id": DINGS_ORG_ID,
        "avatar_url": "",
        "disabled": False,
        "password_hash": store.hash_password("rep3"),
        "created_at": "2026-10-01T00:00:00Z",
    },
    "user-dings-rep-cam": {
        "id": "user-dings-rep-cam",
        "email": "cam@dings.com",
        "name": "Cam Mastrangelo",
        "role": "rep",
        "title": "Sales Representative",
        "org_id": DINGS_ORG_ID,
        "avatar_url": "",
        "disabled": False,
        "password_hash": store.hash_password("rep4"),
        "created_at": "2026-10-01T00:00:00Z",
    },
}

# Lookup map for Sheet host -> user_id & user_name
HOST_MAP = {
    "ericka light": ("user-dings-rep-ericka", "Ericka Light"),
    "rich brauns": ("user-dings-rep-rich", "Rich Brauns"),
    "joel chouinard": ("user-dings-rep-joel", "Joel Chouinard"),
    "cam mastrangelo": ("user-dings-rep-cam", "Cam Mastrangelo"),
    "ben keech": ("user-dings-sales-mgr", "Ben Keech"),
}

EXT_PATTERN = re.compile(r'Name:\s*([^;]+);\s*Email:[^;]*;\s*Phone:\s*([0-9+]+|\S+)', re.IGNORECASE)


def run_import():
    logger.info("Downloading CSV from Google Sheets...")
    req = urllib.request.Request(SHEET_CSV_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as resp:
        lines = [line.decode("utf-8", errors="ignore") for line in resp.readlines()]

    reader = csv.DictReader(lines)
    raw_rows = list(reader)
    total_raw = len(raw_rows)
    logger.info(f"Loaded {total_raw} rows from Google Sheet.")

    st = store.get_state()

    # 1. Setup Organization in state and DB
    dings_org_dict = {
        "id": DINGS_ORG_ID,
        "name": DINGS_ORG_NAME,
        "yard_name": DINGS_ORG_NAME,
        "plan": "enterprise",
        "status": "active",
        "trial_ends_at": None,
        "created_at": "2026-10-01T00:00:00Z",
        "users": len(DINGS_USERS),
        "calls": total_raw,
        "ringcentral_connected": True,
        "card_on_file": True,
        "blocked": False,
        "cancel_reason": "",
        "discount": None,
        "sites": 1,
        "max_sites": 2,
        "extra_sites": 0,
        "is_demo": True,
    }

    admin_orgs = st.setdefault("admin_orgs", [])
    existing_org = next((o for o in admin_orgs if o.get("id") == DINGS_ORG_ID), None)
    if existing_org:
        existing_org.update(dings_org_dict)
    else:
        admin_orgs.append(dings_org_dict)

    # 2. Add Users into state
    users_by_id = st.setdefault("users_by_id", {})
    for uid, udata in DINGS_USERS.items():
        users_by_id[uid] = copy.deepcopy(udata)

    # 3. Add to SQLite Orgs and Users
    database.init_schema()
    with database.get_db() as conn:
        conn.execute("""
            INSERT INTO orgs (id, name, yard_name, plan, status, webhook_token, is_demo, custom_scoring, metric_weights_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                yard_name = excluded.yard_name,
                plan = excluded.plan,
                status = excluded.status,
                is_demo = excluded.is_demo
        """, (
            DINGS_ORG_ID,
            DINGS_ORG_NAME,
            DINGS_ORG_NAME,
            "enterprise",
            "active",
            "dings_tok",
            1,
            0,
            "{}",
            "2026-10-01T00:00:00Z"
        ))

        for uid, u in DINGS_USERS.items():
            conn.execute("""
                INSERT OR REPLACE INTO users (id, org_id, name, email, password_hash, role, title, disabled, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                uid,
                DINGS_ORG_ID,
                u["name"],
                u["email"],
                u["password_hash"],
                u["role"],
                u["title"],
                0,
                u["created_at"]
            ))

    # 4. Parse calls
    logger.info("Transforming sheet rows into Salvage Pulse call records...")
    db_calls_to_insert = []
    state_calls_to_insert = []
    state_full_calls = {}

    for row in raw_rows:
        interaction_id = (row.get("Interaction ID") or "").strip()
        cid = f"rc-{interaction_id}" if interaction_id else f"rc-{uuid.uuid4()}"
        interaction_url = (row.get("Interaction Url") or "").strip()
        interaction_name = (row.get("Interaction Name") or "").strip()

        host_name = (row.get("Host Name") or "").strip()
        host_key = host_name.lower()
        if host_key in HOST_MAP:
            rep_id, rep_name = HOST_MAP[host_key]
        else:
            rep_id = "user-dings-owner"
            rep_name = host_name or "Brandon Cocksucker"

        raw_ext = (row.get("External Participants") or "").strip()
        m = EXT_PATTERN.search(raw_ext)
        cust_name = m.group(1).strip() if m else ""
        cust_phone = m.group(2).strip() if m else ""

        # Clean customer name if it starts with queue prefixes like "2 - " or "3 - "
        clean_cust_name = re.sub(r'^(Wholesale\s*-\s*)?[0-9]\s*-\s*', '', cust_name)
        if not clean_cust_name or clean_cust_name.lower().startswith("wireless caller"):
            clean_cust_name = cust_phone or "Customer"

        # Direction
        dir_val = (row.get("Inbound/Outbound") or "").strip().lower()
        direction = "outbound" if dir_val == "outbound" else "inbound"

        # Duration
        try:
            duration_sec = int(round(float(row.get("Duration") or 0)))
        except Exception:
            duration_sec = 0

        # Timestamp
        raw_dt = (row.get("Date and Time") or "").strip()
        created_at = raw_dt if raw_dt else store.now_iso()
        month_bucket = created_at[:7]

        # Category mapping
        cat_raw = (row.get("Interaction Category") or "").strip()
        if "order" in cat_raw.lower():
            category = "Order/Sale"
            outcome = "won"
        elif "sales enquiry" in cat_raw.lower():
            category = "Part Inquiry/Quote"
            outcome = "pending"
        elif "support" in cat_raw.lower():
            category = "Warranty/Return"
            outcome = "n/a"
        elif "supplier" in cat_raw.lower() or "vendor" in cat_raw.lower():
            category = "Vendor/Scrap Seller"
            outcome = "n/a"
        elif "voicemail" in cat_raw.lower():
            category = "Other"
            outcome = "lost"
        else:
            category = "Part Inquiry/Quote"
            outcome = "pending"

        # Score (RingSense 0-10 -> Salvage Pulse 0-100)
        try:
            raw_score = int(row.get("Score") or 0)
            overall_score = raw_score * 10
        except Exception:
            overall_score = 70

        # Topics & Trackers
        topics_str = (row.get("Topics") or "").strip()
        topics_list = [t.strip() for t in topics_str.split(";") if t.strip()] if topics_str else []

        trackers_str = (row.get("Trackers") or "").strip()
        trackers_list = [tr.strip() for tr in trackers_str.split(";") if tr.strip()] if trackers_str else []

        warranty_pitched = 1 if any("warranty" in tr.lower() for tr in trackers_list) else 0

        # Part requested & Summary from topics
        part_requested = topics_list[0] if topics_list else ""
        summary = f"{interaction_name}. Topics discussed: {', '.join(topics_list)}." if topics_list else interaction_name

        turns = [
            {"speaker": "Rep", "text": f"Ding's Auto Parts, this is {rep_name}. How can I help you?"},
            {"speaker": "Customer", "text": f"Calling regarding {part_requested or 'vehicle parts'}."},
        ]

        metrics = {
            "greeting": 80,
            "needs_discovery": overall_score,
            "product_knowledge": overall_score,
            "upsell_crosssell": 80 if warranty_pitched else 40,
            "objection_handling": 75,
            "closing": 85 if outcome == "won" else 65,
            "courtesy": 90,
        }

        # Build DB row tuple
        db_calls_to_insert.append((
            cid,
            DINGS_ORG_ID,
            rep_id,
            rep_name,
            clean_cust_name,
            clean_cust_name,
            cust_phone,
            direction,
            duration_sec,
            "analyzed",
            "ringcentral",
            interaction_id,
            interaction_url,
            category,
            outcome,
            overall_score,
            0.0,  # order_value
            0.0,  # quoted_value
            warranty_pitched,
            summary,
            f"Rep ({rep_name}): RingCentral call with {clean_cust_name}. [Transcript available on RingCentral player: {interaction_url}]",
            json.dumps(turns),
            json.dumps(metrics),
            json.dumps(topics_list),
            json.dumps(trackers_list),
            part_requested,
            month_bucket,
            created_at,
        ))

        # Build state call summary
        state_call = {
            "id": cid,
            "org_id": DINGS_ORG_ID,
            "rep_id": rep_id,
            "rep_name": rep_name,
            "customer_name": clean_cust_name,
            "customer_phone": cust_phone,
            "direction": direction,
            "duration_sec": duration_sec,
            "status": "analyzed",
            "source": "ringcentral",
            "category": category,
            "outcome": outcome,
            "overall_score": overall_score,
            "order_value": 0.0,
            "quoted_value": 0.0,
            "warranty_pitched": warranty_pitched,
            "summary": summary,
            "part_requested": part_requested,
            "external_id": interaction_id,
            "external_url": interaction_url,
            "topics": topics_list,
            "trackers": trackers_list,
            "created_at": created_at,
        }
        state_calls_to_insert.append(state_call)

        state_full_calls[cid] = {
            "id": cid,
            "org_id": DINGS_ORG_ID,
            "rep_id": rep_id,
            "rep_name": rep_name,
            "customer_name": clean_cust_name,
            "customer_phone": cust_phone,
            "direction": direction,
            "duration_sec": duration_sec,
            "status": "analyzed",
            "category": category,
            "outcome": outcome,
            "overall_score": overall_score,
            "order_value": 0.0,
            "quoted_value": 0.0,
            "warranty_pitched": warranty_pitched,
            "summary": summary,
            "transcript": f"Rep ({rep_name}): RingCentral call with {clean_cust_name}. [Transcript available on RingCentral player: {interaction_url}]",
            "turns": turns,
            "metrics": metrics,
            "external_id": interaction_id,
            "external_url": interaction_url,
            "created_at": created_at,
        }

    # 5. Insert into SQLite in batches
    logger.info(f"Writing {len(db_calls_to_insert)} calls into salvage_pulse.db...")
    with database.get_db() as conn:
        # Clear existing calls for dings if re-running
        conn.execute("DELETE FROM calls WHERE org_id = ?", (DINGS_ORG_ID,))
        conn.executemany("""
            INSERT INTO calls (
                id, org_id, rep_id, rep_name, customer_key, customer_name, customer_phone,
                direction, duration_sec, status, source, external_id, external_url,
                category, outcome, overall_score, order_value, quoted_value, warranty_pitched,
                summary, transcript, turns_json, metrics_json, topics_json, trackers_json,
                part_requested, month_bucket, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, db_calls_to_insert)

    # 6. Update in-memory state
    logger.info("Merging calls into store state...")
    existing_calls = [c for c in st.get("calls", []) if c.get("org_id") != DINGS_ORG_ID]
    st["calls"] = existing_calls + state_calls_to_insert

    full_calls = st.setdefault("full_calls", {})
    # Remove old dings calls from full_calls
    for k in list(full_calls.keys()):
        if k.startswith("rc-"):
            del full_calls[k]
    full_calls.update(state_full_calls)

    store.save_state()
    logger.info("Import completed successfully! State and DB are in sync.")


if __name__ == "__main__":
    run_import()
