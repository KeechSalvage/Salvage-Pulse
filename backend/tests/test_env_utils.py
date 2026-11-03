"""Regression tests for environment-file loading.

A production install keeps ``.env`` root-owned (0600) and passes the values via
systemd.  The application user cannot read that file, so python-dotenv raises
``PermissionError``; that must not stop the service from starting.
"""
from __future__ import annotations

import unittest
from unittest import mock

import env_utils


class EnvUtilsTests(unittest.TestCase):
    def test_unreadable_env_does_not_raise(self) -> None:
        with mock.patch.object(
            env_utils,
            "load_dotenv",
            side_effect=PermissionError(13, "Permission denied"),
        ):
            env_utils.load_env_files()

    def test_loads_backend_and_repo_root_candidates(self) -> None:
        calls: list[str | None] = []

        def fake_load(path: str | None = None) -> bool:
            calls.append(path)
            return True

        with mock.patch.object(env_utils, "load_dotenv", side_effect=fake_load):
            env_utils.load_env_files()

        self.assertEqual(len(calls), 2)
        self.assertTrue(calls[0].endswith(".env"))
        self.assertIsNone(calls[1])


if __name__ == "__main__":
    unittest.main()
