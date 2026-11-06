"""Provider-agnostic call ingestion endpoints.

Public endpoints are authenticated by a per-yard unguessable webhook token
(optionally plus each provider's own signature).  Management endpoints are
normal authenticated/manager routes scoped to the caller's yard.
"""

from __future__ import annotations

import json
import os
import uuid
from typing import Any, Optional
from urllib.parse import parse_qsl

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, Response, UploadFile

from auth_utils import get_current_user, get_uploads_dir
from security import (
    ALLOWED_AUDIO_EXTENSIONS,
    effective_org,
    is_manager,
    require_authenticated,
    validate_upload,
)
import store

from ingest import config as ingest_config
from ingest.adapters import ADAPTERS, adapter_for, detect_provider, parse_payload
from ingest.media import audio_extension
from ingest.models import NormalizedCall
from ingest.service import (
    clear_events,
    ingest_call,
    recent_events,
    retry_event,
)
from ingest.transcription import available_providers

public_router = APIRouter(tags=["ingest"])
router = APIRouter(tags=["ingest"], dependencies=[Depends(require_authenticated)])


def _base_url(request: Request) -> str:
    configured = (os.getenv("PUBLIC_BASE_URL") or os.getenv("APP_URL") or "").strip().rstrip("/")
    if configured:
        return configured
    return str(request.base_url).rstrip("/")


def _public_context(request: Request, token: str) -> tuple[str, dict[str, Any], dict[str, Any]]:
    st = store.get_state()
    found = ingest_config.find_by_token(st, token)
    if not found:
        # Deliberately indistinguishable from an unknown path.
        raise HTTPException(status_code=404, detail="Not found")
    org_id, cfg = found
    if not _org_exists(st, org_id):
        raise HTTPException(status_code=404, detail="Not found")
    return org_id, cfg, st


def _org_exists(st: dict[str, Any], org_id: str) -> bool:
    if not org_id:
        return False
    if any(org.get("id") == org_id for org in st.get("admin_orgs", [])):
        return True
    org = st.get("org") or {}
    return org.get("id") == org_id or (org_id == store.KEECH_ORG_ID and bool(st.get("users_by_id")))


def _signature_urls(request: Request, configured_base: str) -> list[str]:
    path = request.url.path
    query = request.url.query
    suffix = path + (f"?{query}" if query else "")
    candidates = [
        f"{configured_base}{suffix}",
        str(request.url),
    ]
    forwarded_proto = request.headers.get("x-forwarded-proto")
    forwarded_host = request.headers.get("x-forwarded-host") or request.headers.get("host")
    if forwarded_proto and forwarded_host:
        candidates.append(f"{forwarded_proto}://{forwarded_host}{suffix}")
    out: list[str] = []
    for candidate in candidates:
        if candidate and candidate not in out:
            out.append(candidate)
    return out


def _parse_body(raw: bytes, content_type: str) -> tuple[Any, dict[str, str]]:
    content_type = (content_type or "").lower()
    if "application/json" in content_type or (not content_type and raw[:1] in (b"{", b"[")):
        try:
            return json.loads(raw.decode("utf-8") or "{}"), {}
        except (UnicodeDecodeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail="Body is not valid JSON") from exc
    if "application/x-www-form-urlencoded" in content_type:
        try:
            pairs = parse_qsl(raw.decode("utf-8", errors="replace"), keep_blank_values=True)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Body is not valid form data") from exc
        form = {key: value for key, value in pairs}
        return form, form
    # Some providers send JSON without a content type. Try JSON before form.
    try:
        parsed = json.loads(raw.decode("utf-8") or "{}")
        return parsed, {}
    except (UnicodeDecodeError, ValueError):
        pairs = parse_qsl(raw.decode("utf-8", errors="replace"), keep_blank_values=True)
        if pairs:
            form = {key: value for key, value in pairs}
            return form, form
    raise HTTPException(status_code=415, detail="Send JSON or application/x-www-form-urlencoded")


def _verify_with_candidates(
    *,
    adapter,
    raw: bytes,
    headers: dict[str, str],
    form: dict[str, str],
    urls: list[str],
    config: dict[str, Any],
) -> None:
    last_error: Exception | None = None
    for url in urls:
        try:
            adapter.verify(raw_body=raw, headers=headers, form=form, url=url, config=config)
            return
        except ValueError as exc:
            last_error = exc
    raise HTTPException(status_code=401, detail=str(last_error or "Invalid signature"))


def _run_calls(
    *,
    org_id: str,
    calls: list[NormalizedCall],
    source: str,
    wait: bool,
    audio_path: str = "",
    audio_mime: str = "",
) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    # Bound synchronous work so a public webhook cannot tie up a worker for
    # dozens of AI jobs in one request.
    sync_allowed = wait and len(calls) <= 5
    for call in calls:
        results.append(
            ingest_call(
                org_id=org_id,
                call=call,
                source=source,
                sync=sync_allowed,
                audio_path=audio_path if len(calls) == 1 else "",
                audio_mime=audio_mime if len(calls) == 1 else "",
            )
        )
    if len(results) == 1:
        return {"ok": True, **results[0]}
    summary = {
        "ok": True,
        "accepted": len([item for item in results if item.get("status") not in ("duplicate",)]),
        "duplicates": len([item for item in results if item.get("status") == "duplicate"]),
        "results": results,
    }
    return summary


# ===========================================================================
# Public receiver
# ===========================================================================
@public_router.get("/api/ingest/webhook/{token}")
@public_router.get("/api/ingest/webhook/{token}/{provider}")
def ingest_webhook_handshake(token: str, request: Request, provider: str = "") -> Response:
    """RingCentral (and similar) subscription validation handshake."""
    _public_context(request, token)
    validation = request.headers.get("validation-token") or request.headers.get("Validation-Token") or ""
    if not validation:
        return Response(
            content=json.dumps({"ok": True, "message": "Send call events with POST"}),
            media_type="application/json",
        )
    return Response(status_code=200, headers={"Validation-Token": validation})


@public_router.post("/api/ingest/webhook/{token}")
@public_router.post("/api/ingest/webhook/{token}/{provider}")
async def ingest_webhook(
    token: str,
    request: Request,
    provider: str = "",
    wait: bool = Query(False),
) -> Any:
    org_id, config, _st = _public_context(request, token)
    # RingCentral (and some other providers) validate a subscription with a
    # POST that has an empty body and a Validation-Token header.
    validation = request.headers.get("validation-token")
    if validation:
        return Response(status_code=200, headers={"Validation-Token": validation})
    raw = await request.body()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty webhook body")
    payload, form = _parse_body(raw, request.headers.get("content-type", ""))

    requested = (provider or request.query_params.get("provider") or "").strip()
    if not requested:
        requested = detect_provider(payload, {k.lower(): v for k, v in request.headers.items()}, request.headers.get("content-type", ""), form)
    adapter = adapter_for(requested)
    headers = {k.lower(): v for k, v in request.headers.items()}
    _verify_with_candidates(
        adapter=adapter,
        raw=raw,
        headers=headers,
        form=form,
        urls=_signature_urls(request, _base_url(request)),
        config=config,
    )

    try:
        calls = parse_payload(adapter, payload, headers)
    except Exception as exc:  # noqa: BLE001 - malformed provider payloads are client errors
        raise HTTPException(status_code=400, detail=f"Could not read {adapter.name} payload: {str(exc)[:200]}") from exc
    if not calls:
        return {"ok": True, "accepted": 0, "message": "No call events found in this payload"}
    for call in calls:
        call.metadata["provider_event_name"] = adapter.name
        if adapter.name != "generic":
            call.provider = adapter.name
    return _run_calls(org_id=org_id, calls=calls, source="webhook", wait=wait)


@public_router.post("/api/ingest/audio/{token}")
async def ingest_audio(
    token: str,
    request: Request,
    file: UploadFile = File(...),
    wait: bool = Query(False),
    external_id: str = Form(""),
    direction: str = Form("inbound"),
    from_number: str = Form(""),
    to_number: str = Form(""),
    agent_email: str = Form(""),
    agent_name: str = Form(""),
    agent_extension: str = Form(""),
    customer_name: str = Form(""),
    customer_phone: str = Form(""),
    started_at: str = Form(""),
    duration_sec: str = Form("0"),
    transcript: str = Form(""),
) -> dict[str, Any]:
    """Universal audio push for phone systems that cannot send a recording URL."""
    org_id, _config, _st = _public_context(request, token)
    content = await file.read()
    max_bytes = int(float(os.getenv("INGEST_MEDIA_MAX_MB", "100")) * 1024 * 1024)
    validate_upload(content, file.filename or "recording.wav", ALLOWED_AUDIO_EXTENSIONS, max_bytes=max_bytes)
    ext = audio_extension(content, file.content_type or "", file.filename or "")
    upload_dir = get_uploads_dir()
    upload_id = f"ingest-upload-{uuid.uuid4().hex[:16]}"
    path = os.path.join(upload_dir, f"{upload_id}{ext}")
    with open(path, "wb") as handle:
        handle.write(content)
    os.chmod(path, 0o600)

    from ingest.adapters import _parse_duration, _parse_timestamp  # local import keeps adapter internals private
    mime = {
        ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
        ".mp4": "video/mp4", ".ogg": "audio/ogg", ".webm": "audio/webm",
        ".flac": "audio/flac", ".aac": "audio/aac", ".mpeg": "audio/mpeg",
    }.get(ext, file.content_type or "audio/wav")

    call = NormalizedCall(
        provider="upload",
        external_id=(external_id or upload_id).strip()[:200],
        event="transcript" if transcript.strip() else "recording",
        direction=direction,
        started_at=_parse_timestamp(started_at) if started_at else store.now_iso(),
        duration_sec=_parse_duration(duration_sec),
        from_number=from_number,
        to_number=to_number,
        agent_email=agent_email,
        agent_name=agent_name,
        agent_extension=agent_extension,
        customer_name=customer_name,
        customer_phone=customer_phone,
        transcript=transcript,
        metadata={"audio_path": path, "audio_mime": mime},
    )
    if not call.customer_phone:
        call.customer_phone = from_number
    return _run_calls(org_id=org_id, calls=[call], source="audio_upload", wait=wait, audio_path=path, audio_mime=mime)


# ===========================================================================
# Management UI
# ===========================================================================
@router.get("/api/ingest/settings")
def get_ingest_settings(request: Request, org_id: Optional[str] = Query(None)) -> dict[str, Any]:
    u = get_current_user(request)
    if not is_manager(u):
        raise HTTPException(status_code=403, detail="Manager access required")
    scoped = effective_org(u, org_id)
    if not scoped:
        raise HTTPException(status_code=400, detail="Choose a yard to configure call ingestion")
    st = store.get_state()
    cfg = ingest_config.get_config(st, scoped)
    payload = ingest_config.public_config(cfg, _base_url(request))
    payload.update(
        {
            "supported_providers": sorted(ADAPTERS.keys()),
            "stt_available": available_providers(),
            "recent_events": recent_events(scoped, 25),
        }
    )
    return payload


@router.put("/api/ingest/settings")
def put_ingest_settings(body: dict[str, Any], request: Request, org_id: Optional[str] = Query(None)) -> dict[str, Any]:
    u = get_current_user(request)
    if not is_manager(u):
        raise HTTPException(status_code=403, detail="Manager access required")
    scoped = effective_org(u, org_id)
    if not scoped:
        raise HTTPException(status_code=400, detail="Choose a yard to configure call ingestion")
    st = store.get_state()
    default_rep = body.get("default_rep_id")
    if default_rep not in (None, ""):
        user = st.get("users_by_id", {}).get(str(default_rep))
        if not user or user.get("org_id") != scoped:
            raise HTTPException(status_code=400, detail="Choose a rep in this yard")
    cfg = ingest_config.get_config(st, scoped)
    try:
        ingest_config.patch_config(
            cfg,
            stt_provider=body.get("stt_provider"),
            default_rep_id=body.get("default_rep_id"),
            auto_create_reps=body.get("auto_create_reps"),
            providers=body.get("providers"),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    store.save_state()
    payload = ingest_config.public_config(cfg, _base_url(request))
    payload.update({"supported_providers": sorted(ADAPTERS.keys()), "stt_available": available_providers()})
    return payload


@router.post("/api/ingest/rotate")
def rotate_ingest_token(request: Request, org_id: Optional[str] = Query(None)) -> dict[str, Any]:
    u = get_current_user(request)
    if not is_manager(u):
        raise HTTPException(status_code=403, detail="Manager access required")
    scoped = effective_org(u, org_id)
    if not scoped:
        raise HTTPException(status_code=400, detail="Choose a yard to configure call ingestion")
    st = store.get_state()
    cfg = ingest_config.get_config(st, scoped)
    ingest_config.rotate_token(cfg)
    store.save_state()
    payload = ingest_config.public_config(cfg, _base_url(request))
    payload.update({"supported_providers": sorted(ADAPTERS.keys()), "stt_available": available_providers()})
    return payload


@router.get("/api/ingest/events")
def get_ingest_events(request: Request, org_id: Optional[str] = Query(None), limit: int = Query(50)) -> list[dict[str, Any]]:
    u = get_current_user(request)
    if not is_manager(u):
        raise HTTPException(status_code=403, detail="Manager access required")
    scoped = effective_org(u, org_id)
    if not scoped:
        raise HTTPException(status_code=400, detail="Choose a yard to view ingest events")
    return recent_events(scoped, limit)


@router.post("/api/ingest/events/{event_id}/retry")
def retry_ingest_event(event_id: str, request: Request, org_id: Optional[str] = Query(None)) -> dict[str, Any]:
    u = get_current_user(request)
    if not is_manager(u):
        raise HTTPException(status_code=403, detail="Manager access required")
    scoped = effective_org(u, org_id)
    if not scoped:
        raise HTTPException(status_code=400, detail="Choose a yard")
    try:
        return retry_event(event_id, scoped)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/api/ingest/events")
def clear_ingest_events(request: Request, org_id: Optional[str] = Query(None)) -> dict[str, Any]:
    u = get_current_user(request)
    if not is_manager(u):
        raise HTTPException(status_code=403, detail="Manager access required")
    scoped = effective_org(u, org_id)
    if not scoped:
        raise HTTPException(status_code=400, detail="Choose a yard")
    return {"ok": True, "cleared": clear_events(scoped)}
