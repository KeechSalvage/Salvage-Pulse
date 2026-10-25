import json
import uuid
from datetime import datetime, timedelta, timezone
from database import (
    compute_weighted_overall_score,
    get_db,
    hash_password,
    infer_customer_tag,
    infer_vehicle_body,
    make_customer_key,
    normalize_phone,
)


def iso_days_ago(days: float, hours: float = 0) -> str:
    dt = datetime.now(timezone.utc) - timedelta(days=days, hours=hours)
    return dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def ensure_demo_yard():
    """Self-healing seeder: ensures platform admin, demo yard, reps, calls, arrivals, keywords, watchlist, and roleplay scenarios exist."""
    with get_db() as conn:
        # 1. Platform Master Admin
        master = conn.execute("SELECT id FROM users WHERE email = ?", ("admin@salvagepulse.com",)).fetchone()
        if not master:
            conn.execute(
                """
                INSERT INTO users (id, org_id, name, email, password_hash, role, title, created_at)
                VALUES (?, NULL, ?, ?, ?, 'master', 'Platform Founder', ?)
                """,
                ("usr_master", "Brandon Keech", "admin@salvagepulse.com", hash_password("admin1234"), iso_days_ago(120)),
            )

        # Platform settings
        conn.execute(
            "INSERT OR IGNORE INTO platform_settings (key, value) VALUES ('trial_reminders_enabled', 'true')"
        )

        # Check if demo org and its calls exist
        demo_org = conn.execute("SELECT id FROM orgs WHERE id = 'org_demo'").fetchone()
        demo_calls_count = conn.execute("SELECT COUNT(*) AS c FROM calls WHERE org_id = 'org_demo'").fetchone()["c"]
        if demo_org and demo_calls_count >= 15:
            return

        now_iso = iso_days_ago(0)
        if not demo_org:
            conn.execute(
                """
                INSERT INTO orgs (
                    id, name, yard_name, avg_order_value, plan, status, billing_interval,
                    card_on_file, no_card_trial, email_verified, trial_started_at, trial_ends_at,
                    limited_starts_at, card_added_at, preview_ends_at, preview_used,
                    show_enterprise_tour, extra_rep_packs, blocked, accent, default_mode,
                    digest_email, digest_enabled, watchlist_email, watchlist_email_enabled,
                    watchlist_last_sent_at, rc_connected, rc_connected_by, rc_last_sync_at,
                    rc_last_result, webhook_token, sample_data, is_demo, created_at
                ) VALUES (
                    'org_demo', 'Northside Auto Recyclers', 'Northside Auto Recyclers', 365.0,
                    'enterprise', 'active', 'month', 1, 0, 1, ?, ?, ?, ?, NULL, 0,
                    0, 1, 0, '', 'dark', 'rich@northsideauto.com', 1, 'rich@northsideauto.com', 1,
                    ?, 1, 'Rich Vance', ?, '38 calls synced · 0 errors', 'whk_northside_demo_99281a',
                    1, 1, ?
                )
                """,
                (
                    iso_days_ago(110),
                    iso_days_ago(-30),
                    iso_days_ago(105),
                    iso_days_ago(108),
                    iso_days_ago(3),
                    iso_days_ago(0, 1),
                    iso_days_ago(110),
                ),
            )

        # Also seed a couple of trial/customer yards for the Admin Console (/admin)
        for oid, oname, oplan, ostatus, card, days_ago, net in [
            ("org_apex", "Apex Auto Parts & Salvage", "pro", "trialing", 1, 3, "198.51.100.0/24"),
            ("org_midwest", "Midwest Truck Recyclers", "Pro", "active", 1, 42, "203.0.113.0/24"),
            ("org_sunbelt", "Sunbelt Pull-A-Part", "pro", "trialing", 0, 0.4, "192.0.2.0/24"),
        ]:
            if not conn.execute("SELECT id FROM orgs WHERE id = ?", (oid,)).fetchone():
                t_start = iso_days_ago(days_ago)
                t_end = iso_days_ago(days_ago - 7 if card else days_ago - 1)
                lim_start = iso_days_ago(days_ago - 4)
                conn.execute(
                    """
                    INSERT INTO orgs (
                        id, name, yard_name, plan, status, card_on_file, no_card_trial,
                        email_verified, trial_started_at, trial_ends_at, limited_starts_at,
                        card_added_at, webhook_token, sample_data, signup_network, is_demo, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 0, ?, 0, ?)
                    """,
                    (
                        oid,
                        oname,
                        oname,
                        oplan.lower(),
                        ostatus,
                        card,
                        0 if card else 1,
                        t_start,
                        t_end,
                        lim_start,
                        iso_days_ago(days_ago - 0.3) if card else None,
                        f"whk_{oid}_token",
                        net,
                        t_start,
                    ),
                )

        # 2. Demo Users (Manager + 4 Reps)
        users_seed = [
            ("usr_mgr", "org_demo", "Rich Vance", "manager@northsideauto.com", "manager", "General Manager"),
            ("usr_rep1", "org_demo", "Chris Miller", "rep@northsideauto.com", "rep", "Senior Counter Sales"),
            ("usr_rep2", "org_demo", "Tyler Brooks", "tyler@northsideauto.com", "rep", "Commercial & Body Shop Desk"),
            ("usr_rep3", "org_demo", "Maria Santos", "maria@northsideauto.com", "rep", "Wholesale & Mechanical Desk"),
            ("usr_rep4", "org_demo", "Jake Kowalski", "jake@northsideauto.com", "rep", "Inbound Sales Rep"),
            ("usr_apex_mgr", "org_apex", "Dan Mercer", "dan@apexsalvage.com", "manager", "Owner / Manager"),
        ]
        for uid, oid, uname, uemail, urole, utitle in users_seed:
            conn.execute(
                """
                INSERT OR REPLACE INTO users (id, org_id, name, email, password_hash, role, title, disabled, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
                """,
                (uid, oid, uname, uemail, hash_password("demo1234"), urole, utitle, iso_days_ago(100)),
            )

        # Clear partial demo calls if re-seeding
        conn.execute("DELETE FROM calls WHERE org_id = 'org_demo'")
        conn.execute("DELETE FROM customers WHERE org_id = 'org_demo'")
        conn.execute("DELETE FROM winback_marks WHERE org_id = 'org_demo'")
        conn.execute("DELETE FROM arrivals WHERE org_id = 'org_demo'")
        conn.execute("DELETE FROM arrival_callers WHERE org_id = 'org_demo'")

        # 3. Customers & Calls across 4 months
        accounts = [
            ("Ridgeline Collision", "(860) 555-0142", "body_shop", "manual"),
            ("Tony's Auto Repair", "(860) 555-0188", "mechanic", "manual"),
            ("Metro Fleet Services", "(860) 555-0195", "fleet", "manual"),
            ("Harbor Body & Paint", "(860) 555-0211", "body_shop", "manual"),
            ("Valley Imports Garage", "(860) 555-0244", "mechanic", "auto"),
            ("Tri-County Plumbing Fleet", "(860) 555-0277", "fleet", "auto"),
            ("Eastside Collision Center", "(860) 555-0309", "body_shop", "manual"),
            ("Summit Automotive", "(860) 555-0331", "mechanic", "auto"),
            ("Mike Henderson", "(860) 555-0389", "retail", "auto"),
            ("Oakwood Tire & Service", "(860) 555-0412", "mechanic", "auto"),
            ("Precision Fender & Body", "(860) 555-0455", "body_shop", "manual"),
            ("dave's transmission shop", "(860) 555-0490", "mechanic", "auto"),
        ]

        for cname, cphone, ctag, csrc in accounts:
            ckey = make_customer_key(cname, cphone)
            conn.execute(
                """
                INSERT OR REPLACE INTO customers (org_id, customer_key, name, phone, tag, tag_source, updated_at)
                VALUES ('org_demo', ?, ?, ?, ?, ?, ?)
                """,
                (ckey, cname.title() if cname.islower() else cname, cphone, ctag, csrc, now_iso),
            )

        # Add customer notes
        rk_key = make_customer_key("Ridgeline Collision", "(860) 555-0142")
        conn.execute(
            """
            INSERT OR REPLACE INTO customer_notes (id, org_id, customer_key, author, text, created_at)
            VALUES ('note_1', 'org_demo', ?, 'Rich Vance', 'Prefers Grade A sheet metal with photos texted to shop foreman before loading on the Tuesday/Thursday truck.', ?)
            """,
            (rk_key, iso_days_ago(12)),
        )

        # Helper to insert a call
        def add_call(
            cid: str,
            rep_id: str,
            rep_name: str,
            cname: str,
            cphone: str,
            days_ago: float,
            hour_offset: int,
            direction: str,
            duration_sec: int,
            category: str,
            outcome: str,
            metrics: dict,
            order_val: float,
            quoted_val: float,
            warranty: int,
            vyear: int,
            vmake: str,
            vmodel: str,
            part: str,
            loss_reason: str = "",
            transcript: str = "",
            source: str = "ringcentral",
            callback_done: int = 0,
            callback_by: str = "",
        ):
            dt = datetime.now(timezone.utc) - timedelta(days=days_ago)
            dt = dt.replace(hour=max(8, min(17, hour_offset)), minute=15, second=0, microsecond=0)
            created_at = dt.isoformat().replace("+00:00", "Z")
            month_bucket = created_at[:7]
            ckey = make_customer_key(cname, cphone)
            pnorm = normalize_phone(cphone)
            score = compute_weighted_overall_score(metrics) if metrics else 0
            vbody = infer_vehicle_body(vmake, vmodel) if vmake else ""

            if not transcript and duration_sec >= 30:
                veh_label = f"{vyear or ''} {vmake} {vmodel}".strip() or "vehicle"
                part_label = part or "assembly"
                transcript = (
                    f"Rep: Thanks for calling Northside Auto Recyclers, this is {rep_name.split()[0]}.\n"
                    f"Customer: Hey {rep_name.split()[0]}, this is {cname}. I'm looking for a {part_label.lower()} for a {veh_label}.\n"
                    f"Rep: Let me check our Hollander interchange for that {veh_label}. Do you have the VIN or trim handy?\n"
                    f"Customer: Yeah, it's the standard trim. What condition is yours in and what's the price?\n"
                    f"Rep: We have a clean OEM Grade A {part_label.lower()} off a low-mile donor for ${int(quoted_val or 350)}"
                    + (" with our 90-day warranty and extended coverage available.\n" if warranty else ".\n")
                    + (
                        "Customer: Sounds good, put it on our shop account and send it on the afternoon delivery truck.\nRep: You got it, I'll pull it now and have it on the truck today."
                        if outcome == "won"
                        else "Customer: Let me check with the customer on the price and call you back.\nRep: Sounds good, let me know if you want me to hold it."
                    )
                )

            turns = []
            for ln in (transcript or "").splitlines():
                if ":" in ln:
                    sp, tx = ln.split(":", 1)
                    turns.append({"speaker": sp.strip(), "text": tx.strip()})

            topics = [x for x in [part, f"{vmake} {vmodel}".strip() if vmake else "", "90-Day Warranty" if warranty else "", "Hollander Interchange" if score >= 80 else ""] if x]
            trackers = [x for x in ["Warranty Pitched" if warranty else "", "VIN Checked" if score >= 75 else "", "OEM Value" if score >= 82 else ""] if x]

            strengths = ["Identified Northside Auto Recyclers clearly", "Checked Hollander interchange and donor mileage"] if score >= 70 else ["Answered promptly"]
            improvements = (
                ["Keep offering companion parts on body shop orders"]
                if score >= 80
                else ["Always state the 90-day warranty before quoting price", "Ask a direct closing question to lock in the order"]
            )
            insights = [f"Caller: {cname}", f"Requested: {vyear or ''} {vmake} {vmodel} {part}".strip()]
            summary = (
                f"{cname} called regarding a {part.lower() or 'part'} for a {vyear or ''} {vmake} {vmodel}. "
                + (f"Order closed at ${int(order_val)}." if outcome == "won" else "Missed call / voicemail." if duration_sec < 30 else f"Quoted ${int(quoted_val)}; outcome {outcome}.")
            ).strip()
            coaching = (
                "Great call execution — verified fitment, highlighted OEM grade and 90-day warranty, and secured the order."
                if score >= 80
                else "Make sure to anchor the OEM part's condition and 90-day warranty before giving the price, and ask to hold the part for the caller."
            )

            conn.execute(
                """
                INSERT INTO calls (
                    id, org_id, rep_id, rep_name, customer_key, customer_name, customer_phone, phone_norm,
                    direction, duration_sec, status, source, source_category, external_id, external_url,
                    category, outcome, overall_score, order_value, quoted_value, warranty_pitched,
                    loss_reason, summary, transcript, turns_json, metrics_json, coaching_feedback,
                    strengths_json, improvements_json, insights_json, topics_json, trackers_json,
                    vehicle_year, vehicle_make, vehicle_model, vehicle_body, part_requested,
                    callback_done, callback_by, is_sample, month_bucket, created_at
                ) VALUES (
                    ?, 'org_demo', ?, ?, ?, ?, ?, ?,
                    ?, ?, 'analyzed', ?, 'Sales', ?, 'https://app.ringcentral.com',
                    ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?,
                    ?, ?, 1, ?, ?
                )
                """,
                (
                    cid,
                    rep_id,
                    rep_name,
                    ckey,
                    cname,
                    cphone,
                    pnorm,
                    direction,
                    duration_sec,
                    source,
                    f"rc_{cid}",
                    category,
                    outcome,
                    score,
                    order_val,
                    quoted_val,
                    warranty,
                    loss_reason,
                    summary,
                    transcript,
                    json.dumps(turns),
                    json.dumps(metrics),
                    coaching,
                    json.dumps(strengths),
                    json.dumps(improvements),
                    json.dumps(insights),
                    json.dumps(topics),
                    json.dumps(trackers),
                    vyear,
                    vmake,
                    vmodel,
                    vbody,
                    part,
                    callback_done,
                    callback_by or None,
                    month_bucket,
                    created_at,
                ),
            )

        high_m = {"greeting": 9, "needs_discovery": 9, "product_knowledge": 9, "upsell_crosssell": 8, "objection_handling": 9, "closing": 9, "courtesy": 9}
        good_m = {"greeting": 8, "needs_discovery": 8, "product_knowledge": 8, "upsell_crosssell": 7, "objection_handling": 8, "closing": 8, "courtesy": 8}
        mid_m = {"greeting": 7, "needs_discovery": 7, "product_knowledge": 7, "upsell_crosssell": 5, "objection_handling": 6, "closing": 6, "courtesy": 8}
        low_m = {"greeting": 6, "needs_discovery": 5, "product_knowledge": 6, "upsell_crosssell": 4, "objection_handling": 5, "closing": 4, "courtesy": 7}

        sample_calls = [
            # Current month (days_ago 0..20)
            ("call_01", "usr_rep1", "Chris Miller", "Ridgeline Collision", "(860) 555-0142", 0.3, 9, "inbound", 215, "Order/Sale", "won", high_m, 680, 680, 1, 2019, "Ford", "F-150", "Front Door", ""),
            ("call_02", "usr_rep2", "Tyler Brooks", "Tony's Auto Repair", "(860) 555-0188", 0.5, 10, "inbound", 190, "Order/Sale", "won", high_m, 540, 540, 1, 2018, "Chevrolet", "Silverado 1500", "Alternator", ""),
            ("call_03", "usr_rep1", "Chris Miller", "Harbor Body & Paint", "(860) 555-0211", 1.1, 11, "inbound", 165, "Part Inquiry/Quote", "pending", good_m, 0, 420, 1, 2020, "Honda", "Civic", "Headlight Assembly", "price"),
            ("call_04", "usr_rep3", "Maria Santos", "Metro Fleet Services", "(860) 555-0195", 1.4, 13, "inbound", 240, "Order/Sale", "won", high_m, 1150, 1150, 1, 2019, "Ford", "Transit 250", "Transmission", ""),
            ("call_05", "usr_rep4", "Jake Kowalski", "Mike Henderson", "(860) 555-0389", 1.8, 14, "inbound", 142, "Price Negotiation", "lost", low_m, 0, 290, 0, 2017, "Toyota", "Camry", "Alternator", "price"),
            ("call_06", "usr_rep2", "Tyler Brooks", "Ridgeline Collision", "(860) 555-0142", 2.2, 9, "inbound", 205, "Order/Sale", "won", good_m, 495, 495, 1, 2019, "Ford", "F-150", "Tailgate", ""),
            ("call_07", "usr_rep3", "Maria Santos", "Valley Imports Garage", "(860) 555-0244", 2.6, 15, "inbound", 178, "Part Inquiry/Quote", "lost", mid_m, 0, 850, 1, 2018, "Subaru", "Outback", "Engine Assembly", "out_of_stock"),
            ("call_08", "usr_rep4", "Jake Kowalski", "Summit Automotive", "(860) 555-0331", 3.1, 16, "inbound", 130, "Price Negotiation", "lost", low_m, 0, 310, 0, 2016, "Jeep", "Grand Cherokee", "Transfer Case", "price"),
            ("call_09", "usr_rep1", "Chris Miller", "Tony's Auto Repair", "(860) 555-0188", 4.0, 10, "outbound", 188, "Order/Sale", "won", high_m, 390, 390, 1, 2019, "Ford", "F-150", "Front Bumper", ""),
            ("call_10", "usr_rep2", "Tyler Brooks", "Harbor Body & Paint", "(860) 555-0211", 5.2, 11, "inbound", 210, "Order/Sale", "won", good_m, 620, 620, 1, 2021, "Toyota", "RAV4", "Front Door", ""),
            ("call_11", "usr_rep3", "Maria Santos", "Metro Fleet Services", "(860) 555-0195", 6.5, 14, "inbound", 195, "Order/Sale", "won", high_m, 780, 780, 1, 2018, "Chevrolet", "Silverado 1500", "Rear Axle", ""),
            ("call_12", "usr_rep1", "Chris Miller", "Oakwood Tire & Service", "(860) 555-0412", 7.3, 12, "inbound", 160, "Part Inquiry/Quote", "pending", good_m, 0, 275, 1, 2020, "Honda", "Civic", "Side Mirror", "price"),
            # Untagged connected calls for Quick Vehicle Tagging queue (/tag-vehicles)
            ("call_13", "usr_rep1", "Chris Miller", "Ridgeline Collision", "(860) 555-0142", 0.8, 15, "inbound", 154, "Part Inquiry/Quote", "pending", good_m, 0, 410, 1, None, "", "", "Front Door", ""),
            ("call_14", "usr_rep2", "Tyler Brooks", "Tony's Auto Repair", "(860) 555-0188", 1.6, 12, "inbound", 168, "Part Inquiry/Quote", "pending", mid_m, 0, 340, 1, None, "", "", "Alternator", ""),
            # Open missed-call callbacks (<30s inbound calls with no subsequent reconnect)
            ("call_15", "usr_rep1", "Chris Miller", "Precision Fender & Body", "(860) 555-0455", 0.2, 8, "inbound", 18, "Other", "n/a", {}, 0, 0, 0, None, "", "", "", ""),
            ("call_16", "usr_rep4", "Jake Kowalski", "Dave's Transmission Shop", "(860) 555-0490", 0.4, 16, "inbound", 22, "Other", "n/a", {}, 0, 0, 0, None, "", "", "", ""),
            # Resolved callback
            ("call_17", "usr_rep2", "Tyler Brooks", "Summit Automotive", "(860) 555-0331", 4.5, 9, "inbound", 15, "Other", "n/a", {}, 0, 0, 0, None, "", "", "", "", "", "ringcentral", 1, "Tyler Brooks"),
            # Prior month 1 (days_ago 28..50) — includes Win-back repeat buyers (35+ days quiet!)
            ("call_18", "usr_rep1", "Chris Miller", "Eastside Collision Center", "(860) 555-0309", 36, 10, "inbound", 230, "Order/Sale", "won", high_m, 640, 640, 1, 2019, "Ford", "F-150", "Front Door", ""),
            ("call_19", "usr_rep1", "Chris Miller", "Eastside Collision Center", "(860) 555-0309", 44, 14, "inbound", 205, "Order/Sale", "won", good_m, 510, 510, 1, 2018, "Honda", "CR-V", "Fender", ""),
            ("call_20", "usr_rep2", "Tyler Brooks", "Tri-County Plumbing Fleet", "(860) 555-0277", 38, 11, "inbound", 260, "Order/Sale", "won", high_m, 890, 890, 1, 2019, "Ford", "Transit 250", "Alternator", ""),
            ("call_21", "usr_rep2", "Tyler Brooks", "Tri-County Plumbing Fleet", "(860) 555-0277", 48, 15, "inbound", 215, "Order/Sale", "won", good_m, 720, 720, 1, 2018, "Chevrolet", "Express 2500", "AC Compressor", ""),
            ("call_22", "usr_rep3", "Maria Santos", "Ridgeline Collision", "(860) 555-0142", 32, 9, "inbound", 195, "Order/Sale", "won", good_m, 580, 580, 1, 2020, "Ford", "Explorer", "Hood", ""),
            ("call_23", "usr_rep4", "Jake Kowalski", "Valley Imports Garage", "(860) 555-0244", 35, 13, "inbound", 170, "Price Negotiation", "lost", mid_m, 0, 450, 0, 2017, "Honda", "Accord", "Transmission", "price"),
            ("call_24", "usr_rep2", "Tyler Brooks", "Tony's Auto Repair", "(860) 555-0188", 30, 10, "inbound", 200, "Order/Sale", "won", high_m, 430, 430, 1, 2017, "Chevrolet", "Silverado 1500", "Transfer Case", ""),
            # Prior month 2 (days_ago 60..80)
            ("call_25", "usr_rep1", "Chris Miller", "Ridgeline Collision", "(860) 555-0142", 62, 11, "inbound", 220, "Order/Sale", "won", high_m, 610, 610, 1, 2018, "Ford", "F-150", "Front Door", ""),
            ("call_26", "usr_rep2", "Tyler Brooks", "Harbor Body & Paint", "(860) 555-0211", 65, 14, "inbound", 185, "Order/Sale", "won", good_m, 470, 470, 1, 2019, "Toyota", "Camry", "Front Bumper", ""),
            ("call_27", "usr_rep3", "Maria Santos", "Metro Fleet Services", "(860) 555-0195", 68, 10, "inbound", 240, "Order/Sale", "won", good_m, 920, 920, 1, 2017, "Ram", "1500", "Transmission", ""),
            ("call_28", "usr_rep4", "Jake Kowalski", "Oakwood Tire & Service", "(860) 555-0412", 72, 15, "inbound", 150, "Part Inquiry/Quote", "lost", mid_m, 0, 320, 0, 2016, "Nissan", "Rogue", "Alternator", "price"),
            # Prior month 3 (days_ago 90..105)
            ("call_29", "usr_rep1", "Chris Miller", "Tony's Auto Repair", "(860) 555-0188", 92, 9, "inbound", 195, "Order/Sale", "won", good_m, 480, 480, 1, 2018, "Ford", "F-150", "Alternator", ""),
            ("call_30", "usr_rep2", "Tyler Brooks", "Ridgeline Collision", "(860) 555-0142", 95, 13, "inbound", 210, "Order/Sale", "won", good_m, 550, 550, 1, 2019, "Chevrolet", "Equinox", "Headlight Assembly", ""),
        ]

        for row in sample_calls:
            add_call(*row)

        # 4. Seed Win-Back Marks (confirmed by subsequent won calls within 30 days!)
        winback_seed = [
            ("wb_1", make_customer_key("Ridgeline Collision", "(860) 555-0142"), "Ridgeline Collision", "usr_rep1", "Chris Miller", "ordered", 5.0),
            ("wb_2", make_customer_key("Tony's Auto Repair", "(860) 555-0188"), "Tony's Auto Repair", "usr_rep2", "Tyler Brooks", "ordered", 6.0),
            ("wb_3", make_customer_key("Metro Fleet Services", "(860) 555-0195"), "Metro Fleet Services", "usr_rep3", "Maria Santos", "reached", 8.0),
            ("wb_4", make_customer_key("Harbor Body & Paint", "(860) 555-0211"), "Harbor Body & Paint", "usr_rep1", "Chris Miller", "ordered", 35.0),
            ("wb_5", make_customer_key("Ridgeline Collision", "(860) 555-0142"), "Ridgeline Collision", "usr_rep1", "Chris Miller", "ordered", 66.0),
        ]
        for wid, ckey, cname, rid, rname, outc, d_ago in winback_seed:
            c_at = iso_days_ago(d_ago)
            conn.execute(
                """
                INSERT INTO winback_marks (id, org_id, customer_key, customer_name, rep_id, rep_name, outcome, month_bucket, created_at)
                VALUES (?, 'org_demo', ?, ?, ?, ?, ?, ?, ?)
                """,
                (wid, ckey, cname, rid, rname, outc, c_at[:7], c_at),
            )

        # 5. Seed Keywords
        if conn.execute("SELECT COUNT(*) AS c FROM keywords WHERE org_id = 'org_demo'").fetchone()["c"] == 0:
            kw_seed = [
                ("kw_1", "Warranty / 90-Day / Guarantee", "Value Selling"),
                ("kw_2", "Hollander / Interchange / VIN", "Fitment"),
                ("kw_3", "OEM / Factory / Grade A", "Quality"),
                ("kw_4", "Price / Discount / Cheaper", "Objections"),
                ("kw_5", "LKQ / Aftermarket", "Competitor"),
                ("kw_6", "Truck / Delivery / Freight", "Logistics"),
            ]
            for kid, kw, grp in kw_seed:
                conn.execute(
                    "INSERT INTO keywords (id, org_id, keyword, group_name, created_at) VALUES (?, 'org_demo', ?, ?, ?)",
                    (kid, kw, grp, iso_days_ago(90)),
                )

        # 6. Seed Vehicle Arrivals & Callers
        arr_1_at = iso_days_ago(2.0)
        arr_2_at = iso_days_ago(5.0)
        conn.execute(
            """
            INSERT INTO arrivals (id, org_id, vehicle_year, vehicle_make, vehicle_model, year_span, note, created_by, blasts_json, created_at)
            VALUES
              ('arr_1', 'org_demo', 2019, 'Ford', 'F-150', 2, 'Stock #N-4412 · Lariat 5.0L 4WD · clean doors, tailgate & front clip', 'Rich Vance', ?, ?),
              ('arr_2', 'org_demo', 2020, 'Honda', 'Civic', 2, 'Stock #N-4408 · Sport 2.0L · LED headlights & passenger side doors intact', 'Rich Vance', '[]', ?)
            """,
            (
                json.dumps([{"mode": "practice", "count": 2, "failed": 0, "at": iso_days_ago(1.5), "by": "Rich Vance"}]),
                arr_1_at,
                arr_2_at,
            ),
        )

        arr_callers = [
            ("ac_1", "arr_1", make_customer_key("Ridgeline Collision", "(860) 555-0142"), "Ridgeline Collision", "(860) 555-0142", "usr_rep1", "Chris Miller", "2019 Ford F-150", 1, ["Front Door", "Tailgate"], iso_days_ago(0.3), 3, "call_01", "sold", iso_days_ago(1.2), "usr_rep1", iso_days_ago(1.5), "Hi Ridgeline, it's Northside. The 2019 Ford F-150 you asked about just came in!", "delivered", "SM101", iso_days_ago(1.3), "Yes! Hold the driver door and tailgate for us."),
            ("ac_2", "arr_1", make_customer_key("Tony's Auto Repair", "(860) 555-0188"), "Tony's Auto Repair", "(860) 555-0188", "usr_rep1", "Chris Miller", "2019 Ford F-150", 1, ["Front Bumper", "Alternator"], iso_days_ago(4.0), 2, "call_09", "to_call", None, None, iso_days_ago(1.5), "Hi Tony, it's Northside. The 2019 Ford F-150 you asked about just came in!", None, None, None, None),
            ("ac_3", "arr_1", make_customer_key("Eastside Collision Center", "(860) 555-0309"), "Eastside Collision Center", "(860) 555-0309", "usr_rep2", "Tyler Brooks", "2018 Ford F-150", 0, ["Front Door"], iso_days_ago(36.0), 1, "call_18", "called", iso_days_ago(1.0), "usr_rep2", None, None, None, None, None, None),
            ("ac_4", "arr_2", make_customer_key("Harbor Body & Paint", "(860) 555-0211"), "Harbor Body & Paint", "(860) 555-0211", "usr_rep1", "Chris Miller", "2020 Honda Civic", 1, ["Headlight Assembly"], iso_days_ago(1.1), 1, "call_03", "to_call", None, None, None, None, None, None, None, None),
            ("ac_5", "arr_2", make_customer_key("Oakwood Tire & Service", "(860) 555-0412"), "Oakwood Tire & Service", "(860) 555-0412", "usr_rep1", "Chris Miller", "2020 Honda Civic", 1, ["Side Mirror"], iso_days_ago(7.3), 1, "call_12", "sold", iso_days_ago(3.8), "usr_rep2", None, None, None, None, None, None),
        ]
        for row in arr_callers:
            conn.execute(
                """
                INSERT INTO arrival_callers (
                    id, arrival_id, org_id, customer_key, customer_name, customer_phone,
                    rep_id, rep_name, vehicle, exact_year, parts_json, last_asked, times_asked,
                    last_call_id, status, status_updated_at, status_by_id, texted_at, text_body,
                    sms_status, sms_sid, replied_at, sms_reply
                ) VALUES (?, ?, 'org_demo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8],
                    json.dumps(row[9]), row[10], row[11], row[12], row[13], row[14], row[15],
                    row[16], row[17], row[18], row[19], row[20], row[21],
                ),
            )

        # 7. Seed Watchlist
        if conn.execute("SELECT COUNT(*) AS c FROM watchlist WHERE org_id = 'org_demo'").fetchone()["c"] == 0:
            conn.execute(
                """
                INSERT INTO watchlist (id, org_id, make, model, year_from, year_to, part, created_at)
                VALUES
                  ('wl_1', 'org_demo', 'Ford', 'F-150', 2017, 2021, 'Front Door', ?),
                  ('wl_2', 'org_demo', 'Chevrolet', 'Silverado 1500', 2016, 2020, '', ?),
                  ('wl_3', 'org_demo', 'Honda', 'Civic', 2018, 2022, 'Headlight Assembly', ?)
                """,
                (iso_days_ago(30), iso_days_ago(25), iso_days_ago(20)),
            )

        # 8. Seed Role-Play Scenarios, Assignments & Sessions
        if conn.execute("SELECT COUNT(*) AS c FROM roleplay_scenarios").fetchone()["c"] == 0:
            scenarios = [
                (
                    "sc_1",
                    None,
                    "Aftermarket Price Pushback (LED Headlight)",
                    "Medium",
                    "Tony, owner of Tony's Auto Repair",
                    "Defend the $245 OEM LED headlight price against a $150 aftermarket quote, highlight fitment/seal quality and the 90-day warranty, and close the pickup order.",
                    "Start by greeting Tony and confirming the 2020 Honda Civic trim/VIN.",
                    "You need a driver-side LED headlight for a 2020 Honda Civic. You saw a cheap $150 aftermarket unit online. Push back on price first, then buy if the rep explains OEM fitment/ballast inclusion and includes a 90-day warranty.",
                    1,
                    0,
                ),
                (
                    "sc_2",
                    None,
                    "Body Shop Door Assembly & Companion Upsell",
                    "Easy",
                    "Carla, estimator at Ridgeline Collision",
                    "Quote a Grade A 2019 F-150 front door, proactively offer the matching side mirror and fender at a bundle price, and schedule Tuesday truck delivery.",
                    "Ask Carla for the paint code and whether she also needs the mirror or hinges.",
                    "You are writing a supplement on a 2019 Ford F-150 crew cab (paint code YZ Oxford White). You called for a front driver door, but you also need the power tow mirror if the rep asks.",
                    0,
                    0,
                ),
                (
                    "sc_3",
                    None,
                    "High-Mileage Transmission Hesitation",
                    "Hard",
                    "Marcus, service manager at Metro Fleet Services",
                    "Overcome mileage concerns on a 92k-mile 2019 Ford Transit transmission by citing donor testing, fluid inspection, and extended labor warranty.",
                    "Acknowledge the mileage concern directly and offer the 1-year parts & labor warranty.",
                    "You manage 40 plumbing vans and have one down on a lift. You're nervous about installing a used transmission with 92,000 miles unless it was run-tested and has labor coverage.",
                    1,
                    0,
                ),
            ]
            for s in scenarios:
                conn.execute(
                    """
                    INSERT INTO roleplay_scenarios (
                        id, org_id, title, difficulty, persona, objective, opening_hint,
                        customer_brief, price_objection, custom, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (*s, iso_days_ago(60)),
                )

            # Assignments
            today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            past_str = (datetime.now(timezone.utc) - timedelta(days=2)).strftime("%Y-%m-%d")
            future_str = (datetime.now(timezone.utc) + timedelta(days=4)).strftime("%Y-%m-%d")
            conn.execute(
                """
                INSERT INTO roleplay_assignments (id, org_id, scenario_id, rep_id, due_date, pass_score, created_at)
                VALUES
                  ('rpa_1', 'org_demo', 'sc_1', 'usr_rep1', ?, 75, ?),
                  ('rpa_2', 'org_demo', 'sc_3', 'usr_rep4', ?, 70, ?),
                  ('rpa_3', 'org_demo', 'sc_2', 'usr_rep2', ?, 75, ?)
                """,
                (future_str, iso_days_ago(5), past_str, iso_days_ago(7), today_str, iso_days_ago(3)),
            )

            # Graded session for Chris Miller
            sess_msgs = [
                {"role": "customer", "text": "Hey, I need a driver side LED headlight for a 2020 Honda Civic, what are you getting for one?"},
                {"role": "rep", "text": "Thanks for calling Northside Auto Recyclers, this is Chris! I have a clean OEM factory LED headlight assembly with the ballast intact for $245, backed by our 90-day warranty. Do you have the VIN handy to confirm trim?"},
                {"role": "customer", "text": "Wait, aftermarket is $150 online. Why is yours $245?"},
                {"role": "rep", "text": "Great question, Tony. Aftermarket LED headlights on the 2020 Civic often flicker or fog up at the seal, and don't include the OEM Mitsubishi ballast. Ours is factory Honda, plugs right in with zero dash lights, and includes our 90-day warranty. Want me to put your name on it for the afternoon truck?"},
                {"role": "customer", "text": "Fair point, aftermarket burned me last month. Put it on my account and send it over."},
            ]
            sess_grade = {
                "overall_score": 90,
                "summary": "Handled the aftermarket price objection smoothly and closed the sale.",
                "metrics": high_m,
                "coaching_feedback": "Textbook OEM value defense — contrasted factory ballast and seal reliability against cheap aftermarket units and asked directly for the order.",
                "strengths": ["Strong yard greeting", "Defended OEM price with specific technical facts", "Closed with delivery logistics"],
                "improvements": ["Offer the matching front bumper brackets or clips as a quick cross-sell"],
            }
            conn.execute(
                """
                INSERT INTO roleplay_sessions (
                    id, org_id, scenario_id, scenario_title, user_id, user_name,
                    status, messages_json, grade_json, created_at
                ) VALUES ('rps_1', 'org_demo', 'sc_1', 'Aftermarket Price Pushback (LED Headlight)', 'usr_rep1', 'Chris Miller', 'graded', ?, ?, ?)
                """,
                (json.dumps(sess_msgs), json.dumps(sess_grade), iso_days_ago(2)),
            )

        # 9. Audit log entries
        if conn.execute("SELECT COUNT(*) AS c FROM audit_logs").fetchone()["c"] == 0:
            conn.execute(
                """
                INSERT INTO audit_logs (id, actor, action, target, at)
                VALUES
                  ('aud_1', 'Brandon Keech', 'Created organization', 'Northside Auto Recyclers (Enterprise)', ?),
                  ('aud_2', 'Brandon Keech', 'Extended trial +3 days', 'Apex Auto Parts & Salvage', ?)
                """,
                (iso_days_ago(30), iso_days_ago(1)),
            )
