from __future__ import annotations

import copy
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from auth_utils import get_current_user
import database
import store
import yard_analytics as ya
from database import infer_customer_tag
from security import (
    assert_same_org,
    effective_org,
    is_manager,
    is_staff,
    public_user,
    require_authenticated,
    resolve_write_org,
    validate_email,
)

router = APIRouter(tags=["analytics"], dependencies=[Depends(require_authenticated)])


def _customer_visible(st: dict[str, Any], key: str, user: dict[str, Any]) -> bool:
    """Whether ``key`` (a customer name or phone) belongs to the caller's yard.

    Platform staff with no org filter may see every customer.  Everyone else is
    restricted to customers that have a call in their own yard; full-customer
    records carrying an explicit ``org_id`` must match as well.
    """
    org_id = effective_org(user)
    if org_id is None:
        return True

    full = (st.get("full_customers") or {}).get(key)
    if isinstance(full, dict):
        record_org = (full.get("stat") or {}).get("org_id") or full.get("org_id")
        if record_org == org_id:
            return True

    for call in st.get("calls", []):
        if call.get("customer_name") == key or call.get("customer_phone") == key:
            if call.get("org_id") == org_id:
                return True
    return False


def _customer_store_key(key: str, user: dict[str, Any]) -> str:
    """Namespace manual tags/notes per yard while keeping Keech's legacy keys."""
    org_id = effective_org(user)
    if org_id and org_id != store.KEECH_ORG_ID:
        return f"{org_id}:{key}"
    return key


DEFAULT_OVERVIEW: dict[str, Any] = {
    "total_calls": 0,
    "avg_score": 0,
    "avg_duration_sec": 0,
    "warranty_pitch_rate": 0,
    "conversion_rate": 0,
    "won": 0,
    "lost": 0,
    "pending": 0,
    "inbound": 0,
    "outbound": 0,
    "scored_calls": 0,
    "open_callbacks": 0,
    "metric_averages": [
        {"name": "Greeting", "avg": 0},
        {"name": "Parts Lookup", "avg": 0},
        {"name": "Pricing", "avg": 0},
        {"name": "Warranty", "avg": 0},
        {"name": "Delivery Option", "avg": 0},
        {"name": "Closing / Next Steps", "avg": 0},
        {"name": "Professionalism", "avg": 0},
    ],
    "category_breakdown": [],
    "hourly": [],
    "trend": [],
    "topic_stats": [],
    "focus_areas": [],
    "coaching_flags": [],
    "rep": None,
}


METRIC_NAMES = [
    ("greeting", "Greeting & Brand"),
    ("needs_discovery", "Needs Discovery"),
    ("product_knowledge", "Product Knowledge"),
    ("upsell_crosssell", "Upsell & Cross-sell"),
    ("objection_handling", "Objection Handling"),
    ("closing", "Closing & Next Steps"),
    ("compliance_warranty", "Warranty & Compliance"),
    ("tone_empathy", "Courtesy & Professionalism"),
]


def _call_has_warranty(st: dict[str, Any], c: dict[str, Any]) -> bool:
    full = st.get("full_calls", {}).get(c.get("id"), {})
    text = (full.get("transcript") or "").lower()
    return "warranty" in text or any("warranty" in str(t).lower() for t in c.get("topics", []))


def _stats(st: dict[str, Any], calls: list[dict[str, Any]]) -> dict[str, Any]:
    scored = [c for c in calls if c.get("overall_score") is not None]
    # Delivery calls are logged for the delivery board but are never sales.
    sales_calls = [c for c in calls if not c.get("delivery_call")]
    won = sum(1 for c in sales_calls if c.get("outcome") == "won")
    lost = sum(1 for c in sales_calls if c.get("outcome") == "lost")
    pending = sum(1 for c in sales_calls if c.get("outcome") == "pending")
    sales = won + lost + pending
    warr = sum(1 for c in calls if _call_has_warranty(st, c))
    return {
        "calls": len(calls),
        "scored": len(scored),
        "avg_score": round(sum(c["overall_score"] for c in scored) / len(scored), 1) if scored else 0,
        "won": won, "lost": lost, "pending": pending,
        "conversion_rate": round(won / sales * 100, 1) if sales else 0,
        "warranty_pitch_rate": round(warr / len(calls) * 100, 1) if calls else 0,
    }


def _build_leaderboard(st: dict[str, Any], org_id: Optional[str], calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    for u in st.get("users_by_id", {}).values():
        if u.get("role") not in ("rep", "sales_rep") or u.get("disabled"):
            continue
        if org_id and u.get("org_id") != org_id:
            continue
        mine = [c for c in calls if c.get("rep_id") == u["id"]]
        s = _stats(st, mine)
        rows.append({
            "rep_id": u["id"], "name": u["name"], "title": u.get("title") or "Sales Representative",
            "calls": s["calls"], "avg_score": s["avg_score"],
            "conversion_rate": s["conversion_rate"], "warranty_pitch_rate": s["warranty_pitch_rate"],
        })
    rows.sort(key=lambda r: (r["avg_score"], r["conversion_rate"]), reverse=True)
    return rows


@router.get("/api/analytics/overview")
def get_analytics_overview(
    request: Request,
    rep_id: Optional[str] = Query(None),
    days: Optional[int] = Query(None),
    site_id: Optional[str] = Query(None),
) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)

    # Reps may only ever see themselves; managers may pick a rep in their own
    # yard; platform staff may cross yards.
    effective_rep_id = ya.scoped_rep_id(u, rep_id, st)
    org_calls = ya.org_calls(st, org_id, site_id=site_id)
    yard_calls = [c for c in org_calls if not effective_rep_id or c.get("rep_id") == effective_rep_id]
    if days:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
        yard_calls = [c for c in yard_calls if (c.get("created_at") or "") >= cutoff]

    base = dict(DEFAULT_OVERVIEW)
    s = _stats(st, yard_calls)
    base.update({
        "total_calls": s["calls"], "scored_calls": s["scored"], "avg_score": s["avg_score"],
        "won": s["won"], "lost": s["lost"], "pending": s["pending"],
        "conversion_rate": s["conversion_rate"], "warranty_pitch_rate": s["warranty_pitch_rate"],
        "inbound": sum(1 for c in yard_calls if c.get("direction", "inbound") == "inbound"),
        "outbound": sum(1 for c in yard_calls if c.get("direction") == "outbound"),
    })
    durations = [c.get("duration_sec", 0) for c in yard_calls if c.get("duration_sec")]
    base["avg_duration_sec"] = round(sum(durations) / len(durations)) if durations else 0

    cat_counts: dict[str, list[float]] = {}
    date_map: dict[str, list[float]] = {}
    topic_counts: dict[str, int] = {}
    hour_in: dict[int, int] = {}
    metric_vals: dict[str, list[float]] = {k: [] for k, _ in METRIC_NAMES}
    for c in yard_calls:
        score = c.get("overall_score") or 0
        cat_counts.setdefault(c.get("category", "Sales Inquiry"), []).append(score)
        date_map.setdefault((c.get("created_at") or store.today_str())[:10], []).append(score)
        for t in c.get("topics", []):
            topic_counts[t] = topic_counts.get(t, 0) + 1
        try:
            h = int((c.get("created_at") or "")[11:13])
            hour_in[h] = hour_in.get(h, 0) + 1
        except ValueError:
            pass
        for k, v in (st.get("full_calls", {}).get(c.get("id"), {}).get("metrics") or {}).items():
            val = float(v)
            if 0 < val <= 10:
                val *= 10
            if k in metric_vals:
                metric_vals[k].append(val)
            elif k == "courtesy" and "tone_empathy" in metric_vals:
                metric_vals["tone_empathy"].append(val)
    base["category_breakdown"] = [
        {"category": k, "count": len(v), "avg_score": round(sum(v) / len(v), 1)} for k, v in cat_counts.items()
    ]
    base["trend"] = [
        {"date": d, "calls": len(v), "avg_score": round(sum(v) / len(v), 1)} for d, v in sorted(date_map.items())
    ]
    base["topic_stats"] = [
        {"topic": k, "count": v} for k, v in sorted(topic_counts.items(), key=lambda kv: -kv[1])[:12]
    ]
    base["hourly"] = [{"hour": h, "inbound": n, "outbound": 0} for h, n in sorted(hour_in.items())]
    base["metric_averages"] = [
        {"key": k, "name": n, "avg": round(sum(metric_vals[k]) / len(metric_vals[k]), 1) if metric_vals[k] else 0}
        for k, n in METRIC_NAMES
    ]
    flags = sorted([c for c in yard_calls if (c.get("overall_score") or 100) < 65], key=lambda c: c["overall_score"])[:8]
    base["coaching_flags"] = [
        {"call_id": c["id"], "rep_name": c.get("rep_name", ""), "customer_name": c.get("customer_name", ""),
         "category": c.get("category", ""), "overall_score": c.get("overall_score", 0),
         "top_improvement": ((st.get("full_calls", {}).get(c["id"], {}).get("improvements") or [""])[0])}
        for c in flags
    ]
    base["leaderboard"] = _build_leaderboard(st, org_id, org_calls)

    # Dynamic keyword & mention tracker calculation
    default_keywords = [
        {"id": "kw-warranty", "keyword": "Warranty", "group": "Assurance"},
        {"id": "kw-pricing", "keyword": "Pricing / Price", "group": "Negotiation"},
        {"id": "kw-trans", "keyword": "Transmission", "group": "Suggested"},
        {"id": "kw-vin", "keyword": "VIN", "group": "Fitment"},
        {"id": "kw-engine", "keyword": "Engine", "group": "Suggested"},
        {"id": "kw-delivery", "keyword": "Delivery / Shipping", "group": "Suggested"},
        {"id": "kw-core", "keyword": "Core", "group": "Financial"},
        {"id": "kw-oem", "keyword": "OEM", "group": "Quality"},
    ]
    user_keywords = [
        k for k in st.get("keywords", [])
        if not org_id or k.get("org_id") in (None, "", org_id)
    ]
    effective_keywords = user_keywords if user_keywords else default_keywords
    full_calls_map = st.get("full_calls", {})

    computed_kw_stats = []
    for kw in effective_keywords:
        words = [w.strip() for w in kw.get("keyword", "").split("/") if w.strip()]
        if not words:
            continue
        rx = re.compile(r"\b(?:" + "|".join(re.escape(w) for w in words) + r")\b", re.I)
        hit_count = 0
        call_count = 0
        for c in yard_calls:
            fc = full_calls_map.get(c.get("id"), {})
            transcript = fc.get("transcript", "") or ""
            topics_str = " ".join(c.get("topics", []))
            part = c.get("part_requested", "")
            veh = c.get("vehicle", "")
            blob = f"{transcript} {topics_str} {part} {veh}"
            found = rx.findall(blob)
            if found:
                hit_count += len(found)
                call_count += 1
        if hit_count > 0:
            computed_kw_stats.append({
                "id": kw.get("id", str(uuid.uuid4())),
                "keyword": kw.get("keyword", ""),
                "group": kw.get("group", "Custom"),
                "count": hit_count,
                "calls": call_count,
            })

    computed_kw_stats.sort(key=lambda x: -x["count"])
    base["keyword_stats"] = computed_kw_stats

    base["roleplay_sessions"] = len([
        x for x in st.get("roleplay_sessions", [])
        if not org_id or st.get("users_by_id", {}).get(x.get("user_id"), {}).get("org_id") == org_id
    ])
    base["open_callbacks"] = len([
        c for c in st.get("callbacks_open", [])
        if (not org_id or c.get("org_id") == org_id)
        and (not effective_rep_id or c.get("rep_id") == effective_rep_id)
    ])
    base["lot_name"] = ""
    if effective_rep_id:
        u_rep = st.get("users_by_id", {}).get(effective_rep_id)
        if u_rep:
            base["rep"] = public_user(u_rep)
    return base


@router.get("/api/analytics/team-benchmark")
def get_team_benchmark(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    calls = [c for c in st.get("calls", []) if not org_id or c.get("org_id") == org_id]
    reps = {x["id"] for x in st.get("users_by_id", {}).values() if x.get("role") in ("rep", "sales_rep")}
    calls = [c for c in calls if c.get("rep_id") in reps]
    s = _stats(st, calls)
    metric_vals: dict[str, list[float]] = {k: [] for k, _ in METRIC_NAMES}
    for c in calls:
        for k, v in (st.get("full_calls", {}).get(c.get("id"), {}).get("metrics") or {}).items():
            val = float(v)
            if 0 < val <= 10:
                val *= 10
            if k in metric_vals:
                metric_vals[k].append(val)
            elif k == "courtesy" and "tone_empathy" in metric_vals:
                metric_vals["tone_empathy"].append(val)
    return {
        "avg_score": s["avg_score"], "conversion_rate": s["conversion_rate"],
        "warranty_pitch_rate": s["warranty_pitch_rate"],
        "metric_averages": [
            {"key": k, "name": n, "avg": round(sum(metric_vals[k]) / len(metric_vals[k]), 1) if metric_vals[k] else 0}
            for k, n in METRIC_NAMES
        ],
    }


@router.get("/api/analytics/monthly")
def get_analytics_monthly(
    request: Request,
    rep_id: Optional[str] = Query(None),
    site_id: Optional[str] = Query(None),
) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    effective_rep_id = ya.scoped_rep_id(u, rep_id, st)
    calls = ya.org_calls(st, org_id, rep_id=effective_rep_id, site_id=site_id)

    # Compute dynamic monthly trend points from the calls dataset
    months_map: dict[str, list[dict[str, Any]]] = {}
    for c in calls:
        m = (c.get("created_at") or store.today_str())[:7]
        months_map.setdefault(m, []).append(c)

    all_months = sorted(months_map.keys())
    if not all_months:
        return {"months": [], "avg_order_value": 0.0}

    month_points = []
    total_sales_val = 0.0
    total_sales_count = 0

    for m in all_months:
        mcalls = months_map[m]
        metric_calls = [c for c in mcalls if not c.get("delivery_call")]
        m_sales = [c for c in metric_calls if c.get("outcome") in ("won", "lost", "pending")]
        m_won = [c for c in metric_calls if c.get("outcome") == "won"]
        sales_calls_cnt = len(m_sales)
        won_cnt = len(m_won)
        close_rate = round(won_cnt / max(sales_calls_cnt, 1) * 100, 1) if sales_calls_cnt else 0.0
        val = sum(float(c.get("order_value") or 0.0) for c in m_won)
        if won_cnt > 0:
            total_sales_val += val
            total_sales_count += won_cnt

        month_points.append({
            "month": m,
            "calls": len(mcalls),
            "sales_calls": sales_calls_cnt,
            "won": won_cnt,
            "close_rate": close_rate,
            "est_value": round(val, 2),
        })

    avg_order_value = round(total_sales_val / max(total_sales_count, 1), 1) if total_sales_count else 350.0

    return {
        "months": month_points,
        "avg_order_value": avg_order_value,
    }


def _build_monthly_reps(st: dict[str, Any], org_id: Optional[str], site_id: Optional[str] = None) -> dict[str, Any]:
    calls = ya.org_calls(st, org_id, site_id=site_id)
    reps_data = []
    months_set = set()
    for c in calls:
        m = (c.get("created_at") or store.today_str())[:7]
        months_set.add(m)
    all_months = sorted(months_set) if months_set else [store.today_str()[:7]]

    for u in st.get("users_by_id", {}).values():
        if u.get("role") not in ("rep", "sales_rep") or u.get("disabled"):
            continue
        if org_id and u.get("org_id") != org_id:
            continue
        if site_id and u.get("site_id") != site_id:
            continue
        rep_calls = [c for c in calls if c.get("rep_id") == u["id"]]
        month_map: dict[str, list[dict[str, Any]]] = {}
        for c in rep_calls:
            m = (c.get("created_at") or store.today_str())[:7]
            month_map.setdefault(m, []).append(c)

        points = []
        total_won = 0
        total_sales = 0
        for m in all_months:
            mcalls = month_map.get(m, [])
            metric_calls = [c for c in mcalls if not c.get("delivery_call")]
            m_won = sum(1 for c in metric_calls if c.get("outcome") == "won")
            m_sales = sum(1 for c in metric_calls if c.get("outcome") in ("won", "lost", "pending"))
            total_won += m_won
            total_sales += m_sales
            points.append({
                "month": m,
                "calls": len(mcalls),
                "sales_calls": m_sales,
                "won": m_won,
                "close_rate": round(m_won / max(m_sales, 1) * 100, 1) if m_sales else 0.0,
                "est_value": float(sum(c.get("order_value") or 0.0 for c in metric_calls if c.get("outcome") == "won")),
            })
        cr = round(total_won / max(total_sales, 1) * 100, 1) if total_sales else 0.0
        reps_data.append({
            "rep_id": u["id"],
            "rep_name": u["name"],
            "points": points,
            "close_rate": cr,
            "change": None,
        })
    reps_data.sort(key=lambda r: r["close_rate"], reverse=True)
    return {"months": all_months, "reps": reps_data}


@router.get("/api/analytics/monthly/reps")
def get_analytics_monthly_reps(request: Request, site_id: Optional[str] = Query(None)) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    return _build_monthly_reps(st, org_id, site_id=site_id)


def _build_parts_seasonal(st: dict[str, Any], org_id: Optional[str]) -> dict[str, Any]:
    calls = [
        c for c in st.get("calls", [])
        if (not org_id or c.get("org_id") == org_id) and not c.get("delivery_call")
    ]
    if not calls:
        return {"months": [], "parts": [], "yard_close_rate": 0.0}

    months = sorted({(c.get("created_at") or "")[:7] for c in calls if (c.get("created_at") or "")[:7]})[-6:]
    part_names = [
        "Door", "Transmission", "Bumper", "Engine", "Headlight", "Wheel / Rim",
        "Mirror", "Fender", "Axle", "Suspension", "Alternator", "Starter"
    ]
    total_sales_won = sum(1 for c in calls if c.get("outcome") == "won")
    total_sales_calls = sum(1 for c in calls if c.get("outcome") in ("won", "lost", "pending"))
    yard_close_rate = round(total_sales_won / max(1, total_sales_calls) * 100, 1)

    # Resolve each call's parts once with the same predicate the drill-down
    # uses, so the number in a seasonal cell always equals the calls it opens.
    call_parts = {id(c): ya.parts_for_call(st, c) for c in calls}
    parts_data = []
    for p_name in part_names:
        target = ya.canonical_part(p_name)
        matched = [c for c in calls if target in call_parts[id(c)]]
        asked = len(matched)
        sold = sum(1 for c in matched if c.get("outcome") == "won")
        scalls = sum(1 for c in matched if c.get("outcome") in ("won", "lost", "pending"))
        crate = round(sold / max(1, scalls) * 100, 1) if scalls else 0.0

        asked_by_m = []
        sold_by_m = []
        for m in months:
            mcalls = [c for c in matched if (c.get("created_at") or "")[:7] == m]
            asked_by_m.append(len(mcalls))
            sold_by_m.append(sum(1 for c in mcalls if c.get("outcome") == "won"))

        peak_month = months[asked_by_m.index(max(asked_by_m))] if asked_by_m else ""

        # Count real loss reasons where the yard recorded them.
        reasons = []
        for reason in ("price", "out_of_stock", "condition", "fitment", "unknown"):
            count = sum(
                1 for c in matched
                if (c.get("loss_reason") or c.get("lost_reason") or "").lower().replace(" ", "_") == reason
            )
            reasons.append({"reason": reason, "calls": count, "from_ai": 0})

        parts_data.append({
            "part": p_name.lower(),
            "sold": sold,
            "asked": asked,
            "sold_by_month": sold_by_m,
            "asked_by_month": asked_by_m,
            "peak_month": peak_month,
            "sales_calls": scalls,
            "close_rate": crate,
            "low_close": crate < yard_close_rate,
            "reasons": reasons,
        })

    parts_data.sort(key=lambda x: x["asked"], reverse=True)
    return {
        "months": months,
        "parts": parts_data,
        "yard_close_rate": yard_close_rate,
    }


def _build_customer_insights(st: dict[str, Any], org_id: Optional[str]) -> dict[str, Any]:
    from collections import defaultdict, Counter
    calls = [c for c in st.get("calls", []) if not org_id or c.get("org_id") == org_id]
    if not calls:
        return {
            "total_customers": 0, "repeat_customers": 0, "avg_order_value": 0.0, "avg_order_basis": "ai",
            "most_calls": [], "most_orders": [], "top_value": [], "win_back": [],
            "suggested": [], "type_breakdown": [], "all_customers": [],
        }

    by_cust = defaultdict(list)
    for c in calls:
        key = c.get("customer_phone") or c.get("customer_name")
        if key:
            by_cust[key].append(c)

    all_custs = []
    for key, c_list in by_cust.items():
        c_list.sort(key=lambda x: x.get("created_at", ""), reverse=True)
        c0 = c_list[0]
        name = c0.get("customer_name") or key
        phone = c0.get("customer_phone") or ""
        total_calls = len(c_list)
        orders = sum(1 for c in c_list if c.get("outcome") == "won")
        talk_sec = sum(c.get("duration_sec", 0) for c in c_list)
        rep_names = sorted(list({c.get("rep_name") for c in c_list if c.get("rep_name")}))
        topics = []
        for c in c_list:
            topics.extend(c.get("topics") or [])
        top_topics = [t for t, _ in Counter(topics).most_common(5)] or ["Part Inquiry"]
        part = c0.get("part_requested") or (top_topics[0] if top_topics else "Part")

        nl = name.lower()
        if "body" in nl or "collision" in nl:
            tag = "body_shop"
        elif "auto" in nl or "tire" in nl or "service" in nl or "garage" in nl or "repair" in nl:
            tag = "mechanic"
        elif "motor" in nl or "ford" in nl or "chev" in nl or "nissan" in nl or "honda" in nl:
            tag = "dealership"
        else:
            tag = "retail" if total_calls == 1 else "regular"

        all_custs.append({
            "key": key,
            "name": name,
            "phone": phone,
            "calls": total_calls,
            "orders": orders,
            "talk_sec": round(talk_sec, 1),
            "last_call_at": c0.get("created_at", ""),
            "last_call_id": c0.get("id", ""),
            "last_category": c0.get("category", "Sales Inquiry"),
            "top_topics": top_topics,
            "rep_names": rep_names,
            "tag": tag,
            "tag_source": "auto",
            "est_value": orders * 350.0,
            "value_basis": "estimated",
            "reason": f"Quoted {part} on {c0.get('created_at', '')[:10]} — follow up recommended",
            "priority": "high" if orders > 0 or total_calls > 3 else "medium",
            "opener": "",
            "last_mark": "",
        })

    all_custs.sort(key=lambda x: (x["orders"], x["calls"]), reverse=True)

    tag_counts = Counter(c["tag"] for c in all_custs)
    tag_calls = Counter()
    for c in all_custs:
        tag_calls[c["tag"]] += c["calls"]
    type_breakdown = [
        {"tag": "body_shop", "customers": tag_counts["body_shop"], "calls": tag_calls["body_shop"], "count": tag_counts["body_shop"], "est_value": sum(c["est_value"] for c in all_custs if c["tag"] == "body_shop")},
        {"tag": "mechanic", "customers": tag_counts["mechanic"], "calls": tag_calls["mechanic"], "count": tag_counts["mechanic"], "est_value": sum(c["est_value"] for c in all_custs if c["tag"] == "mechanic")},
        {"tag": "dealership", "customers": tag_counts["dealership"], "calls": tag_calls["dealership"], "count": tag_counts["dealership"], "est_value": sum(c["est_value"] for c in all_custs if c["tag"] == "dealership")},
        {"tag": "regular", "customers": tag_counts["regular"], "calls": tag_calls["regular"], "count": tag_counts["regular"], "est_value": sum(c["est_value"] for c in all_custs if c["tag"] == "regular")},
        {"tag": "retail", "customers": tag_counts["retail"], "calls": tag_calls["retail"], "count": tag_counts["retail"], "est_value": sum(c["est_value"] for c in all_custs if c["tag"] == "retail")},
    ]

    return {
        "total_customers": len(all_custs),
        "repeat_customers": sum(1 for c in all_custs if c["calls"] > 1),
        "avg_order_value": 350.0,
        "avg_order_basis": "ai",
        "most_calls": sorted(all_custs, key=lambda x: x["calls"], reverse=True)[:15],
        "most_orders": sorted(all_custs, key=lambda x: x["orders"], reverse=True)[:15],
        "top_value": sorted(all_custs, key=lambda x: x["est_value"], reverse=True)[:15],
        "suggested": [c for c in all_custs if c["calls"] >= 2 and c["orders"] == 0][:15] or all_custs[:15],
        "win_back": [c for c in all_custs if c["orders"] > 0][:15],
        "type_breakdown": type_breakdown,
        "all_customers": all_custs[:50],
    }


@router.get("/api/analytics/parts-seasonal")
def get_parts_seasonal(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    # Computed from each yard's own calls.  The old Keech seed carried demo
    # counts that did not correspond to any real call, so its cells opened a
    # different number of calls than they displayed.
    return _build_parts_seasonal(st, org_id)


@router.get("/api/analytics/vehicles")
def get_vehicles(
    request: Request,
    rank: str = Query("calls"),
    body: Optional[str] = Query(None),
    site_id: Optional[str] = Query(None),
) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    if org_id == store.KEECH_ORG_ID and not site_id:
        base = st["seed"].get("/analytics/vehicles?rank=calls", {})
        if not body or body == "all":
            return base

        res = copy.deepcopy(base)
        models = [m for m in res.get("models", []) if m.get("body_type") == body]
        res["models"] = models

        # Filter makes to only those that have models matching this body style
        allowed_makes = set(m["make"] for m in models)
        makes = [mk for mk in res.get("makes", []) if mk.get("make") in allowed_makes]
        res["makes"] = makes
        return res
    return ya.build_vehicle_demand(st, org_id, rank=rank, body=body, site_id=site_id)


@router.get("/api/analytics/lost-vehicles")
def get_lost_vehicles(
    request: Request,
    rank: str = Query("calls"),
    body: Optional[str] = Query(None),
    site_id: Optional[str] = Query(None),
) -> list[dict[str, Any]]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    if org_id == store.KEECH_ORG_ID and not site_id:
        base_lost = st["seed"].get("/analytics/lost-vehicles?rank=calls", [])
        if not body or body == "all":
            return base_lost
        return [lv for lv in base_lost if lv.get("body_type") == body]
    return ya.build_lost_vehicles(st, org_id, rank=rank, body=body, site_id=site_id)


@router.get("/api/analytics/stock-alerts")
def get_stock_alerts(
    request: Request,
    rank: str = Query("calls"),
    site_id: Optional[str] = Query(None),
) -> list[dict[str, Any]]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    if org_id == store.KEECH_ORG_ID and not site_id:
        return st["seed"].get("/analytics/stock-alerts?rank=calls", [])
    return ya.build_stock_alerts(st, org_id, rank=rank, site_id=site_id)


@router.get("/api/analytics/customers")
def get_analytics_customers(
    request: Request,
    rep_id: Optional[str] = Query(None),
    tag: Optional[str] = Query(None),
    include_all: bool = Query(False),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    effective_rep_id = ya.scoped_rep_id(u, rep_id, st)
    return ya.build_customer_insights(
        st,
        org_id,
        rep_id=effective_rep_id,
        tag=tag,
        include_all=include_all,
        date_from=date_from,
        date_to=date_to,
    )


@router.get("/api/customers/{key}")
def get_customer_profile(key: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    if not _customer_visible(st, key, u):
        raise HTTPException(status_code=404, detail="Customer not found")
    org_id = effective_org(u)
    store_key = _customer_store_key(key, u)
    profile = ya._customer_profile(st, org_id, key)
    manual_tag = ya._manual_tag(st, org_id, key)
    full_custs = st.get("full_customers", {})
    full = full_custs.get(key)
    if isinstance(full, dict):
        record_org = (full.get("stat") or {}).get("org_id") or full.get("org_id")
        # Platform staff may read every yard.  A yard may only read its own
        # full-customer record; legacy Keech records predate ``org_id``.
        if org_id is None or record_org == org_id or (not record_org and org_id == store.KEECH_ORG_ID):
            full_stat = full.setdefault("stat", {})
            if isinstance(full_stat, dict):
                full_stat["name"] = profile.get("name") or full_stat.get("name") or key
                full_stat["email"] = str(profile.get("email") or "")
                full_stat["text_ok"] = profile.get("text_ok") if "text_ok" in profile else None
                if manual_tag:
                    full_stat["tag"] = manual_tag
                    full_stat["tag_source"] = "manual"
            return full

    calls = [
        c for c in st.get("calls", [])
        if (not org_id or c.get("org_id") == org_id)
        and (c.get("customer_name") == key or c.get("customer_phone") == key)
    ]
    calls.sort(key=lambda c: c.get("created_at", ""), reverse=True)
    metric_calls = [c for c in calls if not c.get("delivery_call")]
    topics: list[str] = []
    for c in calls[:5]:
        for topic in (c.get("topics") or []):
            if topic and topic not in topics:
                topics.append(str(topic))
    stat = {
        "key": key,
        "name": profile.get("name") or (calls[0].get("customer_name") if calls else key) or key,
        "phone": calls[0].get("customer_phone", "") if calls else "",
        "calls": len(calls),
        "orders": sum(1 for c in metric_calls if c.get("outcome") == "won"),
        "talk_sec": sum(int(c.get("duration_sec") or 0) for c in calls),
        "last_call_at": calls[0].get("created_at", store.now_iso()) if calls else store.now_iso(),
        "last_call_id": calls[0].get("id", "") if calls else "",
        "last_category": calls[0].get("category", "Sales Inquiry") if calls else "Sales Inquiry",
        "top_topics": topics or ["Part Inquiry"],
        "rep_names": list({c.get("rep_name") for c in calls if c.get("rep_name")}),
        "tag": manual_tag,
        "tag_source": "manual" if manual_tag else "",
        "email": str(profile.get("email") or ""),
        "text_ok": profile.get("text_ok") if "text_ok" in profile else None,
        "est_value": sum(float(c.get("order_value") or 0) for c in metric_calls) or 350.0,
        "value_basis": "ai",
    }
    notes = st.get("customer_notes", {}).get(store_key, [])
    return {"stat": stat, "calls": calls[:20], "notes": notes}


@router.put("/api/customers/{key}/tag")
def put_customer_tag(key: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    if not _customer_visible(st, key, u):
        raise HTTPException(status_code=404, detail="Customer not found")
    tag = body.get("tag") or ""
    if not isinstance(tag, str) or len(tag) > 64:
        raise HTTPException(status_code=400, detail="tag must be a string of 64 characters or fewer")
    org_id = effective_org(u)
    for store_key in ya.customer_store_keys(org_id, key):
        st.setdefault("customer_tags", {})[store_key] = tag
    prof = get_customer_profile(key, request)
    prof["stat"]["tag"] = tag
    prof["stat"]["tag_source"] = "manual"
    store.save_state()
    return prof["stat"]


@router.put("/api/customers/{key}/profile")
def put_customer_profile(key: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    if not _customer_visible(st, key, u):
        raise HTTPException(status_code=404, detail="Customer not found")
    if not is_manager(u):
        raise HTTPException(status_code=403, detail="Manager access required to edit customer details")
    name = body.get("name", "")
    if not isinstance(name, str):
        raise HTTPException(status_code=400, detail="name must be a string")
    name = name.strip()
    if len(name) > 120:
        raise HTTPException(status_code=400, detail="name is too long (max 120 characters)")
    email = body.get("email", "")
    if not isinstance(email, str):
        raise HTTPException(status_code=400, detail="email must be a string")
    email = email.strip()
    if email:
        email = validate_email(email)
    text_ok = body.get("text_ok", None)
    if text_ok is not None and not isinstance(text_ok, bool):
        raise HTTPException(status_code=400, detail="text_ok must be true, false, or null")
    org_id = effective_org(u)
    record = {
        "name": name,
        "email": email,
        "text_ok": text_ok,
        "updated_at": store.now_iso(),
        "updated_by": u.get("id", ""),
    }
    for store_key in ya.customer_store_keys(org_id, key):
        st.setdefault("customer_profiles", {})[store_key] = dict(record)
    store.save_state()
    prof = get_customer_profile(key, request)
    prof["stat"]["name"] = name or prof["stat"].get("name", key)
    prof["stat"]["email"] = email
    prof["stat"]["text_ok"] = text_ok
    return prof["stat"]


@router.post("/api/customers/bulk-tag")
def post_customers_bulk_tag(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    keys = body.get("keys", [])
    if not isinstance(keys, list):
        raise HTTPException(status_code=400, detail="keys must be a list")
    if len(keys) > 500:
        raise HTTPException(status_code=400, detail="Too many customers in one request (max 500)")
    blocked = [k for k in keys if not isinstance(k, str) or not _customer_visible(st, k, u)]
    if blocked:
        raise HTTPException(status_code=403, detail="You cannot tag another yard's customers")
    tag = body.get("tag") or ""
    if not isinstance(tag, str) or len(tag) > 64:
        raise HTTPException(status_code=400, detail="tag must be a string of 64 characters or fewer")
    org_id = effective_org(u)
    for k in keys:
        for store_key in ya.customer_store_keys(org_id, k):
            st.setdefault("customer_tags", {})[store_key] = tag
    store.save_state()
    return {"updated": len(keys)}


@router.post("/api/customers/confirm-suggested")
def post_customers_confirm_suggested(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    keys = body.get("keys", [])
    if not isinstance(keys, list):
        raise HTTPException(status_code=400, detail="keys must be a list")
    if len(keys) > 500:
        raise HTTPException(status_code=400, detail="Too many customers in one request (max 500)")
    blocked = [k for k in keys if not isinstance(k, str) or not _customer_visible(st, k, u)]
    if blocked:
        raise HTTPException(status_code=403, detail="You cannot tag another yard's customers")
    org_id = effective_org(u)
    updated = 0
    for key in keys:
        if ya._manual_tag(st, org_id, key):
            continue
        profile = ya._customer_profile(st, org_id, key)
        name = str(profile.get("name") or "")
        if not name:
            phone = ya.normalize_phone(key)
            matches = [
                c for c in st.get("calls", [])
                if (not org_id or c.get("org_id") == org_id)
                and (
                    c.get("customer_name") == key
                    or (phone and ya.normalize_phone(c.get("customer_phone")) == phone)
                )
            ]
            if matches:
                latest = max(matches, key=lambda c: c.get("created_at") or "")
                name = str(latest.get("customer_name") or "")
        tag, _ = infer_customer_tag(name)
        if tag == "untagged":
            continue
        for store_key in ya.customer_store_keys(org_id, key):
            st.setdefault("customer_tags", {})[store_key] = tag
        updated += 1
    store.save_state()
    return {"updated": updated}


@router.post("/api/customers/{key}/notes")
def post_customer_note(key: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    if not _customer_visible(st, key, u):
        raise HTTPException(status_code=404, detail="Customer not found")
    text = body.get("text", "")
    if not isinstance(text, str):
        raise HTTPException(status_code=400, detail="text must be a string")
    text = text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Note text is required")
    if len(text) > 4000:
        raise HTTPException(status_code=400, detail="Note text is too long (max 4000 characters)")
    note = {
        "id": str(uuid.uuid4()),
        "customer_key": key,
        "text": text,
        "author": u.get("name", "Rep"),
        "created_at": store.now_iso(),
    }
    store_key = _customer_store_key(key, u)
    st.setdefault("customer_notes", {}).setdefault(store_key, []).insert(0, note)
    store.save_state()
    return note


@router.post("/api/customers/{key}/winback")
def post_customer_winback(key: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    if not _customer_visible(st, key, u):
        raise HTTPException(status_code=404, detail="Customer not found")
    org_id = effective_org(u)
    outcome = str(body.get("outcome") or "reached").strip().lower()
    if outcome not in ("reached", "ordered", "no_interest"):
        raise HTTPException(status_code=400, detail="outcome must be reached, ordered, or no_interest")
    calls = [
        c for c in st.get("calls", [])
        if (org_id is None or c.get("org_id") == org_id)
        and (c.get("customer_name") == key or c.get("customer_phone") == key)
    ]
    calls.sort(key=lambda c: c.get("created_at", ""), reverse=True)
    mark = {
        "id": str(uuid.uuid4()),
        "org_id": org_id,
        "customer_key": key,
        "customer_name": (calls[0].get("customer_name") if calls else "") or key,
        "customer_phone": (calls[0].get("customer_phone") if calls else "") or "",
        "outcome": outcome,
        "rep_id": u["id"],
        "rep_name": u.get("name") or "Rep",
        "created_at": store.now_iso(),
    }
    st.setdefault("winback_marks", []).insert(0, mark)
    store.save_state()
    confirmed, call_id, value = ya._winback_confirmation(st, mark)
    return {**mark, "confirmed": confirmed, "confirmed_call_id": call_id, "confirmed_value": value}


# Winback
@router.get("/api/analytics/winback")
def get_analytics_winback(
    request: Request,
    rep_id: Optional[str] = Query(None),
    site_id: Optional[str] = Query(None),
) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    effective_rep_id = ya.scoped_rep_id(u, rep_id, st)
    return ya.build_winback_results(st, org_id, rep_id=effective_rep_id, site_id=site_id)


@router.get("/api/analytics/winback/leaderboard")
def get_winback_leaderboard(
    request: Request,
    month: Optional[str] = Query(None),
    site_id: Optional[str] = Query(None),
) -> dict[str, Any]:
    st = store.get_state()
    org_id = effective_org(get_current_user(request))
    return ya.build_winback_leaderboard(st, org_id, month=month, site_id=site_id)


@router.get("/api/analytics/winback/trophies")
def get_winback_trophies(request: Request, site_id: Optional[str] = Query(None)) -> dict[str, Any]:
    st = store.get_state()
    org_id = effective_org(get_current_user(request))
    return ya.build_winback_trophies(st, org_id, site_id=site_id)


@router.get("/api/analytics/winback/winners")
def get_winback_winners(request: Request, site_id: Optional[str] = Query(None)) -> dict[str, Any]:
    st = store.get_state()
    org_id = effective_org(get_current_user(request))
    return ya.build_winback_winners(st, org_id, site_id=site_id)


# Watchlist
@router.get("/api/watchlist")
def get_watchlist(request: Request) -> list[dict[str, Any]]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    items = st.get("watchlist", [])
    if org_id:
        return [
            w for w in items
            if w.get("org_id") == org_id
            or (org_id == store.KEECH_ORG_ID and not w.get("org_id"))
        ]
    return items


@router.post("/api/watchlist")
def post_watchlist(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    item = {
        "id": str(uuid.uuid4()),
        "org_id": org_id,
        "make": body.get("make", ""),
        "model": body.get("model", ""),
        "year_from": body.get("year_from"),
        "year_to": body.get("year_to"),
        "part": body.get("part", ""),
        "label": f"{body.get('year_from') or ''}–{body.get('year_to') or ''} {body.get('make', '')} {body.get('model', '')}".strip(),
        "calls_7d": 0,
        "calls_30d": 0,
        "prev_30d": 0,
        "orders_30d": 0,
        "lost_30d": 0,
        "top_parts": [body.get("part") or "Engine"],
    }
    st.setdefault("watchlist", []).insert(0, item)
    store.save_state()
    return item


@router.delete("/api/watchlist/{wid}")
def delete_watchlist(wid: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    target = next((w for w in st.get("watchlist", []) if w.get("id") == wid), None)
    if not target:
        raise HTTPException(status_code=404, detail="Watchlist item not found")
    assert_same_org(u, target.get("org_id"))
    st["watchlist"] = [w for w in st.get("watchlist", []) if w.get("id") != wid]
    store.save_state()
    return {"ok": True}


@router.get("/api/watchlist/email")
def get_watchlist_email(request: Request) -> dict[str, Any]:
    u = get_current_user(request)
    st = store.get_state()
    org_id = effective_org(u)
    if org_id:
        return st.setdefault("watchlist_email_by_org", {}).get(
            org_id, {"enabled": False, "recipient_email": "", "last_sent_at": None}
        )
    return st.get("watchlist_email", {})


@router.put("/api/watchlist/email")
def put_watchlist_email(body: dict[str, Any], request: Request) -> dict[str, Any]:
    u = get_current_user(request)
    if not is_manager(u):
        raise HTTPException(status_code=403, detail="Manager access required")
    st = store.get_state()
    org_id = effective_org(u)
    if org_id:
        cur = st.setdefault("watchlist_email_by_org", {}).setdefault(org_id, {})
        cur.update({k: v for k, v in body.items() if k in {"enabled", "recipient_email", "last_sent_at"}})
        store.save_state()
        return cur
    st["watchlist_email"] = {**st.get("watchlist_email", {}), **body}
    store.save_state()
    return st["watchlist_email"]


# Keywords
@router.get("/api/keywords")
def get_keywords(request: Request) -> list[dict[str, Any]]:
    u = get_current_user(request)
    st = store.get_state()
    org_id = effective_org(u)
    items = st.get("keywords", [])
    if org_id:
        return [k for k in items if k.get("org_id") in (None, "", org_id)]
    return items


@router.post("/api/keywords")
def post_keyword(body: dict[str, Any], request: Request) -> dict[str, Any]:
    u = get_current_user(request)
    if not is_manager(u):
        raise HTTPException(status_code=403, detail="Manager access required")
    st = store.get_state()
    kw = {
        "id": str(uuid.uuid4()),
        "org_id": effective_org(u) or "",
        "keyword": str(body.get("keyword", ""))[:120],
        "group": str(body.get("group", "Custom"))[:60],
    }
    st.setdefault("keywords", []).append(kw)
    store.save_state()
    return kw


@router.put("/api/keywords/{kid}")
def put_keyword(kid: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    u = get_current_user(request)
    if not is_manager(u):
        raise HTTPException(status_code=403, detail="Manager access required")
    st = store.get_state()
    for kw in st.get("keywords", []):
        if kw.get("id") == kid:
            if kw.get("org_id"):
                assert_same_org(u, kw.get("org_id"))
            kw["keyword"] = str(body.get("keyword", kw["keyword"]))[:120]
            kw["group"] = str(body.get("group", kw["group"]))[:60]
            store.save_state()
            return kw
    raise HTTPException(status_code=404, detail="Keyword not found")


@router.delete("/api/keywords/{kid}")
def delete_keyword(kid: str, request: Request) -> dict[str, Any]:
    u = get_current_user(request)
    if not is_manager(u):
        raise HTTPException(status_code=403, detail="Manager access required")
    st = store.get_state()
    target = next((k for k in st.get("keywords", []) if k.get("id") == kid), None)
    if not target:
        raise HTTPException(status_code=404, detail="Keyword not found")
    if target.get("org_id"):
        assert_same_org(u, target.get("org_id"))
    st["keywords"] = [k for k in st.get("keywords", []) if k.get("id") != kid]
    store.save_state()
    return {"ok": True}


@router.get("/api/keywords/alerts")
def get_keyword_alerts(request: Request, site_id: Optional[str] = Query(None)) -> list[dict[str, Any]]:
    st = store.get_state()
    org_id = effective_org(get_current_user(request))
    return ya.build_keyword_alerts(st, org_id, site_id=site_id)


@router.get("/api/keywords/rep-usage")
def get_keyword_rep_usage(request: Request, site_id: Optional[str] = Query(None)) -> list[dict[str, Any]]:
    st = store.get_state()
    org_id = effective_org(get_current_user(request))
    return ya.build_keyword_rep_usage(st, org_id, site_id=site_id)


@router.get("/api/keywords/suggestions")
def get_keyword_suggestions(request: Request) -> list[dict[str, Any]]:
    st = store.get_state()
    org_id = effective_org(get_current_user(request))
    items = st.get("keyword_suggestions", [])
    if org_id is None:
        return items
    return [
        s for s in items
        if s.get("org_id") == org_id or (org_id == store.KEECH_ORG_ID and not s.get("org_id"))
    ]


@router.post("/api/keywords/suggestions/dismiss")
@router.post("/api/keywords/suggestions/restore")
def post_keyword_suggestion_action() -> dict[str, Any]:
    return {"ok": True}


@router.get("/api/keywords/{kid}/calls")
def get_keyword_calls(
    kid: str,
    request: Request,
    month: Optional[str] = Query(None),
    site_id: Optional[str] = Query(None),
) -> list[dict[str, Any]]:
    st = store.get_state()
    org_id = effective_org(get_current_user(request))
    keyword = next(
        (
            k for k in (st.get("keywords", []) or [])
            if k.get("id") == kid and (org_id is None or k.get("org_id") in (None, "", org_id))
        ),
        None,
    )
    if not keyword:
        keyword = next((k for k in ya.DEFAULT_KEYWORDS if k.get("id") == kid), None)
    if not keyword:
        return []
    return ya.build_keyword_calls(st, org_id, keyword, month=month, site_id=site_id)


# Arrivals & Yard Inventory Lifecycle
def require_inventory_permission(user: dict[str, Any]) -> None:
    role = user.get("role", "")
    if role not in ("owner", "inventory_manager", "master", "admin", "manager", "sales_manager"):
        raise HTTPException(
            status_code=403,
            detail="Only Owners and Inventory Managers can manage yard inventory and crushing queues.",
        )


@router.get("/api/arrivals")
def get_arrivals(request: Request) -> list[dict[str, Any]]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    items = [a for a in st.get("arrivals", []) if not org_id or a.get("org_id") == org_id]

    now_dt = datetime.now(timezone.utc)
    purged_ids: set[str] = set()
    surviving = []

    MODEL_BODY_MAP = {
        "f-150": "pickup", "f-250": "pickup", "f-350": "pickup", "silverado": "pickup",
        "silverado 1500": "pickup", "silverado 2500": "pickup", "sierra": "pickup",
        "sierra 1500": "pickup", "ram 1500": "pickup", "ram 2500": "pickup", "1500": "pickup",
        "2500": "pickup", "tacoma": "pickup", "tundra": "pickup", "colorado": "pickup",
        "canyon": "pickup", "ranger": "pickup", "frontier": "pickup",
        "grand cherokee": "suv", "cherokee": "suv", "wrangler": "suv", "explorer": "suv",
        "equinox": "suv", "traverse": "suv", "tahoe": "suv", "suburban": "suv", "yukon": "suv",
        "rav4": "suv", "highlander": "suv", "4runner": "suv", "cr-v": "suv", "pilot": "suv",
        "rogue": "suv", "pathfinder": "suv", "tucson": "suv", "cx-5": "suv", "outback": "suv",
        "transit": "van", "grand caravan": "van", "caravan": "van", "pacifica": "van",
        "promaster": "van", "express": "van", "sienna": "van", "odyssey": "van",
        "camry": "car", "corolla": "car", "accord": "car", "civic": "car", "altima": "car",
        "sentra": "car", "fusion": "car", "malibu": "car", "impala": "car", "optima": "car",
        "elantra": "car", "sonata": "car", "charger": "car", "3 series": "car", "328i": "car",
    }

    for a in items:
        status = a.get("inventory_status") or "newly_arrived"
        a["inventory_status"] = status
        for caller in a.get("callers", []):
            profile = ya._customer_profile(
                st,
                a.get("org_id") or org_id,
                caller.get("customer_phone") or caller.get("customer_name") or "",
            )
            caller["text_ok"] = profile.get("text_ok") if "text_ok" in profile else None

        if not a.get("body_type"):
            m = (a.get("vehicle_model") or "").strip().lower()
            make = (a.get("vehicle_make") or "").strip().lower()
            if m in MODEL_BODY_MAP:
                a["body_type"] = MODEL_BODY_MAP[m]
            elif "pickup" in m or "truck" in m or "1500" in m or "tacoma" in m or "silverado" in m or "f-150" in m:
                a["body_type"] = "pickup"
            elif "suv" in m or "cherokee" in m or "explorer" in m or "equinox" in m or "tahoe" in m or "cr-v" in m:
                a["body_type"] = "suv"
            elif "van" in m or "transit" in m or "caravan" in m:
                a["body_type"] = "van"
            elif "car" in m or "sedan" in m or "camry" in m or "civic" in m or "accord" in m or "altima" in m:
                a["body_type"] = "car"
            elif make == "ram":
                a["body_type"] = "pickup"
            elif make == "jeep":
                a["body_type"] = "suv"
            else:
                a["body_type"] = "other"

        # If vehicle is in crushing queue, check deadline
        if status == "to_be_crushed":
            days = a.get("days_until_crushed")
            if days is not None and int(days) <= 0:
                purged_ids.add(a.get("id"))
                continue
            deadline_str = a.get("crush_deadline")
            if deadline_str:
                try:
                    deadline_dt = datetime.fromisoformat(deadline_str.replace("Z", "+00:00"))
                    if now_dt >= deadline_dt:
                        # Vehicle hit crush deadline -> purged entirely
                        purged_ids.add(a.get("id"))
                        continue
                    diff = deadline_dt - now_dt
                    a["days_remaining"] = max(0, int(diff.total_seconds() // 86400) + (1 if diff.total_seconds() % 86400 > 0 else 0))
                except Exception:
                    a["days_remaining"] = days or 0
            else:
                a["days_remaining"] = days or 0

        surviving.append(a)

    if purged_ids:
        st["arrivals"] = [a for a in st.get("arrivals", []) if a.get("id") not in purged_ids]
        store.save_state()

    return surviving


@router.post("/api/arrivals")
def post_arrival(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    require_inventory_permission(u)
    org_id = effective_org(u)
    aid = str(uuid.uuid4())
    try:
        year = int(body.get("vehicle_year") or 2018)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Vehicle year must be a number")
    if year < 1900 or year > 2100:
        raise HTTPException(status_code=400, detail="Vehicle year is out of range")
    make = str(body.get("vehicle_make", "") or "")[:80]
    model = str(body.get("vehicle_model", "") or "")[:80]

    matching_callers = []
    yard_calls = [c for c in st.get("calls", []) if not org_id or c.get("org_id") == org_id]
    for c in yard_calls[:40]:
        vehicle = ya.vehicle_for_call(st, c)
        if make.lower() in (vehicle.get("make") or "").lower():
            profile = ya._customer_profile(
                st,
                org_id,
                c.get("customer_phone") or c.get("customer_name") or "",
            )
            matching_callers.append({
                "key": c.get("customer_name", "Caller"),
                "customer_name": c.get("customer_name", "Caller"),
                "customer_phone": c.get("customer_phone", "+15551234567"),
                "text_ok": profile.get("text_ok") if "text_ok" in profile else None,
                "vehicle": f"{year} {make} {model}".strip(),
                "parts": [vehicle.get("part") or c.get("part_requested") or "Part"],
                "exact_year": True,
                "last_asked": c.get("created_at", store.now_iso()),
                "times_asked": 1,
                "rep_id": c.get("rep_id", ""),
                "rep_name": c.get("rep_name", ""),
                "last_call_id": c.get("id", ""),
                "status": "to_call",
                "sold_price": None,
                "parts_sold": [],
                "updated_by": "",
                "texted_at": None,
                "text": "",
                "updated_at": None,
                "replied_at": None,
                "reply_call_id": "",
                "ordered_at": None,
                "sms_sid": "",
                "sms_status": "",
                "sms_error": "",
                "sms_reply": "",
                "sms_replied_at": None,
            })

    new_arr = {
        "id": aid,
        "org_id": org_id,
        "vehicle_year": year,
        "vehicle_make": make,
        "vehicle_model": model,
        "note": body.get("note", ""),
        "stock_number": body.get("stock_number", f"STK-{uuid.uuid4().hex[:5].upper()}"),
        "year_span": body.get("year_span", 2),
        "cost": body.get("cost"),
        "inventory_status": "newly_arrived",
        "checked_in_at": None,
        "checked_in_by": None,
        "queued_for_crush_at": None,
        "days_until_crushed": None,
        "crush_deadline": None,
        "days_remaining": None,
        "callback_list_id": "",
        "created_by": u.get("name", "Manager"),
        "created_at": store.now_iso(),
        "callers": matching_callers[:8],
        "blasts": [],
        "results": {
            "callers": len(matching_callers[:8]),
            "contacted": 0,
            "texted": 0,
            "replied": 0,
            "sold": 0,
            "orders": 0,
            "first_sale_days": None,
            "revenue": 0.0,
            "revenue_estimated": False,
            "profit": None,
        },
    }
    st.setdefault("arrivals", []).insert(0, new_arr)
    store.save_state()
    return new_arr


@router.post("/api/arrivals/check-in")
def check_in_arrivals(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    require_inventory_permission(u)
    org_id = effective_org(u)
    ids = set(body.get("ids", []))
    if not ids:
        raise HTTPException(status_code=400, detail="No vehicle IDs provided for check-in")

    updated = []
    for a in st.get("arrivals", []):
        if a.get("id") in ids and (not org_id or a.get("org_id") == org_id):
            a["inventory_status"] = "yard_inventory"
            a["checked_in_at"] = store.now_iso()
            a["checked_in_by"] = u.get("name", "Manager")
            updated.append(a.get("id"))

    store.save_state()
    return {"ok": True, "count": len(updated), "updated_ids": updated}


@router.post("/api/arrivals/queue-crush")
def queue_crush_arrivals(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    require_inventory_permission(u)
    org_id = effective_org(u)
    ids = set(body.get("ids", []))
    if not ids:
        raise HTTPException(status_code=400, detail="No vehicle IDs provided for crush queue")

    try:
        days = int(body.get("days") or 30)
    except (ValueError, TypeError):
        days = 30
    days = max(1, days)

    now_dt = datetime.now(timezone.utc)
    deadline_dt = now_dt + timedelta(days=days)

    updated = []
    for a in st.get("arrivals", []):
        if a.get("id") in ids and (not org_id or a.get("org_id") == org_id):
            a["inventory_status"] = "to_be_crushed"
            a["queued_for_crush_at"] = now_dt.isoformat()
            a["days_until_crushed"] = days
            a["crush_deadline"] = deadline_dt.isoformat()
            a["days_remaining"] = days
            updated.append(a.get("id"))

    store.save_state()
    return {"ok": True, "count": len(updated), "updated_ids": updated}


@router.patch("/api/arrivals/{aid}/crush-days")
def patch_crush_days(aid: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    require_inventory_permission(u)
    org_id = effective_org(u)

    val = body.get("days")
    if val is None:
        raise HTTPException(status_code=400, detail="Days count is required")
    try:
        days = int(val)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="Days must be a valid number")

    # If days <= 0, the vehicle hits its crush deadline immediately: purge it entirely!
    if days <= 0:
        initial_len = len(st.get("arrivals", []))
        st["arrivals"] = [a for a in st.get("arrivals", []) if a.get("id") != aid or (org_id and a.get("org_id") != org_id)]
        if len(st["arrivals"]) < initial_len:
            store.save_state()
            return {"ok": True, "crushed": True, "id": aid, "message": "Vehicle hit crush deadline and was removed entirely."}
        raise HTTPException(status_code=404, detail="Vehicle not found in queue")

    for a in st.get("arrivals", []):
        if a.get("id") == aid and (not org_id or a.get("org_id") == org_id):
            now_dt = datetime.now(timezone.utc)
            deadline_dt = now_dt + timedelta(days=days)
            a["days_until_crushed"] = days
            a["crush_deadline"] = deadline_dt.isoformat()
            a["days_remaining"] = days
            store.save_state()
            return a

    raise HTTPException(status_code=404, detail="Vehicle not found")


@router.post("/api/arrivals/{aid}/crush")
def post_crush_now(aid: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    require_inventory_permission(u)
    org_id = effective_org(u)

    initial_len = len(st.get("arrivals", []))
    st["arrivals"] = [a for a in st.get("arrivals", []) if a.get("id") != aid or (org_id and a.get("org_id") != org_id)]
    if len(st["arrivals"]) < initial_len:
        store.save_state()
        return {"ok": True, "crushed": True, "id": aid, "message": "Vehicle crushed and removed from inventory."}
    raise HTTPException(status_code=404, detail="Vehicle not found")


@router.post("/api/arrivals/{aid}/restore")
def post_restore_from_crush(aid: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    require_inventory_permission(u)
    org_id = effective_org(u)

    for a in st.get("arrivals", []):
        if a.get("id") == aid and (not org_id or a.get("org_id") == org_id):
            a["inventory_status"] = "yard_inventory"
            a["queued_for_crush_at"] = None
            a["days_until_crushed"] = None
            a["crush_deadline"] = None
            a.pop("days_remaining", None)
            store.save_state()
            return a

    raise HTTPException(status_code=404, detail="Vehicle not found")


@router.delete("/api/arrivals/{aid}")
def delete_arrival(aid: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    require_inventory_permission(u)
    org_id = effective_org(u)
    target = next((a for a in st.get("arrivals", []) if a.get("id") == aid), None)
    if not target:
        raise HTTPException(status_code=404, detail="Arrival not found")
    assert_same_org(u, target.get("org_id"))
    st["arrivals"] = [a for a in st.get("arrivals", []) if a.get("id") != aid]
    store.save_state()
    return {"ok": True}


@router.patch("/api/arrivals/{aid}/cost")
def patch_arrival_cost(aid: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    require_inventory_permission(u)
    for a in st.get("arrivals", []):
        if a.get("id") == aid:
            assert_same_org(u, a.get("org_id"))
            a["cost"] = body.get("cost")
            store.save_state()
            return a
    raise HTTPException(status_code=404, detail="Arrival not found")


@router.patch("/api/arrivals/{aid}/callers/{key}")
def patch_arrival_caller(aid: str, key: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    for a in st.get("arrivals", []):
        if a.get("id") == aid:
            assert_same_org(u, a.get("org_id"))
            for c in a.get("callers", []):
                if c.get("key") == key:
                    c["status"] = body.get("status", c["status"])
                    if "sold_price" in body:
                        c["sold_price"] = body["sold_price"]
                    if "parts_sold" in body:
                        c["parts_sold"] = body["parts_sold"]
                    c["updated_by"] = u.get("name", "Rep")
                    c["updated_at"] = store.now_iso()
                    store.save_state()
                    return a
    raise HTTPException(status_code=404, detail="Arrival caller not found")


@router.post("/api/arrivals/{aid}/text")
def post_arrival_text(aid: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    for a in st.get("arrivals", []):
        if a.get("id") == aid:
            assert_same_org(u, a.get("org_id"))
            template = body.get("template", "")
            callers = a.get("callers", [])
            org_id = a.get("org_id") or effective_org(u)
            for caller in callers:
                profile = ya._customer_profile(
                    st,
                    org_id,
                    caller.get("customer_phone") or caller.get("customer_name") or "",
                )
                caller["text_ok"] = profile.get("text_ok") if "text_ok" in profile else caller.get("text_ok")
            eligible = [
                c for c in callers
                if c.get("status") in ("to_call", "called")
                and c.get("customer_phone")
                and c.get("text_ok") is True
                and "stop" not in (c.get("sms_reply") or "").lower()
            ]
            if not eligible:
                raise HTTPException(
                    status_code=400,
                    detail="No callers on this list are approved for texting. Set 'Can text' on each customer profile first.",
                )
            for c in eligible:
                c["texted_at"] = store.now_iso()
                c["text"] = template
            a.setdefault("blasts", []).append({
                "at": store.now_iso(),
                "by": u.get("name", "Manager"),
                "template": template,
                "count": len(eligible),
                "skipped": len(callers) - len(eligible),
                "mode": "practice",
                "failed": 0,
            })
            store.save_state()
            return a
    raise HTTPException(status_code=404, detail="Arrival not found")


@router.post("/api/arrivals/{aid}/callback-list")
def post_arrival_callback_list(aid: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    arrival = next((a for a in st.get("arrivals", []) if a.get("id") == aid), None)
    if not arrival:
        raise HTTPException(status_code=404, detail="Arrival not found")
    assert_same_org(u, arrival.get("org_id"))
    org_id = arrival.get("org_id") or effective_org(u)

    rep_ids = body.get("rep_ids")
    if not rep_ids and body.get("rep_id"):
        rep_ids = [body["rep_id"]]
    if not rep_ids:
        rep_ids = [u["id"]]
    if not isinstance(rep_ids, list):
        raise HTTPException(status_code=400, detail="rep_ids must be a list")

    # Every assignee must belong to the arrival's yard (platform staff may cross).
    resolved_reps = []
    for rid in rep_ids:
        rep = st.get("users_by_id", {}).get(str(rid))
        if not rep or rep.get("disabled"):
            raise HTTPException(status_code=400, detail="Unknown team member")
        if not is_staff(u) and rep.get("org_id") != org_id:
            raise HTTPException(status_code=403, detail="You cannot assign callers to another yard")
        resolved_reps.append(rep)
    if not resolved_reps:
        raise HTTPException(status_code=400, detail="Select at least one rep")

    created_lists = []
    base_name = body.get("name") or f"{arrival.get('vehicle_year')} {arrival.get('vehicle_make')} {arrival.get('vehicle_model')} callers"
    due_date = body.get("due_date") or ""
    waiting_callers = [c for c in arrival.get("callers", []) if c.get("status") == "to_call" and c.get("last_call_id")]

    # Index calls by call id for quick lookup (never across yard boundaries)
    calls_by_id = {
        c["id"]: c
        for c in st.get("calls", [])
        if c.get("id") and (not org_id or c.get("org_id") == org_id)
    }

    for rep in resolved_reps:
        lid = str(uuid.uuid4())
        
        # Add each waiting caller to callbacks_open under this rep and list
        items_added = 0
        for caller in waiting_callers:
            call_id = caller.get("last_call_id")
            original_call = calls_by_id.get(call_id, {})
            
            cb_item = dict(original_call)
            cb_item["id"] = f"cb_{uuid.uuid4().hex[:12]}"
            cb_item["original_call_id"] = call_id
            cb_item["org_id"] = org_id
            cb_item["rep_id"] = rep["id"]
            cb_item["rep_name"] = rep["name"]
            cb_item["customer_name"] = caller.get("customer_name") or cb_item.get("customer_name", "Caller")
            cb_item["customer_phone"] = caller.get("customer_phone") or cb_item.get("customer_phone", "+15551234567")
            cb_item["vehicle"] = caller.get("vehicle") or f"{arrival.get('vehicle_year')} {arrival.get('vehicle_make')} {arrival.get('vehicle_model')}".strip()
            cb_item["part_requested"] = (caller.get("parts") or ["Part"])[0] if isinstance(caller.get("parts"), list) and caller.get("parts") else cb_item.get("part_requested", "")
            cb_item["reason"] = f"Vehicle Arrival: {arrival.get('vehicle_year')} {arrival.get('vehicle_make')} {arrival.get('vehicle_model')}"
            cb_item["followed_up"] = False
            cb_item["followed_up_at"] = None
            cb_item["assigned_list_id"] = lid
            cb_item["assigned_list_name"] = base_name
            cb_item["assigned_by"] = u.get("name", "Manager")
            cb_item["assigned_by_id"] = u.get("id", "")
            cb_item["assigned_by_role"] = u.get("role", "")
            cb_item["assigned_note"] = body.get("note") or f"Vehicle arrived in stock ({arrival.get('stock_number', '')})"
            cb_item["list_due_date"] = due_date
            cb_item["list_overdue"] = False
            cb_item["arrival_id"] = aid
            
            st.setdefault("callbacks_open", []).insert(0, cb_item)
            items_added += 1

        new_list = {
            "id": lid,
            "org_id": org_id,
            "name": base_name,
            "rep_id": rep["id"],
            "rep_name": rep["name"],
            "created_by": u.get("name", "Manager"),
            "created_at": store.now_iso(),
            "open": items_added,
            "total": items_added,
            "done": 0,
            "sold": 0,
            "revenue": 0.0,
            "arrival_id": aid,
            "due_date": due_date,
            "overdue": False,
        }
        st.setdefault("callback_lists", []).insert(0, new_list)
        created_lists.append(new_list)

    if created_lists:
        arrival["callback_list_id"] = created_lists[0]["id"]
    store.save_state()
    return created_lists[0]


@router.get("/api/arrivals/leaderboard")
def get_arrivals_leaderboard(
    request: Request,
    month: Optional[str] = Query(None),
    site_id: Optional[str] = Query(None),
) -> dict[str, Any]:
    st = store.get_state()
    org_id = effective_org(get_current_user(request))
    return ya.build_arrivals_leaderboard(st, org_id, month=month, site_id=site_id)


@router.get("/api/arrivals/winner")
def get_arrivals_winner(request: Request, site_id: Optional[str] = Query(None)) -> dict[str, Any]:
    st = store.get_state()
    org_id = effective_org(get_current_user(request))
    return ya.build_arrivals_winner(st, org_id, site_id=site_id)


@router.get("/api/arrivals/streak-chase")
def get_arrivals_streak_chase(request: Request, site_id: Optional[str] = Query(None)) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    chase, _ = ya.build_arrivals_streak(st, org_id, user_id=u.get("id", ""), site_id=site_id)
    return chase


@router.get("/api/arrivals/streak-break")
def get_arrivals_streak_break(request: Request, site_id: Optional[str] = Query(None)) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    _, streak_break = ya.build_arrivals_streak(st, org_id, user_id=u.get("id", ""), site_id=site_id)
    return streak_break


# Callbacks & Callback Lists
@router.get("/api/callbacks")
def get_callbacks(
    request: Request,
    status: str = Query("open"),
    source: str = Query(""),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
) -> list[dict[str, Any]]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    if status == "resolved":
        items = st.get("callbacks_resolved", [])
    else:
        items = st.get("callbacks_open", [])
    if org_id:
        items = [i for i in items if i.get("org_id") == org_id]
    if date_from:
        items = [i for i in items if (i.get("created_at") or i.get("call_at") or "")[:10] >= date_from]
    if date_to:
        items = [i for i in items if (i.get("created_at") or i.get("call_at") or "")[:10] <= date_to]
    if source:
        if source == "inventory_manager":
            items = [
                i for i in items
                if (i.get("assigned_by_role") or "").lower() == "inventory_manager"
                or (i.get("reason") or "").lower().startswith("vehicle arrival")
            ]
        elif source == "sales_manager":
            items = [
                i for i in items
                if ((i.get("assigned_by_role") or "").lower() in ("sales_manager", "owner", "manager"))
                and not (i.get("reason") or "").lower().startswith("vehicle arrival")
            ]
        elif source == "missed":
            items = [i for i in items if not i.get("assigned_by")]
        elif source == "assigned":
            items = [i for i in items if i.get("assigned_by")]
        else:
            items = [i for i in items if i.get("assigned_list_id") == source]
    return items


@router.post("/api/callbacks/assign")
def post_callbacks_assign(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    if not is_manager(u):
        raise HTTPException(status_code=403, detail="Manager access required")
    org_id = resolve_write_org(u, body.get("org_id"))
    cids = {str(c) for c in body.get("call_ids", []) if c}
    if not cids:
        raise HTTPException(status_code=400, detail="Select at least one call to assign")

    rep_id = body.get("rep_id") or u.get("id")
    rep = st["users_by_id"].get(rep_id)
    if not rep:
        raise HTTPException(status_code=400, detail="Unknown team member")
    if not is_staff(u) and rep.get("org_id") != org_id:
        raise HTTPException(status_code=403, detail="You cannot assign calls to another yard")

    list_id = body.get("list_id", "") or ""
    lists = st.get("callback_lists", [])
    target_list = next((l for l in lists if l.get("id") == list_id), None)
    if list_id and not target_list:
        raise HTTPException(status_code=404, detail="Callback list not found")
    if target_list:
        assert_same_org(u, target_list.get("org_id"))
    list_name = target_list.get("name", "") if target_list else ""

    assigned = 0
    for c in st.get("calls", []):
        if c.get("id") not in cids:
            continue
        # Never let a manager pull another yard's call into their callback queue.
        if c.get("org_id") and c.get("org_id") != org_id:
            raise HTTPException(status_code=403, detail="Access denied")
        item = dict(c)
        item["org_id"] = org_id
        item["customer_phone"] = item.get("customer_phone") or "+15551234567"
        item["reason"] = body.get("note") or "Assigned by manager"
        item["followed_up"] = False
        item["followed_up_at"] = None
        item["assigned_list_id"] = list_id
        item["assigned_list_name"] = list_name
        item["assigned_by"] = u.get("name", "Manager")
        item["assigned_by_id"] = u.get("id", "")
        item["assigned_by_role"] = u.get("role", "")
        item["assigned_note"] = body.get("note", "")
        item["list_due_date"] = target_list.get("due_date", "") if target_list else ""
        item["list_overdue"] = False
        item["rep_id"] = rep["id"]
        item["rep_name"] = rep["name"]
        st.setdefault("callbacks_open", []).insert(0, item)
        assigned += 1

    if assigned == 0:
        raise HTTPException(status_code=404, detail="No matching calls found")
    if target_list:
        target_list["total"] = int(target_list.get("total") or 0) + assigned
        target_list["open"] = int(target_list.get("open") or 0) + assigned

    store.save_state()
    return {"assigned": assigned}


@router.get("/api/callback-lists")
def get_callback_lists(request: Request) -> list[dict[str, Any]]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    items = st.get("callback_lists", [])
    if org_id:
        return [l for l in items if l.get("org_id") == org_id]
    return items


@router.post("/api/callback-lists")
def post_callback_lists(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    if not is_manager(u):
        raise HTTPException(status_code=403, detail="Manager access required")
    org_id = resolve_write_org(u, body.get("org_id"))
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Give the callback list a name")

    rep_id = body.get("rep_id") or u["id"]
    rep = st["users_by_id"].get(rep_id)
    if not rep:
        raise HTTPException(status_code=400, detail="Unknown team member")
    if not is_staff(u) and rep.get("org_id") != org_id:
        raise HTTPException(status_code=403, detail="You cannot create a list for another yard")

    lid = str(uuid.uuid4())
    new_list = {
        "id": lid,
        "org_id": org_id,
        "name": name[:120],
        "rep_id": rep["id"],
        "rep_name": rep["name"],
        "created_by": u.get("name", "Manager"),
        "created_at": store.now_iso(),
        "open": 0,
        "total": 0,
        "done": 0,
        "sold": 0,
        "revenue": 0.0,
        "arrival_id": "",
        "due_date": body.get("due_date") or "",
        "overdue": False,
    }
    st.setdefault("callback_lists", []).insert(0, new_list)
    store.save_state()
    return new_list


@router.patch("/api/callback-lists/{lid}")
def patch_callback_list(lid: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    if not is_manager(u):
        raise HTTPException(status_code=403, detail="Manager access required")
    for l in st.get("callback_lists", []):
        if l.get("id") == lid:
            assert_same_org(u, l.get("org_id"))
            l["due_date"] = body.get("due_date") or ""
            store.save_state()
            return l
    raise HTTPException(status_code=404, detail="Callback list not found")


@router.delete("/api/callback-lists/{lid}")
def delete_callback_list(lid: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    if not is_manager(u):
        raise HTTPException(status_code=403, detail="Manager access required")
    target = next((l for l in st.get("callback_lists", []) if l.get("id") == lid), None)
    if not target:
        raise HTTPException(status_code=404, detail="Callback list not found")
    assert_same_org(u, target.get("org_id"))
    st["callback_lists"] = [l for l in st.get("callback_lists", []) if l.get("id") != lid]
    st["callbacks_open"] = [
        c for c in st.get("callbacks_open", [])
        if c.get("assigned_list_id") != lid or c.get("org_id") != target.get("org_id")
    ]
    store.save_state()
    return {"ok": True}


@router.get("/api/callback-lists/leaderboard")
def get_callback_lists_leaderboard(
    request: Request,
    month: Optional[str] = Query(None),
    site_id: Optional[str] = Query(None),
) -> dict[str, Any]:
    st = store.get_state()
    org_id = effective_org(get_current_user(request))
    return ya.build_list_leaderboard(st, org_id, month=month, site_id=site_id)


@router.post("/api/callback-lists/overdue-alerts/send-now")
def post_callback_lists_overdue_alerts(request: Request) -> dict[str, Any]:
    u = get_current_user(request)
    if not is_manager(u):
        raise HTTPException(status_code=403, detail="Manager access required")
    return {"lists": 0, "emails": 0, "texts": 0}


# Call Queue
@router.get("/api/queue")
def get_call_queue(request: Request, site_id: Optional[str] = Query(None)) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    return ya.build_queue(st, org_id, user=u, site_id=site_id)


@router.get("/api/queue/team")
def get_team_queue(request: Request, site_id: Optional[str] = Query(None)) -> dict[str, Any]:
    st = store.get_state()
    org_id = effective_org(get_current_user(request))
    return ya.build_team_queue(st, org_id, site_id=site_id)


# Leaderboards Hub
@router.get("/api/leaderboards/champions")
def get_leaderboards_champions(request: Request, site_id: Optional[str] = Query(None)) -> dict[str, Any]:
    st = store.get_state()
    org_id = effective_org(get_current_user(request))
    return ya.build_champions(st, org_id, site_id=site_id)


@router.get("/api/leaderboards/delivery")
def get_leaderboards_delivery(
    request: Request,
    month: Optional[str] = Query(None),
    site_id: Optional[str] = Query(None),
) -> dict[str, Any]:
    st = store.get_state()
    org_id = effective_org(get_current_user(request))
    return ya.build_delivery_board(st, org_id, month=month, site_id=site_id)


@router.get("/api/leaderboards/team-player")
def get_leaderboards_team_player(
    request: Request,
    month: Optional[str] = Query(None),
    site_id: Optional[str] = Query(None),
) -> dict[str, Any]:
    st = store.get_state()
    org_id = effective_org(get_current_user(request))
    return ya.build_team_player_board(st, org_id, month=month, site_id=site_id)


@router.post("/api/leaderboards/posters/send-now")
def post_leaderboards_posters_send_now() -> dict[str, Any]:
    return {
        "month": store.current_month_str(),
        "sent": 5,
        "champions": 3,
        "lot_sent": 1,
        "lots": 1,
    }


# Reports
@router.get("/api/reports/summary")
def get_reports_summary(
    request: Request,
    date_from: str = Query("2026-01-01"),
    date_to: str = Query("2026-12-31"),
    site_id: Optional[str] = Query(None),
    rep_id: Optional[str] = Query(None),
) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    effective_rep_id = ya.scoped_rep_id(u, rep_id, st)
    return ya.build_report_summary(
        st,
        org_id,
        date_from=date_from,
        date_to=date_to,
        rep_id=effective_rep_id,
        site_id=site_id,
    )
