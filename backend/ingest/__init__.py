"""Provider-agnostic call ingestion.

The platform should not care whether a call came from RingCentral, Twilio,
Telnyx, Vonage, Zoom Phone, Dialpad, 3CX or a home-grown PBX.  Every provider
adapter normalises its webhook into the same :class:`NormalizedCall`, then the
shared pipeline downloads the recording (or accepts an upload), transcribes it
and hands the transcript to the existing Salvage Pulse analyzer.

Adding a provider is intentionally small: write an adapter in
``ingest/adapters.py`` that knows how to verify and parse that provider's
payload, register it in ``ADAPTERS``, and it immediately gets recording
download, AI transcription, de-duplication, retries and the call library.
"""

from .models import NormalizedCall

__all__ = ["NormalizedCall"]
