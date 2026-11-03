"""Environment-file loading helpers.

Production installs keep ``.env`` root-owned with mode ``0600`` and inject the
values through systemd's ``EnvironmentFile``.  The application user therefore
cannot read that file, and python-dotenv raises ``PermissionError`` when it
tries.  Loading a local ``.env`` is only a development convenience, so an
unreadable file must never prevent the app from starting.
"""
from __future__ import annotations

import os

from dotenv import load_dotenv


def load_env_files() -> None:
    """Load ``backend/.env`` and a repo-root ``.env`` when they are readable."""
    candidates: tuple[str | None, ...] = (
        os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"),
        None,
    )
    for path in candidates:
        try:
            if path is None:
                load_dotenv()
            else:
                load_dotenv(path)
        except OSError:
            # Root-owned 0600 production files are expected here.
            continue
