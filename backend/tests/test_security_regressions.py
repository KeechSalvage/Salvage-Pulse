"""Security regression tests for the Salvage Pulse API.

Run from the ``backend`` directory::

    .venv/bin/python -m unittest discover -s tests -v

The suite uses a throw-away ``DATA_DIR`` and disables SMTP so it never touches
the real yard data or sends mail.
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
import uuid

# ---------------------------------------------------------------------------
# Configure the process *before* importing the application.  ``load_dotenv``
# does not override variables that already exist, so these values win over a
# developer's local .env file.
# ---------------------------------------------------------------------------
_TMP_DATA_DIR = tempfile.mkdtemp(prefix="salvage-pulse-tests-")
os.environ["DATA_DIR"] = _TMP_DATA_DIR
os.environ["ENVIRONMENT"] = "development"
os.environ["SEED_DEMO_DATA"] = "1"
os.environ["DEMO_LOGIN_ENABLED"] = "0"
os.environ["INITIAL_MASTER_PASSWORD"] = "MasterPass!234"
os.environ["GOOGLE_CLIENT_ID"] = "test-client.apps.googleusercontent.com"
os.environ["AUTH_RATE_LIMIT"] = "100000"
os.environ["AUTH_RATE_WINDOW_SECONDS"] = "1"
os.environ["SIGNUP_RATE_LIMIT"] = "100000"
os.environ["SIGNUP_RATE_WINDOW_SECONDS"] = "1"
os.environ["SMTP_USER"] = ""
os.environ["SMTP_PASSWORD"] = ""
os.environ["APP_URL"] = "https://app.example.test"

import store  # noqa: E402  (environment must be configured first)

# Seed a fresh state file so get_state() does not fall back to a developer's
# local preview_state.json.
if not os.path.exists(store.STATE_PATH):
    with open(store.STATE_PATH, "w", encoding="utf-8") as fh:
        json.dump(store._build_initial_state(), fh)

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from auth_utils import issue_security_token  # noqa: E402

MASTER_EMAIL = store.INITIAL_MASTER_EMAIL
MASTER_PASSWORD = os.environ["INITIAL_MASTER_PASSWORD"]
NEW_MASTER_PASSWORD = "MasterPass!2345"


def _client() -> TestClient:
    return TestClient(main.app)


def _signup(client: TestClient, *, yard: str = "Test Yard", password: str = "StrongPass!234"):
    email = f"user-{uuid.uuid4().hex[:10]}@example.test"
    response = client.post(
        "/api/auth/signup",
        json={"yard_name": yard, "name": "Test Owner", "email": email, "password": password},
    )
    assert response.status_code == 200, response.text
    return response.json(), email, password


def _login(client: TestClient, email: str, password: str):
    response = client.post("/api/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    return response.json()


def setUpModule():
    """Rotate the bootstrap master password once so it is no longer forced."""
    client = _client()
    _login(client, MASTER_EMAIL, MASTER_PASSWORD)
    response = client.post(
        "/api/auth/change-password",
        json={"current_password": MASTER_PASSWORD, "new_password": NEW_MASTER_PASSWORD},
    )
    assert response.status_code == 200, response.text


def _master_client() -> TestClient:
    client = _client()
    _login(client, MASTER_EMAIL, NEW_MASTER_PASSWORD)
    return client


class AuthenticationTests(unittest.TestCase):
    def test_unauthenticated_admin_access_is_rejected(self):
        response = _client().get("/api/admin/orgs")
        self.assertIn(response.status_code, (401, 403))

    def test_google_session_id_bypass_is_rejected(self):
        response = _client().post("/api/auth/google", json={"session_id": "user-keech-owner"})
        self.assertEqual(response.status_code, 400)

    def test_google_login_requires_configured_client_id(self):
        original = os.environ.get("GOOGLE_CLIENT_ID", "")
        os.environ["GOOGLE_CLIENT_ID"] = ""
        try:
            response = _client().post("/api/auth/google", json={"access_token": "forged-token"})
            self.assertEqual(response.status_code, 400)
        finally:
            os.environ["GOOGLE_CLIENT_ID"] = original

    def test_google_config_does_not_enumerate_accounts(self):
        response = _client().get("/api/auth/google/config")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["configured"])
        self.assertEqual(body["accounts"], [])
        self.assertNotIn("owner@keechauto.com", response.text)

    def test_google_access_token_audience_field_is_accepted(self):
        from routers import auth as auth_module
        import asyncio

        class FakeResponse:
            status_code = 200

            @staticmethod
            def json():
                return {
                    "audience": os.environ["GOOGLE_CLIENT_ID"],
                    "email": "person@example.test",
                    "email_verified": True,
                }

        class FakeClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def get(self, *args, **kwargs):
                return FakeResponse()

        original = auth_module.httpx.AsyncClient
        auth_module.httpx.AsyncClient = FakeClient
        try:
            profile = asyncio.run(auth_module._fetch_google_user("access-token", None))
        finally:
            auth_module.httpx.AsyncClient = original
        self.assertEqual(profile["email"], "person@example.test")

    def test_google_token_with_wrong_audience_is_rejected(self):
        from routers import auth as auth_module
        import asyncio

        class FakeResponse:
            status_code = 200

            @staticmethod
            def json():
                return {
                    "aud": "some-other-client.apps.googleusercontent.com",
                    "email": "person@example.test",
                    "email_verified": True,
                }

        class FakeClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def get(self, *args, **kwargs):
                return FakeResponse()

        original = auth_module.httpx.AsyncClient
        auth_module.httpx.AsyncClient = FakeClient
        try:
            profile = asyncio.run(auth_module._fetch_google_user(None, "id-token"))
        finally:
            auth_module.httpx.AsyncClient = original
        self.assertIsNone(profile)

    def test_login_does_not_leak_hashes_or_account_existence(self):
        client = _client()
        response = _client().post(
            "/api/auth/login",
            json={"email": "owner@keechauto.com", "password": "owner"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("password_hash", response.json())
        self.assertNotIn("password", response.json())

        unknown = client.post(
            "/api/auth/login",
            json={"email": f"nobody-{uuid.uuid4().hex}@example.test", "password": "whatever"},
        )
        wrong = client.post(
            "/api/auth/login",
            json={"email": "owner@keechauto.com", "password": "not-the-password"},
        )
        self.assertEqual(unknown.status_code, wrong.status_code)
        self.assertEqual(unknown.json()["detail"], wrong.json()["detail"])

    def test_forced_password_change_blocks_yard_data(self):
        client = _client()
        user, email, password = _signup(client)
        state = store.get_state()
        state["users_by_id"][user["id"]]["must_change_password"] = True
        store.save_state()

        self.assertEqual(client.get("/api/auth/me").status_code, 200)
        self.assertEqual(client.get("/api/calls").status_code, 403)

        changed = client.post(
            "/api/auth/change-password",
            json={"current_password": password, "new_password": "EvenStronger!234"},
        )
        self.assertEqual(changed.status_code, 200)
        self.assertEqual(client.get("/api/calls").status_code, 200)

    def test_reset_token_is_single_use(self):
        client = _client()
        user, _email, _password = _signup(client)
        state = store.get_state()
        token = issue_security_token(state, "reset", user["id"])
        store.save_state()

        first = client.post("/api/auth/reset-password", json={"token": token, "password": "ResetPass!234"})
        self.assertEqual(first.status_code, 200, first.text)

        second = client.post("/api/auth/reset-password", json={"token": token, "password": "ResetPass!345"})
        self.assertEqual(second.status_code, 400)


class DemoAndBootstrapTests(unittest.TestCase):
    def test_demo_seeding_is_disabled_by_default(self):
        original = store.SEED_DEMO_DATA
        store.SEED_DEMO_DATA = False
        try:
            state = {"users_by_id": {"master-1": {"id": "master-1", "role": "master"}}}
            result = store._ensure_demo_users(state)
            self.assertEqual(set(result["users_by_id"]), {"master-1"})
        finally:
            store.SEED_DEMO_DATA = original

    def test_known_demo_passwords_are_forced_to_rotate(self):
        original = store.SEED_DEMO_DATA
        store.SEED_DEMO_DATA = False
        try:
            state = {
                "users_by_id": {
                    "user-keech-admin": {
                        "id": "user-keech-admin",
                        "role": "master",
                        "password_hash": store.hash_password("admin"),
                    }
                }
            }
            self.assertTrue(store._enforce_demo_password_rotation(state))
            self.assertTrue(state["users_by_id"]["user-keech-admin"]["must_change_password"])
        finally:
            store.SEED_DEMO_DATA = original

    def test_bootstrap_password_is_written_once(self):
        original_password = store.INITIAL_MASTER_PASSWORD
        original_path = store.BOOTSTRAP_PASSWORD_PATH
        temp_path = os.path.join(_TMP_DATA_DIR, "bootstrap-test.txt")
        store.INITIAL_MASTER_PASSWORD = ""
        store.BOOTSTRAP_PASSWORD_PATH = temp_path
        try:
            password = store._bootstrap_master_password()
            self.assertTrue(os.path.exists(temp_path))
            with open(temp_path, "r", encoding="utf-8") as fh:
                contents = fh.read()
            self.assertIn(password, contents)
            self.assertEqual(store._bootstrap_master_password(), password)
            self.assertEqual(os.stat(temp_path).st_mode & 0o777, 0o600)
        finally:
            store.INITIAL_MASTER_PASSWORD = original_password
            store.BOOTSTRAP_PASSWORD_PATH = original_path


class PlatformMasterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.original_emails = store.INITIAL_MASTER_EMAILS
        self.original_legacy = store._LEGACY_MASTER_EMAIL
        self.original_names = store.INITIAL_MASTER_NAMES
        self.original_password = store.INITIAL_MASTER_PASSWORD
        self.original_path = store.BOOTSTRAP_PASSWORD_PATH
        self.temp_path = os.path.join(_TMP_DATA_DIR, f"masters-{uuid.uuid4().hex}.txt")
        store.BOOTSTRAP_PASSWORD_PATH = self.temp_path
        store.INITIAL_MASTER_EMAILS = (
            "brettk@salvagepulsepro.com,benk@salvagepulsepro.com,genk@salvagepulsepro.com"
        )
        store._LEGACY_MASTER_EMAIL = ""
        store.INITIAL_MASTER_NAMES = "Brett K,Ben K,Gen K"
        store.INITIAL_MASTER_PASSWORD = "MasterPass!234"

    def tearDown(self) -> None:
        store.INITIAL_MASTER_EMAILS = self.original_emails
        store._LEGACY_MASTER_EMAIL = self.original_legacy
        store.INITIAL_MASTER_NAMES = self.original_names
        store.INITIAL_MASTER_PASSWORD = self.original_password
        store.BOOTSTRAP_PASSWORD_PATH = self.original_path

    def test_three_platform_masters_are_created(self) -> None:
        state = store._build_initial_state()
        masters = [u for u in state["users_by_id"].values() if u.get("role") == "master"]
        self.assertEqual(len(masters), 3)
        self.assertEqual(
            {u["id"] for u in masters},
            {"master-brettk", "master-benk", "master-genk"},
        )
        self.assertEqual(
            {u["email"] for u in masters},
            {
                "brettk@salvagepulsepro.com",
                "benk@salvagepulsepro.com",
                "genk@salvagepulsepro.com",
            },
        )
        self.assertTrue(all(u["must_change_password"] for u in masters))
        self.assertEqual(len(state["admin_staff"]), 3)
        self.assertEqual(
            state["provisioned_master_emails"],
            [
                "benk@salvagepulsepro.com",
                "brettk@salvagepulsepro.com",
                "genk@salvagepulsepro.com",
            ],
        )

    def test_each_master_gets_a_unique_generated_password(self) -> None:
        store.INITIAL_MASTER_PASSWORD = ""
        credentials = store._bootstrap_credentials()
        self.assertEqual(len(credentials), 3)
        self.assertEqual(len(set(credentials.values())), 3)
        self.assertNotIn("MasterPass!234", credentials.values())
        with open(self.temp_path, "r", encoding="utf-8") as fh:
            contents = fh.read()
        for email, password in credentials.items():
            self.assertIn(f"Email: {email}", contents)
            self.assertIn(f"Password: {password}", contents)
        self.assertEqual(os.stat(self.temp_path).st_mode & 0o777, 0o600)

    def test_existing_state_gains_masters_once_and_keeps_deletions(self) -> None:
        state = {
            "users_by_id": {
                "master-brettk": {
                    "id": "master-brettk",
                    "email": "brettk@salvagepulsepro.com",
                    "name": "Brett K",
                    "role": "master",
                    "password_hash": store.hash_password("existing-password"),
                }
            },
            "admin_staff": [],
        }

        self.assertTrue(store._ensure_configured_masters(state))
        self.assertEqual(len(state["users_by_id"]), 3)
        # brettk gets a missing staff row; benk and genk get user + staff rows.
        self.assertEqual(len(state["admin_staff"]), 3)

        # The credential file must not advertise a replacement password for the
        # existing brettk master, whose password hash is left untouched.
        with open(self.temp_path, "r", encoding="utf-8") as fh:
            contents = fh.read()
        self.assertNotIn("Email: brettk@salvagepulsepro.com", contents)
        self.assertIn("Email: benk@salvagepulsepro.com", contents)
        self.assertIn("Email: genk@salvagepulsepro.com", contents)

        del state["users_by_id"]["master-benk"]
        self.assertFalse(store._ensure_configured_masters(state))
        self.assertNotIn("master-benk", state["users_by_id"])

    def test_legacy_single_master_email_is_still_honoured(self) -> None:
        store.INITIAL_MASTER_EMAILS = ""
        store._LEGACY_MASTER_EMAIL = "ops@example.com"
        store.INITIAL_MASTER_NAMES = ""
        accounts = store._configured_master_accounts()
        self.assertEqual(len(accounts), 1)
        self.assertEqual(accounts[0]["email"], "ops@example.com")
        self.assertEqual(accounts[0]["name"], "Ops")
        self.assertEqual(accounts[0]["id"], "master-ops")


class AuthorizationTests(unittest.TestCase):
    def test_rep_cannot_reach_staff_or_manager_actions(self):
        client = _client()
        _login(client, "rep1@keechauto.com", "rep1")

        self.assertEqual(client.get("/api/admin/orgs").status_code, 403)
        self.assertEqual(client.put("/api/branding", json={"accent": "#ff0000"}).status_code, 403)
        self.assertEqual(client.put("/api/settings/scoring", json={}).status_code, 403)
        self.assertEqual(client.post("/api/billing/checkout", json={}).status_code, 403)

    def test_admin_cannot_promote_self_to_master(self):
        master = _master_client()
        email = f"admin-{uuid.uuid4().hex[:10]}@example.test"
        created = master.post(
            "/api/admin/staff",
            json={"name": "Test Admin", "email": email, "role": "admin"},
        )
        self.assertEqual(created.status_code, 200, created.text)
        payload = created.json()
        sid = payload["account"]["id"]
        temp_password = payload["temp_password"]

        admin_client = _client()
        _login(admin_client, email, temp_password)
        changed = admin_client.post(
            "/api/auth/change-password",
            json={"current_password": temp_password, "new_password": "AdminPass!234"},
        )
        self.assertEqual(changed.status_code, 200, changed.text)

        response = admin_client.patch(f"/api/admin/staff/{sid}", json={"role": "master"})
        self.assertEqual(response.status_code, 403)
        self.assertNotEqual(store.get_state()["users_by_id"][sid]["role"], "master")

    def test_cross_yard_call_detail_is_blocked(self):
        keech = _client()
        _login(keech, "rep1@keechauto.com", "rep1")
        calls = keech.get("/api/calls").json()
        self.assertTrue(calls)
        call_id = calls[0]["id"]

        other = _client()
        _signup(other, yard="Other Yard")
        response = other.get(f"/api/calls/{call_id}")
        self.assertIn(response.status_code, (403, 404))

    def test_cross_yard_customer_profile_is_blocked(self):
        keech = _client()
        _login(keech, "rep1@keechauto.com", "rep1")
        calls = keech.get("/api/calls").json()
        customer = next((c.get("customer_name") for c in calls if c.get("customer_name")), None)
        self.assertTrue(customer)

        other = _client()
        _signup(other, yard="Other Yard")
        response = other.get(f"/api/customers/{customer}")
        self.assertEqual(response.status_code, 404)

    def test_customer_tags_are_namespaced_per_yard(self):
        keech = _client()
        _login(keech, "rep1@keechauto.com", "rep1")
        calls = keech.get("/api/calls").json()
        customer = next((c.get("customer_name") for c in calls if c.get("customer_name")), None)
        self.assertTrue(customer)
        self.assertEqual(
            keech.put(f"/api/customers/{customer}/tag", json={"tag": "keech-tag"}).status_code,
            200,
        )

        other = _client()
        user, _, _ = _signup(other, yard="Namespaced Yard")
        st = store.get_state()
        st.setdefault("calls", []).append({
            "id": f"call-{uuid.uuid4().hex}",
            "org_id": user["org_id"],
            "customer_name": customer,
            "customer_phone": "",
            "created_at": store.now_iso(),
            "duration_sec": 60,
            "outcome": "pending",
            "rep_name": "Other Rep",
            "category": "Part Inquiry/Quote",
        })
        store.save_state()
        self.assertEqual(
            other.put(f"/api/customers/{customer}/tag", json={"tag": "other-tag"}).status_code,
            200,
        )

        keech_profile = keech.get(f"/api/customers/{customer}").json()
        other_profile = other.get(f"/api/customers/{customer}").json()
        self.assertEqual(keech_profile["stat"]["tag"], "keech-tag")
        self.assertEqual(other_profile["stat"]["tag"], "other-tag")

    def test_analytics_customers_are_scoped_to_the_yard(self):
        other = _client()
        user, _, _ = _signup(other, yard="Analytics Yard")
        st = store.get_state()
        st.setdefault("calls", []).append({
            "id": f"call-{uuid.uuid4().hex}",
            "org_id": user["org_id"],
            "customer_name": "Only This Yard Customer",
            "customer_phone": "",
            "created_at": store.now_iso(),
            "duration_sec": 30,
            "outcome": "won",
            "rep_name": "Other Rep",
            "category": "Part Inquiry/Quote",
        })
        store.save_state()

        data = other.get("/api/analytics/customers").json()
        keys = {c["key"] for c in data.get("all_customers", [])}
        self.assertIn("Only This Yard Customer", keys)
        self.assertNotIn("Dale Miller", keys)

        # Platform staff may still see across yards.
        master_data = _master_client().get("/api/analytics/customers").json()
        self.assertGreater(master_data.get("total_customers", 0), data.get("total_customers", 0))

    def test_cross_yard_rep_creation_is_blocked(self):
        keech = _client()
        _login(keech, "rep1@keechauto.com", "rep1")
        response = keech.post(
            "/api/users/reps",
            json={"name": "Sneaky Rep", "email": f"sneaky-{uuid.uuid4().hex[:6]}@example.test"},
        )
        self.assertEqual(response.status_code, 403)

    def test_public_billing_catalogue_stays_public(self):
        client = _client()
        self.assertEqual(client.get("/api/billing/plans").status_code, 200)
        self.assertEqual(client.get("/api/billing/compare").status_code, 200)
        self.assertIn(client.post("/api/billing/checkout", json={}).status_code, (401, 403))


class ImpersonationTests(unittest.TestCase):
    def test_impersonation_is_session_scoped_and_reversible(self):
        master = _master_client()
        master_id = master.get("/api/auth/me").json()["id"]

        started = master.post("/api/admin/impersonate/user-keech-rep")
        self.assertEqual(started.status_code, 200, started.text)
        self.assertEqual(started.json()["id"], "user-keech-rep")
        self.assertTrue(started.json()["impersonated_by"])

        me = master.get("/api/auth/me").json()
        self.assertEqual(me["id"], "user-keech-rep")
        self.assertEqual(me["impersonator_id"], master_id)

        # The target account itself must never carry the impersonation flag.
        target = store.get_state()["users_by_id"]["user-keech-rep"]
        self.assertNotIn("impersonated_by", target)
        self.assertNotIn("impersonator_id", target)

        blocked = master.post(
            "/api/auth/change-password",
            json={"current_password": "rep1", "new_password": "NewRepPass!234"},
        )
        self.assertEqual(blocked.status_code, 403)

        stopped = master.post("/api/auth/stop-impersonating")
        self.assertEqual(stopped.status_code, 200, stopped.text)
        self.assertEqual(stopped.json()["id"], master_id)
        self.assertEqual(master.get("/api/auth/me").json()["id"], master_id)


class TransportSecurityTests(unittest.TestCase):
    def test_security_headers_are_present(self):
        response = _client().get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get("x-content-type-options"), "nosniff")
        self.assertEqual(response.headers.get("x-frame-options"), "DENY")
        self.assertIn("content-security-policy", response.headers)

    def test_cross_site_post_is_blocked(self):
        response = _client().post(
            "/api/auth/login",
            json={"email": "owner@keechauto.com", "password": "owner"},
            headers={"Origin": "https://evil.example"},
        )
        self.assertEqual(response.status_code, 403)

    def test_oversized_json_body_is_rejected(self):
        response = _client().post(
            "/api/auth/login",
            content=b"x" * (3 * 1024 * 1024),
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(response.status_code, 413)

    def test_spa_fallback_does_not_serve_files_outside_the_build(self):
        response = _client().get("/..%2f..%2f..%2fetc%2fpasswd")
        self.assertIn(response.status_code, (200, 404))
        self.assertNotIn(b"root:", response.content)


if __name__ == "__main__":
    unittest.main(verbosity=2)
