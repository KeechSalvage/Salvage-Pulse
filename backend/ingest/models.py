"""The provider-neutral shape every webhook is converted into."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


CALL_EVENTS = frozenset({"started", "completed", "recording", "transcript", "unknown"})


@dataclass
class NormalizedCall:
    """One call event, independent of the phone system that produced it."""

    provider: str
    external_id: str
    event: str = "completed"  # started | completed | recording | transcript
    direction: str = "inbound"
    started_at: str = ""
    ended_at: str = ""
    duration_sec: float = 0.0
    from_number: str = ""
    to_number: str = ""
    agent_email: str = ""
    agent_name: str = ""
    agent_extension: str = ""
    agent_phone: str = ""
    customer_name: str = ""
    customer_phone: str = ""
    recording_url: str = ""
    transcript: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict, repr=False)

    def __post_init__(self) -> None:
        self.provider = (self.provider or "generic").strip().lower()
        self.external_id = str(self.external_id or "").strip()
        self.event = self.event if self.event in CALL_EVENTS else "unknown"
        self.direction = "outbound" if str(self.direction).lower().startswith("out") else "inbound"
        self.duration_sec = _as_float(self.duration_sec)
        self.from_number = _clean_number(self.from_number)
        self.to_number = _clean_number(self.to_number)
        self.agent_phone = _clean_number(self.agent_phone)
        self.customer_phone = _clean_number(self.customer_phone)
        self.transcript = (self.transcript or "").strip()
        self.recording_url = (self.recording_url or "").strip()
        if not self.customer_phone:
            self.customer_phone = self.from_number if self.direction == "inbound" else self.to_number
        if not self.agent_phone:
            self.agent_phone = self.to_number if self.direction == "inbound" else self.from_number
        if not self.customer_name:
            self.customer_name = self.customer_phone or "Caller"

    @property
    def has_media(self) -> bool:
        return bool(self.recording_url or self.metadata.get("audio_path"))

    @property
    def is_processable(self) -> bool:
        """Only events that carry audio or a transcript can become a call.

        Start/answer/end callbacks are still kept in the event log and merged
        with a later recording callback. They must never create a transcript-
        free "fake" call from the analyzer's fallback text.
        """
        return bool(self.transcript or self.recording_url or self.metadata.get("audio_path"))

    def to_job_dict(self) -> dict[str, Any]:
        """Serialisable form stored beside a queued job (never stores the raw payload)."""
        data = asdict(self)
        data.pop("raw", None)
        return data

    @classmethod
    def from_job_dict(cls, data: dict[str, Any]) -> "NormalizedCall":
        allowed = {f.name for f in cls.__dataclass_fields__.values()}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in (data or {}).items() if k in allowed})


def _as_float(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return number if number > 0 else 0.0


def _clean_number(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    # Keep a leading + and digits only; providers decorate numbers with spaces,
    # dots, parentheses and "sip:" prefixes.
    plus = text.startswith("+")
    digits = "".join(ch for ch in text if ch.isdigit())
    if not digits:
        return text[:40]
    return ("+" if plus else "") + digits
