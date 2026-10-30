from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from fastapi import APIRouter, HTTPException, Query, Request
from auth_utils import get_current_user
import store

router = APIRouter(tags=["analytics"])

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
    won = sum(1 for c in calls if c.get("outcome") == "won")
    lost = sum(1 for c in calls if c.get("outcome") == "lost")
    pending = sum(1 for c in calls if c.get("outcome") == "pending")
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
    org_id = u.get("org_id")

    org_calls = [c for c in st.get("calls", []) if not org_id or c.get("org_id") == org_id]
    
    # If signed in as an individual rep, default to viewing their own rep calls unless a specific rep_id is passed
    effective_rep_id = rep_id
    if not effective_rep_id and u.get("role") in ("rep", "sales_rep"):
        effective_rep_id = u.get("id")

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
        cat_counts.setdefault(c.get("category", "Other"), []).append(score)
        date_map.setdefault((c.get("created_at") or store.today_str())[:10], []).append(score)
        for t in c.get("topics", []):
            topic_counts[t] = topic_counts.get(t, 0) + 1
        try:
            h = int((c.get("created_at") or "")[11:13])
            hour_in[h] = hour_in.get(h, 0) + 1
        except ValueError:
            pass
        for k, v in (st.get("full_calls", {}).get(c.get("id"), {}).get("metrics") or {}).items():
            if k in metric_vals:
                metric_vals[k].append(v)
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
    user_keywords = st.get("keywords", [])
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

    base["roleplay_sessions"] = len([x for x in st.get("roleplay_sessions", []) if not org_id or st.get("users_by_id", {}).get(x.get("user_id"), {}).get("org_id") == org_id])
    base["open_callbacks"] = len([c for c in st.get("callbacks_open", []) if c.get("org_id") == org_id])
    base["lot_name"] = ""
    if effective_rep_id:
        u_rep = st.get("users_by_id", {}).get(effective_rep_id)
        if u_rep:
            base["rep"] = u_rep
    return base


@router.get("/api/analytics/team-benchmark")
def get_team_benchmark(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    calls = [c for c in st.get("calls", []) if not org_id or c.get("org_id") == org_id]
    reps = {x["id"] for x in st.get("users_by_id", {}).values() if x.get("role") in ("rep", "sales_rep")}
    calls = [c for c in calls if c.get("rep_id") in reps]
    s = _stats(st, calls)
    metric_vals: dict[str, list[float]] = {k: [] for k, _ in METRIC_NAMES}
    for c in calls:
        for k, v in (st.get("full_calls", {}).get(c.get("id"), {}).get("metrics") or {}).items():
            if k in metric_vals:
                metric_vals[k].append(v)
    return {
        "avg_score": s["avg_score"], "conversion_rate": s["conversion_rate"],
        "warranty_pitch_rate": s["warranty_pitch_rate"],
        "metric_averages": [
            {"key": k, "name": n, "avg": round(sum(metric_vals[k]) / len(metric_vals[k]), 1) if metric_vals[k] else 0}
            for k, n in METRIC_NAMES
        ],
    }


@router.get("/api/analytics/monthly")
def get_analytics_monthly(request: Request, rep_id: Optional[str] = Query(None)) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    calls = [c for c in st.get("calls", []) if not org_id or c.get("org_id") == org_id]
    if rep_id:
        calls = [c for c in calls if c.get("rep_id") == rep_id]

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
        m_sales = [c for c in mcalls if c.get("outcome") in ("won", "lost", "pending")]
        m_won = [c for c in mcalls if c.get("outcome") == "won"]
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


def _build_monthly_reps(st: dict[str, Any], org_id: Optional[str]) -> dict[str, Any]:
    calls = [c for c in st.get("calls", []) if not org_id or c.get("org_id") == org_id]
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
            m_won = sum(1 for c in mcalls if c.get("outcome") == "won")
            m_sales = sum(1 for c in mcalls if c.get("outcome") in ("won", "lost", "pending"))
            total_won += m_won
            total_sales += m_sales
            points.append({
                "month": m,
                "calls": len(mcalls),
                "sales_calls": m_sales,
                "won": m_won,
                "close_rate": round(m_won / max(m_sales, 1) * 100, 1) if m_sales else 0.0,
                "est_value": float(sum(c.get("order_value") or 0.0 for c in mcalls if c.get("outcome") == "won")),
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
def get_analytics_monthly_reps(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    return _build_monthly_reps(st, org_id)


@router.get("/api/analytics/parts-seasonal")
def get_parts_seasonal(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    if org_id == store.KEECH_ORG_ID:
        return st["seed"].get("/analytics/parts-seasonal", {})
    return {"categories": []}


@router.get("/api/analytics/vehicles")
def get_vehicles(request: Request, rank: str = Query("calls")) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    if org_id == store.KEECH_ORG_ID:
        return st["seed"].get("/analytics/vehicles?rank=calls", {})
    return {"vehicles": [], "makes": [], "models": []}


@router.get("/api/analytics/lost-vehicles")
def get_lost_vehicles(request: Request, rank: str = Query("calls")) -> list[dict[str, Any]]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    if org_id == store.KEECH_ORG_ID:
        return st["seed"].get("/analytics/lost-vehicles?rank=calls", [])
    return []


@router.get("/api/analytics/stock-alerts")
def get_stock_alerts(request: Request, rank: str = Query("calls")) -> list[dict[str, Any]]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    if org_id == store.KEECH_ORG_ID:
        return st["seed"].get("/analytics/stock-alerts?rank=calls", [])
    return []


@router.get("/api/analytics/customers")
def get_analytics_customers(
    request: Request,
    rep_id: Optional[str] = Query(None),
    tag: Optional[str] = Query(None),
    include_all: bool = Query(False),
) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    if org_id == store.KEECH_ORG_ID:
        if include_all:
            return st["seed"].get("/analytics/customers?include_all=true", st["seed"].get("/analytics/customers", {}))
        return st["seed"].get("/analytics/customers", {})
    return {"customers": [], "total": 0, "categories": []}


@router.get("/api/customers/{key}")
def get_customer_profile(key: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    full_custs = st.get("full_customers", {})
    if key in full_custs:
        return full_custs[key]

    calls = [c for c in st.get("calls", []) if (not org_id or c.get("org_id") == org_id) and (c.get("customer_name") == key or c.get("customer_phone") == key)]
    stat = {
        "key": key,
        "name": key,
        "phone": calls[0].get("customer_phone", "") if calls else "",
        "calls": len(calls),
        "orders": sum(1 for c in calls if c.get("outcome") == "won"),
        "talk_sec": sum(int(c.get("duration_sec", 0)) for c in calls),
        "last_call_at": calls[0].get("created_at", store.now_iso()) if calls else store.now_iso(),
        "last_call_id": calls[0].get("id", "") if calls else "",
        "last_category": calls[0].get("category", "Part Inquiry/Quote") if calls else "Part Inquiry/Quote",
        "top_topics": ["Part Inquiry"],
        "rep_names": list({c.get("rep_name") for c in calls if c.get("rep_name")}),
        "tag": st.get("customer_tags", {}).get(key, ""),
        "tag_source": "manual" if key in st.get("customer_tags", {}) else "",
        "est_value": sum(float(c.get("order_value", 0)) for c in calls) or 350.0,
        "value_basis": "ai",
    }
    notes = st.get("customer_notes", {}).get(key, [])
    return {"stat": stat, "calls": calls[:20], "notes": notes}


@router.put("/api/customers/{key}/tag")
def put_customer_tag(key: str, body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    tag = body.get("tag") or ""
    st.setdefault("customer_tags", {})[key] = tag
    prof = get_customer_profile(key)
    prof["stat"]["tag"] = tag
    prof["stat"]["tag_source"] = "manual"
    store.save_state()
    return prof["stat"]


@router.post("/api/customers/bulk-tag")
def post_customers_bulk_tag(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    keys = body.get("keys", [])
    tag = body.get("tag") or ""
    for k in keys:
        st.setdefault("customer_tags", {})[k] = tag
    store.save_state()
    return {"updated": len(keys)}


@router.post("/api/customers/{key}/notes")
def post_customer_note(key: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    note = {
        "id": str(uuid.uuid4()),
        "customer_key": key,
        "text": body.get("text", ""),
        "author": u.get("name", "Rep"),
        "created_at": store.now_iso(),
    }
    st.setdefault("customer_notes", {}).setdefault(key, []).insert(0, note)
    store.save_state()
    return note


@router.post("/api/customers/{key}/winback")
def post_customer_winback(key: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    u = get_current_user(request)
    return {
        "id": str(uuid.uuid4()),
        "customer_key": key,
        "customer_name": key,
        "outcome": body.get("outcome", "reached"),
        "rep_id": u["id"],
        "rep_name": u["name"],
        "created_at": store.now_iso(),
        "confirmed": False,
        "confirmed_call_id": "",
        "confirmed_value": 0.0,
    }


# Winback
@router.get("/api/analytics/winback")
def get_analytics_winback() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/analytics/winback", {})


@router.get("/api/analytics/winback/leaderboard")
def get_winback_leaderboard(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    if org_id == store.KEECH_ORG_ID:
        return {
            "months": ["2026-10"],
            "month": "2026-10",
            "leaders": [
                {
                    "rep_id": "user-keech-rep",
                    "rep_name": "Tyler Grant",
                    "marks": 14,
                    "customers_won": 10,
                    "won_value": 5250.0,
                },
                {
                    "rep_id": "user-keech-rep-2",
                    "rep_name": "Cody Miller",
                    "marks": 10,
                    "customers_won": 6,
                    "won_value": 2400.0,
                },
                {
                    "rep_id": "user-keech-rep-3",
                    "rep_name": "Jake Bradley",
                    "marks": 9,
                    "customers_won": 5,
                    "won_value": 2100.0,
                },
                {
                    "rep_id": "user-keech-rep-4",
                    "rep_name": "Austin Davis",
                    "marks": 4,
                    "customers_won": 1,
                    "won_value": 340.0,
                },
            ],
        }
    return {"months": [], "month": "", "leaders": []}


@router.get("/api/analytics/winback/trophies")
def get_winback_trophies(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    if org_id == store.KEECH_ORG_ID:
        return {
            "months": [
                {
                    "month": "2026-10",
                    "top_dollars": {
                        "rep_id": "user-keech-rep",
                        "rep_name": "Tyler Grant",
                        "marks": 14,
                        "customers_won": 10,
                        "won_value": 8450.0,
                        "avg_recovery": 845.0,
                    },
                    "top_customers": {
                        "rep_id": "user-keech-rep",
                        "rep_name": "Tyler Grant",
                        "marks": 14,
                        "customers_won": 10,
                        "won_value": 8450.0,
                        "avg_recovery": 845.0,
                    },
                    "truck": [
                        {
                            "rep_id": "user-keech-rep-2",
                            "rep_name": "Cody Miller",
                            "sales": 5,
                        }
                    ],
                },
                {
                    "month": "2026-09",
                    "top_dollars": {
                        "rep_id": "user-keech-rep",
                        "rep_name": "Tyler Grant",
                        "marks": 12,
                        "customers_won": 8,
                        "won_value": 6800.0,
                        "avg_recovery": 850.0,
                    },
                    "top_customers": {
                        "rep_id": "user-keech-rep-2",
                        "rep_name": "Cody Miller",
                        "marks": 10,
                        "customers_won": 7,
                        "won_value": 4200.0,
                        "avg_recovery": 600.0,
                    },
                    "truck": [
                        {
                            "rep_id": "user-keech-rep",
                            "rep_name": "Tyler Grant",
                            "sales": 6,
                        }
                    ],
                },
            ],
            "reps": [
                {
                    "rep_id": "user-keech-rep",
                    "rep_name": "Tyler Grant",
                    "trophies": 3,
                    "months_won": 2,
                    "current_streak": 2,
                    "best_streak": 2,
                    "truck_trophies": 1,
                    "truck_streak": 0,
                    "best_truck_streak": 1,
                },
                {
                    "rep_id": "user-keech-rep-2",
                    "rep_name": "Cody Miller",
                    "trophies": 1,
                    "months_won": 1,
                    "current_streak": 1,
                    "best_streak": 1,
                    "truck_trophies": 1,
                    "truck_streak": 1,
                    "best_truck_streak": 1,
                },
                {
                    "rep_id": "user-keech-rep-3",
                    "rep_name": "Jake Bradley",
                    "trophies": 0,
                    "months_won": 0,
                    "current_streak": 0,
                    "best_streak": 0,
                    "truck_trophies": 0,
                    "truck_streak": 0,
                    "best_truck_streak": 0,
                },
                {
                    "rep_id": "user-keech-rep-4",
                    "rep_name": "Austin Davis",
                    "trophies": 0,
                    "months_won": 0,
                    "current_streak": 0,
                    "best_streak": 0,
                    "truck_trophies": 0,
                    "truck_streak": 0,
                    "best_truck_streak": 0,
                },
            ],
        }
    return {"months": [], "reps": []}


@router.get("/api/analytics/winback/winners")
def get_winback_winners(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    if org_id == store.KEECH_ORG_ID:
        return {
            "month": "2026-10",
            "top_dollars": {
                "rep_id": "user-keech-rep",
                "rep_name": "Tyler Grant",
                "marks": 14,
                "customers_won": 10,
                "won_value": 5250.0,
            },
            "top_customers": {
                "rep_id": "user-keech-rep",
                "rep_name": "Tyler Grant",
                "marks": 14,
                "customers_won": 10,
                "won_value": 5250.0,
            },
            "truck": [
                {
                    "rep_id": "user-keech-rep",
                    "rep_name": "Tyler Grant",
                    "sales": 8,
                }
            ],
        }
    return {"month": "", "top_dollars": None, "top_customers": None, "truck": []}


# Watchlist
@router.get("/api/watchlist")
def get_watchlist(request: Request) -> list[dict[str, Any]]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    items = st.get("watchlist", [])
    if org_id:
        return [w for w in items if w.get("org_id") == org_id]
    return items


@router.post("/api/watchlist")
def post_watchlist(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
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
def delete_watchlist(wid: str) -> dict[str, Any]:
    st = store.get_state()
    st["watchlist"] = [w for w in st.get("watchlist", []) if w.get("id") != wid]
    store.save_state()
    return {"ok": True}


@router.get("/api/watchlist/email")
def get_watchlist_email() -> dict[str, Any]:
    st = store.get_state()
    return st.get("watchlist_email", {})


@router.put("/api/watchlist/email")
def put_watchlist_email(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    st["watchlist_email"] = {**st.get("watchlist_email", {}), **body}
    store.save_state()
    return st["watchlist_email"]


# Keywords
@router.get("/api/keywords")
def get_keywords() -> list[dict[str, Any]]:
    st = store.get_state()
    return st.get("keywords", [])


@router.post("/api/keywords")
def post_keyword(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    kw = {
        "id": str(uuid.uuid4()),
        "keyword": body.get("keyword", ""),
        "group": body.get("group", "Custom"),
    }
    st.setdefault("keywords", []).append(kw)
    store.save_state()
    return kw


@router.put("/api/keywords/{kid}")
def put_keyword(kid: str, body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    for kw in st.get("keywords", []):
        if kw.get("id") == kid:
            kw["keyword"] = body.get("keyword", kw["keyword"])
            kw["group"] = body.get("group", kw["group"])
            store.save_state()
            return kw
    raise HTTPException(status_code=404, detail="Keyword not found")


@router.delete("/api/keywords/{kid}")
def delete_keyword(kid: str) -> dict[str, Any]:
    st = store.get_state()
    st["keywords"] = [k for k in st.get("keywords", []) if k.get("id") != kid]
    store.save_state()
    return {"ok": True}


@router.get("/api/keywords/alerts")
def get_keyword_alerts() -> list[dict[str, Any]]:
    st = store.get_state()
    return st["seed"].get("/keywords/alerts", [])


@router.get("/api/keywords/rep-usage")
def get_keyword_rep_usage() -> list[dict[str, Any]]:
    st = store.get_state()
    return st["seed"].get("/keywords/rep-usage", [])


@router.get("/api/keywords/suggestions")
def get_keyword_suggestions() -> list[dict[str, Any]]:
    st = store.get_state()
    return st.get("keyword_suggestions", [])


@router.post("/api/keywords/suggestions/dismiss")
@router.post("/api/keywords/suggestions/restore")
def post_keyword_suggestion_action() -> dict[str, Any]:
    return {"ok": True}


@router.get("/api/keywords/{kid}/calls")
def get_keyword_calls(kid: str, month: Optional[str] = Query(None)) -> list[dict[str, Any]]:
    st = store.get_state()
    return st.get("calls", [])[:15]


# Arrivals
@router.get("/api/arrivals")
def get_arrivals(request: Request) -> list[dict[str, Any]]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    items = st.get("arrivals", [])
    if org_id:
        return [a for a in items if a.get("org_id") == org_id]
    return items


@router.post("/api/arrivals")
def post_arrival(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    aid = str(uuid.uuid4())
    year = int(body.get("vehicle_year") or 2018)
    make = body.get("vehicle_make", "")
    model = body.get("vehicle_model", "")

    matching_callers = []
    yard_calls = [c for c in st.get("calls", []) if not org_id or c.get("org_id") == org_id]
    for c in yard_calls[:40]:
        if make.lower() in (c.get("vehicle_make") or "").lower():
            matching_callers.append({
                "key": c.get("customer_name", "Caller"),
                "customer_name": c.get("customer_name", "Caller"),
                "customer_phone": c.get("customer_phone", "+15551234567"),
                "vehicle": f"{year} {make} {model}".strip(),
                "parts": [c.get("part_requested") or "Part"],
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


@router.delete("/api/arrivals/{aid}")
def delete_arrival(aid: str) -> dict[str, Any]:
    st = store.get_state()
    st["arrivals"] = [a for a in st.get("arrivals", []) if a.get("id") != aid]
    store.save_state()
    return {"ok": True}


@router.patch("/api/arrivals/{aid}/cost")
def patch_arrival_cost(aid: str, body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    for a in st.get("arrivals", []):
        if a.get("id") == aid:
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
            template = body.get("template", "")
            for c in a.get("callers", []):
                c["texted_at"] = store.now_iso()
                c["text"] = template
            a.setdefault("blasts", []).append({
                "at": store.now_iso(),
                "by": u.get("name", "Manager"),
                "template": template,
                "count": len(a.get("callers", [])),
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

    lid = str(uuid.uuid4())
    rep_id = body.get("rep_id") or u["id"]
    rep = st["users_by_id"].get(rep_id, u)

    name = body.get("name") or f"{arrival.get('vehicle_year')} {arrival.get('vehicle_make')} {arrival.get('vehicle_model')} callers"
    new_list = {
        "id": lid,
        "name": name,
        "rep_id": rep["id"],
        "rep_name": rep["name"],
        "created_by": u.get("name", "Manager"),
        "created_at": store.now_iso(),
        "open": len(arrival.get("callers", [])),
        "total": len(arrival.get("callers", [])),
        "done": 0,
        "sold": 0,
        "revenue": 0.0,
        "arrival_id": aid,
        "due_date": body.get("due_date") or "",
        "overdue": False,
    }
    st.setdefault("callback_lists", []).insert(0, new_list)
    arrival["callback_list_id"] = lid
    store.save_state()
    return new_list


@router.get("/api/arrivals/leaderboard")
def get_arrivals_leaderboard() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/arrivals/leaderboard", {})


@router.get("/api/arrivals/winner")
def get_arrivals_winner() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/arrivals/winner", {})


@router.get("/api/arrivals/streak-chase")
def get_arrivals_streak_chase() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/arrivals/streak-chase", {})


@router.get("/api/arrivals/streak-break")
def get_arrivals_streak_break() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/arrivals/streak-break", {})


# Callbacks & Callback Lists
@router.get("/api/callbacks")
def get_callbacks(
    request: Request,
    status: str = Query("open"),
    source: str = Query(""),
) -> list[dict[str, Any]]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    if status == "resolved":
        items = st.get("callbacks_resolved", [])
    else:
        items = st.get("callbacks_open", [])
    if org_id:
        items = [i for i in items if i.get("org_id") == org_id]
    if source:
        items = [i for i in items if i.get("assigned_list_id") == source]
    return items


@router.post("/api/callbacks/assign")
def post_callbacks_assign(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    cids = set(body.get("call_ids", []))
    rep_id = body.get("rep_id")
    rep = st["users_by_id"].get(rep_id, u)
    list_id = body.get("list_id", "")

    lists = st.get("callback_lists", [])
    target_list = next((l for l in lists if l.get("id") == list_id), None)
    list_name = target_list.get("name", "") if target_list else ""

    for c in st.get("calls", []):
        if c.get("id") in cids:
            item = dict(c)
            item["org_id"] = org_id
            item["customer_phone"] = item.get("customer_phone") or "+15551234567"
            item["reason"] = body.get("note") or "Assigned by manager"
            item["followed_up"] = False
            item["followed_up_at"] = None
            item["assigned_list_id"] = list_id
            item["assigned_list_name"] = list_name
            item["assigned_by"] = u.get("name", "Manager")
            item["assigned_note"] = body.get("note", "")
            item["list_due_date"] = target_list.get("due_date", "") if target_list else ""
            item["list_overdue"] = False
            item["rep_id"] = rep["id"]
            item["rep_name"] = rep["name"]
            st.setdefault("callbacks_open", []).insert(0, item)

    if target_list:
        target_list["total"] += len(cids)
        target_list["open"] += len(cids)

    store.save_state()
    return {"assigned": len(cids)}


@router.get("/api/callback-lists")
def get_callback_lists(request: Request) -> list[dict[str, Any]]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    items = st.get("callback_lists", [])
    if org_id:
        return [l for l in items if l.get("org_id") == org_id]
    return items


@router.post("/api/callback-lists")
def post_callback_lists(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    lid = str(uuid.uuid4())
    rep_id = body.get("rep_id") or u["id"]
    rep = st["users_by_id"].get(rep_id, u)

    new_list = {
        "id": lid,
        "org_id": org_id,
        "name": body["name"],
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
def patch_callback_list(lid: str, body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    for l in st.get("callback_lists", []):
        if l.get("id") == lid:
            l["due_date"] = body.get("due_date") or ""
            store.save_state()
            return l
    raise HTTPException(status_code=404, detail="Callback list not found")


@router.delete("/api/callback-lists/{lid}")
def delete_callback_list(lid: str) -> dict[str, Any]:
    st = store.get_state()
    st["callback_lists"] = [l for l in st.get("callback_lists", []) if l.get("id") != lid]
    st["callbacks_open"] = [c for c in st.get("callbacks_open", []) if c.get("assigned_list_id") != lid]
    store.save_state()
    return {"ok": True}


@router.get("/api/callback-lists/leaderboard")
def get_callback_lists_leaderboard() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/callback-lists/leaderboard", {})


@router.post("/api/callback-lists/overdue-alerts/send-now")
def post_callback_lists_overdue_alerts() -> dict[str, Any]:
    return {"lists": 0, "emails": 0, "texts": 0}


# Call Queue
@router.get("/api/queue")
def get_call_queue() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/queue", {"items": [], "counts": {}, "progress": None})


@router.get("/api/queue/team")
def get_team_queue() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/queue/team", {"after_noon": False, "reps": []})


# Leaderboards Hub
@router.get("/api/leaderboards/champions")
def get_leaderboards_champions(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    if org_id == store.KEECH_ORG_ID:
        return {
            "champions": [
                {
                    "category": "vehicle_sales",
                    "period": "2026-10",
                    "names": ["Tyler Grant"],
                    "rep_ids": ["user-keech-rep"],
                    "detail": "28 sales · 84.8% close rate",
                    "site_ids": [],
                },
                {
                    "category": "winback_dollars",
                    "period": "2026-10",
                    "names": ["Tyler Grant"],
                    "rep_ids": ["user-keech-rep"],
                    "detail": "$8,450 recovered · 10 customers won back",
                    "site_ids": [],
                },
                {
                    "category": "delivery_score",
                    "period": "2026-10",
                    "names": ["Cody Miller"],
                    "rep_ids": ["user-keech-rep-2"],
                    "detail": "79.0 avg delivery score · 8 checked calls",
                    "site_ids": [],
                },
                {
                    "category": "callback_lists",
                    "period": "2026-10",
                    "names": ["Tyler Grant"],
                    "rep_ids": ["user-keech-rep"],
                    "detail": "12 callback lists closed",
                    "site_ids": [],
                },
            ],
            "totals": [
                {"name": "Tyler Grant", "trophies": 3},
                {"name": "Cody Miller", "trophies": 1},
            ],
        }
    return {"champions": [], "totals": []}


@router.get("/api/leaderboards/delivery")
def get_leaderboards_delivery(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    if org_id == store.KEECH_ORG_ID:
        return {
            "month": "2026-10",
            "reps": [
                {"rep_id": "user-keech-rep", "name": "Tyler Grant", "avg_score": 91, "checked": 14},
                {"rep_id": "user-keech-rep-2", "name": "Cody Miller", "avg_score": 79, "checked": 8},
                {"rep_id": "user-keech-rep-3", "name": "Jake Bradley", "avg_score": 76, "checked": 7},
                {"rep_id": "user-keech-rep-4", "name": "Austin Davis", "avg_score": 58, "checked": 3},
            ],
        }
    return {"month": "", "reps": []}


@router.get("/api/leaderboards/team-player")
def get_leaderboards_team_player(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    if org_id == store.KEECH_ORG_ID:
        return {
            "month": "2026-10",
            "reps": [
                {"rep_id": "user-keech-rep", "name": "Tyler Grant", "rep_name": "Tyler Grant", "handled": 12, "all_time": 4, "score": 92},
                {"rep_id": "user-keech-rep-2", "name": "Cody Miller", "rep_name": "Cody Miller", "handled": 6, "all_time": 2, "score": 79},
                {"rep_id": "user-keech-rep-3", "name": "Jake Bradley", "rep_name": "Jake Bradley", "handled": 5, "all_time": 1, "score": 76},
                {"rep_id": "user-keech-rep-4", "name": "Austin Davis", "rep_name": "Austin Davis", "handled": 1, "all_time": 0, "score": 58},
            ],
        }
    return {"month": "", "reps": []}


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
) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")

    calls = [c for c in st.get("calls", []) if not org_id or c.get("org_id") == org_id]
    if site_id:
        calls = [c for c in calls if c.get("site_id") == site_id]

    # Filter by date range (inclusive)
    from_iso = f"{date_from}T00:00:00Z" if len(date_from) == 10 else date_from
    to_iso = f"{date_to}T23:59:59Z" if len(date_to) == 10 else date_to
    calls = [c for c in calls if from_iso <= (c.get("created_at") or "") <= to_iso]

    if not calls:
        return {
            "date_from": date_from,
            "date_to": date_to,
            "totals": {
                "calls": 0, "inbound": 0, "outbound": 0, "voicemails": 0,
                "avg_score": 0.0, "avg_duration_sec": 0.0, "sales_calls": 0,
                "won": 0, "close_rate": 0.0, "revenue": 0.0,
            },
            "by_rep": [],
            "by_category": [],
            "top_parts": [],
            "top_vehicles": [],
            "daily": [],
            "arrivals": 0,
            "avg_order_value": 0.0,
            "parts_sold": 0,
            "price_missing": 0,
        }

    scored = [c for c in calls if c.get("overall_score")]
    avg_score = round(sum(c.get("overall_score", 0) for c in scored) / len(scored), 1) if scored else 0.0
    durations = [c.get("duration_sec", 0) for c in calls if c.get("duration_sec")]
    avg_dur = round(sum(durations) / len(durations), 1) if durations else 0.0
    inbound = sum(1 for c in calls if c.get("direction", "inbound") == "inbound")
    outbound = sum(1 for c in calls if c.get("direction") == "outbound")
    sales_calls = [c for c in calls if c.get("outcome") in ("won", "lost", "pending")]
    won = [c for c in calls if c.get("outcome") == "won"]
    revenue = sum(float(c.get("order_value") or 0.0) for c in won)
    close_rate = round(len(won) / max(len(sales_calls), 1) * 100, 1) if sales_calls else 0.0

    # by_rep
    rep_map: dict[str, list[dict[str, Any]]] = {}
    for c in calls:
        rid = c.get("rep_id") or "unassigned"
        rep_map.setdefault(rid, []).append(c)

    by_rep = []
    users = st.get("users_by_id", {})
    for rid, rcalls in rep_map.items():
        user = users.get(rid, {})
        rname = user.get("name") or (rcalls[0].get("rep_name") if rcalls else "Rep")
        r_scored = [c for c in rcalls if c.get("overall_score")]
        r_avg_score = round(sum(c.get("overall_score", 0) for c in r_scored) / len(r_scored), 1) if r_scored else 0.0
        r_sales = [c for c in rcalls if c.get("outcome") in ("won", "lost", "pending")]
        r_won = [c for c in rcalls if c.get("outcome") == "won"]
        r_rev = sum(float(c.get("order_value") or 0.0) for c in r_won)
        r_close = round(len(r_won) / max(len(r_sales), 1) * 100, 1) if r_sales else 0.0
        by_rep.append({
            "rep_id": rid,
            "name": rname,
            "calls": len(rcalls),
            "avg_score": r_avg_score,
            "sales_calls": len(r_sales),
            "won": len(r_won),
            "close_rate": r_close,
            "revenue": round(r_rev, 2),
        })
    by_rep.sort(key=lambda x: x["calls"], reverse=True)

    # by_category
    cat_map: dict[str, int] = {}
    for c in calls:
        cat = c.get("category") or "Other"
        cat_map[cat] = cat_map.get(cat, 0) + 1
    by_category = [{"label": k, "calls": v, "won": 0, "key": ""} for k, v in sorted(cat_map.items(), key=lambda kv: -kv[1])]

    # top_parts
    parts_map: dict[str, dict[str, int]] = {}
    for c in calls:
        p = c.get("part_requested")
        if p:
            entry = parts_map.setdefault(p, {"calls": 0, "won": 0})
            entry["calls"] += 1
            if c.get("outcome") == "won":
                entry["won"] += 1
    top_parts = [
        {"label": k, "calls": v["calls"], "won": v["won"], "key": k.lower()}
        for k, v in sorted(parts_map.items(), key=lambda kv: -kv[1]["calls"])[:10]
    ]

    # top_vehicles
    veh_map: dict[str, dict[str, int]] = {}
    for c in calls:
        v = c.get("vehicle")
        if v:
            entry = veh_map.setdefault(v, {"calls": 0, "won": 0})
            entry["calls"] += 1
            if c.get("outcome") == "won":
                entry["won"] += 1
    top_vehicles = [
        {"label": k, "calls": v["calls"], "won": v["won"], "key": k}
        for k, v in sorted(veh_map.items(), key=lambda kv: -kv[1]["calls"])[:10]
    ]

    # daily
    daily_map: dict[str, dict[str, int]] = {}
    for c in calls:
        d = (c.get("created_at") or store.today_str())[:10]
        entry = daily_map.setdefault(d, {"calls": 0, "won": 0})
        entry["calls"] += 1
        if c.get("outcome") == "won":
            entry["won"] += 1
    daily = [{"date": k, "calls": v["calls"], "won": v["won"]} for k, v in sorted(daily_map.items())]

    return {
        "date_from": date_from,
        "date_to": date_to,
        "totals": {
            "calls": len(calls),
            "inbound": inbound,
            "outbound": outbound,
            "voicemails": sum(1 for c in calls if c.get("category") == "Voicemail"),
            "avg_score": avg_score,
            "avg_duration_sec": avg_dur,
            "sales_calls": len(sales_calls),
            "won": len(won),
            "close_rate": close_rate,
            "revenue": round(revenue, 2),
        },
        "by_rep": by_rep,
        "by_category": by_category,
        "top_parts": top_parts,
        "top_vehicles": top_vehicles,
        "daily": daily,
        "arrivals": 0,
        "avg_order_value": round(revenue / max(len(won), 1), 1) if won else 350.0,
        "parts_sold": len(won),
        "price_missing": 0,
    }
