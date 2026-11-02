#!/usr/bin/env python3
"""
CLI utility to manually set or reset any user's password in Salvage Pulse.

Usage:
    python backend/set_password.py <email> [new_password]

Omit the password to be prompted without echoing it (recommended).

Inside Docker:
    docker exec -it salvage-pulse-app python set_password.py brettk@salvagepulsepro.com
"""
from __future__ import annotations

import getpass
import sys
import os

# Ensure backend directory is in path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import store
from auth_utils import invalidate_user_sessions


def set_user_password(email: str, new_password: str) -> bool:
    if len(new_password) < 8:
        print("Error: Password must be at least 8 characters long.")
        return False

    st = store.get_state()
    clean_email = email.strip().lower()

    target_user = None
    for uid, u in st.get("users_by_id", {}).items():
        if u.get("email", "").strip().lower() == clean_email:
            target_user = u
            break

    # Keyword fallback for master
    if not target_user and clean_email in ("master", "admin"):
        target_user = next((u for u in st.get("users_by_id", {}).values() if u.get("role") == "master"), None)

    if not target_user:
        print(f"Error: User with email '{email}' not found.")
        print("Available users:")
        for u in st.get("users_by_id", {}).values():
            print(f"  - {u.get('name')} <{u.get('email')}> (Role: {u.get('role')})")
        return False

    target_user["password_hash"] = store.hash_password(new_password)
    target_user["must_change_password"] = False
    invalidate_user_sessions(st, target_user["id"])
    store.save_state()
    print(f"Success! Password for '{target_user.get('name')}' <{target_user.get('email')}> has been updated.")
    return True


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python set_password.py <user_email> [new_password]")
        print("Omit the password to be prompted securely.")
        sys.exit(1)

    email_arg = sys.argv[1]
    password_arg = sys.argv[2] if len(sys.argv) > 2 else getpass.getpass("New password: ")
    success = set_user_password(email_arg, password_arg)
    sys.exit(0 if success else 1)
