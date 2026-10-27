"""Randomized (but deterministic) extra demo calls so the four Keech reps have a clear ranking.

Target standings (by avg score): Tyler 1st (clear), Cody 2nd, Jake 3rd (close to Cody), Austin last (clear).
"""
from __future__ import annotations

import random
from datetime import datetime, timedelta, timezone
from typing import Any

ORG_ID = "org-keech-salvage"

PROFILES = [
    # rep_id, rep_name, prefix, n, base score, p_won, p_lost, p_warranty, seed
    ("user-keech-rep", "Tyler Grant", "demo-tyler-extra-", 25, 90, 0.78, 0.08, 0.92, 11),
    ("user-keech-rep-2", "Cody Miller", "demo-cody-extra-", 25, 78, 0.52, 0.28, 0.60, 22),
    ("user-keech-rep-3", "Jake Bradley", "demo-jake-extra-", 25, 75, 0.46, 0.30, 0.50, 33),
    ("user-keech-rep-4", "Austin Davis", "demo-austin-extra-", 25, 55, 0.20, 0.50, 0.20, 44),
]

FIRST = ["Mike", "Sarah", "Carlos", "Linda", "Dave", "Priya", "Tom", "Jennifer", "Robert", "Amanda", "Kevin", "Rachel",
         "Gary", "Beth", "Marcus", "Janet", "Frank", "Olivia", "Derek", "Monica", "Tony", "Sophie", "Eric", "Patricia",
         "Walt", "Natalie", "Dennis", "Heather", "Ray", "Allison", "Brian", "Lucy", "Paul", "Renee", "Oscar", "Gloria"]
LAST = ["Hart", "Nolan", "Pierce", "Vega", "Moss", "Boone", "Rowe", "Sloan", "Tate", "Webb", "Yates", "Zimmer", "Dixon",
        "Ellis", "Fields", "Grant", "Hayes", "Irwin", "Jensen", "Knox", "Lowe", "Mayer", "Norris", "Owens", "Prince"]
VEHICLES = [(2018, "Ford", "F-150"), (2016, "Honda", "Accord"), (2019, "Chevrolet", "Silverado 1500"), (2014, "Toyota", "Camry"),
            (2017, "Ram", "1500"), (2015, "Nissan", "Altima"), (2012, "Jeep", "Wrangler"), (2020, "Hyundai", "Elantra"),
            (2013, "BMW", "328i"), (2021, "Subaru", "Outback"), (2016, "Dodge", "Charger"), (2019, "Kia", "Sorento"),
            (2015, "Chevrolet", "Equinox"), (2017, "Ford", "Escape"), (2020, "Honda", "Civic"), (2018, "Toyota", "RAV4")]
PARTS = [("Alternator", 110, 190, "Part Inquiry/Quote"), ("Headlight", 150, 320, "Part Inquiry/Quote"),
         ("Front Bumper Cover", 220, 380, "Price Negotiation"), ("Transmission", 900, 1900, "Part Inquiry/Quote"),
         ("Engine", 1500, 3600, "Part Inquiry/Quote"), ("Side Mirror", 70, 160, "Part Inquiry/Quote"),
         ("Radiator", 110, 220, "Price Negotiation"), ("Tail Light", 80, 180, "Order/Sale"),
         ("Hood", 260, 480, "Shipping/Delivery"), ("Door", 240, 450, "Shipping/Delivery"),
         ("Starter", 80, 150, "Part Inquiry/Quote"), ("AC Compressor", 140, 260, "Part Inquiry/Quote")]


def _clip(x: float, lo: int = 25, hi: int = 99) -> int:
    return int(max(lo, min(hi, round(x))))


def _metrics(score: int, outcome: str, warranty: bool) -> dict[str, int]:
    return {
        "greeting": _clip(score + 6, 20, 100),
        "needs_discovery": _clip(score + 3, 20, 100),
        "product_knowledge": _clip(score + 4, 20, 100),
        "upsell_crosssell": _clip(score - 10, 20, 100),
        "objection_handling": _clip(score - (12 if outcome == "lost" else 2), 20, 100),
        "closing": _clip(score - (20 if outcome == "lost" else 0), 20, 100),
        "compliance_warranty": _clip(score - 4 if warranty else score - 30, 20, 100),
        "tone_empathy": _clip(score + 7, 20, 100),
    }


def _turns(rep: str, cust: str, veh: str, part: str, price: int, tier: str, outcome: str, warranty: bool) -> list[tuple[str, str]]:
    first = rep.split()[0]
    cf = cust.split()[0]
    if tier == "strong":
        t = [("rep", f"Thanks for calling Keech's Auto Salvage, this is {first}. How can I help you today?"),
             ("cust", f"Hi, {cf} here. I need a {part.lower()} for a {veh}."),
             ("rep", f"Happy to help, {cf}. Do you have the VIN or trim so I can match the exact {part.lower()}?"),
             ("cust", "Sure, it's the standard trim, I can text you the VIN.")]
        t.append(("rep", f"Perfect. I have a tested A-grade {part.lower()} on the rack for ${price}."
                  + (" It carries our 90-day warranty and I can add a 1-year parts and labor option." if warranty else "")))
        if outcome == "won":
            t += [("cust", "That sounds good, let's do it."),
                  ("rep", f"Great. Since you're already in there, I'd recommend the matching hardware for about $25, and I'll have everything ready for pickup or delivery tomorrow morning.")]
        elif outcome == "pending":
            t += [("cust", "Let me check with my customer first."),
                  ("rep", f"No problem. I'll hold it until noon tomorrow and text you a photo right now.")]
        else:
            t += [("cust", "I found a lower price, I'll pass."),
                  ("rep", f"I understand. Ours is tested with a warranty, and I can come down a little if you can pick up today.")]
        return t
    if tier == "medium":
        t = [("rep", f"Keech's Auto Salvage, {first} speaking."),
             ("cust", f"Hi, I need a {part.lower()} for a {veh}."),
             ("rep", f"Okay, I have one in stock for ${price}."
              + (" It comes with a 90-day warranty." if warranty else "")),
             ("cust", "Is there any room on the price?" if outcome != "won" else "Alright, I'll take it.")]
        t.append(("rep", "I can't do much better than that." if outcome == "lost" else "Great, I'll set it aside for you."))
        if outcome == "lost":
            t.append(("cust", "Okay, I'll look around. Thanks."))
        return t
    t = [("rep", "Keech's."),
         ("cust", f"I need a {part.lower()} for a {veh}."),
         ("rep", f"Yeah we might have that. It's ${price}."),
         ("cust", "Hmm, that seems high."),
         ("rep", "That's the price.")]
    if outcome == "won":
        t += [("cust", "Fine, I'll take it."), ("rep", "Okay.")]
    else:
        t += [("cust", "Never mind then, thanks.")]
    return t


def build_extra_calls() -> list[tuple[dict[str, Any], dict[str, Any]]]:
    out: list[tuple[dict[str, Any], dict[str, Any]]] = []
    now = datetime.now(timezone.utc)
    for rep_id, rep_name, prefix, n, base, p_won, p_lost, p_warr, seed in PROFILES:
        rnd = random.Random(seed)
        for i in range(1, n + 1):
            cid = f"{prefix}{i:02d}"
            roll = rnd.random()
            outcome = "won" if roll < p_won else ("lost" if roll < p_won + p_lost else "pending")
            if outcome == "won":
                score = _clip(rnd.gauss(base + 3, 4))
            elif outcome == "lost":
                score = _clip(rnd.gauss(base - 10, 5))
            else:
                score = _clip(rnd.gauss(base, 5))
            tier = "strong" if score >= 85 else ("medium" if score >= 65 else "weak")
            warranty = rnd.random() < p_warr
            cust = f"{rnd.choice(FIRST)} {rnd.choice(LAST)}"
            year, make, model = rnd.choice(VEHICLES)
            part, lo, hi, cat = rnd.choice(PARTS)
            price = int(rnd.randint(lo, hi) / 5) * 5
            veh = f"{year} {make} {model}"
            turns = [{"speaker": rep_name if r == "rep" else cust, "text": tx}
                     for r, tx in _turns(rep_name, cust, veh, part, price, tier, outcome, warranty)]
            transcript = "\n".join(f"{t['speaker']}: {t['text']}" for t in turns)
            when = (now - timedelta(days=rnd.randint(0, 29))).replace(
                hour=rnd.randint(8, 17), minute=rnd.randint(0, 59), second=0, microsecond=0)
            if when.weekday() >= 6:
                when -= timedelta(days=1)
            sentiment = "positive" if score >= 80 else ("neutral" if score >= 60 else "negative")
            summary_txt = {
                "won": f"{cust} bought a {part.lower()} for a {veh} at ${price}.",
                "lost": f"{cust} asked about a {part.lower()} for a {veh} at ${price} but did not buy.",
                "pending": f"{cust} is considering a {part.lower()} for a {veh} quoted at ${price}.",
            }[outcome]
            summary = {
                "id": cid, "org_id": ORG_ID, "rep_id": rep_id, "rep_name": rep_name,
                "customer_name": cust, "customer_phone": f"+1512555{rnd.randint(1000, 9999)}",
                "source": "transcript", "status": "completed", "category": cat, "summary": summary_txt,
                "vehicle": veh, "part_requested": part, "outcome": outcome, "sentiment": sentiment,
                "overall_score": score, "created_at": when.strftime("%Y-%m-%dT%H:%M:%SZ"), "direction": "inbound",
                "duration_sec": float(rnd.randint(70, 320)), "source_category": "Sales Inquiry",
                "topics": [part, "Warranty"] if warranty else [part],
                "order_value": float(price) if outcome == "won" else 0.0, "quoted_value": float(price),
                "parts_sold": [part] if outcome == "won" else [], "delivery_call": False, "delivery_check": None,
                "lost_reason": "Price" if outcome == "lost" else "", "callback_done": False, "callback_by": "",
                "callback_at": None, "vehicle_year": year, "vehicle_make": make, "vehicle_model": model,
                "delivery_kind": "", "delivery_score": None, "has_audio": False,
            }
            full = dict(summary)
            full.update({
                "turns": turns, "transcript": transcript, "metrics": _metrics(score, outcome, warranty),
                "strengths": ["Clear greeting and fast lookup"] if score >= 70 else [],
                "improvements": (["Present warranty options on every quote"] if not warranty else [])
                + (["Ask for the order and defend price"] if outcome == "lost" else []),
                "insights": [f"Category: {cat}", f"Customer inquired about {part} for a {veh}."],
                "coaching_feedback": (f"Strong call by {rep_name}. Keep pitching warranty and companion parts." if score >= 80
                                      else f"{rep_name} should build value before quoting and always ask for the sale."),
                "keyword_hits": [{"keyword": "Warranty", "count": 1}] if warranty else [],
                "error": "", "trackers": ["Warranty Mentioned"] if warranty else [], "external_url": "",
            })
            out.append((summary, full))
    return out
