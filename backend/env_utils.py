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
    """Load ``backend/.env`` and a repo-root ``.env`` when they are readable.

    Both files are loaded explicitly.  Relying on ``load_dotenv()`` alone finds
    the nearest file and stops, which means a root ``.env`` is missed whenever
    ``backend/.env`` exists.  Real process environment variables (systemd,
    Docker, the shell) always win because ``override=False``.
    """
    backend_dir = os.path.dirname(os.path.abspath(__file__))
    candidates = (
        os.path.join(backend_dir, ".env"),
        os.path.join(os.path.dirname(backend_dir), ".env"),
    )
    seen: set[str] = set()
    for path in candidates:
        real = os.path.realpath(path)
        if real in seen:
            continue
        seen.add(real)
        try:
            load_dotenv(path, override=False)
        except OSError:
            # Root-owned 0600 production files are expected here.  systemd's
            # EnvironmentFile or Docker's environment supplies the values.
            continue
    # Also support running from a workspace root with its own .env.
    try:
        load_dotenv(override=False)
    except OSError:
        pass
