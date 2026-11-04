"""Canonical call categories and direction-aware classification.

Inbound customer calls are sales inquiries, warranty/returns, or orders.
Outbound calls are delivery calls or return calls.  Legacy category names are
accepted and normalized so older imports and hand-edited calls still sort
correctly.
"""
from __future__ import annotations

import re
from typing import Any, Iterable, Optional

INBOUND_CATEGORIES = ("Sales Inquiry", "Warranty/Return", "Order/Sale")
OUTBOUND_CATEGORIES = ("Delivery", "Return Call")
CATEGORIES = [*INBOUND_CATEGORIES, *OUTBOUND_CATEGORIES]

# Old names kept only for normalizing existing data.
LEGACY_CATEGORY_MAP = {
    "part inquiry/quote": "Sales Inquiry",
    "price negotiation": "Sales Inquiry",
    "vendor/scrap seller": "Sales Inquiry",
    "shipping/delivery": "Delivery",
    "core return": "Warranty/Return",
    "other": "Sales Inquiry",
}

# Warranty and product-return language.  Deliberately excludes a rep pitching
# warranty coverage ("warranty pitch", "warranty options") on a sales call.
_WARRANTY_RE = re.compile(
    r"\b(?:"
    r"warranty\s+(?:claim|issue|process|return|replacement|repair)"
    r"|defective|return(?:ed|ing|s)?|return\s+policy"
    r"|return\s+(?:label|shipping|authorization|merchandise)"
    r"|send\s+(?:it|the\s+part)\s+back|received\s+the\s+wrong"
    r"|refund|exchange|core\s+return|core\s+credit|damage\s+credit"
    r"|credit\s+request|wrong\b|missing\s+part|not\s+working"
    r"|doesn'?t\s+work|does\s+not\s+work|stopped\s+working"
    r"|damaged|broken|cracked|replacement\s+(?:unit|part)|overheating"
    r")\b",
    re.I,
)

# Existing-order / payment language.
_ORDER_RE = re.compile(
    r"\b(?:"
    r"order\s+(?:confirmation|status|processing|issue|inquiry|details|number|delivery|support)"
    r"|invoice|payment|billing|paid|purchase|place\s+(?:an\s+)?order"
    r"|ordered|po\s+number|tracking\s+number|shipping\s+status"
    r"|delivery\s+(?:status|update)"
    r")\b",
    re.I,
)

# Delivery / shipping language.  Only used to split outbound calls.
_DELIVERY_RE = re.compile(
    r"\b(?:deliver(?:y|ed|ing)?|shipping|shipment|freight|driver|tracking|eta|drop\s?off|truck|route)\b",
    re.I,
)

# Raw RingCentral / legacy categories that carry a strong direction-aware hint.
_INBOUND_ORDER_RAW = {"order processing calls", "order processing"}
_INBOUND_WARRANTY_RAW = {"customer support calls", "customer support", "support"}
_INBOUND_SALES_RAW = {
    "sales enquiry calls",
    "sales inquiry calls",
    "sales enquiry",
    "sales inquiry",
    "supplier or vendor calls",
    "supplier or vendor",
    "supplier",
    "vendor",
    "part inquiry/quote",
    "price negotiation",
    "vendor/scrap seller",
    "other",
}
_INBOUND_ORDER_TOPIC_RAW = {"shipping/delivery", "shipping", "delivery"}


def _join_text(
    *,
    topics: Optional[Iterable[Any]] = None,
    trackers: Optional[Iterable[Any]] = None,
    transcript: str = "",
    summary: str = "",
    interaction_name: str = "",
) -> str:
    parts: list[str] = []
    for value in topics or []:
        if value:
            parts.append(str(value))
    for value in trackers or []:
        if value:
            parts.append(str(value))
    for value in (transcript, summary, interaction_name):
        if value:
            parts.append(str(value))
    return " ".join(parts).lower()


def classify_call(
    *,
    direction: Optional[str],
    category: str = "",
    topics: Optional[Iterable[Any]] = None,
    trackers: Optional[Iterable[Any]] = None,
    transcript: str = "",
    summary: str = "",
    interaction_name: str = "",
) -> str:
    """Return one of the five canonical categories for a call.

    The classifier is intentionally keyword-first.  It never returns the old
    catch-all categories ("Other", "Vendor/Scrap Seller"), because those calls
    are customer calls and belong in an actionable bucket.
    """
    low = _join_text(
        topics=topics,
        trackers=trackers,
        transcript=transcript,
        summary=summary,
        interaction_name=interaction_name,
    )
    raw = (category or "").strip().lower()
    outbound = (direction or "").strip().lower().startswith("out")

    if outbound:
        return "Delivery" if _DELIVERY_RE.search(low) else "Return Call"

    # Inbound: warranty/return and existing-order signals win over a generic
    # sales inquiry, regardless of the source system's original category.
    if _WARRANTY_RE.search(low):
        return "Warranty/Return"
    if _ORDER_RE.search(low):
        return "Order/Sale"
    if raw in _INBOUND_ORDER_RAW:
        return "Order/Sale"
    if raw in _INBOUND_ORDER_TOPIC_RAW:
        return "Order/Sale"
    if raw in _INBOUND_WARRANTY_RAW:
        return "Warranty/Return"
    if raw in _INBOUND_SALES_RAW:
        return "Sales Inquiry"
    # Voicemail, blank source category, and unknown sources are still inbound
    # customer calls.  Most are part/price/availability inquiries.
    return "Sales Inquiry"


def delivery_kind(*, transcript: str = "", summary: str = "") -> str:
    """Classify a delivery call as a confirmation or a delivery question."""
    text = f"{transcript or ''} {summary or ''}".lower()
    return "confirmation" if "confirm" in text else "question"


def migrate_call_taxonomy(state: dict[str, Any]) -> bool:
    """Rewrite legacy categories in a loaded state and flag delivery calls.

    Returns True when anything changed so the caller can persist the state.
    Outcomes are left alone; this migration only fixes sorting and the
    delivery exclusion flag.
    """
    changed = False
    full_calls = state.get("full_calls") or {}
    for call in state.get("calls") or []:
        full = full_calls.get(call.get("id")) or {}
        new_category = classify_call(
            direction=call.get("direction"),
            category=call.get("category") or full.get("category") or "",
            topics=call.get("topics") or full.get("topics"),
            trackers=call.get("trackers") or full.get("trackers"),
            transcript=full.get("transcript") or "",
            summary=call.get("summary") or full.get("summary") or "",
            interaction_name=call.get("customer_name") or "",
        )
        if call.get("category") != new_category:
            call["category"] = new_category
            changed = True
        if full and full.get("category") != new_category:
            full["category"] = new_category
            changed = True
        if new_category == "Delivery":
            if not call.get("delivery_call"):
                call["delivery_call"] = True
                changed = True
            if full and not full.get("delivery_call"):
                full["delivery_call"] = True
                changed = True
            kind = delivery_kind(
                transcript=full.get("transcript") or "",
                summary=call.get("summary") or full.get("summary") or "",
            )
            if not call.get("delivery_kind"):
                call["delivery_kind"] = kind
                changed = True
            if full and not full.get("delivery_kind"):
                full["delivery_kind"] = kind
                changed = True
    return changed
