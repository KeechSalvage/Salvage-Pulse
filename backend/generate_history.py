"""Script to generate historical calls for each Keech yard user across the past 14 months (2025-09 to 2026-10).

Adds a random amount of calls to each user:
- Tyler Grant (Senior Rep): high volume, high scores, high close rate
- Cody Miller (Commercial Rep): strong volume, solid scores, steady conversion
- Jake Bradley (Wholesale Rep): moderate volume, consistent scores
- Austin Davis (Junior Rep): ramp-up volume, improving scores
- Dale Miller (Owner / Counter backup): occasional high-ticket quotes & sales
- Marcus Reed (Sales Manager): occasional escalated calls & supervisory sales
- Rick Martinez (Inventory Manager): parts verification & inventory inquiry calls

All calls are populated into store.calls and store.full_calls with realistic
transcripts, turns, metrics, vehicles, parts, and dates spread across the last 14 months.
"""
from __future__ import annotations

import random
from datetime import datetime, timedelta, timezone
from typing import Any
import store
from demo_extra_calls import FIRST, LAST, VEHICLES, PARTS, _metrics, _turns, _clip

ORG_ID = store.KEECH_ORG_ID

USER_CONFIGS = [
    # rep_id, rep_name, role, prefix, (min_per_mo, max_per_mo), base_score, p_won, p_lost, p_warr, seed
    ("user-keech-rep", "Tyler Grant", "rep", "hist-tyler-", (18, 30), 89, 0.76, 0.10, 0.90, 101),
    ("user-keech-rep-2", "Cody Miller", "rep", "hist-cody-", (14, 25), 78, 0.52, 0.28, 0.62, 202),
    ("user-keech-rep-3", "Jake Bradley", "rep", "hist-jake-", (12, 22), 74, 0.46, 0.32, 0.52, 303),
    ("user-keech-rep-4", "Austin Davis", "rep", "hist-austin-", (8, 18), 58, 0.24, 0.52, 0.22, 404),
    ("user-keech-owner", "Dale Miller", "owner", "hist-dale-", (3, 8), 84, 0.68, 0.18, 0.70, 505),
    ("user-keech-sales-mgr", "Marcus Reed", "sales_manager", "hist-marcus-", (3, 7), 86, 0.70, 0.15, 0.85, 606),
    ("user-keech-inv-mgr", "Rick Martinez", "inventory_manager", "hist-rick-", (2, 6), 72, 0.40, 0.35, 0.40, 707),
]

# 14 months from Sep 2025 through Oct 2026
MONTHS = [
    (2025, 9, 30), (2025, 10, 31), (2025, 11, 30), (2025, 12, 31),
    (2026, 1, 31), (2026, 2, 28), (2026, 3, 31), (2026, 4, 30),
    (2026, 5, 31), (2026, 6, 30), (2026, 7, 31), (2026, 8, 31),
    (2026, 9, 30), (2026, 10, 27),
]


def build_history_calls() -> list[tuple[dict[str, Any], dict[str, Any]]]:
    pairs: list[tuple[dict[str, Any], dict[str, Any]]] = []

    for rep_id, rep_name, role, prefix, (min_mo, max_mo), base_score, p_won, p_lost, p_warr, seed in USER_CONFIGS:
        rnd = random.Random(seed)
        call_seq = 0

        for year, month, max_day in MONTHS:
            count = rnd.randint(min_mo, max_mo)
            for _ in range(count):
                call_seq += 1
                cid = f"{prefix}{call_seq:04d}"
                roll = rnd.random()
                outcome = "won" if roll < p_won else ("lost" if roll < p_won + p_lost else "pending")

                if outcome == "won":
                    score = _clip(rnd.gauss(base_score + 3, 4))
                elif outcome == "lost":
                    score = _clip(rnd.gauss(base_score - 9, 5))
                else:
                    score = _clip(rnd.gauss(base_score, 5))

                tier = "strong" if score >= 85 else ("medium" if score >= 65 else "weak")
                warranty = rnd.random() < p_warr
                cust = f"{rnd.choice(FIRST)} {rnd.choice(LAST)}"
                v_year, make, model = rnd.choice(VEHICLES)
                part, lo, hi, cat = rnd.choice(PARTS)
                price = int(rnd.randint(lo, hi) / 5) * 5
                veh = f"{v_year} {make} {model}"

                turns = [{"speaker": rep_name if r == "rep" else cust, "text": tx}
                         for r, tx in _turns(rep_name, cust, veh, part, price, tier, outcome, warranty)]
                transcript = "\n".join(f"{t['speaker']}: {t['text']}" for t in turns)

                day = rnd.randint(1, max_day)
                dt_call = datetime(year, month, day, rnd.randint(8, 17), rnd.randint(0, 59), 0, tzinfo=timezone.utc)
                if dt_call.weekday() == 6:  # Sunday -> push to Monday
                    dt_call += timedelta(days=1)
                elif dt_call.weekday() == 5 and rnd.random() < 0.5:
                    dt_call -= timedelta(days=1)

                sentiment = "positive" if score >= 80 else ("neutral" if score >= 60 else "negative")
                summary_txt = {
                    "won": f"{cust} bought a {part.lower()} for a {veh} at ${price}.",
                    "lost": f"{cust} asked about a {part.lower()} for a {veh} at ${price} but did not buy.",
                    "pending": f"{cust} is considering a {part.lower()} for a {veh} quoted at ${price}.",
                }[outcome]

                summary = {
                    "id": cid,
                    "org_id": ORG_ID,
                    "rep_id": rep_id,
                    "rep_name": rep_name,
                    "customer_name": cust,
                    "customer_phone": f"+1512555{rnd.randint(1000, 9999)}",
                    "source": "transcript",
                    "status": "analyzed",
                    "category": cat,
                    "summary": summary_txt,
                    "vehicle": veh,
                    "part_requested": part,
                    "outcome": outcome,
                    "sentiment": sentiment,
                    "overall_score": score,
                    "created_at": dt_call.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "direction": "inbound" if rnd.random() < 0.85 else "outbound",
                    "duration_sec": float(rnd.randint(70, 360)),
                    "source_category": "Sales Inquiry" if cat in ("Part Inquiry/Quote", "Order/Sale") else "Customer Service",
                    "topics": [part, "Warranty"] if warranty else [part],
                    "order_value": float(price) if outcome == "won" else 0.0,
                    "quoted_value": float(price),
                    "parts_sold": [part] if outcome == "won" else [],
                    "delivery_call": False,
                    "delivery_check": None,
                    "lost_reason": "Price" if outcome == "lost" else "",
                    "callback_done": False,
                    "callback_by": "",
                    "callback_at": None,
                    "vehicle_year": v_year,
                    "vehicle_make": make,
                    "vehicle_model": model,
                    "delivery_kind": "",
                    "delivery_score": None,
                    "has_audio": False,
                }

                full = dict(summary)
                full.update({
                    "turns": turns,
                    "transcript": transcript,
                    "metrics": _metrics(score, outcome, warranty),
                    "strengths": ["Clear greeting and verified compatibility"] if score >= 70 else [],
                    "improvements": (["Present warranty options on every quote"] if not warranty else [])
                    + (["Ask for the order and follow up"] if outcome == "lost" else []),
                    "insights": [f"Category: {cat}", f"Customer requested {part} for a {veh}."],
                    "coaching_feedback": (f"Strong call by {rep_name}. Consistent product knowledge." if score >= 80
                                          else f"{rep_name} should confirm part specifications and defend quote."),
                    "keyword_hits": [{"keyword": "Warranty", "count": 1}] if warranty else [],
                    "error": "",
                    "trackers": ["Warranty Mentioned"] if warranty else [],
                    "external_url": "",
                })

                pairs.append((summary, full))

    return pairs


def generate_history():
    st = store.get_state()
    calls = st.setdefault("calls", [])
    full_calls = st.setdefault("full_calls", {})

    # Remove existing generated 'hist-' calls if re-running
    calls[:] = [c for c in calls if not str(c.get("id", "")).startswith("hist-")]
    for k in list(full_calls.keys()):
        if str(k).startswith("hist-"):
            del full_calls[k]

    for summary, full in build_history_calls():
        calls.append(summary)
        full_calls[summary["id"]] = full

    calls.sort(key=lambda c: c.get("created_at") or "", reverse=True)
    store.save_state()
    print(f"Generated {len(calls)} historical calls across 14 months.")


if __name__ == "__main__":
    generate_history()
