"""The shared ingest pipeline: normalise -> resolve rep -> transcribe -> analyze -> save.

Every provider adapter ends up here.  The pipeline is deliberately independent
of the web framework so it can be exercised directly by tests and by future
workers (Celery/RQ/SQS) without changing the provider adapters.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import re
import secrets
import threading
import uuid
from typing import Any

import analyzer
import store
from database import compute_weighted_overall_score
from scoring_config import resolve_scoring

from . import config as ingest_config
from .adapters import adapter_for
from .media import audio_extension, fetch_recording
from .models import NormalizedCall
from .transcription import TranscriptionUnavailable, transcribe

logger = logging.getLogger("salvage_pulse.ingest.service")

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.environ.get("DATA_DIR") or os.path.join(BACKEND_DIR, "data")
JOBS_DIR = os.path.join(DATA_DIR, "ingest_jobs")
UPLOADS_DIR = os.path.join(DATA_DIR, "uploads")
MAX_EVENTS = 500
MAX_PENDING = 1000

_QUEUE: "queue.Queue[str]" = queue.Queue()
_WORKER: threading.Thread | None = None
_WORKER_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# Job/event bookkeeping
# ---------------------------------------------------------------------------
def _ensure_dirs() -> None:
    for path in (JOBS_DIR, UPLOADS_DIR):
        os.makedirs(path, mode=0o700, exist_ok=True)
        try:
            os.chmod(path, 0o700)
        except OSError:
            pass


def _job_path(job_id: str) -> str:
    clean = re.sub(r"[^A-Za-z0-9_.-]", "", job_id)
    return os.path.join(JOBS_DIR, f"{clean}.json")


def _write_job(job_id: str, payload: dict[str, Any]) -> None:
    _ensure_dirs()
    path = _job_path(job_id)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def _read_job(job_id: str) -> dict[str, Any] | None:
    path = _job_path(job_id)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def _remove_job(job_id: str) -> None:
    try:
        os.unlink(_job_path(job_id))
    except OSError:
        pass


def _safe_error(exc: Exception | str) -> str:
    text = str(exc or "Unknown error")
    text = re.sub(r"(https?://[^\s?]+)\?[^\s]*", r"\1?…", text)
    text = re.sub(r"(?i)(token|secret|password|authorization)=([^&\s]+)", r"\1=…", text)
    return text[:500]


def _event_summary(event: dict[str, Any]) -> dict[str, Any]:
    return {
        key: event.get(key)
        for key in (
            "id", "org_id", "provider", "external_id", "event", "status",
            "message", "call_id", "attempts", "duration_sec", "engine",
            "created_at", "updated_at", "rep_name", "rep_id", "customer_name",
            "direction", "from_number", "to_number", "customer_phone",
            "agent_phone", "started_at",
        )
    }


def record_event(
    *,
    org_id: str,
    call: NormalizedCall | None = None,
    status: str,
    message: str = "",
    call_id: str = "",
    job_id: str = "",
    provider: str = "",
    external_id: str = "",
    event: str = "",
    duration_sec: float = 0.0,
    engine: str = "",
    rep_name: str = "",
    customer_name: str = "",
) -> dict[str, Any]:
    event_id = job_id or f"evt-{uuid.uuid4().hex[:16]}"
    now = store.now_iso()
    with store._LOCK:  # serialise event-log appends across the worker and requests
        st = store.get_state()
        events = st.setdefault("ingest_events", [])
        existing = next((item for item in events if item.get("id") == event_id), None)
        if existing is None:
            existing = {
                "id": event_id,
                "org_id": org_id,
                "provider": provider or (call.provider if call else "generic"),
                "external_id": external_id or (call.external_id if call else ""),
                "event": event or (call.event if call else ""),
                "status": status,
                "message": message,
                "call_id": call_id,
                "attempts": 0,
                "duration_sec": duration_sec,
                "engine": engine,
                "created_at": now,
                "updated_at": now,
                "rep_name": rep_name,
                "rep_id": (call.metadata.get("rep_id") if call else "") or "",
                "customer_name": customer_name or (call.customer_name if call else ""),
                "direction": (call.direction if call else "") or "",
                "from_number": (call.from_number if call else "") or "",
                "to_number": (call.to_number if call else "") or "",
                "customer_phone": (call.customer_phone if call else "") or "",
                "agent_phone": (call.agent_phone if call else "") or "",
                "started_at": (call.started_at if call else "") or now,
            }
            events.insert(0, existing)
        else:
            existing.update(
                {
                    "status": status,
                    "updated_at": now,
                }
            )
            if message:
                existing["message"] = message
            if call_id:
                existing["call_id"] = call_id
            if duration_sec:
                existing["duration_sec"] = duration_sec
            if engine:
                existing["engine"] = engine
            if rep_name:
                existing["rep_name"] = rep_name
            if customer_name:
                existing["customer_name"] = customer_name
        # Keep the log bounded; job files are pruned with it.
        removed = events[MAX_EVENTS:]
        if removed:
            st["ingest_events"] = events[:MAX_EVENTS]
            for old in removed:
                if old.get("id") and old.get("id") != event_id:
                    _remove_job(str(old["id"]))
        store.save_state()
        return dict(existing)


def _increment_attempt(job_id: str) -> int:
    with store._LOCK:
        st = store.get_state()
        event = next((item for item in st.get("ingest_events", []) if item.get("id") == job_id), None)
        if event is not None:
            event["attempts"] = int(event.get("attempts") or 0) + 1
            event["updated_at"] = store.now_iso()
            store.save_state()
            return int(event["attempts"])
    return 1


def recent_events(org_id: str, limit: int = 50) -> list[dict[str, Any]]:
    st = store.get_state()
    rows = [item for item in st.get("ingest_events", []) if not org_id or item.get("org_id") == org_id]
    rows.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
    return [_event_summary(item) for item in rows[: max(1, min(limit, 200))]]


# ---------------------------------------------------------------------------
# Pending start/answer callbacks
# ---------------------------------------------------------------------------
def _pending_key(org_id: str, call: NormalizedCall) -> str:
    return f"{org_id}|{call.provider}|{call.external_id}"


def _remember_pending(org_id: str, call: NormalizedCall) -> None:
    with store._LOCK:
        st = store.get_state()
        pending = st.setdefault("ingest_pending", {})
        pending[_pending_key(org_id, call)] = {
            "call": call.to_job_dict(),
            "updated_at": store.now_iso(),
        }
        if len(pending) > MAX_PENDING:
            oldest = sorted(pending.items(), key=lambda item: str(item[1].get("updated_at") or ""))[:-MAX_PENDING]
            for key, _ in oldest:
                pending.pop(key, None)
        store.save_state()


def _take_pending(org_id: str, call: NormalizedCall) -> NormalizedCall | None:
    key = _pending_key(org_id, call)
    with store._LOCK:
        st = store.get_state()
        pending = st.get("ingest_pending") or {}
        entry = pending.pop(key, None)
        if entry:
            store.save_state()
    if not entry:
        return None
    try:
        return NormalizedCall.from_job_dict(entry.get("call") or {})
    except Exception:  # noqa: BLE001
        return None


def _merge_calls(base: NormalizedCall | None, incoming: NormalizedCall) -> NormalizedCall:
    if base is None:
        return incoming
    for field in (
        "started_at", "ended_at", "from_number", "to_number", "agent_email",
        "agent_name", "agent_extension", "agent_phone", "customer_name",
        "customer_phone", "recording_url", "transcript",
    ):
        if not getattr(incoming, field) and getattr(base, field):
            setattr(incoming, field, getattr(base, field))
    if not incoming.duration_sec and base.duration_sec:
        incoming.duration_sec = base.duration_sec
    # A later recording callback often has no direction/start/name. Prefer the
    # earlier status callback's context unless the new event supplied its own.
    meta = incoming.metadata or {}
    if not meta.get("direction_supplied") and base.direction:
        incoming.direction = base.direction
    if not meta.get("started_at_supplied") and base.started_at:
        incoming.started_at = base.started_at
    if not meta.get("customer_name_supplied") and base.customer_name and base.customer_name != "Caller":
        incoming.customer_name = base.customer_name
        incoming.customer_phone = incoming.customer_phone or base.customer_phone
    incoming.metadata = {**(base.metadata or {}), **meta}
    return incoming


# ---------------------------------------------------------------------------
# Queue
# ---------------------------------------------------------------------------
def _ensure_worker() -> None:
    global _WORKER
    with _WORKER_LOCK:
        if _WORKER and _WORKER.is_alive():
            return
        _WORKER = threading.Thread(target=_worker_loop, name="call-ingest-worker", daemon=True)
        _WORKER.start()


def _worker_loop() -> None:
    while True:
        job_id = _QUEUE.get()
        try:
            process_job(job_id)
        except Exception:  # noqa: BLE001 - one bad job must not kill the worker
            logger.exception("Unhandled ingest job failure")
        finally:
            _QUEUE.task_done()


def enqueue_job(job_id: str, *, sync: bool = False) -> None:
    if sync:
        process_job(job_id)
        return
    _ensure_worker()
    _QUEUE.put(job_id)


def clear_events(org_id: str) -> int:
    with store._LOCK:
        st = store.get_state()
        events = st.get("ingest_events", [])
        removed = [item for item in events if item.get("org_id") == org_id]
        st["ingest_events"] = [item for item in events if item.get("org_id") != org_id]
        pending = st.get("ingest_pending") or {}
        for key in [key for key in pending if str(key).startswith(f"{org_id}|")]:
            pending.pop(key, None)
        store.save_state()
    for item in removed:
        if item.get("id"):
            _remove_job(str(item["id"]))
    return len(removed)


def retry_event(job_id: str, org_id: str) -> dict[str, Any]:
    job = _read_job(job_id)
    if not job or job.get("org_id") != org_id:
        raise ValueError("This ingest attempt is no longer available to retry")
    record_event(
        org_id=org_id,
        job_id=job_id,
        status="queued",
        message="Retry queued",
        provider=str(job.get("provider") or "generic"),
        external_id=str(job.get("external_id") or ""),
    )
    enqueue_job(job_id)
    events = recent_events(org_id, 200)
    return next((item for item in events if item.get("id") == job_id), {"id": job_id, "status": "queued"})


# ---------------------------------------------------------------------------
# Main entry point used by the webhook and audio-upload routes
# ---------------------------------------------------------------------------
def ingest_call(
    *,
    org_id: str,
    call: NormalizedCall,
    source: str = "webhook",
    sync: bool = False,
    audio_path: str = "",
    audio_mime: str = "",
) -> dict[str, Any]:
    """Accept one normalised event and either queue it or return a waiting status."""
    if audio_path:
        call.metadata["audio_path"] = audio_path
    if audio_mime:
        call.metadata["audio_mime"] = audio_mime

    pending = _take_pending(org_id, call)
    call = _merge_calls(pending, call)

    existing = _existing_call(org_id, call.provider, call.external_id)
    if existing:
        record_event(
            org_id=org_id,
            call=call,
            status="duplicate",
            message="This call already exists in the library",
            call_id=str(existing.get("id") or ""),
            duration_sec=float(existing.get("duration_sec") or 0),
            rep_name=str(existing.get("rep_name") or ""),
            customer_name=str(existing.get("customer_name") or ""),
        )
        return {
            "status": "duplicate",
            "call_id": existing.get("id") or "",
            "message": "Call already ingested",
        }

    if not call.is_processable:
        # Start/answer/end callbacks are useful context for a later recording
        # callback, but they must not create an empty call. A provider with
        # call-log credentials (RingCentral) may be able to find audio itself.
        cfg = ingest_config.get_config(store.get_state(), org_id)
        adapter = adapter_for(call.provider)
        can_lookup = call.event in ("completed", "recording") and adapter.can_resolve_recording(cfg)
        if not can_lookup:
            summary = record_event(
                org_id=org_id,
                call=call,
                status="waiting",
                message="Waiting for a recording URL, audio upload or transcript",
            )
            _remember_pending(org_id, call)
            return {
                "status": "waiting",
                "event_id": summary["id"],
                "message": summary["message"],
            }

    job_id = f"evt-{uuid.uuid4().hex[:16]}"
    record_event(
        org_id=org_id,
        call=call,
        status="queued",
        message="Queued for transcription",
        job_id=job_id,
    )
    _write_job(
        job_id,
        {
            "org_id": org_id,
            "provider": call.provider,
            "external_id": call.external_id,
            "source": source,
            "call": call.to_job_dict(),
            "created_at": store.now_iso(),
        },
    )
    enqueue_job(job_id, sync=sync)
    events = recent_events(org_id, 200)
    event = next((item for item in events if item.get("id") == job_id), {"id": job_id, "status": "queued"})
    return {"status": event.get("status"), "event_id": job_id, "call_id": event.get("call_id") or "", "message": event.get("message") or ""}


def _existing_call(org_id: str, provider: str, external_id: str) -> dict[str, Any] | None:
    if not external_id:
        return None
    for item in store.get_state().get("calls", []):
        if (
            item.get("org_id") == org_id
            and str(item.get("external_id") or "") == str(external_id)
            and str(item.get("ingest_provider") or "") == str(provider)
            and item.get("source") == "ingest"
        ):
            return item
    return None


def _update_event(job_id: str, *, org_id: str, **fields: Any) -> dict[str, Any] | None:
    with store._LOCK:
        st = store.get_state()
        event = next((item for item in st.get("ingest_events", []) if item.get("id") == job_id), None)
        if event is None:
            return None
        event.update({key: value for key, value in fields.items() if value is not None})
        event["updated_at"] = store.now_iso()
        store.save_state()
        return dict(event)


# ---------------------------------------------------------------------------
# Worker: download -> transcribe -> score -> save
# ---------------------------------------------------------------------------
def process_job(job_id: str) -> dict[str, Any] | None:
    job = _read_job(job_id)
    if not job:
        return None
    org_id = str(job.get("org_id") or "")
    if not org_id:
        return None
    call = NormalizedCall.from_job_dict(job.get("call") or {})
    call.metadata["event_id"] = job_id
    attempts = _increment_attempt(job_id)
    _update_event(job_id, org_id=org_id, status="processing", message="Processing call", attempts=attempts)

    try:
        st = store.get_state()
        cfg = ingest_config.get_config(st, org_id)
        rep = _resolve_rep(st, org_id, call, cfg)
        if not rep:
            raise IngestError("No rep could be matched. Set a default rep in Phone connectors.")
        call.metadata["rep_id"] = rep.get("id")
        call.metadata["rep_match"] = rep.get("_match") or "default"
        rep_name = str(rep.get("name") or "Sales Rep")
        customer_name = call.customer_name or "Caller"

        audio = b""
        audio_path = str(call.metadata.get("audio_path") or "")
        mime_type = str(call.metadata.get("audio_mime") or "")
        if not audio_path and not call.recording_url and not call.transcript:
            adapter = adapter_for(call.provider)
            call.recording_url = adapter.resolve_recording(call, cfg)
        if not audio_path and call.recording_url:
            try:
                _update_event(job_id, org_id=org_id, message="Downloading recording")
                adapter = adapter_for(call.provider)
                audio, mime_type, final_url = fetch_recording(
                    call.recording_url,
                    headers=adapter.recording_headers(cfg),
                )
                call.metadata["recording_final_host"] = re.sub(r"^https?://([^/]+).*$", r"\1", final_url)
                ext = audio_extension(audio, mime_type, final_url)
                _ensure_dirs()
                audio_path = os.path.join(UPLOADS_DIR, f"ingest-{job_id}{ext}")
                with open(audio_path, "wb") as handle:
                    handle.write(audio)
                os.chmod(audio_path, 0o600)
                mime_type = mime_type or _mime_for_ext(ext)
            except Exception as exc:  # noqa: BLE001
                # A transcript-only call should still complete if the media URL
                # is expired or requires credentials we do not have.
                if not call.transcript:
                    raise
                logger.warning("Ingest %s could not download media: %s", job_id, _safe_error(exc))
                call.metadata["media_error"] = _safe_error(exc)
        elif audio_path and not call.transcript:
            if not os.path.exists(audio_path):
                raise IngestError("The uploaded audio file is no longer available")
            with open(audio_path, "rb") as handle:
                audio = handle.read()
            if not mime_type:
                mime_type = _mime_for_ext(os.path.splitext(audio_path)[1].lower())

        if not call.transcript:
            if not audio:
                raise IngestError(
                    "No recording was found. Send a recording_url or transcript, or add provider credentials "
                    "so the call-log lookup can download the audio."
                )
            if not mime_type:
                mime_type = _mime_for_ext(os.path.splitext(audio_path)[1].lower())

        scoring = resolve_scoring(st, org_id, rep.get("site_id") or None)
        custom_weights = scoring["weights"] if scoring["custom_scoring"] else None

        analysis: dict[str, Any] | None = None
        transcript = call.transcript
        engine = "provided"
        duration = call.duration_sec or _estimate_duration(transcript)
        if not transcript:
            _update_event(job_id, org_id=org_id, message="Transcribing with AI")
            try:
                result = transcribe(
                    audio,
                    mime_type,
                    filename=os.path.basename(audio_path) or "recording.wav",
                    provider=cfg.get("stt_provider"),
                    customer_name=customer_name,
                    rep_name=rep_name,
                    custom_criteria=scoring["criteria"],
                    custom_instructions=scoring["instructions"],
                    on_progress=lambda message: _update_event(job_id, org_id=org_id, message=message),
                )
            except TranscriptionUnavailable as exc:
                raise IngestError(str(exc)) from exc
            transcript = result.transcript
            engine = result.engine
            duration = result.duration_sec or duration
            analysis = result.analysis
            call.transcript = transcript

        if analysis is None:
            analysis = analyzer.analyze_transcript(
                transcript,
                customer_name=customer_name,
                rep_name=rep_name,
                custom_weights=custom_weights,
                custom_criteria=scoring["criteria"],
                custom_instructions=scoring["instructions"],
                direction=call.direction,
            )
        elif custom_weights and analysis.get("metrics"):
            analysis["overall_score"] = compute_weighted_overall_score(analysis["metrics"], custom_weights=custom_weights)

        if not transcript:
            raise IngestError("Transcription produced an empty transcript")

        summary, full = _build_records(
            org_id=org_id,
            call=call,
            rep=rep,
            analysis=analysis,
            transcript=transcript,
            duration=duration,
            audio_path=audio_path,
            mime_type=mime_type,
            engine=engine,
        )
        inserted = _insert_call(summary, full)
        if not inserted:
            # A concurrent request won the race; link the event to the call
            # that actually made it into the library.
            existing = _existing_call(org_id, call.provider, call.external_id)
            if existing:
                summary = existing
        _update_event(
            job_id,
            org_id=org_id,
            status="completed",
            message="Call transcribed and scored",
            call_id=str(summary["id"]),
            duration_sec=float(summary.get("duration_sec") or 0),
            engine=engine,
            rep_name=str(summary.get("rep_name") or ""),
            rep_id=str(summary.get("rep_id") or ""),
            customer_name=str(summary.get("customer_name") or ""),
        )
        _remove_job(job_id)
        return summary

    except Exception as exc:  # noqa: BLE001 - surfaced to the event log
        message = _safe_error(exc)
        logger.warning("Ingest job %s failed: %s", job_id, message)
        _update_event(
            job_id,
            org_id=org_id,
            status="failed",
            message=message,
            attempts=attempts,
        )
        return None


class IngestError(RuntimeError):
    pass


def _mime_for_ext(ext: str) -> str:
    return {
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".m4a": "audio/mp4",
        ".mp4": "video/mp4",
        ".ogg": "audio/ogg",
        ".webm": "audio/webm",
        ".flac": "audio/flac",
        ".aac": "audio/aac",
        ".mpeg": "audio/mpeg",
    }.get(ext.lower(), "audio/wav")


def _estimate_duration(transcript: str) -> float:
    words = len((transcript or "").split())
    return float(max(30, min(3600, round(words / 2.5)))) if words else 0.0


# ---------------------------------------------------------------------------
# Rep matching
# ---------------------------------------------------------------------------
def _resolve_rep(st: dict[str, Any], org_id: str, call: NormalizedCall, cfg: dict[str, Any]) -> dict[str, Any] | None:
    requested = str(call.metadata.get("rep_id") or "").strip()
    users = [
        user for user in st.get("users_by_id", {}).values()
        if user.get("org_id") == org_id and not user.get("disabled")
    ]
    if requested:
        for user in users:
            if user.get("id") == requested:
                return {**user, "_match": "explicit"}
    email = (call.agent_email or "").strip().lower()
    if email:
        for user in users:
            if str(user.get("email") or "").strip().lower() == email:
                return {**user, "_match": "email"}
    extension = (call.agent_extension or "").strip()
    if extension:
        for user in users:
            values = {
                str(user.get("extension") or ""),
                str(user.get("rc_extension_id") or ""),
                str(user.get("extension_number") or ""),
            }
            if extension in {value for value in values if value}:
                return {**user, "_match": "extension"}
    name = (call.agent_name or "").strip().lower()
    if name:
        for user in users:
            if str(user.get("name") or "").strip().lower() == name:
                return {**user, "_match": "name"}
    phone = (call.agent_phone or "").strip()
    if phone:
        digits = "".join(ch for ch in phone if ch.isdigit())
        text_prefs = st.get("me_mobile_by_user", {})
        for user in users:
            numbers = [str(user.get(field) or "") for field in ("phone", "mobile", "cell", "direct_number")]
            numbers.extend(str(item or "") for item in (user.get("alt_phones") or []))
            # Existing text numbers saved before profile phones existed should
            # still match calls without requiring the user to re-save them.
            numbers.append(str((text_prefs.get(user.get("id")) or {}).get("mobile") or ""))
            for number in numbers:
                value = "".join(ch for ch in number if ch.isdigit())
                if digits and value and digits[-10:] == value[-10:]:
                    return {**user, "_match": "phone"}

    default_id = str(cfg.get("default_rep_id") or "").strip()
    if default_id:
        for user in users:
            if user.get("id") == default_id:
                return {**user, "_match": "default"}

    if cfg.get("auto_create_reps") and email and "@" in email:
        created = _create_rep(st, org_id, email, call.agent_name or email.split("@", 1)[0])
        if created:
            return {**created, "_match": "auto_created"}

    # Never drop a real call because the provider omitted the agent. Attribute
    # it to the yard owner so the call is visible and can be reassigned.
    for role in ("owner", "sales_manager", "manager", "admin"):
        for user in users:
            if user.get("role") == role:
                return {**user, "_match": f"{role}_fallback"}
    return users[0] if users else None


def _create_rep(st: dict[str, Any], org_id: str, email: str, name: str) -> dict[str, Any] | None:
    email = email.strip().lower()
    if "@" not in email:
        return None
    users = st.setdefault("users_by_id", {})
    if any(str(user.get("email") or "").lower() == email for user in users.values()):
        return None
    user = {
        "id": f"user-{uuid.uuid4().hex[:10]}",
        "email": email,
        "name": (name or email.split("@", 1)[0]).strip()[:120] or "Sales Representative",
        "role": "rep",
        "title": "Sales Representative",
        "avatar_url": "",
        "org_id": org_id,
        "disabled": False,
        "site_id": "",
        # The rep must use "forgot password" before signing in; no temporary
        # credential is ever written to the ingest event log.
        "must_change_password": True,
        "password_hash": store.hash_password(secrets.token_urlsafe(24)),
        "created_at": store.now_iso(),
    }
    users[user["id"]] = user
    yard = next((org for org in st.get("admin_orgs", []) if org.get("id") == org_id), None)
    if yard and isinstance(yard.get("users"), int):
        yard["users"] += 1
    return user


# ---------------------------------------------------------------------------
# Call records
# ---------------------------------------------------------------------------
def _build_records(
    *,
    org_id: str,
    call: NormalizedCall,
    rep: dict[str, Any],
    analysis: dict[str, Any],
    transcript: str,
    duration: float,
    audio_path: str,
    mime_type: str,
    engine: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    cid = f"call-{uuid.uuid4().hex[:16]}"
    rep_name = str(rep.get("name") or "Sales Rep")
    customer_name = call.customer_name or call.customer_phone or "Caller"
    vehicle = analysis.get("vehicle") or " ".join(
        str(item) for item in (
            analysis.get("vehicle_year"),
            analysis.get("vehicle_make"),
            analysis.get("vehicle_model"),
        ) if item
    )
    turns = analysis.get("turns") or analyzer.parse_turns(transcript)
    duration = float(duration or call.duration_sec or _estimate_duration(transcript) or 120.0)
    summary_item = {
        "id": cid,
        "org_id": org_id,
        "site_id": rep.get("site_id") or "",
        "rep_id": rep["id"],
        "rep_name": rep_name,
        "customer_name": customer_name,
        "customer_phone": call.customer_phone,
        "source": "ingest",
        "ingest_provider": call.provider,
        "external_id": call.external_id,
        "external_url": call.recording_url,
        "status": "analyzed",
        "category": analysis.get("category", "Sales Inquiry"),
        "category_source": analysis.get("category_source", "auto"),
        "category_confidence": analysis.get("category_confidence", 0.5),
        "caller_intent": analysis.get("caller_intent", "buyer"),
        "summary": analysis.get("summary") or f"{call.provider.title()} call · {analysis.get('part_requested', 'Part')} inquiry",
        "vehicle": vehicle,
        "part_requested": analysis.get("part_requested", ""),
        "outcome": analysis.get("outcome", "pending"),
        "sentiment": analysis.get("sentiment", "neutral"),
        "overall_score": int(analysis.get("overall_score", 70)),
        "created_at": call.started_at or store.now_iso(),
        "direction": call.direction,
        "duration_sec": duration,
        "source_category": "Sales Inquiry",
        "topics": analysis.get("topics") or ["Part Inquiry"],
        "order_value": float(analysis.get("order_value") or 0.0),
        "quoted_value": float(analysis.get("quoted_value") or 0.0),
        "parts_sold": analysis.get("parts_sold") or [],
        "delivery_call": False,
        "delivery_check": None,
        "lost_reason": analysis.get("lost_reason", ""),
        "callback_done": False,
        "callback_by": "",
        "callback_at": None,
        "vehicle_year": analysis.get("vehicle_year"),
        "vehicle_make": analysis.get("vehicle_make", ""),
        "vehicle_model": analysis.get("vehicle_model", ""),
        "delivery_kind": "",
        "delivery_score": None,
        "has_audio": bool(audio_path),
        "audio_path": audio_path,
        "audio_mime": mime_type,
        "analysis_engine": engine,
        "ingest_event_id": call.metadata.get("event_id") or "",
    }
    full = store.synthesize_call_details(summary_item)
    full["transcript"] = transcript
    full["turns"] = turns
    full["ingest"] = {
        "provider": call.provider,
        "external_id": call.external_id,
        "event": call.event,
        "recording_url": call.recording_url,
        "engine": engine,
        "rep_match": call.metadata.get("rep_match") or "",
        "received_at": call.metadata.get("received_at") or "",
        "media_host": call.metadata.get("recording_final_host") or "",
        "media_error": call.metadata.get("media_error") or "",
    }
    full["has_audio"] = bool(audio_path)
    full["audio_path"] = audio_path
    full["audio_mime"] = mime_type
    for key in ("metrics", "strengths", "improvements", "insights", "coaching_feedback", "keywords", "keyword_hits"):
        if analysis.get(key) is not None:
            full[key] = analysis[key]
    # Fill any sections the model omitted without inventing a new transcript.
    store.fill_coaching_fields(summary_item, full)
    return summary_item, full


def _insert_call(summary: dict[str, Any], full: dict[str, Any]) -> bool:
    with store._LOCK:
        st = store.get_state()
        existing = _existing_call(summary["org_id"], str(summary.get("ingest_provider") or ""), str(summary.get("external_id") or ""))
        if existing:
            return False
        st.setdefault("calls", []).insert(0, summary)
        st.setdefault("full_calls", {})[summary["id"]] = full
        store.save_state()
        return True
