"""Sync store state to SQL database (salvage_pulse.db) and provide SQL-backed storage."""
import json
import logging
import sqlite3
import os
import store
import database

logger = logging.getLogger("salvage_pulse.db_sync")

def sync_store_to_sql():
    database.init_schema()
    st = store.get_state()
    
    with database.get_db() as conn:
        # Sync Orgs
        org = st.get("org", {})
        org_id = org.get("id") or store.KEECH_ORG_ID
        org_cs = 1 if (org.get("custom_scoring") or (st.get("admin_orgs") and any(ao.get("id") == org_id and ao.get("custom_scoring") for ao in st.get("admin_orgs", [])))) else 0
        org_weights = json.dumps(org.get("metric_weights") or next((ao.get("metric_weights") for ao in st.get("admin_orgs", []) if ao.get("id") == org_id and ao.get("metric_weights")), {}))
        conn.execute("""
            INSERT INTO orgs (id, name, yard_name, plan, status, webhook_token, custom_scoring, metric_weights_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                yard_name = excluded.yard_name,
                plan = excluded.plan,
                status = excluded.status,
                webhook_token = excluded.webhook_token,
                custom_scoring = CASE WHEN excluded.custom_scoring = 1 THEN 1 ELSE orgs.custom_scoring END,
                metric_weights_json = CASE WHEN excluded.custom_scoring = 1 THEN excluded.metric_weights_json ELSE orgs.metric_weights_json END
        """, (
            org_id,
            org.get("name") or "Keech's Auto Salvage",
            org.get("yard_name") or "Keech's Auto Salvage",
            org.get("plan") or "pro",
            org.get("status") or "trialing",
            org.get("webhook_token") or "default_token",
            org_cs,
            org_weights,
            store.now_iso(),
        ))

        # Admin orgs
        for ao in st.get("admin_orgs", []):
            ao_cs = 1 if ao.get("custom_scoring") else 0
            ao_weights = json.dumps(ao.get("metric_weights") or {})
            conn.execute("""
                INSERT INTO orgs (id, name, yard_name, plan, status, webhook_token, is_demo, custom_scoring, metric_weights_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    yard_name = excluded.yard_name,
                    plan = excluded.plan,
                    status = excluded.status,
                    webhook_token = excluded.webhook_token,
                    is_demo = excluded.is_demo,
                    custom_scoring = CASE WHEN excluded.custom_scoring = 1 THEN 1 ELSE orgs.custom_scoring END,
                    metric_weights_json = CASE WHEN excluded.custom_scoring = 1 THEN excluded.metric_weights_json ELSE orgs.metric_weights_json END
            """, (
                ao.get("id"),
                ao.get("name") or "Yard",
                ao.get("yard_name") or ao.get("name") or "Yard",
                ao.get("plan") or "pro",
                ao.get("status") or "active",
                "admin_tok",
                1 if ao.get("is_demo") else 0,
                ao_cs,
                ao_weights,
                ao.get("created_at") or store.now_iso(),
            ))

        # Sync Users
        users = st.get("users_by_id", {})
        for uid, u in users.items():
            conn.execute("""
                INSERT OR REPLACE INTO users (id, org_id, name, email, password_hash, role, title, disabled, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                uid,
                u.get("org_id") or org_id,
                u.get("name") or "",
                u.get("email") or "",
                u.get("password_hash") or "",
                u.get("role") or "rep",
                u.get("title") or "Sales Rep",
                1 if u.get("disabled") else 0,
                u.get("created_at") or store.now_iso(),
            ))

        # Sync Calls
        calls = st.get("calls", [])
        full_calls = st.get("full_calls", {})
        for c in calls:
            cid = c.get("id")
            full = full_calls.get(cid, {})
            created_at = c.get("created_at") or store.now_iso()
            conn.execute("""
                INSERT OR REPLACE INTO calls (
                    id, org_id, rep_id, rep_name, customer_key, customer_name, customer_phone,
                    direction, duration_sec, status, source, category, outcome, overall_score,
                    order_value, quoted_value, summary, transcript, turns_json, metrics_json,
                    vehicle_year, vehicle_make, vehicle_model, part_requested, month_bucket, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                cid,
                c.get("org_id") or org_id,
                c.get("rep_id") or "",
                c.get("rep_name") or "",
                c.get("customer_name") or "",
                c.get("customer_name") or "",
                c.get("customer_phone") or "",
                c.get("direction") or "inbound",
                int(c.get("duration_sec") or 0),
                c.get("status") or "analyzed",
                c.get("source") or "transcript",
                c.get("category") or "Part Inquiry/Quote",
                c.get("outcome") or "pending",
                int(c.get("overall_score") or 0),
                float(c.get("order_value") or 0.0),
                float(c.get("quoted_value") or 0.0),
                c.get("summary") or "",
                full.get("transcript") or "",
                json.dumps(full.get("turns") or []),
                json.dumps(full.get("metrics") or {}),
                c.get("vehicle_year"),
                c.get("vehicle_make") or "",
                c.get("vehicle_model") or "",
                c.get("part_requested") or "",
                created_at[:7],
                created_at,
            ))

        # Sync Arrivals
        arrivals = st.get("arrivals", [])
        for a in arrivals:
            aid = a.get("id")
            if not aid:
                continue
            conn.execute("""
                INSERT OR REPLACE INTO arrivals (
                    id, org_id, vehicle_year, vehicle_make, vehicle_model, year_span,
                    note, stock_number, cost, inventory_status, checked_in_at, checked_in_by,
                    queued_for_crush_at, days_until_crushed, crush_deadline, created_by,
                    blasts_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                aid,
                a.get("org_id") or org_id,
                int(a.get("vehicle_year") or 2018),
                a.get("vehicle_make") or "",
                a.get("vehicle_model") or "",
                int(a.get("year_span") or 2),
                a.get("note") or "",
                a.get("stock_number") or "",
                a.get("cost"),
                a.get("inventory_status") or "newly_arrived",
                a.get("checked_in_at"),
                a.get("checked_in_by"),
                a.get("queued_for_crush_at"),
                a.get("days_until_crushed"),
                a.get("crush_deadline"),
                a.get("created_by") or "Manager",
                json.dumps(a.get("blasts") or []),
                a.get("created_at") or store.now_iso(),
            ))

        org_cnt = conn.execute("SELECT count(*) FROM orgs").fetchone()[0]
        user_cnt = conn.execute("SELECT count(*) FROM users").fetchone()[0]
        call_cnt = conn.execute("SELECT count(*) FROM calls").fetchone()[0]
        arr_cnt = conn.execute("SELECT count(*) FROM arrivals").fetchone()[0]
        print(f"SQL Database synced: {org_cnt} orgs, {user_cnt} users, {call_cnt} calls, {arr_cnt} arrivals.")

if __name__ == "__main__":
    sync_store_to_sql()
