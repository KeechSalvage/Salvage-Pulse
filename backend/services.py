import json
import re
import sqlite3
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple
from database import (
    CATEGORIES,
    COMMON_PARTS,
    METRICS,
    PLANS,
    VEHICLE_CATALOG,
    infer_customer_tag,
    infer_vehicle_body,
    make_customer_key,
    normalize_phone,
)


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso_now() -> str:
    return now_utc().replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_iso(ts: Optional[str]) -> Optional[datetime]:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        return None


def compute_keyword_hits_for_text(text: str, keywords: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    hits = []
    if not text:
        return hits
    for kw in keywords:
        words = [w.strip() for w in kw["keyword"].split("/") if w.strip()]
        if not words:
            continue
        pattern = r"\b(?:" + "|".join(re.escape(w) for w in words) + r")\b"
        matches = re.findall(pattern, text, flags=re.I)
        if matches:
            hits.append({"keyword_id": kw["id"], "keyword": kw["keyword"], "count": len(matches)})
    return hits


def format_call_row(row: Any, keywords: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    d = dict(row)
    d["turns"] = json.loads(d.pop("turns_json", "[]") or "[]")
    d["metrics"] = json.loads(d.pop("metrics_json", "{}") or "{}")
    d["strengths"] = json.loads(d.pop("strengths_json", "[]") or "[]")
    d["improvements"] = json.loads(d.pop("improvements_json", "[]") or "[]")
    d["insights"] = json.loads(d.pop("insights_json", "[]") or "[]")
    d["topics"] = json.loads(d.pop("topics_json", "[]") or "[]")
    d["trackers"] = json.loads(d.pop("trackers_json", "[]") or "[]")
    d["has_audio"] = bool(d.get("has_audio"))
    d["callback_done"] = bool(d.get("callback_done"))
    d["warranty_pitched"] = bool(d.get("warranty_pitched"))
    veh_parts = [str(x) for x in [d.get("vehicle_year"), d.get("vehicle_make"), d.get("vehicle_model")] if x]
    d["vehicle"] = " ".join(veh_parts)
    if keywords is not None:
        search_blob = f"{d.get('transcript') or ''} {' '.join(d['topics'])}"
        d["keyword_hits"] = compute_keyword_hits_for_text(search_blob, keywords)
    else:
        d["keyword_hits"] = []
    return d


def build_org_payload(conn: Any, org_id: str) -> Dict[str, Any]:
    org = conn.execute("SELECT * FROM orgs WHERE id = ?", (org_id,)).fetchone()
    if not org:
        return {}
    o = dict(org)
    reps_count = conn.execute(
        "SELECT COUNT(*) AS c FROM users WHERE org_id = ? AND role = 'rep' AND disabled = 0",
        (org_id,),
    ).fetchone()["c"]

    plan_info = next((p for p in PLANS if p["id"] == o["plan"]), PLANS[1])
    base_max = plan_info["max_reps"]
    extra_packs = int(o.get("extra_rep_packs") or 0)
    max_extra_packs = 3 if o["plan"] == "pro" else 0
    extra_pack_price = 50
    max_reps = (base_max + extra_packs * 2) if base_max is not None else None

    now = now_utc()
    t_end = parse_iso(o.get("trial_ends_at"))
    days_left = max(0, int(round((t_end - now).total_seconds() / 86400))) if t_end else 0

    lim_start = parse_iso(o.get("limited_starts_at"))
    trial_limited = bool(o["status"] == "trialing" and lim_start and now >= lim_start and not o["is_demo"])

    prev_end = parse_iso(o.get("preview_ends_at"))
    preview_active = bool(prev_end and prev_end > now)
    preview_days_left = max(0, int(round((prev_end - now).total_seconds() / 86400))) if preview_active else 0

    plan_locked: List[str] = []
    if o["plan"] == "starter":
        plan_locked.extend(["roleplay", "daily_email", "leaderboards", "vehicle_arrivals"])
    if o["plan"] in ("starter", "pro", "pro_unlimited") and not preview_active:
        plan_locked.extend(["monthly_trends", "rep_trends", "parts_insights", "trend_alerts", "inventory_insights"])

    locked_features: List[str] = []
    if trial_limited:
        locked_features.extend(["monthly_trends", "parts_insights", "trend_alerts", "daily_email"])

    access = not bool(o.get("blocked")) and o["status"] in ("active", "trialing")
    if o["status"] == "trialing" and t_end and now > t_end and not o["is_demo"]:
        access = False

    return {
        "id": o["id"],
        "name": o["name"],
        "yard_name": o.get("yard_name") or o["name"],
        "plan": o["plan"],
        "status": o["status"],
        "billing_interval": o.get("billing_interval") or "month",
        "access": access,
        "blocked": bool(o.get("blocked")),
        "cancel_reason": o.get("cancel_reason"),
        "card_on_file": bool(o.get("card_on_file")),
        "no_card_trial": bool(o.get("no_card_trial")),
        "email_verified": bool(o.get("email_verified")),
        "days_left": days_left,
        "trial_ends_at": o.get("trial_ends_at"),
        "limited_starts_at": o.get("limited_starts_at"),
        "trial_limited": trial_limited,
        "roleplay_daily_cap": 1 if trial_limited else None,
        "suggestion_cap": 3 if trial_limited else None,
        "preview_available": o["plan"] in ("pro", "pro_unlimited") and not bool(o.get("preview_used")) and not preview_active,
        "preview_ends_at": o.get("preview_ends_at") if preview_active else None,
        "preview_days_left": preview_days_left,
        "preview_ending": preview_active and preview_days_left <= 2,
        "show_enterprise_tour": bool(o.get("show_enterprise_tour")),
        "reps": reps_count,
        "max_reps": max_reps,
        "extra_rep_packs": extra_packs,
        "max_extra_packs": max_extra_packs,
        "extra_pack_price": extra_pack_price,
        "locked_features": locked_features,
        "plan_locked": plan_locked,
        "sample_data": bool(o.get("sample_data")),
    }


def get_yard_avg_order(conn: Any, org_id: str) -> Tuple[float, str]:
    org = conn.execute("SELECT avg_order_value FROM orgs WHERE id = ?", (org_id,)).fetchone()
    scored_orders = conn.execute(
        "SELECT order_value FROM calls WHERE org_id = ? AND outcome = 'won' AND order_value > 0",
        (org_id,),
    ).fetchall()
    if len(scored_orders) >= 3:
        avg_v = sum(r["order_value"] for r in scored_orders) / len(scored_orders)
        return (round(avg_v, 2), "ai")
    if org and org["avg_order_value"]:
        return (float(org["avg_order_value"]), "manager")
    return (350.0, "default")


def compute_callbacks(conn: Any, org_id: str, rep_id: Optional[str] = None, status: str = "open") -> List[Dict[str, Any]]:
    """
    Inbound voicemails and calls under 30 seconds.
    Auto-resolves when anyone connects with that number again (30s+, in or out) after the missed call,
    or when manually marked callback_done.
    """
    all_calls = conn.execute(
        "SELECT * FROM calls WHERE org_id = ? ORDER BY created_at ASC",
        (org_id,),
    ).fetchall()

    # Map latest connected call (duration >= 30) per normalized phone / customer_key
    connected_times: Dict[str, List[str]] = defaultdict(list)
    for c in all_calls:
        if c["duration_sec"] >= 30:
            key = c["phone_norm"] or c["customer_key"]
            connected_times[key].append(c["created_at"])

    results = []
    for c in reversed(all_calls):
        if c["direction"] != "inbound" or c["duration_sec"] >= 30:
            continue
        if rep_id and c["rep_id"] != rep_id:
            continue

        key = c["phone_norm"] or c["customer_key"]
        later_connects = [t for t in connected_times.get(key, []) if t > c["created_at"]]
        followed_up = len(later_connects) > 0
        followed_up_at = later_connects[0] if followed_up else None
        is_resolved = bool(c["callback_done"]) or followed_up

        if (status == "open" and not is_resolved) or (status == "resolved" and is_resolved):
            results.append(
                {
                    "id": c["id"],
                    "customer_name": c["customer_name"],
                    "customer_phone": c["customer_phone"],
                    "rep_id": c["rep_id"],
                    "rep_name": c["rep_name"],
                    "reason": "Voicemail" if c["duration_sec"] >= 20 else f"Short call ({c['duration_sec']}s)",
                    "created_at": c["created_at"],
                    "callback_done": bool(c["callback_done"]),
                    "callback_by": c["callback_by"],
                    "followed_up": followed_up,
                    "followed_up_at": followed_up_at,
                }
            )
    return results


def build_customer_analytics(
    conn: Any,
    org_id: str,
    rep_id: Optional[str] = None,
    tag_filter: Optional[str] = None,
    include_all: bool = False,
) -> Dict[str, Any]:
    avg_order_val, avg_basis = get_yard_avg_order(conn, org_id)
    org_row = conn.execute("SELECT yard_name, name FROM orgs WHERE id = ?", (org_id,)).fetchone()
    yard_label = (org_row["yard_name"] or org_row["name"]) if org_row else "Northside Auto Recyclers"

    cust_rows = {
        r["customer_key"]: dict(r)
        for r in conn.execute("SELECT * FROM customers WHERE org_id = ?", (org_id,)).fetchall()
    }
    winback_rows = conn.execute(
        "SELECT * FROM winback_marks WHERE org_id = ? ORDER BY created_at DESC",
        (org_id,),
    ).fetchall()
    latest_mark_by_key: Dict[str, Dict[str, Any]] = {}
    for w in winback_rows:
        if w["customer_key"] not in latest_mark_by_key:
            latest_mark_by_key[w["customer_key"]] = dict(w)

    open_cb_keys = {c["phone_norm"] if "phone_norm" in c else make_customer_key(c["customer_name"], c["customer_phone"]) for c in compute_callbacks(conn, org_id, rep_id=rep_id, status="open")}

    query = "SELECT * FROM calls WHERE org_id = ?"
    params: List[Any] = [org_id]
    if rep_id:
        query += " AND rep_id = ?"
        params.append(rep_id)
    query += " ORDER BY created_at DESC"
    calls = conn.execute(query, params).fetchall()

    grouped: Dict[str, List[sqlite3.Row]] = defaultdict(list)
    for c in calls:
        grouped[c["customer_key"]].append(c)

    now = now_utc()
    all_stats: List[Dict[str, Any]] = []
    type_Initial: Dict[str, Dict[str, Any]] = {
        t: {"tag": t, "customers": 0, "orders": 0, "est_value": 0.0}
        for t in ["body_shop", "mechanic", "fleet", "retail", "untagged"]
    }

    for ckey, clist in grouped.items():
        latest = clist[0]
        meta = cust_rows.get(ckey)
        cname = meta["name"] if meta else latest["customer_name"]
        cphone = meta["phone"] if (meta and meta["phone"]) else latest["customer_phone"]
        if meta and meta["tag"]:
            tag = meta["tag"]
            tag_source = meta["tag_source"]
        else:
            tag, tag_source = infer_customer_tag(cname)

        orders = [c for c in clist if c["outcome"] == "won"]
        ai_val = sum(float(c["order_value"] or 0) for c in orders if (c["order_value"] or 0) > 0)
        unvalued_orders = sum(1 for c in orders if not (c["order_value"] or 0) > 0)
        est_value = ai_val + unvalued_orders * avg_order_val
        if len(orders) == 0:
            val_basis = ""
        elif unvalued_orders == 0:
            val_basis = "ai"
        elif ai_val > 0:
            val_basis = "mixed"
        else:
            val_basis = "estimated"

        topics_counter: Counter = Counter()
        rep_names_seen: List[str] = []
        for c in clist:
            if c["rep_name"] and c["rep_name"] not in rep_names_seen:
                rep_names_seen.append(c["rep_name"])
            for tp in json.loads(c["topics_json"] or "[]"):
                topics_counter[tp] += 1
            if c["part_requested"]:
                topics_counter[c["part_requested"]] += 1

        # Accumulate type breakdown before tag filter
        tb_bucket = tag if tag in type_Initial else "untagged"
        type_Initial[tb_bucket]["customers"] += 1
        type_Initial[tb_bucket]["orders"] += len(orders)
        type_Initial[tb_bucket]["est_value"] += est_value

        if tag_filter and tag_filter != "all" and tag != tag_filter:
            continue

        last_dt = parse_iso(latest["created_at"]) or now
        days_quiet = max(0, int((now - last_dt).total_seconds() // 86400))

        stat_obj = {
            "key": ckey,
            "name": cname,
            "phone": cphone,
            "tag": tag,
            "tag_source": tag_source,
            "calls": len(clist),
            "orders": len(orders),
            "est_value": round(est_value, 2),
            "value_basis": val_basis,
            "talk_sec": sum(int(c["duration_sec"] or 0) for c in clist),
            "last_call_at": latest["created_at"],
            "last_category": latest["category"] or "Part Inquiry/Quote",
            "top_topics": [k for k, _ in topics_counter.most_common(4)],
            "rep_names": rep_names_seen,
            "days_quiet": days_quiet,
        }
        all_stats.append(stat_obj)

    # Build Suggested list (urgent missed callbacks, pending quotes, high-frequency non-buyers)
    suggested = []
    win_back = []
    for st in all_stats:
        ckey = st["key"]
        clist = grouped[ckey]
        latest = clist[0]
        rep_first = (st["rep_names"][0].split()[0]) if st["rep_names"] else "Rich"
        cust_first = st["name"].split()[0]
        top_part = st["top_topics"][0] if st["top_topics"] else "OEM parts"

        if ckey in open_cb_keys or (latest["direction"] == "inbound" and latest["duration_sec"] < 30 and not latest["callback_done"]):
            suggested.append(
                {
                    **st,
                    "priority": "high",
                    "reason": "Unreturned missed call — call back before they source elsewhere",
                    "opener": f"Hi {cust_first}, it's {rep_first} at {yard_label} returning your call — what vehicle and part are you working on today?",
                }
            )
        elif latest["outcome"] == "pending" and st["days_quiet"] <= 14:
            q_val = int(latest["quoted_value"] or avg_order_val)
            suggested.append(
                {
                    **st,
                    "priority": "high" if q_val >= 400 else "medium",
                    "reason": f"Open ${q_val} quote on {top_part} with no order yet",
                    "opener": f"Hi {cust_first}, it's {rep_first} from {yard_label}. Checking in on the {top_part.lower()} we quoted — still need us to pull it for your truck?",
                }
            )
        elif st["calls"] >= 2 and st["orders"] == 0:
            suggested.append(
                {
                    **st,
                    "priority": "medium",
                    "reason": f"{st['calls']} inquiries without an order yet",
                    "opener": f"Hi {cust_first}, it's {rep_first} at {yard_label}. We just stocked fresh inventory for {top_part.lower()} — anything on your lifts today?",
                }
            )

        # Win-back: Repeat buyers (2+ orders) with no call in 30+ days (and not marked in last 14 days)
        if st["orders"] >= 2 and st["days_quiet"] >= 30:
            lmark = latest_mark_by_key.get(ckey)
            mark_dt = parse_iso(lmark["created_at"]) if lmark else None
            recently_marked = bool(mark_dt and (now - mark_dt).total_seconds() < 14 * 86400)
            if not recently_marked:
                last_mark_txt = (
                    f"Last marked {lmark['outcome']} by {lmark['rep_name'].split()[0]}"
                    if lmark
                    else ""
                )
                win_back.append(
                    {
                        **st,
                        "priority": "high" if st["est_value"] >= 1000 or st["days_quiet"] >= 45 else "medium",
                        "reason": f"{st['orders']} past orders ({int(st['est_value']):,} total) · quiet for {st['days_quiet']} days",
                        "opener": f"Hi {cust_first}, it's {rep_first} from {yard_label}. Haven't heard from your shop in a few weeks — we just got fresh {top_part.lower()} inventory in. What's on your bays this week?",
                        "last_mark": last_mark_txt,
                    }
                )

    prio_rank = {"high": 0, "medium": 1, "low": 2}
    suggested.sort(key=lambda x: (prio_rank.get(x["priority"], 2), -x["est_value"], -x["calls"]))
    win_back.sort(key=lambda x: (prio_rank.get(x["priority"], 2), -x["est_value"], -x["days_quiet"]))

    top_value = sorted(all_stats, key=lambda x: (-x["est_value"], -x["orders"]))[:25]
    most_calls = sorted(all_stats, key=lambda x: (-x["calls"], -x["est_value"]))[:25]
    most_orders = sorted(all_stats, key=lambda x: (-x["orders"], -x["est_value"]))[:25]
    all_customers = sorted(all_stats, key=lambda x: x["name"].lower()) if include_all else all_stats[:50]

    total_customers = sum(v["customers"] for v in type_Initial.values())
    repeat_customers = sum(1 for clist in grouped.values() if len(clist) > 1)

    return {
        "total_customers": total_customers,
        "repeat_customers": repeat_customers,
        "avg_order_value": avg_order_val,
        "avg_order_basis": avg_basis,
        "type_breakdown": [v for v in type_Initial.values() if v["customers"] > 0],
        "suggested": suggested[:20],
        "top_value": top_value,
        "most_calls": most_calls,
        "most_orders": most_orders,
        "win_back": win_back,
        "all_customers": all_customers,
    }


def evaluate_winback_confirmations(conn: Any, org_id: str, rep_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    A win-back mark counts as confirmed when that customer's next won order call shows up within 30 days.
    """
    avg_order_val, _ = get_yard_avg_order(conn, org_id)
    marks_q = "SELECT * FROM winback_marks WHERE org_id = ?"
    params: List[Any] = [org_id]
    if rep_id:
        marks_q += " AND rep_id = ?"
        params.append(rep_id)
    marks_q += " ORDER BY created_at DESC"
    marks = conn.execute(marks_q, params).fetchall()

    won_calls = conn.execute(
        "SELECT id, customer_key, order_value, created_at FROM calls WHERE org_id = ? AND outcome = 'won' ORDER BY created_at ASC",
        (org_id,),
    ).fetchall()
    won_by_cust: Dict[str, List[Any]] = defaultdict(list)
    for wc in won_calls:
        won_by_cust[wc["customer_key"]].append(wc)

    evaluated = []
    for m in marks:
        m_dt = parse_iso(m["created_at"])
        confirmed_call = None
        if m_dt:
            for wc in won_by_cust.get(m["customer_key"], []):
                w_dt = parse_iso(wc["created_at"])
                if w_dt and timedelta(seconds=-60) <= (w_dt - m_dt) <= timedelta(days=30):
                    confirmed_call = wc
                    break
        c_val = float(confirmed_call["order_value"] or avg_order_val) if confirmed_call else 0.0
        evaluated.append(
            {
                "id": m["id"],
                "customer_key": m["customer_key"],
                "customer_name": m["customer_name"],
                "rep_id": m["rep_id"],
                "rep_name": m["rep_name"],
                "outcome": m["outcome"],
                "month": m["month_bucket"],
                "created_at": m["created_at"],
                "confirmed": confirmed_call is not None,
                "confirmed_call_id": confirmed_call["id"] if confirmed_call else None,
                "confirmed_value": round(c_val, 2),
            }
        )
    return evaluated


def build_overview_analytics(conn: Any, org_id: str, rep_id: Optional[str] = None) -> Dict[str, Any]:
    keywords = [dict(r) for r in conn.execute("SELECT * FROM keywords WHERE org_id = ?", (org_id,)).fetchall()]
    q = "SELECT * FROM calls WHERE org_id = ?"
    params: List[Any] = [org_id]
    if rep_id:
        q += " AND rep_id = ?"
        params.append(rep_id)
    q += " ORDER BY created_at DESC"
    calls = conn.execute(q, params).fetchall()

    total_calls = len(calls)
    scored_calls_list = [c for c in calls if (c["overall_score"] or 0) > 0]
    scored_calls = len(scored_calls_list)
    avg_score = round(sum(c["overall_score"] for c in scored_calls_list) / scored_calls, 1) if scored_calls else 0

    connected = [c for c in calls if (c["duration_sec"] or 0) >= 30]
    avg_duration_sec = round(sum(c["duration_sec"] for c in calls) / total_calls) if total_calls else 0
    warranty_pitch_rate = (
        round(100.0 * sum(1 for c in connected if c["warranty_pitched"]) / len(connected), 1)
        if connected
        else 0.0
    )

    won = sum(1 for c in calls if c["outcome"] == "won")
    lost = sum(1 for c in calls if c["outcome"] == "lost")
    pending = sum(1 for c in calls if c["outcome"] == "pending")
    sales_total = won + lost + pending
    conversion_rate = round(100.0 * won / sales_total, 1) if sales_total > 0 else 0.0

    inbound = sum(1 for c in calls if c["direction"] == "inbound" and (c["duration_sec"] or 0) >= 30)
    outbound = sum(1 for c in calls if c["direction"] == "outbound")
    voicemails = sum(1 for c in calls if c["direction"] == "inbound" and (c["duration_sec"] or 0) < 30)

    # Hourly breakdown (8am to 5pm)
    hourly_map = {h: {"hour": h, "inbound": 0, "outbound": 0} for h in range(8, 18)}
    for c in calls:
        dt = parse_iso(c["created_at"])
        h = dt.hour if dt else 10
        h = max(8, min(17, h))
        if c["direction"] == "outbound":
            hourly_map[h]["outbound"] += 1
        else:
            hourly_map[h]["inbound"] += 1

    # Category breakdown
    cat_groups: Dict[str, List[int]] = defaultdict(list)
    for c in calls:
        cat = c["category"] or "Other"
        cat_groups[cat].append(int(c["overall_score"] or 0))
    category_breakdown = [
        {
            "category": cat,
            "count": len(scores),
            "avg_score": round(sum(s for s in scores if s > 0) / max(1, len([s for s in scores if s > 0])), 1),
        }
        for cat, scores in sorted(cat_groups.items(), key=lambda kv: -len(kv[1]))
    ]

    # Metric averages
    metric_totals: Dict[str, List[float]] = defaultdict(list)
    for c in scored_calls_list:
        mdata = json.loads(c["metrics_json"] or "{}")
        for mdef in METRICS:
            val = mdata.get(mdef["key"])
            if val is None and mdef["key"] == "courtesy":
                val = mdata.get("tone_empathy")
            if val is not None:
                f_val = float(val)
                # Normalize legacy single-digit metrics to 0-100 scale
                if 0 < f_val <= 10:
                    f_val *= 10
                metric_totals[mdef["key"]].append(f_val)
    metric_averages = [
        {
            "key": mdef["key"],
            "name": mdef["name"],
            "avg": round(sum(metric_totals[mdef["key"]]) / len(metric_totals[mdef["key"]]), 1)
            if metric_totals[mdef["key"]]
            else 0.0,
        }
        for mdef in METRICS
    ]

    # Daily QA trend
    day_scores: Dict[str, List[int]] = defaultdict(list)
    for c in scored_calls_list:
        day_scores[c["created_at"][:10]].append(int(c["overall_score"]))
    trend = [
        {"date": d, "avg_score": round(sum(vals) / len(vals), 1)}
        for d, vals in sorted(day_scores.items())[-14:]
    ]

    # Topics
    topic_counter: Counter = Counter()
    for c in calls:
        for tp in json.loads(c["topics_json"] or "[]"):
            topic_counter[tp] += 1
    topic_stats = [{"topic": k, "count": v} for k, v in topic_counter.most_common(12)]

    # Keyword stats
    kw_stats = []
    for kw in keywords:
        words = [w.strip() for w in kw["keyword"].split("/") if w.strip()]
        if not words:
            continue
        rx = re.compile(r"\b(?:" + "|".join(re.escape(w) for w in words) + r")\b", re.I)
        hit_count = 0
        call_count = 0
        month_calls: Dict[str, int] = defaultdict(int)
        for c in calls:
            blob = f"{c['transcript'] or ''} {' '.join(json.loads(c['topics_json'] or '[]'))}"
            found = rx.findall(blob)
            if found:
                hit_count += len(found)
                call_count += 1
                month_calls[c["month_bucket"]] += 1
        all_months = sorted({c["month_bucket"] for c in calls})[-6:]
        monthly_arr = [{"month": m, "calls": month_calls.get(m, 0)} for m in all_months]
        kw_stats.append(
            {
                "id": kw["id"],
                "keyword": kw["keyword"],
                "group": kw["group_name"],
                "count": hit_count,
                "calls": call_count,
                "monthly": monthly_arr,
            }
        )
    kw_stats.sort(key=lambda x: -x["count"])

    # Coaching flags (score > 0 and < 65)
    coaching_flags = []
    for c in scored_calls_list:
        if c["overall_score"] < 65:
            imps = json.loads(c["improvements_json"] or "[]")
            coaching_flags.append(
                {
                    "call_id": c["id"],
                    "rep_id": c["rep_id"],
                    "rep_name": c["rep_name"],
                    "customer_name": c["customer_name"],
                    "category": c["category"],
                    "overall_score": c["overall_score"],
                    "top_improvement": imps[0] if imps else c["coaching_feedback"],
                }
            )

    # Leaderboard across reps
    reps = conn.execute(
        "SELECT id, name, title, avatar_url FROM users WHERE org_id = ? AND role = 'rep' AND disabled = 0",
        (org_id,),
    ).fetchall()
    all_org_calls = calls if not rep_id else conn.execute("SELECT * FROM calls WHERE org_id = ?", (org_id,)).fetchall()
    leaderboard = []
    for r in reps:
        rcalls = [c for c in all_org_calls if c["rep_id"] == r["id"]]
        rscored = [c for c in rcalls if (c["overall_score"] or 0) > 0]
        rconn = [c for c in rcalls if (c["duration_sec"] or 0) >= 30]
        rwon = sum(1 for c in rcalls if c["outcome"] == "won")
        rsales = sum(1 for c in rcalls if c["outcome"] in ("won", "lost", "pending"))
        leaderboard.append(
            {
                "rep_id": r["id"],
                "name": r["name"],
                "title": r["title"] or "Sales Rep",
                "avatar_url": r["avatar_url"] or "",
                "calls": len(rcalls),
                "avg_score": round(sum(c["overall_score"] for c in rscored) / len(rscored), 1) if rscored else 0.0,
                "conversion_rate": round(100.0 * rwon / rsales, 1) if rsales else 0.0,
                "warranty_pitch_rate": round(100.0 * sum(1 for c in rconn if c["warranty_pitched"]) / len(rconn), 1)
                if rconn
                else 0.0,
            }
        )
    leaderboard.sort(key=lambda x: (-x["avg_score"], -x["conversion_rate"]))

    # Rep-specific profile info
    rep_obj = None
    focus_areas: List[str] = []
    rp_sessions_count = 0
    if rep_id:
        u = conn.execute("SELECT id, name, title, avatar_url FROM users WHERE id = ?", (rep_id,)).fetchone()
        if u:
            rep_obj = dict(u)
        for c in scored_calls_list[:8]:
            for imp in json.loads(c["improvements_json"] or "[]"):
                if imp not in focus_areas:
                    focus_areas.append(imp)
        rp_sessions_count = conn.execute(
            "SELECT COUNT(*) AS c FROM roleplay_sessions WHERE org_id = ? AND user_id = ?",
            (org_id, rep_id),
        ).fetchone()["c"]

    open_cbs = len(compute_callbacks(conn, org_id, rep_id=rep_id, status="open"))

    return {
        "total_calls": total_calls,
        "scored_calls": scored_calls,
        "avg_score": avg_score,
        "avg_duration_sec": avg_duration_sec,
        "warranty_pitch_rate": warranty_pitch_rate,
        "conversion_rate": conversion_rate,
        "won": won,
        "lost": lost,
        "pending": pending,
        "inbound": inbound,
        "outbound": outbound,
        "voicemails": voicemails,
        "open_callbacks": open_cbs,
        "hourly": list(hourly_map.values()),
        "category_breakdown": category_breakdown,
        "metric_averages": metric_averages,
        "trend": trend,
        "topic_stats": topic_stats,
        "keyword_stats": kw_stats,
        "coaching_flags": coaching_flags[:6],
        "leaderboard": leaderboard,
        "rep": rep_obj,
        "focus_areas": focus_areas[:4],
        "roleplay_sessions": rp_sessions_count,
    }


def build_arrival_payload(conn: Any, arrival_row: Any, current_user: Dict[str, Any]) -> Dict[str, Any]:
    a = dict(arrival_row)
    callers_rows = conn.execute(
        "SELECT * FROM arrival_callers WHERE arrival_id = ? ORDER BY exact_year DESC, times_asked DESC",
        (a["id"],),
    ).fetchall()
    # Check if any caller placed an order after the arrival was logged
    won_after = conn.execute(
        "SELECT customer_key, created_at FROM calls WHERE org_id = ? AND outcome = 'won' AND created_at >= ?",
        (a["org_id"], a["created_at"]),
    ).fetchall()
    ordered_by_key = {r["customer_key"]: r["created_at"] for r in won_after}

    callers = []
    for cr in callers_rows:
        if current_user["role"] == "rep" and cr["rep_id"] != current_user["id"]:
            continue
        c = dict(cr)
        c["key"] = c["customer_key"]
        c["exact_year"] = bool(c["exact_year"])
        c["parts"] = json.loads(c.pop("parts_json", "[]") or "[]")
        c["text"] = c.pop("text_body", None)
        c["ordered_at"] = ordered_by_key.get(c["customer_key"])
        callers.append(c)

    all_c = [dict(cr) for cr in callers_rows]
    sold_count = sum(1 for c in all_c if c["status"] == "sold")
    orders_count = sum(1 for c in all_c if c["customer_key"] in ordered_by_key)
    contacted_count = sum(1 for c in all_c if c["status"] != "to_call" or c.get("texted_at"))
    texted_count = sum(1 for c in all_c if c.get("texted_at"))
    replied_count = sum(1 for c in all_c if c.get("replied_at"))

    arr_dt = parse_iso(a["created_at"])
    sale_deltas = []
    for c in all_c:
        if c["status"] == "sold" and c.get("status_updated_at") and arr_dt:
            s_dt = parse_iso(c["status_updated_at"])
            if s_dt:
                sale_deltas.append(max(0.0, (s_dt - arr_dt).total_seconds() / 86400.0))
    first_sale_days = round(min(sale_deltas), 1) if sale_deltas else None

    return {
        "id": a["id"],
        "vehicle_year": a["vehicle_year"],
        "vehicle_make": a["vehicle_make"],
        "vehicle_model": a["vehicle_model"],
        "year_span": a["year_span"],
        "note": a["note"],
        "created_by": a["created_by"],
        "created_at": a["created_at"],
        "blasts": json.loads(a.get("blasts_json") or "[]"),
        "callers": callers,
        "results": {
            "callers": len(all_c),
            "contacted": contacted_count,
            "texted": texted_count,
            "replied": replied_count,
            "sold": sold_count,
            "orders": orders_count,
            "first_sale_days": first_sale_days,
        },
    }
