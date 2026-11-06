"""Built-in provider adapters and the normalisation rules they share.

The generic adapter is deliberately forgiving: it recognises the common field
names used by Aircall, Dialpad, Zoom Phone, 8x8, Nextiva, 3CX, Zapier, Make and
custom PBXs.  Provider-specific adapters only need to handle the parts that are
genuinely different (signature verification and nested payload shapes).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import Any

from .models import NormalizedCall

logger = logging.getLogger("salvage_pulse.ingest.adapters")


# ---------------------------------------------------------------------------
# Small normalisation helpers
# ---------------------------------------------------------------------------
def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _as_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, dict):
                return parsed
        except ValueError:
            pass
    return {}


def _lookup(payload: dict[str, Any], *names: str) -> Any:
    """Case-insensitive lookup, including one level of common wrappers."""
    wanted = [n.lower() for n in names]
    direct = {str(k).lower(): v for k, v in payload.items()}
    for name in wanted:
        if name in direct and direct[name] not in (None, ""):
            return direct[name]
    # Providers commonly wrap the actual call in ``call``/``payload``/``data``.
    for wrapper in ("call", "payload", "record", "data", "body", "call_data", "resource"):
        nested = _as_dict(direct.get(wrapper))
        if not nested:
            continue
        nested_direct = {str(k).lower(): v for k, v in nested.items()}
        for name in wanted:
            if name in nested_direct and nested_direct[name] not in (None, ""):
                return nested_direct[name]
    return None


def _text(payload: dict[str, Any], *names: str, limit: int = 400) -> str:
    value = _lookup(payload, *names)
    if isinstance(value, (str, int, float)) and str(value).strip():
        return str(value).strip()[:limit]
    return ""


def _iter_call_payloads(payload: Any) -> list[dict[str, Any]]:
    """Flatten the handful of envelope shapes webhook senders use."""
    if isinstance(payload, list):
        return [_as_dict(item) for item in payload if isinstance(item, (dict, str))]
    if not isinstance(payload, dict):
        return []
    for key in ("calls", "events", "items", "results", "records"):
        value = payload.get(key)
        if isinstance(value, list):
            return [_as_dict(item) for item in value if isinstance(item, (dict, str))]
    data = payload.get("data")
    if isinstance(data, list):
        return [_as_dict(item) for item in data if isinstance(item, (dict, str))]
    if isinstance(data, dict):
        # Telnyx-style envelope: {"data": {"event_type": "...", "payload": {...}}}
        inner = data.get("payload") if isinstance(data.get("payload"), dict) else data
        merged = dict(inner)
        for key in ("event_type", "event", "id", "record_type", "occurred_at"):
            if key in data and key not in merged:
                merged[key] = data[key]
        return [merged]
    return [payload]


def _is_empty(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _normalise_direction(value: Any) -> str:
    low = str(value or "").lower()
    if any(token in low for token in ("out", "egress", "dial")):
        return "outbound"
    return "inbound"


_STARTED = {
    "answered", "answer", "in-progress", "inprogress", "in_progress", "started",
    "start", "ringing", "initiated", "queued", "active", "accepted",
    "call.answered", "call.initiated", "call.ringing", "call.in-progress",
}
_COMPLETED = {
    "completed", "complete", "ended", "end", "disconnected", "hangup", "hung-up",
    "hang_up", "missed", "no-answer", "no_answer", "noanswer", "canceled",
    "cancelled", "failed", "busy", "rejected", "voicemail", "call.hangup",
    "call.ended", "call.missed", "call.completed",
}

# RingCentral party status codes. Ringing/Setup/Proceeding are ignored so the
# popup appears when the call is actually answered, not while it is ringing.
_RC_STARTED = {"answered", "inprogress", "in-progress", "active"}
_RC_COMPLETED = {
    "disconnected", "gone", "missed", "noanswer", "no-answer", "busy",
    "rejected", "failed", "canceled", "cancelled", "voicemail",
}


def _normalise_event(status: Any, event_type: Any, recording_url: str, transcript: str) -> str:
    raw = f"{event_type or ''} {status or ''}".strip().lower()
    if "recording" in raw or "media" in raw:
        return "recording"
    if any(token in raw for token in _COMPLETED):
        return "completed"
    if any(token in raw for token in _STARTED):
        return "started"
    if transcript:
        return "transcript"
    if recording_url:
        return "recording"
    return "unknown"


def _parse_timestamp(value: Any) -> str:
    if _is_empty(value):
        return _now_iso()
    if isinstance(value, (int, float)):
        stamp = float(value)
        if stamp > 10_000_000_000:  # milliseconds
            stamp /= 1000.0
        try:
            return datetime.fromtimestamp(stamp, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        except (OverflowError, OSError, ValueError):
            return _now_iso()
    raw = str(value).strip()
    if re.fullmatch(r"\d{10,13}", raw):
        return _parse_timestamp(int(raw))
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        pass
    for fmt in (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%m/%d/%Y %I:%M %p",
        "%m/%d/%Y %H:%M",
        "%m/%d/%Y %H:%M:%S",
        "%Y/%m/%d %H:%M",
        "%a, %d %b %Y %H:%M:%S %z",
        "%a, %d %b %Y %H:%M:%S %Z",
    ):
        try:
            parsed = datetime.strptime(raw, fmt)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        except ValueError:
            continue
    return _now_iso()


def _parse_duration(value: Any) -> float:
    if _is_empty(value):
        return 0.0
    if isinstance(value, (int, float)):
        return max(0.0, float(value))
    raw = str(value).strip().lower()
    if raw.isdigit():
        return float(raw)
    # 01:23:45 or 12:34
    if re.fullmatch(r"\d{1,2}(:\d{1,2}){1,2}", raw):
        parts = [int(p) for p in raw.split(":")]
        seconds = 0
        for part in parts:
            seconds = seconds * 60 + part
        return float(seconds)
    # 3m 4s / 184 seconds
    matches = re.findall(r"(\d+(?:\.\d+)?)\s*(h|hr|hour|m|min|minute|s|sec|second)s?", raw)
    if matches:
        total = 0.0
        for amount, unit in matches:
            number = float(amount)
            if unit.startswith("h"):
                total += number * 3600
            elif unit.startswith("m"):
                total += number * 60
            else:
                total += number
        return max(0.0, total)
    try:
        return max(0.0, float(raw))
    except ValueError:
        return 0.0


def _recording_url(payload: dict[str, Any]) -> str:
    value = _lookup(
        payload,
        "recording_url", "recordingurl", "recording", "recording_link",
        "recording_download_url", "recording_content_uri", "recordingcontenturi",
        "recording_urls", "public_recording_urls", "recording_file_url",
        "audio_url", "media_url", "download_url", "file_url", "contenturi",
        "content_uri", "recordingUrl", "recordingUrlMp3",
    )
    if isinstance(value, dict):
        value = _lookup(value, "url", "uri", "download_url", "downloadurl", "contenturi", "content_uri", "href")
    if isinstance(value, list):
        selected: Any = ""
        for item in value:
            if isinstance(item, str) and item.strip():
                selected = item
                break
            if isinstance(item, dict):
                selected = _lookup(item, "url", "uri", "download_url", "downloadurl", "contenturi", "content_uri", "href")
                if selected:
                    break
        value = selected
    url = str(value or "").strip()
    if url and not url.lower().startswith(("http://", "https://")):
        return ""
    return url[:4000]


def _transcript(payload: dict[str, Any]) -> str:
    value = _lookup(
        payload,
        "transcript", "transcription", "transcript_text", "call_transcript",
        "dialogue", "text", "body_text",
    )
    if isinstance(value, dict):
        value = _lookup(value, "text", "transcript", "content")
    if isinstance(value, list):
        lines: list[str] = []
        for item in value:
            if isinstance(item, str):
                lines.append(item)
            elif isinstance(item, dict):
                speaker = _text(item, "speaker", "role", "participant", "from")
                text = _text(item, "text", "content", "transcript", limit=4000)
                if text:
                    lines.append(f"{speaker or 'Speaker'}: {text}")
        return "\n".join(lines).strip()[:200_000]
    return str(value or "").strip()[:200_000]


def _external_id(payload: dict[str, Any]) -> str:
    value = _lookup(
        payload,
        "external_id", "call_id", "callid", "callsid", "id", "session_id",
        "sessionid", "interaction_id", "interactionid", "telephonysessionid",
        "telephony_session_id", "call_control_id", "callcontrolid", "uuid",
        "conversation_id", "conversationid", "recording_sid",
    )
    if _is_empty(value):
        # A deterministic fingerprint keeps replayed payloads idempotent even
        # when the PBX does not send a call id.
        stable = json.dumps(payload, sort_keys=True, default=str)[:8000]
        return "auto-" + hashlib.sha256(stable.encode("utf-8")).hexdigest()[:24]
    return str(value).strip()[:200]


def _metadata(payload: dict[str, Any], provider: str, status: Any, event_type: Any) -> dict[str, Any]:
    return {
        "provider": provider,
        "provider_status": str(status or "")[:80],
        "provider_event": str(event_type or "")[:120],
        "account_id": _text(payload, "account_id", "accountid", "account_sid", "accountsid", "organization_id", limit=120),
        "received_at": _now_iso(),
    }


# ---------------------------------------------------------------------------
# Adapters
# ---------------------------------------------------------------------------
class ProviderAdapter:
    name = "generic"

    def verification_secret(self, config: dict[str, Any]) -> str:
        providers = _as_dict(config.get("providers"))
        return str(_as_dict(providers.get(self.name)).get("signing_secret") or "")

    def verify(
        self,
        *,
        raw_body: bytes,
        headers: dict[str, str],
        form: dict[str, str],
        url: str,
        config: dict[str, Any],
    ) -> None:
        """Raise ``ValueError`` if the request cannot be trusted.

        A token in the webhook URL is already a bearer secret.  A configured
        signing secret adds provider-level authenticity on top of it.
        """
        secret = self.verification_secret(config)
        if not secret:
            return
        header = headers.get("x-ingest-secret") or headers.get("x-webhook-token") or ""
        if not hmac.compare_digest(header, secret):
            raise ValueError("Invalid ingestion signature")

    def recording_headers(self, config: dict[str, Any]) -> dict[str, str]:
        providers = _as_dict(config.get("providers"))
        provider_cfg = _as_dict(providers.get(self.name))
        bearer = str(provider_cfg.get("media_bearer_token") or "").strip()
        if bearer:
            return {"Authorization": f"Bearer {bearer}"}
        header_name = str(provider_cfg.get("media_header_name") or "").strip()
        header_value = str(provider_cfg.get("media_header_value") or "").strip()
        if header_name and header_value:
            return {header_name: header_value}
        return {}

    def can_resolve_recording(self, config: dict[str, Any]) -> bool:
        """Whether this adapter can find audio after the webhook has ended."""
        return False

    def resolve_recording(self, call: NormalizedCall, config: dict[str, Any]) -> str:
        """Hook for providers whose webhook omits the audio URL."""
        return call.recording_url

    def parse(self, payload: Any, headers: dict[str, str]) -> list[NormalizedCall]:
        calls: list[NormalizedCall] = []
        for item in _iter_call_payloads(payload):
            calls.extend(self._parse_generic_item(item))
        return calls

    def _parse_generic_item(self, payload: dict[str, Any]) -> list[NormalizedCall]:
        status = _lookup(payload, "status", "call_status", "callstatus", "state", "result", "disposition")
        event_type = _lookup(payload, "event_type", "eventtype", "event", "type", "notification")
        recording = _recording_url(payload)
        transcript = _transcript(payload)
        event = _normalise_event(status, event_type, recording, transcript)
        start_value = _lookup(payload, "start_time", "starttime", "started_at", "startedat", "created_at", "createdat", "date_and_time", "timestamp", "datecreated", "initiated_at")
        started = _parse_timestamp(start_value)
        ended = _parse_timestamp(
            _lookup(payload, "end_time", "endtime", "ended_at", "endedat", "completed_at", "completedat", "hangup_time")
        ) if _lookup(payload, "end_time", "endtime", "ended_at", "endedat", "completed_at", "completedat", "hangup_time") else ""
        duration = max(
            _parse_duration(_lookup(payload, "duration", "duration_sec", "duration_seconds", "callduration", "call_duration", "talk_time")),
            _parse_duration(_lookup(payload, "recording_duration", "recordingduration")),
        )
        direction_value = _lookup(payload, "direction", "call_direction", "inbound_outbound", "inout", "call_type")
        direction = _normalise_direction(direction_value)
        from_number = _text(payload, "from", "from_number", "fromnumber", "caller", "caller_number", "caller_number", "customer_phone", "source", limit=50)
        to_number = _text(payload, "to", "to_number", "tonumber", "callee", "callee_number", "destination", "dialed_number", limit=50)
        agent_email = _text(payload, "agent_email", "agentemail", "host_email", "hostemail", "user_email", "useremail", "rep_email", "extension_email", "email", limit=200)
        agent_name = _text(payload, "agent_name", "agentname", "host_name", "hostname", "user_name", "username", "rep_name", "extension_name", "owner_name", limit=160)
        agent_extension = _text(payload, "agent_extension", "agentelephonyextension", "extension_id", "extensionid", "extension_number", "extensionnumber", "extension", "user_id", limit=80)
        agent_phone = _text(payload, "agent_phone", "agentphone", "agent_number", "host_phone", limit=50)
        customer_name = _text(payload, "customer_name", "customername", "caller_name", "callername", "contact_name", "from_name", "display_name", limit=160)
        if not customer_name:
            candidate = _text(payload, "name", limit=160)
            if candidate and not agent_name:
                customer_name = candidate
        customer_phone = _text(payload, "customer_phone", "customerphone", "caller_number", limit=50)
        if not agent_phone:
            agent_phone = to_number if direction == "inbound" else from_number
        if not customer_phone:
            customer_phone = from_number if direction == "inbound" else to_number

        # Some senders only include the recording, some only the transcript, and
        # some a start event followed by a completed event.  A started event with
        # media is immediately usable.
        if event == "started" and (recording or transcript):
            event = "recording" if recording else "transcript"

        call = NormalizedCall(
            provider=self.name,
            external_id=_external_id(payload),
            event=event,
            direction=direction,
            started_at=started,
            ended_at=ended,
            duration_sec=duration,
            from_number=from_number,
            to_number=to_number,
            agent_email=agent_email,
            agent_name=agent_name,
            agent_extension=agent_extension,
            agent_phone=agent_phone,
            customer_name=customer_name,
            customer_phone=customer_phone,
            recording_url=recording,
            transcript=transcript,
            metadata=_metadata(payload, self.name, status, event_type)
            | {
                "started_at_supplied": bool(start_value),
                "direction_supplied": bool(direction_value),
                "customer_name_supplied": bool(customer_name and customer_name not in ("Caller",)),
            },
            raw=payload,
        )
        return [call]


class GenericAdapter(ProviderAdapter):
    name = "generic"

    def verify(self, *, raw_body: bytes, headers: dict[str, str], form: dict[str, str], url: str, config: dict[str, Any]) -> None:
        secret = self.verification_secret(config)
        if not secret:
            return
        signature = (
            headers.get("x-call-signature")
            or headers.get("x-webhook-signature")
            or headers.get("x-hub-signature-256")
            or ""
        ).strip()
        expected = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256)
        candidates = {
            expected.hexdigest(),
            "sha256=" + expected.hexdigest(),
        }
        if signature not in candidates:
            raise ValueError("Invalid webhook signature")


class TwilioAdapter(ProviderAdapter):
    name = "twilio"

    def verify(self, *, raw_body: bytes, headers: dict[str, str], form: dict[str, str], url: str, config: dict[str, Any]) -> None:
        secret = self.verification_secret(config)
        if secret:
            signature = headers.get("x-twilio-signature") or ""
            data = url + "".join(f"{key}{form[key]}" for key in sorted(form))
            digest = hmac.new(secret.encode("utf-8"), data.encode("utf-8"), hashlib.sha1).digest()
            expected = base64.b64encode(digest).decode("ascii")
            if not signature or not hmac.compare_digest(signature, expected):
                raise ValueError("Invalid Twilio signature")
        else:
            super().verify(raw_body=raw_body, headers=headers, form=form, url=url, config=config)

    def recording_headers(self, config: dict[str, Any]) -> dict[str, str]:
        providers = _as_dict(config.get("providers"))
        cfg = _as_dict(providers.get("twilio"))
        sid = str(cfg.get("account_sid") or "").strip()
        # Twilio uses the same Auth Token for request signatures and recording
        # downloads, so one saved value is enough.
        token = str(cfg.get("auth_token") or cfg.get("signing_secret") or "").strip()
        if sid and token:
            encoded = base64.b64encode(f"{sid}:{token}".encode("utf-8")).decode("ascii")
            return {"Authorization": f"Basic {encoded}"}
        return super().recording_headers(config)

    def parse(self, payload: Any, headers: dict[str, str]) -> list[NormalizedCall]:
        calls = super().parse(payload, headers)
        for call in calls:
            url = call.recording_url
            # Twilio's RecordingUrl points at the JSON metadata by default; the
            # .mp3 suffix returns the audio bytes.
            path = url.split("?", 1)[0]
            if url and not re.search(r"\.[a-z0-9]{2,5}$", path, re.I):
                call.recording_url = url.rstrip("/") + ".mp3"
        return calls


class TelnyxAdapter(ProviderAdapter):
    name = "telnyx"

    def recording_headers(self, config: dict[str, Any]) -> dict[str, str]:
        headers = super().recording_headers(config)
        if headers:
            return headers
        api_key = os.getenv("TELNYX_API_KEY", "").strip()
        return {"Authorization": f"Bearer {api_key}"} if api_key else {}

    def _parse_generic_item(self, payload: dict[str, Any]) -> list[NormalizedCall]:
        calls = super()._parse_generic_item(payload)
        for call in calls:
            if not call.agent_extension:
                call.agent_extension = _text(payload, "connection_id", "application_id", limit=80)
        return calls


class VonageAdapter(ProviderAdapter):
    name = "vonage"


class RingCentralAdapter(ProviderAdapter):
    name = "ringcentral"

    def verify(self, *, raw_body: bytes, headers: dict[str, str], form: dict[str, str], url: str, config: dict[str, Any]) -> None:
        secret = self.verification_secret(config)
        if not secret:
            return
        token = headers.get("verification-token") or headers.get("x-ringcentral-verification-token") or ""
        if not hmac.compare_digest(token, secret):
            raise ValueError("Invalid RingCentral verification token")

    def can_resolve_recording(self, config: dict[str, Any]) -> bool:
        return _ringcentral_configured(config)

    def recording_headers(self, config: dict[str, Any]) -> dict[str, str]:
        token = _ringcentral_token(config)
        return {"Authorization": f"Bearer {token}"} if token else {}

    def resolve_recording(self, call: NormalizedCall, config: dict[str, Any]) -> str:
        if call.recording_url:
            return call.recording_url
        token = _ringcentral_token(config)
        if not token:
            return ""
        started = call.started_at or _now_iso()
        try:
            from urllib.parse import quote

            date_from = _shift_iso(started, -300)
            url = (
                "https://platform.ringcentral.com/restapi/v1.0/account/~/call-log"
                f"?recordingType=All&view=Simple&perPage=100&dateFrom={quote(date_from)}"
            )
            import httpx

            with httpx.Client(timeout=20.0) as client:
                response = client.get(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
                response.raise_for_status()
                records = (response.json() or {}).get("records") or []
            matches = [
                record for record in records
                if str(record.get("telephonySessionId") or "") == call.external_id and record.get("recording")
            ]
            matches.sort(key=lambda record: record.get("startTime") or "")
            if matches:
                return str((matches[0].get("recording") or {}).get("contentUri") or "")
        except Exception as exc:  # noqa: BLE001 - a missing recording must not drop the event
            logger.warning("RingCentral recording lookup failed for %s: %s", call.external_id, exc)
        return ""

    def parse(self, payload: Any, headers: dict[str, str]) -> list[NormalizedCall]:
        if not isinstance(payload, dict):
            return super().parse(payload, headers)
        body = _as_dict(payload.get("body")) or payload
        session = _as_dict(body.get("telephonySession")) or body
        external_id = str(
            session.get("telephonySessionId")
            or session.get("sessionId")
            or payload.get("telephonySessionId")
            or ""
        ).strip()
        parties = [party for party in (session.get("parties") or []) if isinstance(party, dict)]
        if not external_id or not parties:
            calls = super().parse(payload, headers)
            for call in calls:
                if external_id:
                    call.external_id = external_id
            return calls

        # A telephony session contains one party for the caller and one for the
        # rep. Emitting a call per party created duplicate call records and
        # duplicate "waiting" log rows. Pick the monitoring party and emit one
        # event for the whole session instead.
        statuses: list[tuple[dict[str, Any], str]] = []
        for party in parties:
            code = str(_as_dict(party.get("status")).get("code") or "").strip().lower()
            statuses.append((party, code))
        completed = any(code in _RC_COMPLETED for _, code in statuses)
        started = any(code in _RC_STARTED for _, code in statuses)
        event = "completed" if completed else ("started" if started else "")
        if not event:
            return []

        def has_extension(party: dict[str, Any]) -> bool:
            return bool(party.get("extensionId") or party.get("extensionNumber"))

        # Prefer the party whose status caused this notification, then any
        # internal party, then the first party.
        matching = [
            party for party, code in statuses
            if (code in _RC_COMPLETED if event == "completed" else code in _RC_STARTED) and has_extension(party)
        ]
        agent_party = (matching or [party for party, _ in statuses if has_extension(party)] or [parties[0]])[0]
        customer_party = next((party for party, _ in statuses if party is not agent_party and not has_extension(party)), None)
        if customer_party is None:
            customer_party = next((party for party, _ in statuses if party is not agent_party), agent_party)

        def phone_of(party: dict[str, Any], key: str) -> str:
            info = _as_dict(party.get(key))
            return str(info.get("phoneNumber") or info.get("extensionNumber") or "")

        direction = _normalise_direction(agent_party.get("direction") or session.get("direction"))
        agent_from = phone_of(agent_party, "from")
        agent_to = phone_of(agent_party, "to")
        customer_from = phone_of(customer_party, "from")
        customer_to = phone_of(customer_party, "to")
        if direction == "inbound":
            from_number = customer_from or agent_from
            to_number = agent_to or customer_to
            customer_phone = from_number
            agent_phone = agent_to
        else:
            from_number = agent_from or customer_from
            to_number = customer_to or agent_to
            customer_phone = to_number
            agent_phone = agent_from

        extension_id = str(agent_party.get("extensionId") or "")
        extension_number = str(agent_party.get("extensionNumber") or "")
        event_type = str(payload.get("event") or session.get("event") or "")
        return [
            NormalizedCall(
                provider=self.name,
                external_id=external_id,
                event=event,
                direction=direction,
                started_at=_parse_timestamp(session.get("startTime") or payload.get("timestamp")),
                ended_at=_parse_timestamp(session.get("endTime")) if session.get("endTime") else "",
                duration_sec=_parse_duration(session.get("duration")),
                from_number=from_number,
                to_number=to_number,
                agent_extension=extension_id or extension_number,
                agent_phone=agent_phone,
                customer_phone=customer_phone,
                agent_name=str(agent_party.get("name") or agent_party.get("extensionName") or ""),
                customer_name=str(customer_party.get("name") or ""),
                recording_url=_recording_url(session) or _recording_url(payload),
                transcript=_transcript(session),
                metadata=_metadata(payload, self.name, "", event_type)
                | {
                    "party_id": str(agent_party.get("id") or ""),
                    "extension_number": extension_number,
                    "parties": len(parties),
                },
                raw=payload,
            )
        ]


ADAPTERS: dict[str, ProviderAdapter] = {
    "generic": GenericAdapter(),
    "twilio": TwilioAdapter(),
    "telnyx": TelnyxAdapter(),
    "vonage": VonageAdapter(),
    "ringcentral": RingCentralAdapter(),
}

# Friendly names let a sender use ?provider=zoom, ?provider=dialpad, etc. and
# still land on the generic normaliser.
PROVIDER_ALIASES = {
    "generic": "generic",
    "universal": "generic",
    "webhook": "generic",
    "custom": "generic",
    "zapier": "generic",
    "make": "generic",
    "aircall": "generic",
    "dialpad": "generic",
    "zoom": "generic",
    "zoomphone": "generic",
    "8x8": "generic",
    "eightbyeight": "generic",
    "nextiva": "generic",
    "3cx": "generic",
    "ringcentral": "ringcentral",
    "ring_central": "ringcentral",
    "rc": "ringcentral",
    "twilio": "twilio",
    "telnyx": "telnyx",
    "vonage": "vonage",
    "nexmo": "vonage",
}


def adapter_for(provider: str | None) -> ProviderAdapter:
    key = str(provider or "generic").strip().lower().replace("-", "_").replace(" ", "")
    return ADAPTERS.get(PROVIDER_ALIASES.get(key, key), ADAPTERS["generic"])


def detect_provider(payload: Any, headers: dict[str, str], content_type: str, form: dict[str, str]) -> str:
    hinted = (
        headers.get("x-call-provider")
        or headers.get("x-voip-provider")
        or headers.get("x-provider")
        or ""
    ).strip().lower()
    if hinted:
        return hinted
    if form.get("CallSid") or form.get("CallStatus") or form.get("RecordingSid"):
        return "twilio"
    if isinstance(payload, dict):
        if payload.get("telephonySessionId") or "ringcentral" in str(payload.get("event") or "").lower():
            return "ringcentral"
        data = payload.get("data")
        if isinstance(data, dict) and (
            str(data.get("record_type") or "").lower().startswith("event")
            or "telnyx" in str(data.get("event_type") or "").lower()
            or "call_control_id" in json.dumps(data)[:2000]
        ):
            return "telnyx"
        if payload.get("conversation_uuid") or payload.get("call_uuid"):
            return "vonage"
    # ``call_id`` + ``status`` is used by too many generic senders to infer a
    # vendor safely. Vonage users can target /vonage explicitly (or send the
    # X-Call-Provider header); everything else stays on the generic normaliser.
    return "generic"


def _shift_iso(value: str, seconds: int) -> str:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        from datetime import timedelta

        return (parsed + timedelta(seconds=seconds)).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return _now_iso()


_RC_TOKEN_CACHE: dict[str, tuple[str, float]] = {}


def _ringcentral_credentials(config: dict[str, Any]) -> tuple[str, str, str, str]:
    providers = _as_dict(config.get("providers"))
    cfg = _as_dict(providers.get("ringcentral"))
    server = str(cfg.get("server_url") or os.getenv("RC_SERVER_URL") or "https://platform.ringcentral.com").rstrip("/")
    client_id = str(cfg.get("client_id") or os.getenv("RC_CLIENT_ID") or "")
    client_secret = str(cfg.get("client_secret") or os.getenv("RC_CLIENT_SECRET") or "")
    jwt = str(cfg.get("jwt") or os.getenv("RC_JWT") or "")
    return server, client_id, client_secret, jwt


def _ringcentral_configured(config: dict[str, Any]) -> bool:
    _server, client_id, client_secret, jwt = _ringcentral_credentials(config)
    return bool(client_id and client_secret and jwt)


def _ringcentral_token(config: dict[str, Any]) -> str:
    """Fetch a RingCentral token only when the adapter actually needs audio."""
    import time

    server, client_id, client_secret, jwt = _ringcentral_credentials(config)
    if not (client_id and client_secret and jwt):
        return ""
    cache_key = f"{server}:{client_id}"
    cached = _RC_TOKEN_CACHE.get(cache_key)
    if cached and cached[1] > time.time() + 60:
        return cached[0]
    try:
        import httpx

        credentials = base64.b64encode(f"{client_id}:{client_secret}".encode("utf-8")).decode("ascii")
        response = httpx.post(
            f"{server}/restapi/oauth/token",
            headers={"Authorization": f"Basic {credentials}", "Content-Type": "application/x-www-form-urlencoded"},
            data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": jwt},
            timeout=20.0,
        )
        response.raise_for_status()
        body = response.json()
        token = str(body.get("access_token") or "")
        if token:
            _RC_TOKEN_CACHE[cache_key] = (token, time.time() + float(body.get("expires_in") or 300))
        return token
    except Exception as exc:  # noqa: BLE001
        logger.warning("RingCentral token request failed: %s", exc)
        return ""


def verify_request(
    *,
    adapter: ProviderAdapter,
    raw_body: bytes,
    headers: dict[str, str],
    form: dict[str, str],
    url: str,
    config: dict[str, Any],
) -> None:
    adapter.verify(raw_body=raw_body, headers=headers, form=form, url=url, config=config)


def parse_payload(adapter: ProviderAdapter, payload: Any, headers: dict[str, str]) -> list[NormalizedCall]:
    calls = adapter.parse(payload, headers)
    return [call for call in calls if call.external_id]
