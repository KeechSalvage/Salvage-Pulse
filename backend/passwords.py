"""Password hashing helpers.

PBKDF2-HMAC-SHA256 with a per-password random salt.  The legacy formats that
shipped in earlier builds (``<salt>:<sha256>`` and bare plaintext) are still
accepted for verification so existing accounts can sign in once and be
transparently upgraded to the modern format.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets

ALGORITHM = "pbkdf2_sha256"
DEFAULT_ITERATIONS = int(os.environ.get("PASSWORD_HASH_ITERATIONS", "260000"))
MIN_ITERATIONS = 100_000


def _iterations() -> int:
    return max(MIN_ITERATIONS, DEFAULT_ITERATIONS)


def hash_password(password: str) -> str:
    password = password or ""
    salt = secrets.token_hex(16)
    iterations = _iterations()
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), iterations)
    return f"{ALGORITHM}${iterations}${salt}${digest.hex()}"


def verify_password(password: str, stored: str | None) -> bool:
    """Constant-time verification that never treats a missing hash as valid."""
    if not stored:
        return False
    password = password or ""
    stored = str(stored)

    if stored.startswith(f"{ALGORITHM}$"):
        try:
            _, iterations_raw, salt, expected = stored.split("$", 3)
            iterations = int(iterations_raw)
            if iterations < MIN_ITERATIONS or not salt or not expected:
                return False
            digest = hashlib.pbkdf2_hmac(
                "sha256", password.encode("utf-8"), salt.encode("utf-8"), iterations
            )
            return hmac.compare_digest(digest.hex(), expected)
        except (ValueError, TypeError):
            return False

    if ":" in stored:
        # Legacy format written by store.hash_password(): "<salt>:<sha256>"
        salt, expected = stored.split(":", 1)
        digest = hashlib.sha256((salt + password).encode("utf-8")).hexdigest()
        return hmac.compare_digest(digest, expected)

    # Very old records stored the password in clear text.  Accept it once so the
    # login handler can replace it with a real hash.
    return hmac.compare_digest(password.encode("utf-8"), stored.encode("utf-8"))


def needs_rehash(stored: str | None) -> bool:
    if not stored:
        return True
    stored = str(stored)
    if not stored.startswith(f"{ALGORITHM}$"):
        return True
    try:
        _, iterations_raw, _, _ = stored.split("$", 3)
        return int(iterations_raw) < _iterations()
    except (ValueError, TypeError):
        return True
