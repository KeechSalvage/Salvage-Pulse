"""Resolve a user's display theme on top of their yard's default look.

Mode and accent are user preferences: once someone picks them, they follow that
account on every device.  Users who have not picked one inherit the yard
defaults set by an owner or sales manager.
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
    theme: dict[str, Any] = {}
    mode = str(raw.get("mode") or "").lower()
    if mode in ("dark", "light"):
        theme["mode"] = mode
    if "accent" in raw and isinstance(raw.get("accent"), str):
        theme["accent"] = raw["accent"].strip()
    return theme


def branding_for_user(state: dict[str, Any], user: dict[str, Any]) -> dict[str, Any]:
    """Return the effective branding for one user, with personal overrides."""
    org_id = str((user or {}).get("org_id") or "")
    if org_id:
        branding_map = state.setdefault("branding_by_org", {})
        yard = branding_map.setdefault(org_id, dict(DEFAULT_BRANDING))
    else:
        yard = state.setdefault("branding", dict(DEFAULT_BRANDING))
    yard = {**DEFAULT_BRANDING, **(yard or {})}

    uid = str((user or {}).get("id") or "")
    user_theme = normalize_user_theme(state.setdefault("theme_by_user", {}).get(uid))

    mode = user_theme.get("mode") or yard.get("default_mode") or "dark"
    if mode not in ("dark", "light"):
        mode = "dark"
    accent = user_theme["accent"] if "accent" in user_theme else (yard.get("accent") or "")

    return {
        "yard_name": yard.get("yard_name") or "Salvage Pulse",
        "accent": accent,
        "yard_accent": yard.get("accent") or "",
        "default_mode": yard.get("default_mode") or "dark",
        "logo_url": yard.get("logo_url") or "",
        "user_mode": user_theme.get("mode", ""),
        "user_accent": user_theme.get("accent"),
        "mode": mode,
    }
