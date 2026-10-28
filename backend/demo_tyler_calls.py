"""Demo sales calls for Tyler Grant (Keech's Auto Salvage) used for sales-pitch demos."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

TYLER_ID = "user-keech-rep"
TYLER_NAME = "Tyler Grant"
ORG_ID = "org-keech-salvage"
ID_PREFIX = "demo-tyler-call-"

SCENARIOS: list[dict[str, Any]] = [
    {
        "customer": "Mike Hendricks", "phone": "+15125550141", "year": 2018, "make": "Ford", "model": "F-150",
        "part": "3.5L EcoBoost Engine", "category": "Part Inquiry/Quote", "outcome": "won", "sentiment": "positive",
        "score": 92, "order_value": 2850.0, "quoted_value": 2850.0, "parts_sold": ["Engine"],
        "topics": ["Engine", "Warranty", "Delivery"], "lost_reason": "", "days_ago": 1, "hour": 9, "duration": 312,
        "summary": "Independent mechanic needed a 3.5L EcoBoost for a customer's 2018 F-150. Tyler confirmed fitment, quoted a tested 61k-mile unit with 1-year warranty, and closed the sale with next-day freight.",
        "turns": [
            ("rep", "Keech's Auto Salvage, this is Tyler. How can I help you?"),
            ("cust", "Hey Tyler, Mike over at Hendricks Auto Repair. I need a 3.5 EcoBoost for a 2018 F-150, do you have one?"),
            ("rep", "Good to hear from you, Mike. Is it the twin-turbo 3.5 and do you have the VIN so I can match the engine code?"),
            ("cust", "Yep, twin turbo. VIN ends 4417, it's a 4x4 crew cab."),
            ("rep", "Perfect, I've got a tested 61,000-mile unit on the rack, compression and leak-down verified. It's $2,850 with a 1-year parts warranty, and I can add labor coverage."),
            ("cust", "That works. Can you get it to me by tomorrow?"),
            ("rep", "Yes, it ships on today's freight and lands tomorrow morning. Want me to throw in a new set of coil packs while you're in there? They're $120 for the set."),
            ("cust", "Sure, add the coils. Let's do it."),
        ],
        "strengths": ["Confirmed fitment with VIN before quoting", "Natural cross-sell of coil packs", "Clear warranty and delivery commitment"],
        "improvements": ["Mention core charge policy up front"],
        "coaching": "Excellent consultative close. Tyler verified fitment, built value with testing details, and added a companion part without pressure.",
    },
    {
        "customer": "Sarah Okafor", "phone": "+15125550172", "year": 2016, "make": "Honda", "model": "Accord",
        "part": "Front Bumper Cover", "category": "Price Negotiation", "outcome": "won", "sentiment": "positive",
        "score": 84, "order_value": 285.0, "quoted_value": 325.0, "parts_sold": ["Bumper Cover"],
        "topics": ["Bumper", "Price", "Color Match"], "lost_reason": "", "days_ago": 2, "hour": 11, "duration": 198,
        "summary": "Body shop customer pushed back on a $325 bumper quote. Tyler held value on condition and color match, offered a small discount for same-day pickup, and secured the order at $285.",
        "turns": [
            ("rep", "Keech's Auto Salvage, Tyler speaking."),
            ("cust", "Hi, I need a front bumper cover for a 2016 Accord, Crystal Black. What are you asking?"),
            ("rep", "I have a clean OEM cover in Crystal Black, no cracks, original mounting tabs intact. It's $325."),
            ("cust", "That's high. A yard across town said $250."),
            ("rep", "I understand. Ours is an A-grade color match, so it won't need a repaint. If you can pick up today I can do $285."),
            ("cust", "Okay, $285 and I'll grab it this afternoon."),
            ("rep", "Done. I'll have it at the counter under Okafor Collision. Anything else for that Accord, like fog light bezels?"),
            ("cust", "Not today, thanks Tyler."),
        ],
        "strengths": ["Defended price using color-match value", "Created urgency with same-day pickup"],
        "improvements": ["Could have bundled fog light bezels or grille to raise ticket"],
        "coaching": "Good objection handling. Next time lead with the repaint savings before offering a discount.",
    },
    {
        "customer": "Carlos Mendez", "phone": "+15125550188", "year": 2019, "make": "Chevrolet", "model": "Silverado 1500",
        "part": "6L80 Transmission", "category": "Part Inquiry/Quote", "outcome": "lost", "sentiment": "neutral",
        "score": 68, "order_value": 0.0, "quoted_value": 1950.0, "parts_sold": [],
        "topics": ["Transmission", "Price", "Competitor"], "lost_reason": "Price - went with competitor",
        "days_ago": 3, "hour": 14, "duration": 244,
        "summary": "Customer asked for a 6L80 transmission for a 2019 Silverado. Tyler quoted $1,950 but did not defend price when the buyer mentioned a lower quote elsewhere, and the sale was lost.",
        "turns": [
            ("rep", "Keech's Auto Salvage, this is Tyler."),
            ("cust", "Yeah, Carlos here. Looking for a 6L80 trans for a 2019 Silverado 1500."),
            ("rep", "I have one with 48,000 miles, tested, 90-day warranty. It's $1,950."),
            ("cust", "Hmm, I got $1,700 from another yard."),
            ("rep", "Okay, that's the best I can do I think."),
            ("cust", "Alright, I'll go with them then. Thanks."),
            ("rep", "No problem, call us if anything changes."),
        ],
        "strengths": ["Fast availability confirmation", "Polite close"],
        "improvements": ["Did not ask about the competitor's warranty or mileage", "No attempt to negotiate or add value", "Never asked for the order"],
        "coaching": "A lost-sale learning moment. When price is the objection, compare warranty, mileage, and testing before conceding the deal.",
    },
    {
        "customer": "Linda Patterson", "phone": "+15125550193", "year": 2014, "make": "Toyota", "model": "Camry",
        "part": "Alternator", "category": "Part Inquiry/Quote", "outcome": "won", "sentiment": "positive",
        "score": 88, "order_value": 145.0, "quoted_value": 145.0, "parts_sold": ["Alternator", "Serpentine Belt"],
        "topics": ["Alternator", "Belt", "Warranty"], "lost_reason": "", "days_ago": 3, "hour": 10, "duration": 176,
        "summary": "Retail customer needed an alternator for a 2014 Camry. Tyler explained testing, sold the unit at $145 and upsold a serpentine belt.",
        "turns": [
            ("rep", "Keech's Auto Salvage, Tyler here."),
            ("cust", "Hi, my 2014 Camry battery light is on, the mechanic says it's the alternator."),
            ("rep", "Sorry to hear that. Is it the 2.5 four-cylinder? I have a tested alternator for $145, 90-day warranty."),
            ("cust", "Yes, 2.5. That sounds fair."),
            ("rep", "Since the belt is already off, I'd suggest a serpentine belt for $22. Saves you a second repair."),
            ("cust", "Good idea, add that too."),
        ],
        "strengths": ["Empathetic opening", "Sensible companion-part suggestion"],
        "improvements": ["Offer extended warranty option"],
        "coaching": "Friendly and efficient. Add the 1-year warranty upsell to every retail alternator quote.",
    },
    {
        "customer": "Dave Whitfield", "phone": "+15125550204", "year": 2017, "make": "Ram", "model": "1500",
        "part": "Driver Side Headlamp", "category": "Order/Sale", "outcome": "won", "sentiment": "positive",
        "score": 90, "order_value": 310.0, "quoted_value": 310.0, "parts_sold": ["Headlamp", "Fender"],
        "topics": ["Headlamp", "Fender", "Shipping"], "lost_reason": "", "days_ago": 4, "hour": 13, "duration": 261,
        "summary": "Collision repair customer ordered an LED headlamp and added a matching fender after Tyler confirmed trim level and paint code. Shipping arranged for Friday.",
        "turns": [
            ("rep", "Keech's Auto Salvage, this is Tyler."),
            ("cust", "Dave at Whitfield Collision. Need a driver headlamp for a 2017 Ram 1500 Laramie."),
            ("rep", "Is it the projector or the LED? I want to make sure it's the right plug and housing."),
            ("cust", "LED, Laramie Longhorn."),
            ("rep", "Got it, I have an LED unit, no cracks or fogging, $310. Do you need the fender too? I have a matching one in Bright White."),
            ("cust", "Yes, same truck, what's the fender?"),
            ("rep", "$190 and I'll ship both together Friday so they arrive Monday."),
            ("cust", "Perfect, ship both."),
        ],
        "strengths": ["Asked trim-level questions", "Proactively offered matching fender", "Clear shipping timeline"],
        "improvements": ["Confirm shipping address on the call"],
        "coaching": "Outstanding discovery. Verifying trim and plug type prevents returns and builds trust with body shops.",
    },
    {
        "customer": "Priya Raman", "phone": "+15125550219", "year": 2015, "make": "Nissan", "model": "Altima",
        "part": "CVT Transmission", "category": "Warranty/Return", "outcome": "n/a", "sentiment": "negative",
        "score": 74, "order_value": 0.0, "quoted_value": 0.0, "parts_sold": [],
        "topics": ["Warranty", "Return", "CVT"], "lost_reason": "", "days_ago": 5, "hour": 15, "duration": 289,
        "summary": "Customer called about a CVT that began slipping three weeks after install. Tyler stayed calm, opened a warranty claim, and scheduled a replacement review.",
        "turns": [
            ("rep", "Keech's Auto Salvage, Tyler speaking."),
            ("cust", "I bought a CVT three weeks ago for my Altima and it's already slipping. I'm really frustrated."),
            ("rep", "I'm sorry about that, Priya. That's not the experience we want. Let me pull your invoice, one moment."),
            ("cust", "Order 8841."),
            ("rep", "Found it. You're well within the 90-day warranty. I'll open a claim now, and our tech will review it within 24 hours."),
            ("cust", "Do I have to pay for labor again?"),
            ("rep", "Parts are covered. If you have the labor warranty, that's covered too. I'll check and email you today."),
            ("cust", "Okay, thank you for being helpful."),
        ],
        "strengths": ["Empathy and calm de-escalation", "Quick invoice lookup", "Clear next steps and timeline"],
        "improvements": ["Should have confirmed labor warranty status before the call ended"],
        "coaching": "Great recovery on an upset customer. Always check for labor coverage so the customer leaves with a full answer.",
    },
    {
        "customer": "Tom Brennan", "phone": "+15125550231", "year": 2012, "make": "Jeep", "model": "Wrangler",
        "part": "Hardtop", "category": "Part Inquiry/Quote", "outcome": "pending", "sentiment": "positive",
        "score": 80, "order_value": 0.0, "quoted_value": 1100.0, "parts_sold": [],
        "topics": ["Hardtop", "Quote", "Callback"], "lost_reason": "", "days_ago": 6, "hour": 12, "duration": 205,
        "summary": "Hobbyist wanted a hardtop for a 2012 Wrangler. Tyler quoted $1,100 and the customer asked for time to confirm color; a callback was scheduled.",
        "turns": [
            ("rep", "Keech's Auto Salvage, this is Tyler."),
            ("cust", "Tom here. Do you have a hardtop for a 2012 Wrangler Unlimited?"),
            ("rep", "I do, a black three-piece with the hardware included. $1,100 and it's in good shape."),
            ("cust", "Is it the same black as my Jeep? It's Black Clearcoat."),
            ("rep", "Black Clearcoat, yes. I can send photos to your phone right now."),
            ("cust", "Send them, and I'll call you back after I show my wife."),
            ("rep", "Will do. I'll follow up tomorrow if I haven't heard from you."),
        ],
        "strengths": ["Offered photos to build confidence", "Set a follow-up expectation"],
        "improvements": ["Create urgency since hardtops move fast"],
        "coaching": "Strong lead nurture. A gentle reminder that the unit is in demand helps convert pending quotes.",
    },
    {
        "customer": "Jennifer Cho", "phone": "+15125550247", "year": 2020, "make": "Hyundai", "model": "Elantra",
        "part": "Side Mirror", "category": "Part Inquiry/Quote", "outcome": "won", "sentiment": "positive",
        "score": 86, "order_value": 95.0, "quoted_value": 95.0, "parts_sold": ["Side Mirror"],
        "topics": ["Mirror", "Heated", "Pickup"], "lost_reason": "", "days_ago": 7, "hour": 16, "duration": 142,
        "summary": "Quick retail call for a heated passenger mirror. Tyler verified options, quoted $95, and set up same-day pickup.",
        "turns": [
            ("rep", "Keech's Auto Salvage, Tyler here."),
            ("cust", "Hi, I need a passenger side mirror for a 2020 Elantra."),
            ("rep", "Does yours have the heated glass and blind-spot indicator?"),
            ("cust", "Heated, with the little turn signal on it."),
            ("rep", "Great, I have that exact one for $95. Can you pick it up today?"),
            ("cust", "Yes, I'll be there by five."),
        ],
        "strengths": ["Asked option-specific questions", "Used assumptive close"],
        "improvements": ["Mention warranty and return window"],
        "coaching": "Quick and accurate. Verifying features avoided a return; add warranty language to every close.",
    },
    {
        "customer": "Robert Kessler", "phone": "+15125550263", "year": 2013, "make": "BMW", "model": "328i",
        "part": "N20 Engine", "category": "Core Return", "outcome": "n/a", "sentiment": "neutral",
        "score": 78, "order_value": 0.0, "quoted_value": 0.0, "parts_sold": [],
        "topics": ["Core", "Refund", "Engine"], "lost_reason": "", "days_ago": 8, "hour": 9, "duration": 233,
        "summary": "Customer asked when the $300 core deposit would be refunded. Tyler reviewed the core return, confirmed it was received, and promised the refund within 3 business days.",
        "turns": [
            ("rep", "Keech's Auto Salvage, Tyler speaking."),
            ("cust", "I returned my old N20 core two weeks ago and haven't seen the $300 deposit back."),
            ("rep", "Let me check the core log for you. Last name Kessler?"),
            ("cust", "Yes, Kessler."),
            ("rep", "I see it was received and inspected last Thursday. The refund is queued and should hit your card in 3 business days."),
            ("cust", "That's what I needed. Thanks for checking."),
        ],
        "strengths": ["Used core log to give a precise answer", "Set a clear refund timeline"],
        "improvements": ["Should have emailed a confirmation while on the call"],
        "coaching": "Clear and reassuring. Send a written confirmation immediately for refund calls to reduce repeat contacts.",
    },
    {
        "customer": "Amanda Foster", "phone": "+15125550277", "year": 2021, "make": "Subaru", "model": "Outback",
        "part": "Rear Liftgate", "category": "Shipping/Delivery", "outcome": "won", "sentiment": "positive",
        "score": 89, "order_value": 640.0, "quoted_value": 640.0, "parts_sold": ["Liftgate", "Taillight"],
        "topics": ["Liftgate", "Freight", "Taillight"], "lost_reason": "", "days_ago": 9, "hour": 10, "duration": 274,
        "summary": "Shop in another state needed a liftgate delivered. Tyler quoted freight, matched color, and added a taillight to the order.",
        "turns": [
            ("rep", "Keech's Auto Salvage, this is Tyler."),
            ("cust", "Hi, I'm Amanda at Foster Collision in Tulsa. I need a rear liftgate for a 2021 Outback, Crystal White."),
            ("rep", "I have one in Crystal White with the glass and wiring harness, $640. Freight to Tulsa is $85."),
            ("cust", "That's fine. Can it arrive by Thursday?"),
            ("rep", "If I ship today, yes, Thursday by noon. I can also include the matching taillight for $75."),
            ("cust", "Add the taillight please, and send an invoice."),
            ("rep", "Invoice is coming to your email now, thanks Amanda."),
        ],
        "strengths": ["Confirmed color and included components", "Delivery date commitment", "Upsell with matching taillight"],
        "improvements": ["Mention packaging and damage inspection policy"],
        "coaching": "Great shipping call. Quote freight early and always confirm a delivery date, as Tyler did.",
    },
]


def _iso(days_ago: int, hour: int) -> str:
    base = datetime.now(timezone.utc).replace(minute=12, second=0, microsecond=0, hour=hour)
    return (base - timedelta(days=days_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _metrics(score: int, outcome: str) -> dict[str, int]:
    return {
        "greeting": min(100, score + 6),
        "needs_discovery": min(100, score + 3),
        "product_knowledge": min(100, score + 4),
        "upsell_crosssell": max(40, score - 10),
        "objection_handling": max(35, score - (14 if outcome == "lost" else 2)),
        "closing": max(30, score - (22 if outcome == "lost" else 0)),
        "compliance_warranty": max(50, score - 4),
        "tone_empathy": min(100, score + 7),
    }


def _audio_duration(cid: str, fallback: float) -> float:
    import os
    import wave
    d = os.environ.get("DATA_DIR")
    base = os.path.join(d, "uploads") if d else os.path.join(os.path.dirname(__file__), "uploads")
    path = os.path.join(base, f"{cid}.wav")
    try:
        with wave.open(path, "rb") as w:
            return round(w.getnframes() / float(w.getframerate()), 1)
    except Exception:
        return fallback


def build_demo_calls(
    scenarios: list[dict[str, Any]] | None = None,
    rep_id: str = TYLER_ID,
    rep_name: str = TYLER_NAME,
    id_prefix: str = ID_PREFIX,
) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    """Return a list of (summary, full_details) for each demo call."""
    out = []
    for i, s in enumerate(scenarios if scenarios is not None else SCENARIOS, start=1):
        cid = f"{id_prefix}{i:02d}"
        vehicle = f"{s['year']} {s['make']} {s['model']}"
        turns = [
            {"speaker": rep_name if role == "rep" else s["customer"], "text": text}
            for role, text in s["turns"]
        ]
        transcript = "\n".join(f"{t['speaker']}: {t['text']}" for t in turns)
        summary = {
            "id": cid,
            "org_id": ORG_ID,
            "rep_id": rep_id,
            "rep_name": rep_name,
            "customer_name": s["customer"],
            "customer_phone": s["phone"],
            "source": "transcript",
            "status": "analyzed",
            "category": s["category"],
            "summary": s["summary"],
            "vehicle": vehicle,
            "part_requested": s["part"],
            "outcome": s["outcome"],
            "sentiment": s["sentiment"],
            "overall_score": s["score"],
            "created_at": _iso(s["days_ago"], s["hour"]),
            "direction": "inbound",
            "duration_sec": _audio_duration(cid, float(s["duration"])),
            "source_category": "Sales Inquiry",
            "topics": s["topics"],
            "order_value": s["order_value"],
            "quoted_value": s["quoted_value"],
            "parts_sold": s["parts_sold"],
            "delivery_call": False,
            "delivery_check": None,
            "lost_reason": s["lost_reason"],
            "callback_done": False,
            "callback_by": "",
            "callback_at": None,
            "vehicle_year": s["year"],
            "vehicle_make": s["make"],
            "vehicle_model": s["model"],
            "delivery_kind": "",
            "delivery_score": None,
            "has_audio": True,
            "audio_mime": "audio/wav",
        }
        full = dict(summary)
        full.update({
            "turns": turns,
            "transcript": transcript,
            "metrics": _metrics(s["score"], s["outcome"]),
            "strengths": s["strengths"],
            "improvements": s["improvements"],
            "insights": [f"Category: {s['category']}", f"Customer inquired about {s['part']} for a {vehicle}."],
            "coaching_feedback": s["coaching"],
            "keyword_hits": [{"keyword": "Warranty", "count": 1}],
            "error": "",
            "trackers": ["Warranty Mentioned", "Hollander Checked"],
            "external_url": "",
        })
        out.append((summary, full))
    return out
