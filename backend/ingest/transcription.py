"""Speech-to-text adapters for ingested recordings.

Gemini can transcribe and score in one call, so when it is configured it is the
default.  Deepgram, AssemblyAI and OpenAI are supported for yards that prefer a
dedicated transcription vendor.  Every path returns the same transcript shape,
which is then scored by the platform's existing analyzer.
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any, Callable

import httpx

logger = logging.getLogger("salvage_pulse.ingest.transcription")


class TranscriptionUnavailable(RuntimeError):
    """Raised when no configured STT provider can handle the audio."""


@dataclass
class TranscriptionResult:
    transcript: str
    engine: str
    turns: list[dict[str, str]] = field(default_factory=list)
    duration_sec: float = 0.0
    analysis: dict[str, Any] | None = None
    note: str = ""

    @property
    def is_analysis(self) -> bool:
        return bool(self.analysis)


def available_providers() -> dict[str, bool]:
    return {
        "gemini": bool(os.getenv("GEMINI_API_KEY", "").strip()),
        "deepgram": bool(os.getenv("DEEPGRAM_API_KEY", "").strip()),
        "assemblyai": bool(os.getenv("ASSEMBLYAI_API_KEY", "").strip()),
        "openai": bool(os.getenv("OPENAI_API_KEY", "").strip()),
    }


def resolve_provider(requested: str | None) -> str:
    name = str(requested or os.getenv("INGEST_STT_PROVIDER") or "auto").strip().lower()
    available = available_providers()
    if name == "auto":
        for candidate in ("gemini", "deepgram", "assemblyai", "openai"):
            if available[candidate]:
                return candidate
        return ""
    if name in ("whisper", "whisper-1"):
        return "openai"
    if name in available:
        # Return the explicit choice even when its key is missing so the worker
        # can report "DEEPGRAM_API_KEY is not set" instead of a generic error.
        return name
    return ""


def transcribe(
    audio: bytes,
    mime_type: str,
    *,
    filename: str = "recording.wav",
    provider: str | None = None,
    customer_name: str = "",
    rep_name: str = "",
    custom_criteria: dict[str, str] | None = None,
    custom_instructions: str = "",
    on_progress: Callable[[str], None] | None = None,
) -> TranscriptionResult:
    """Transcribe ``audio`` with the configured provider.

    Gemini is special: it returns a complete scorecard, not just words, which
    avoids sending the transcript back through a second LLM call.
    """
    name = resolve_provider(provider)
    if not name:
        raise TranscriptionUnavailable(
            "No transcription provider is configured. The running server process did not see "
            "GEMINI_API_KEY, DEEPGRAM_API_KEY, ASSEMBLYAI_API_KEY or OPENAI_API_KEY. Add one to the "
            "server environment file and restart the service (systemctl restart salvage-pulse, or "
            "docker compose up -d after editing .env). Check Settings → Phone Connectors to confirm "
            "which provider keys were detected."
        )

    if name == "gemini":
        if not os.getenv("GEMINI_API_KEY", "").strip():
            raise TranscriptionUnavailable("GEMINI_API_KEY is not set")
        from gemini_service import analyze_audio_call_llm

        progress = on_progress or (lambda _msg: None)
        progress("Transcribing and scoring with Gemini")
        result = analyze_audio_call_llm(
            audio,
            mime_type=mime_type,
            customer_name=customer_name,
            rep_name=rep_name,
            custom_criteria=custom_criteria,
            custom_instructions=custom_instructions,
        )
        if not result:
            raise TranscriptionUnavailable("Gemini could not transcribe this recording. Check the API key and model.")
        return TranscriptionResult(
            transcript=str(result.get("transcript") or ""),
            engine=str(result.get("model_used") or "gemini_multimodal_audio"),
            turns=result.get("turns") or [],
            duration_sec=_as_float(result.get("duration_sec")),
            analysis=result,
        )

    if name == "deepgram":
        return _deepgram(audio, mime_type)
    if name == "assemblyai":
        return _assemblyai(audio, mime_type)
    if name == "openai":
        return _openai(audio, mime_type, filename)
    raise TranscriptionUnavailable(f"Unsupported transcription provider: {name}")


# ---------------------------------------------------------------------------
# Deepgram pre-recorded
# ---------------------------------------------------------------------------
def _deepgram(audio: bytes, mime_type: str) -> TranscriptionResult:
    api_key = os.getenv("DEEPGRAM_API_KEY", "").strip()
    if not api_key:
        raise TranscriptionUnavailable("DEEPGRAM_API_KEY is not set")
    model = os.getenv("DEEPGRAM_MODEL", "nova-3").strip() or "nova-3"
    params = {
        "model": model,
        "smart_format": "true",
        "punctuate": "true",
        "diarize": "true",
        "utterances": "true",
    }
    response = httpx.post(
        "https://api.deepgram.com/v1/listen",
        params=params,
        headers={"Authorization": f"Token {api_key}", "Content-Type": mime_type or "audio/wav"},
        content=audio,
        timeout=120.0,
    )
    if response.status_code >= 400:
        raise TranscriptionUnavailable(f"Deepgram returned {response.status_code}: {response.text[:180]}")
    body = response.json()
    transcript, turns = _deepgram_turns(body)
    if not transcript:
        raise TranscriptionUnavailable("Deepgram returned an empty transcript")
    duration = _as_float(((body.get("metadata") or {}).get("duration")))
    return TranscriptionResult(transcript=transcript, engine=f"deepgram:{model}", turns=turns, duration_sec=duration)


def _deepgram_turns(body: dict[str, Any]) -> tuple[str, list[dict[str, str]]]:
    utterances = ((body.get("results") or {}).get("utterances")) or []
    lines: list[str] = []
    turns: list[dict[str, str]] = []
    speaker_map: dict[int, str] = {}
    if isinstance(utterances, list) and utterances:
        for utterance in utterances:
            text = str(utterance.get("transcript") or "").strip()
            if not text:
                continue
            speaker = int(utterance.get("speaker") or 0)
            label = _speaker_label(speaker, speaker_map)
            lines.append(f"{label}: {text}")
            turns.append({"speaker": label, "text": text})
        return "\n".join(lines), turns

    words = (((body.get("results") or {}).get("channels") or [{}])[0].get("alternatives") or [{}])[0].get("words") or []
    current_speaker: int | None = None
    current: list[str] = []
    for word in words:
        speaker = int(word.get("speaker") or 0)
        text = str(word.get("punctuated_word") or word.get("word") or "").strip()
        if not text:
            continue
        if current_speaker is not None and speaker != current_speaker and current:
            label = _speaker_label(current_speaker, speaker_map)
            line = " ".join(current)
            lines.append(f"{label}: {line}")
            turns.append({"speaker": label, "text": line})
            current = []
        current_speaker = speaker
        current.append(text)
    if current and current_speaker is not None:
        label = _speaker_label(current_speaker, speaker_map)
        line = " ".join(current)
        lines.append(f"{label}: {line}")
        turns.append({"speaker": label, "text": line})
    if not lines:
        transcript = str((((body.get("results") or {}).get("channels") or [{}])[0].get("alternatives") or [{}])[0].get("transcript") or "").strip()
        if transcript:
            return transcript, []
    return "\n".join(lines), turns


# ---------------------------------------------------------------------------
# AssemblyAI
# ---------------------------------------------------------------------------
def _assemblyai(audio: bytes, mime_type: str) -> TranscriptionResult:
    api_key = os.getenv("ASSEMBLYAI_API_KEY", "").strip()
    if not api_key:
        raise TranscriptionUnavailable("ASSEMBLYAI_API_KEY is not set")
    headers = {"Authorization": api_key}
    with httpx.Client(timeout=120.0) as client:
        upload = client.post(
            "https://api.assemblyai.com/v2/upload",
            headers={**headers, "Content-Type": "application/octet-stream"},
            content=audio,
        )
        if upload.status_code >= 400:
            raise TranscriptionUnavailable(f"AssemblyAI upload returned {upload.status_code}: {upload.text[:180]}")
        audio_url = str((upload.json() or {}).get("upload_url") or "")
        if not audio_url:
            raise TranscriptionUnavailable("AssemblyAI did not return an upload URL")

        created = client.post(
            "https://api.assemblyai.com/v2/transcript",
            headers={**headers, "Content-Type": "application/json"},
            json={"audio_url": audio_url, "speaker_labels": True, "punctuate": True, "format_text": True},
        )
        if created.status_code >= 400:
            raise TranscriptionUnavailable(f"AssemblyAI returned {created.status_code}: {created.text[:180]}")
        transcript_id = str((created.json() or {}).get("id") or "")
        if not transcript_id:
            raise TranscriptionUnavailable("AssemblyAI did not return a transcript id")

        deadline = time.time() + max(60, int(os.getenv("ASSEMBLYAI_TIMEOUT_SECONDS", "300")))
        body: dict[str, Any] = {}
        while time.time() < deadline:
            poll = client.get(f"https://api.assemblyai.com/v2/transcript/{transcript_id}", headers=headers)
            if poll.status_code >= 400:
                raise TranscriptionUnavailable(f"AssemblyAI poll returned {poll.status_code}")
            body = poll.json() or {}
            if body.get("status") == "completed":
                break
            if body.get("status") == "error":
                raise TranscriptionUnavailable(str(body.get("error") or "AssemblyAI transcription failed"))
            time.sleep(3)
        else:
            raise TranscriptionUnavailable("AssemblyAI transcription timed out")

    utterances = body.get("utterances") or []
    speaker_map: dict[str, str] = {}
    lines: list[str] = []
    turns: list[dict[str, str]] = []
    for utterance in utterances:
        text = str(utterance.get("text") or "").strip()
        if not text:
            continue
        raw_speaker = str(utterance.get("speaker") or "A")
        if raw_speaker not in speaker_map:
            speaker_map[raw_speaker] = "Rep" if not speaker_map else "Customer"
        label = speaker_map[raw_speaker]
        lines.append(f"{label}: {text}")
        turns.append({"speaker": label, "text": text})
    transcript = "\n".join(lines) or str(body.get("text") or "").strip()
    if not transcript:
        raise TranscriptionUnavailable("AssemblyAI returned an empty transcript")
    return TranscriptionResult(
        transcript=transcript,
        engine="assemblyai",
        turns=turns,
        duration_sec=_as_float(body.get("audio_duration")),
    )


# ---------------------------------------------------------------------------
# OpenAI transcription
# ---------------------------------------------------------------------------
def _openai(audio: bytes, mime_type: str, filename: str) -> TranscriptionResult:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise TranscriptionUnavailable("OPENAI_API_KEY is not set")
    model = os.getenv("OPENAI_STT_MODEL", "whisper-1").strip() or "whisper-1"
    response = httpx.post(
        "https://api.openai.com/v1/audio/transcriptions",
        headers={"Authorization": f"Bearer {api_key}"},
        files={"file": (filename or "recording.wav", audio, mime_type or "audio/wav")},
        data={"model": model, "response_format": "verbose_json"},
        timeout=180.0,
    )
    if response.status_code >= 400:
        raise TranscriptionUnavailable(f"OpenAI returned {response.status_code}: {response.text[:180]}")
    body = response.json()
    transcript = str(body.get("text") or "").strip()
    if not transcript:
        raise TranscriptionUnavailable("OpenAI returned an empty transcript")
    return TranscriptionResult(
        transcript=transcript,
        engine=f"openai:{model}",
        turns=[],
        duration_sec=_as_float(body.get("duration")),
    )


def _speaker_label(speaker: int, mapping: dict[int, str]) -> str:
    if speaker not in mapping:
        mapping[speaker] = "Rep" if not mapping else "Customer"
    return mapping[speaker]


def _as_float(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return number if number > 0 else 0.0
