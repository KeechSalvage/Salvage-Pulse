"""Resolve scoring weights, AI criteria, and instructions by yard and location.

Yard settings remain the default.  A location can override weights, metric
criteria, and free-form AI instructions without changing any other location or
any other yard.
"""
from __future__ import annotations

from typing import Any, Optional

from database import METRICS, get_org_scoring_config

DEFAULT_WEIGHTS = {m["key"]: int(m["weight"]) for m in METRICS}
DEFAULT_CRITERIA = {m["key"]: str(m.get("ai_criteria") or "") for m in METRICS}


def _merge_weights(raw: Any, base: dict[str, int]) -> dict[str, int]:
    weights = dict(base)
    if isinstance(raw, dict):
        for key in DEFAULT_WEIGHTS:
            if key in raw:
                try:
                    weights[key] = int(raw[key])
                except (TypeError, ValueError):
                    pass
    return weights


def _merge_criteria(raw: Any, base: dict[str, str]) -> dict[str, str]:
    criteria = dict(base)
    if isinstance(raw, dict):
        for key in DEFAULT_CRITERIA:
            value = raw.get(key)
            if isinstance(value, str) and value.strip():
                criteria[key] = value.strip()[:4000]
    return criteria


def _yard_bucket(state: dict[str, Any], org_id: Optional[str]) -> dict[str, Any]:
    for yard in state.get("admin_orgs", []):
        if yard.get("id") == org_id:
            return yard
    org = state.get("org", {})
    if org.get("id") == org_id:
        return org
    return {}


def resolve_scoring(
    state: dict[str, Any],
    org_id: Optional[str],
    site_id: Optional[str] = None,
) -> dict[str, Any]:
    """Return the effective scoring configuration for a yard or location."""
    custom_scoring, yard_weights = get_org_scoring_config(org_id)
    yard = _yard_bucket(state, org_id)
    weights = _merge_weights(yard_weights, DEFAULT_WEIGHTS)
    criteria = _merge_criteria(yard.get("metric_criteria"), DEFAULT_CRITERIA)
    instructions = str(yard.get("ai_instructions") or "")[:4000]

    if site_id:
        site = next(
            (s for s in state.get("sites_data", {}).get("sites", []) if s.get("id") == site_id),
            None,
        )
        site_config = (site or {}).get("scoring") or {}
        if site_config.get("custom_scoring"):
            custom_scoring = True
            weights = _merge_weights(site_config.get("weights"), weights)
            criteria = _merge_criteria(site_config.get("criteria"), criteria)
            instructions = str(site_config.get("instructions") or instructions)[:4000]

    return {
        "site_id": site_id or "",
        "custom_scoring": bool(custom_scoring),
        "weights": weights,
        "defaults": dict(DEFAULT_WEIGHTS),
        "criteria": criteria,
        "default_criteria": dict(DEFAULT_CRITERIA),
        "instructions": instructions,
    }
