"""Per-yard ingestion configuration, token lookup and public-safe serialisation."""

from __future__ import annotations

import secrets
from typing import Any

import store

TOKEN_BYTES = 24


def _new_token() -> str:
    return secrets.token_urlsafe(TOKEN_BYTES)


def bucket(st: dict[str, Any], org_id: str, *, create: bool = True) -> dict[str, Any]:
    """Return a yard's ingestion bucket.

    The original Keech yard keeps its settings at ``state["ingest"]`` for
    backwards compatibility; every other yard gets an isolated bucket.
    """
    if not org_id or org_id == store.KEECH_ORG_ID:
        if create:
            return st.setdefault("ingest", {})
        return st.get("ingest") or {}
    buckets = st.setdefault("ingest_by_org", {}) if create else (st.get("ingest_by_org") or {})
    if create:
        return buckets.setdefault(org_id, {})
    return buckets.get(org_id) or {}


def default_config() -> dict[str, Any]:
    return {
        "token": _new_token(),
        "stt_provider": "auto",
        "default_rep_id": "",
        "auto_create_reps": False,
        "providers": {
            "generic": {},
            "twilio": {},
            "ringcentral": {},
            "telnyx": {},
            "vonage": {},
        },
        "updated_at": store.now_iso(),
    }


def get_config(st: dict[str, Any], org_id: str) -> dict[str, Any]:
    cfg = bucket(st, org_id, create=True)
    changed = False
    defaults = default_config()
    for key, value in defaults.items():
        if key not in cfg:
            cfg[key] = value
            changed = True
    if not str(cfg.get("token") or "").strip():
        cfg["token"] = _new_token()
        changed = True
    providers = cfg.get("providers")
    if not isinstance(providers, dict):
        cfg["providers"] = defaults["providers"]
        providers = cfg["providers"]
        changed = True
    for name, provider_default in defaults["providers"].items():
        if not isinstance(providers.get(name), dict):
            providers[name] = dict(provider_default)
            changed = True
    if changed:
        cfg["updated_at"] = store.now_iso()
        store.save_state()
    return cfg


def find_by_token(st: dict[str, Any], token: str) -> tuple[str, dict[str, Any]] | None:
    """Constant-time token lookup across all yards."""
    candidate = str(token or "").strip()
    if not candidate:
        return None
    buckets: list[tuple[str, dict[str, Any]]] = []
    legacy = st.get("ingest")
    if isinstance(legacy, dict) and legacy:
        buckets.append((store.KEECH_ORG_ID, legacy))
    for org_id, cfg in (st.get("ingest_by_org") or {}).items():
        if isinstance(cfg, dict):
            buckets.append((str(org_id), cfg))
    match: tuple[str, dict[str, Any]] | None = None
    for org_id, cfg in buckets:
        stored = str(cfg.get("token") or "")
        if stored and secrets.compare_digest(stored, candidate):
            match = (org_id, cfg)
    return match


def public_config(cfg: dict[str, Any], base_url: str) -> dict[str, Any]:
    token = str(cfg.get("token") or "")
    providers = cfg.get("providers") if isinstance(cfg.get("providers"), dict) else {}
    public_providers: dict[str, Any] = {}
    for name, raw in providers.items():
        provider = raw if isinstance(raw, dict) else {}
        signing = str(provider.get("signing_secret") or "").strip()
        bearer = str(provider.get("media_bearer_token") or "").strip()
        custom_header = bool(str(provider.get("media_header_name") or "").strip() and str(provider.get("media_header_value") or "").strip())
        twilio_auth = name == "twilio" and bool(
            str(provider.get("account_sid") or "").strip()
            and (str(provider.get("auth_token") or "").strip() or signing)
        )
        ringcentral_auth = name == "ringcentral" and bool(
            str(provider.get("client_id") or "").strip()
            and str(provider.get("client_secret") or "").strip()
            and str(provider.get("jwt") or "").strip()
        )
        public_providers[name] = {
            "signing_configured": bool(signing),
            "media_auth_configured": bool(bearer or custom_header or twilio_auth or ringcentral_auth),
            "account_sid": str(provider.get("account_sid") or ""),
            "client_id": str(provider.get("client_id") or ""),
        }
    return {
        "token": token,
        "webhook_url": f"{base_url}/api/ingest/webhook/{token}",
        "provider_urls": {
            name: f"{base_url}/api/ingest/webhook/{token}/{name}"
            for name in ("generic", "twilio", "telnyx", "vonage", "ringcentral")
        },
        "audio_upload_url": f"{base_url}/api/ingest/audio/{token}",
        "stt_provider": str(cfg.get("stt_provider") or "auto"),
        "default_rep_id": str(cfg.get("default_rep_id") or ""),
        "auto_create_reps": bool(cfg.get("auto_create_reps")),
        "providers": public_providers,
        "updated_at": cfg.get("updated_at") or "",
    }


def patch_config(
    cfg: dict[str, Any],
    *,
    stt_provider: Any = None,
    default_rep_id: Any = None,
    auto_create_reps: Any = None,
    providers: Any = None,
) -> dict[str, Any]:
    """Apply a settings update without ever returning stored secrets."""
    if stt_provider is not None:
        name = str(stt_provider or "auto").strip().lower()
        if name not in ("auto", "gemini", "deepgram", "assemblyai", "openai"):
            raise ValueError("Unknown transcription provider")
        cfg["stt_provider"] = name
    if default_rep_id is not None:
        cfg["default_rep_id"] = str(default_rep_id or "").strip()[:120]
    if auto_create_reps is not None:
        cfg["auto_create_reps"] = bool(auto_create_reps)
    if isinstance(providers, dict):
        current = cfg.setdefault("providers", {})
        for name, patch in providers.items():
            key = str(name or "").strip().lower()
            if not key or not isinstance(patch, dict):
                continue
            target = current.setdefault(key, {})
            # Only these keys are writable. An empty string clears a secret,
            # while omitting the key leaves the stored value untouched.
            for field in (
                "signing_secret", "media_bearer_token", "media_header_name",
                "media_header_value", "account_sid", "auth_token",
                "client_id", "client_secret", "jwt", "server_url",
            ):
                if field in patch:
                    target[field] = str(patch.get(field) or "").strip()[:4000]
    cfg["updated_at"] = store.now_iso()
    return cfg


def rotate_token(cfg: dict[str, Any]) -> dict[str, Any]:
    cfg["token"] = _new_token()
    cfg["updated_at"] = store.now_iso()
    return cfg
