"""Safe recording download.

Provider webhooks hand us a URL.  Downloading arbitrary URLs from a public
endpoint is an SSRF risk, so every hop is checked: only http(s), no embedded
credentials, no loopback/private/link-local/reserved addresses, redirects are
followed manually, and the response is size-capped.
"""

from __future__ import annotations

import ipaddress
import logging
import os
import socket
from urllib.parse import urljoin, urlparse

import httpx

logger = logging.getLogger("salvage_pulse.ingest.media")


class MediaFetchError(RuntimeError):
    pass


def _allow_private_hosts() -> bool:
    return os.getenv("INGEST_ALLOW_PRIVATE_MEDIA_HOSTS", "0").lower() in ("1", "true", "yes")


def _validate_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise MediaFetchError("Recording URL must start with http:// or https://")
    if not parsed.hostname:
        raise MediaFetchError("Recording URL has no host")
    if parsed.username or parsed.password:
        raise MediaFetchError("Recording URL must not contain credentials")
    if _allow_private_hosts():
        return
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80))}
    except OSError as exc:
        raise MediaFetchError(f"Could not resolve recording host: {exc}") from exc
    for address in addresses:
        try:
            ip = ipaddress.ip_address(address)
        except ValueError:
            continue
        if (
            ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast
            or ip.is_reserved or ip.is_unspecified
        ):
            raise MediaFetchError("Recording URL points at a private or reserved address")


def fetch_recording(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    max_bytes: int | None = None,
    timeout: float = 60.0,
) -> tuple[bytes, str, str]:
    """Return ``(content, content_type, final_url)`` for a provider recording URL."""
    if not url:
        raise MediaFetchError("No recording URL supplied")
    limit = max_bytes or int(float(os.getenv("INGEST_MEDIA_MAX_MB", "100")) * 1024 * 1024)
    current = url
    extra_headers = {str(k): str(v) for k, v in (headers or {}).items() if k and v}

    with httpx.Client(follow_redirects=False, timeout=timeout) as client:
        for _hop in range(4):
            _validate_url(current)
            try:
                with client.stream("GET", current, headers=extra_headers) as response:
                    if response.status_code in (301, 302, 303, 307, 308):
                        location = response.headers.get("location") or ""
                        if not location:
                            raise MediaFetchError("Recording download redirected without a Location header")
                        current = urljoin(current, location)
                        continue
                    if response.status_code != 200:
                        raise MediaFetchError(f"Recording download returned HTTP {response.status_code}")
                    declared = response.headers.get("content-length")
                    if declared:
                        try:
                            if int(declared) > limit:
                                raise MediaFetchError(f"Recording is larger than the {limit // (1024 * 1024)} MB limit")
                        except ValueError:
                            pass
                    chunks: list[bytes] = []
                    total = 0
                    for chunk in response.iter_bytes():
                        total += len(chunk)
                        if total > limit:
                            raise MediaFetchError(f"Recording is larger than the {limit // (1024 * 1024)} MB limit")
                        chunks.append(chunk)
                    content = b"".join(chunks)
                    if not content:
                        raise MediaFetchError("Recording download was empty")
                    content_type = (response.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
                    return content, content_type, current
            except httpx.HTTPError as exc:
                raise MediaFetchError(f"Recording download failed: {exc}") from exc
    raise MediaFetchError("Recording download redirected too many times")


_EXTENSIONS_BY_MIME = {
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/wave": ".wav",
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/aac": ".aac",
    "audio/ogg": ".ogg",
    "audio/opus": ".ogg",
    "audio/webm": ".webm",
    "audio/flac": ".flac",
    "audio/x-flac": ".flac",
    "video/mp4": ".mp4",
}


def audio_extension(content: bytes, content_type: str = "", url: str = "") -> str:
    """Pick an extension from the bytes first, then the MIME type, then the URL."""
    head = content[:16]
    if head.startswith(b"RIFF") and content[8:12] == b"WAVE":
        return ".wav"
    if head.startswith(b"ID3") or (len(head) > 1 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0):
        return ".mp3"
    if head.startswith(b"OggS"):
        return ".ogg"
    if head[4:8] == b"ftyp":
        return ".m4a"
    if head.startswith(b"\x1aE\xdf\xa3"):
        return ".webm"
    if head.startswith(b"fLaC"):
        return ".flac"
    mime = (content_type or "").lower()
    if mime in _EXTENSIONS_BY_MIME:
        return _EXTENSIONS_BY_MIME[mime]
    suffix = os.path.splitext(urlparse(url).path)[1].lower()
    if suffix in {".wav", ".mp3", ".m4a", ".ogg", ".webm", ".flac", ".aac", ".mp4", ".mpeg"}:
        return suffix
    return ".mp3"
