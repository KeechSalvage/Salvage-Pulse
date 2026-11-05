"""Resolve a user's display mode on top of their yard's company branding.

Light/dark is a personal choice.  The accent colour and logo belong to the yard
and can only be changed by the owner, so they apply to everyone.
"""
from __future__ import annotations

from typing import Any

DEFAULT_BRANDING = {
    "yard_name": "Salvage Pulse",
    "accent": "",
    "default_mode": "dark",
    "logo_url": "",
    "user_mode": "",
    "user_accent": None,
    "mode": "dark",
}


def normalize_user_theme(raw: Any) -> dict[str, Any]:
    """Accept both the legacy string form and the newer per-user dict."""
    if isinstance(raw, str):
        return {"mode": raw} if raw in ("dark", "light") else {}
    if not isinstance(raw, dict):
        return {}
    mode = str(raw.get("mode") or "").lower()
    return {"mode": mode} if mode in ("dark", "light") else {}


def branding_for_user(state: dict[str, Any], user: dict[str, Any]) -> dict[str, Any]:
    """Return company branding plus this user's personal light/dark choice."""
    org_id = str((user or {}).get("org_id") or "")
    if org_id:
        branding_map = state.setdefault("branding_by_org", {})
        yard = branding_map.setdefault(org_id, dict(DEFAULT_BRANDING))
    else:
        yard = state.setdefault("branding", dict(DEFAULT_BRANDING))
    yard = {**DEFAULT_BRANDING, **(yard or {})}

    uid = str((user or {}).get("id") or "")
    user_theme = normalize_user_theme(state.setdefault("theme_by_user", {}).get(uid))
    mode = user_theme.get("mode") or "dark"

    return {
        "yard_name": yard.get("yard_name") or "Salvage Pulse",
        "accent": yard.get("accent") or "",
        "yard_accent": yard.get("accent") or "",
        "default_mode": "dark",
        "logo_url": yard.get("logo_url") or "",
        "user_mode": user_theme.get("mode", ""),
        "user_accent": None,
        "mode": mode,
    }
