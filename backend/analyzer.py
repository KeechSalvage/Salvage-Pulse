import re
from typing import Any, Dict, List, Optional, Tuple
from database import (
    CATEGORIES,
    COMMON_PARTS,
    METRICS,
    VEHICLE_CATALOG,
    compute_weighted_overall_score,
    infer_vehicle_body,
)


def parse_turns(transcript: str) -> List[Dict[str, str]]:
    if not transcript or not transcript.strip():
        return []
    turns: List[Dict[str, str]] = []
    lines = [ln.strip() for ln in transcript.strip().splitlines() if ln.strip()]
    speaker_rx = re.compile(r"^(Rep|Agent|Sales|Customer|Caller|Shop|Buyer)\s*:\s*(.+)$", re.I)
    for idx, line in enumerate(lines):
        m = speaker_rx.match(line)
        if m:
            raw_sp = m.group(1).strip()
            speaker = "Rep" if re.match(r"^(rep|agent|sales)$", raw_sp, re.I) else "Customer"
            turns.append({"speaker": speaker, "text": m.group(2).strip()})
        elif turns:
            turns[-1]["text"] += " " + line
        else:
            turns.append({"speaker": "Rep" if idx % 2 == 0 else "Customer", "text": line})
    return turns


def extract_vehicle_and_part(text: str, topics: Optional[List[str]] = None) -> Dict[str, Any]:
    combined = f"{text or ''} {' '.join(topics or [])}"
    low = combined.lower()

    year: Optional[int] = None
    ym = re.search(r"\b(19[7-9]\d|20[0-2]\d|203[0-5])\b", combined)
    if ym:
        year = int(ym.group(1))

    found_make = ""
    found_model = ""
    found_body = ""
    for make, models in VEHICLE_CATALOG.items():
        for model_name, body in models:
            if re.search(rf"\b{re.escape(model_name.lower())}\b", low):
                found_make = make
                found_model = model_name
                found_body = body
                break
        if found_make:
            break

    if not found_make:
        for make, models in VEHICLE_CATALOG.items():
            if re.search(rf"\b{re.escape(make.lower())}\b", low):
                found_make = make
                found_body = models[0][1] if models else "car"
                break

    found_part = ""
    for part in COMMON_PARTS:
        base = part.split("/")[0].replace("Assembly", "").strip().lower()
        if base and re.search(rf"\b{re.escape(base)}s?\b", low):
            found_part = part
            break

    return {
        "vehicle_year": year,
        "vehicle_make": found_make,
        "vehicle_model": found_model,
        "vehicle_body": found_body or infer_vehicle_body(found_make, found_model),
        "part_requested": found_part,
    }


def analyze_transcript(transcript: str, customer_name: str = "") -> Dict[str, Any]:
    turns = parse_turns(transcript)
    low = (transcript or "").lower()
    rep_text = " ".join(t["text"] for t in turns if t["speaker"] == "Rep").lower() or low
    cust_text = " ".join(t["text"] for t in turns if t["speaker"] != "Rep").lower()

    vp = extract_vehicle_and_part(transcript)

    # Dollar amounts
    amounts = [float(x.replace(",", "")) for x in re.findall(r"\$\s*(\d{2,5}(?:,\d{3})?)", transcript)]
    quoted_value = max(amounts) if amounts else 0.0

    # Category & outcome detection
    if any(w in low for w in ["core return", "core credit", "bringing the core"]):
        category = "Core Return"
        outcome = "n/a"
    elif any(w in low for w in ["warranty claim", "defective", "send it back", "return policy"]):
        category = "Warranty/Return"
        outcome = "n/a"
    elif any(w in low for w in ["sell my car", "junk car", "scrap", "catalytic buyer"]):
        category = "Vendor/Scrap Seller"
        outcome = "n/a"
    elif any(w in low for w in ["tracking number", "freight status", "where is the driver", "delivery eta"]):
        category = "Shipping/Delivery"
        outcome = "n/a"
    else:
        won_signals = ["hold it", "i'll take it", "put it on my card", "send it over", "pick up today", "ship it", "sold", "invoice me", "set it aside"]
        lost_signals = ["i'll pass", "too high", "no thanks", "out of stock", "don't have one", "call around", "already bought"]
        price_signals = ["cheaper", "aftermarket", "lkq", "too high", "do better on price", "discount", "knock off"]

        is_won = any(s in low for s in won_signals)
        is_lost = not is_won and any(s in low for s in lost_signals)
        has_price_push = any(s in low for s in price_signals)

        if is_won:
            category = "Order/Sale"
            outcome = "won"
        elif has_price_push:
            category = "Price Negotiation"
            outcome = "lost" if is_lost else "pending"
        else:
            category = "Part Inquiry/Quote"
            outcome = "lost" if is_lost else "pending"

    order_value = quoted_value if outcome == "won" else 0.0
    if outcome == "won" and order_value == 0:
        order_value = 325.0

    warranty_pitched = 1 if any(w in rep_text for w in ["warranty", "90-day", "90 day", "6-month", "1-year", "extended coverage", "guarantee"]) else 0

    # Metric scoring (0-10)
    greeting = 9 if any(w in rep_text for w in ["thanks for calling", "thank you for calling", "this is "]) else 6
    needs_discovery = 9 if any(w in rep_text for w in ["vin", "hollander", "trim", "engine", "2wd", "4wd", "awd", "led or halogen", "interchange"]) else 6
    product_knowledge = 9 if any(w in rep_text for w in ["oem", "grade a", "tested", "miles", "no broken tabs", "compression", "factory"]) else 7
    upsell_crosssell = 8 if (warranty_pitched or any(w in rep_text for w in ["also have", "bundle", "extended", "matching", "companion"])) else 5
    objection_handling = 9 if any(w in rep_text for w in ["aftermarket", "factory", "plug right in", "seal", "oem used"]) else 7
    closing = 9 if any(w in rep_text for w in ["set it aside", "hold it for you", "send that out", "put it on the truck", "take a card", "under your name"]) else 5
    courtesy = 9 if any(w in rep_text for w in ["appreciate", "thank", "no problem", "happy to", "sure thing"]) else 7

    metrics = {
        "greeting": greeting,
        "needs_discovery": needs_discovery,
        "product_knowledge": product_knowledge,
        "upsell_crosssell": upsell_crosssell,
        "objection_handling": objection_handling,
        "closing": closing,
        "courtesy": courtesy,
    }
    overall_score = compute_weighted_overall_score(metrics)

    loss_reason = ""
    if outcome in ("lost", "pending") and category in ("Part Inquiry/Quote", "Price Negotiation"):
        if any(w in low for w in ["out of stock", "don't have", "sold the", "crushed"]):
            loss_reason = "out_of_stock"
        elif any(w in low for w in ["price", "too high", "aftermarket", "lkq", "cheaper"]):
            loss_reason = "price"
        elif any(w in low for w in ["miles", "condition", "rust", "dent", "damage"]):
            loss_reason = "condition"
        elif any(w in low for w in ["vin", "fit", "interchange"]):
            loss_reason = "fitment"
        elif any(w in low for w in ["freight", "shipping", "tomorrow", "wait"]):
            loss_reason = "shipping"
        else:
            loss_reason = "price"

    veh_str = " ".join(str(x) for x in [vp["vehicle_year"], vp["vehicle_make"], vp["vehicle_model"]] if x)
    part_str = vp["part_requested"] or "OEM part"
    summary = (
        f"Caller inquired about a {part_str.lower()} for a {veh_str or 'vehicle'}. "
        f"Rep {'confirmed fitment details, defended OEM quality, and closed the order' if outcome == 'won' else 'provided availability and pricing options'}."
    )

    strengths = []
    improvements = []
    if greeting >= 8:
        strengths.append("Identified the yard and rep name clearly right at the start.")
    else:
        improvements.append("Open every call with the yard name and your first name.")
    if needs_discovery >= 8:
        strengths.append("Asked clarifying fitment questions (VIN / trim / Hollander interchange) before quoting.")
    else:
        improvements.append("Ask for the VIN or trim level early to avoid fitment returns.")
    if warranty_pitched:
        strengths.append("Included warranty terms clearly when presenting the quote.")
    else:
        improvements.append("Pitch the 90-day standard warranty and extended labor coverage on every quote.")
    if closing >= 8:
        strengths.append("Asked directly for the order and confirmed pickup/delivery logistics.")
    else:
        improvements.append("Always end a quote with a direct closing question ('Want me to pull that and put your name on it?').")

    insights = [
        f"Vehicle identified: {veh_str or 'Not specified'} · Part: {part_str}",
        f"Call outcome: {outcome.upper()}" + (f" (${int(order_value)})" if order_value else ""),
    ]

    topics = []
    if vp["part_requested"]:
        topics.append(vp["part_requested"])
    if vp["vehicle_make"]:
        topics.append(f"{vp['vehicle_make']} {vp['vehicle_model']}".strip())
    if warranty_pitched:
        topics.append("90-Day Warranty")
    if "aftermarket" in low or "lkq" in low:
        topics.append("Price vs Aftermarket")

    coaching_feedback = (
        "Strong discovery and OEM value positioning. Keep anchoring your price with part condition, mileage, and warranty coverage before the caller compares to aftermarket."
        if overall_score >= 80
        else "Focus on confirming VIN/interchange up front, stating the 90-day warranty with every price quote, and asking a direct closing question before hanging up."
    )

    return {
        "turns": turns,
        "category": category,
        "outcome": outcome,
        "overall_score": overall_score,
        "order_value": order_value,
        "quoted_value": quoted_value,
        "warranty_pitched": warranty_pitched,
        "loss_reason": loss_reason,
        "summary": summary,
        "metrics": metrics,
        "coaching_feedback": coaching_feedback,
        "strengths": strengths,
        "improvements": improvements,
        "insights": insights,
        "topics": topics or ["Part Inquiry"],
        **vp,
    }


def generate_roleplay_reply(scenario: Dict[str, Any], messages: List[Dict[str, str]], rep_text: str) -> str:
    low = rep_text.lower()
    turn_idx = len([m for m in messages if m.get("role") == "rep"])
    title = (scenario.get("title") or "").lower()

    if turn_idx <= 1:
        if "vin" in low or "year" in low or "trim" in low:
            return "Yeah, I've got the 8th digit of the VIN right here — it's an L, 4WD crew cab. What kind of mileage is on yours and how much are you asking?"
        return f"Hey there. {scenario.get('opening_hint') or 'I need a clean OEM assembly ready to go today — do you have one in stock and what is the price?'}"
    elif turn_idx == 2:
        if any(w in low for w in ["$", "hundred", "warranty", "oem", "miles"]):
            return "Hold on, that's about $85 higher than the aftermarket quote I just got down the road. Why should I pay OEM salvage price on this job?"
        return "Okay, what's the price on it, and does it come with any warranty if my tech puts it in and there's an issue?"
    elif turn_idx == 3:
        if any(w in low for w in ["oem", "factory", "warranty", "fit", "plug", "tested", "grade"]):
            return "Fair point — aftermarket fitment has burned my shop before. If you can include the 90-day warranty and get it on the afternoon truck, what's the total out the door?"
        return "I hear you, but my customer is watching every dollar. Does that include a warranty or can you do anything on the delivery?"
    else:
        if any(w in low for w in ["card", "invoice", "hold", "set it aside", "truck", "deliver", "send", "po"]):
            return "Deal. Put it under our shop account, PO #4418, and send it on the afternoon run. Appreciate the help!"
        return "Alright, that works for me. Can you set it aside at the counter or put it on the next delivery run for us?"


def grade_roleplay_session(scenario: Dict[str, Any], messages: List[Dict[str, str]]) -> Dict[str, Any]:
    transcript = "\n".join(
        f"{'Rep' if m['role'] == 'rep' else 'Customer'}: {m['text']}" for m in messages
    )
    analysis = analyze_transcript(transcript)
    return {
        "overall_score": analysis["overall_score"],
        "summary": f"Completed {len([m for m in messages if m['role'] == 'rep'])} exchanges with {scenario.get('persona', 'the caller')}.",
        "metrics": analysis["metrics"],
        "coaching_feedback": analysis["coaching_feedback"],
        "strengths": analysis["strengths"],
        "improvements": analysis["improvements"],
    }
