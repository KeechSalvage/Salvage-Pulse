"""Password-hashing regression tests.

Run from the ``backend`` directory::

    .venv/bin/python -m unittest discover -s tests -v
"""
from __future__ import annotations

import hashlib
import unittest

import passwords


class PasswordHashingTests(unittest.TestCase):
    def test_new_hashes_use_pbkdf2_and_never_contain_the_password(self):
        hashed = passwords.hash_password("CorrectHorseBatteryStaple")
        self.assertTrue(hashed.startswith("pbkdf2_sha256$"))
        self.assertNotIn("CorrectHorseBatteryStaple", hashed)
        self.assertTrue(passwords.verify_password("CorrectHorseBatteryStaple", hashed))
        self.assertFalse(passwords.verify_password("wrong", hashed))
        self.assertFalse(passwords.needs_rehash(hashed))

    def test_missing_hash_never_authenticates(self):
        self.assertFalse(passwords.verify_password("anything", None))
        self.assertFalse(passwords.verify_password("anything", ""))

    def test_legacy_salted_sha256_is_accepted_and_rehashed(self):
        salt = "legacy-salt"
        legacy = f"{salt}:{hashlib.sha256((salt + 'oldpass').encode()).hexdigest()}"
        self.assertTrue(passwords.verify_password("oldpass", legacy))
        self.assertFalse(passwords.verify_password("other", legacy))
        self.assertTrue(passwords.needs_rehash(legacy))

    def test_plaintext_legacy_record_is_accepted_once(self):
        self.assertTrue(passwords.verify_password("plain", "plain"))
        self.assertFalse(passwords.verify_password("wrong", "plain"))
        self.assertTrue(passwords.needs_rehash("plain"))

    def test_unicode_passwords_do_not_crash(self):
        hashed = passwords.hash_password("pässwörd-🔐")
        self.assertTrue(passwords.verify_password("pässwörd-🔐", hashed))
        self.assertTrue(passwords.verify_password("pässwörd-🔐", "pässwörd-🔐"))
        self.assertFalse(passwords.verify_password("pässwörd", "pässwörd-🔐"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
