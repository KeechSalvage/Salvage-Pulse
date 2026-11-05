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
from call_categories import CATEGORIES  # noqa: E402

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


class CustomerProfileTests(unittest.TestCase):
    """Customer profile edits, the untagged queue, and date filtering."""

    def _add_call(
        self,
        owner: dict,
        *,
        phone: str,
        name: str,
        created_at: str,
        outcome: str = "pending",
        order_value: float = 0.0,
        topics: list[str] | None = None,
        vehicle_year: int | None = None,
        vehicle_make: str = "",
        vehicle_model: str = "",
        part_requested: str = "",
    ) -> str:
        call_id = f"call-{uuid.uuid4().hex}"
        st = store.get_state()
        st.setdefault("calls", []).append({
            "id": call_id,
            "org_id": owner["org_id"],
            "rep_id": owner["id"],
            "rep_name": owner["name"],
            "customer_name": name,
            "customer_phone": phone,
            "direction": "inbound",
            "duration_sec": 60,
            "status": "analyzed",
            "source": "test",
            "category": "Sales Inquiry",
            "outcome": outcome,
            "order_value": order_value,
            "overall_score": 70,
            "topics": topics or [],
            "vehicle_year": vehicle_year,
            "vehicle_make": vehicle_make,
            "vehicle_model": vehicle_model,
            "part_requested": part_requested,
            "created_at": created_at,
        })
        store.save_state()
        return call_id

    def test_profile_details_and_untagged_queue(self):
        client = _client()
        owner, _, _ = _signup(client, yard="Customer Profile Yard")
        phone = "15550007001"
        self._add_call(owner, phone=phone, name="Original Name", created_at="2026-05-10T12:00:00Z")

        untagged = client.get("/api/analytics/customers?include_all=true&tag=untagged").json()
        self.assertIn(phone, {c["key"] for c in untagged["all_customers"]})
        self.assertEqual(untagged["untagged_customers"], 1)

        tagged = client.put(f"/api/customers/{phone}/tag", json={"tag": "fleet"})
        self.assertEqual(tagged.status_code, 200, tagged.text)
        untagged = client.get("/api/analytics/customers?include_all=true&tag=untagged").json()
        self.assertNotIn(phone, {c["key"] for c in untagged["all_customers"]})
        self.assertEqual(untagged["untagged_customers"], 0)

        updated = client.put(
            f"/api/customers/{phone}/profile",
            json={"name": "Acme Fleet", "email": "ops@acme.test", "text_ok": False},
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        profile = client.get(f"/api/customers/{phone}").json()["stat"]
        self.assertEqual(profile["name"], "Acme Fleet")
        self.assertEqual(profile["email"], "ops@acme.test")
        self.assertFalse(profile["text_ok"])

        fleet = client.get("/api/analytics/customers?include_all=true&tag=fleet").json()
        row = next(c for c in fleet["all_customers"] if c["key"] == phone)
        self.assertEqual(row["name"], "Acme Fleet")
        self.assertEqual(row["email"], "ops@acme.test")
        self.assertFalse(row["text_ok"])

    def test_rep_can_edit_customer_details(self):
        client = _client()
        owner, _, _ = _signup(client, yard="Rep Customer Edit Yard")
        phone = "15550007801"
        self._add_call(owner, phone=phone, name="Original Name", created_at=store.now_iso())
        rep_email = f"customer-rep-{uuid.uuid4().hex[:8]}@example.test"
        created = client.post(
            "/api/users/reps",
            json={
                "name": "Customer Rep",
                "email": rep_email,
                "password": "RepPass!234",
                "role": "rep",
            },
        )
        self.assertEqual(created.status_code, 200, created.text)

        rep = _client()
        _login(rep, rep_email, "RepPass!234")
        saved = rep.put(
            f"/api/customers/{phone}/profile",
            json={"name": "Added By Rep", "email": "rep@example.test", "text_ok": True},
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        profile = rep.get(f"/api/customers/{phone}").json()["stat"]
        self.assertEqual(profile["name"], "Added By Rep")
        self.assertEqual(profile["email"], "rep@example.test")
        self.assertTrue(profile["text_ok"])

    def test_alternate_phone_groups_existing_and_new_calls(self):
        client = _client()
        owner, _, _ = _signup(client, yard="Alternate Contact Yard")
        primary = "15550007601"
        alternate = "15550007602"
        self._add_call(owner, phone=primary, name="Primary Customer", created_at="2026-05-10T12:00:00Z")
        alt_call = self._add_call(owner, phone=alternate, name="Alternate Name", created_at="2026-05-11T12:00:00Z")

        before = client.get("/api/analytics/customers?include_all=true").json()
        self.assertEqual(before["total_customers"], 2)

        saved = client.put(
            f"/api/customers/{primary}/profile",
            json={
                "name": "Primary Customer",
                "email": "",
                "alt_phones": [alternate],
                "alt_emails": ["alt@example.test"],
                "text_ok": True,
            },
        )
        self.assertEqual(saved.status_code, 200, saved.text)

        profile = client.get(f"/api/customers/{primary}").json()
        self.assertEqual(profile["stat"]["key"], primary)
        self.assertEqual(profile["stat"]["calls"], 2)
        self.assertEqual(profile["stat"]["alt_phones"], [alternate])
        self.assertEqual(profile["stat"]["alt_emails"], ["alt@example.test"])

        via_alt = client.get(f"/api/customers/{alternate}").json()
        self.assertEqual(via_alt["stat"]["key"], primary)
        self.assertEqual(via_alt["stat"]["calls"], 2)

        insights = client.get("/api/analytics/customers?include_all=true").json()
        self.assertEqual(insights["total_customers"], 1)
        self.assertEqual(insights["all_customers"][0]["key"], primary)
        self.assertEqual(insights["all_customers"][0]["calls"], 2)

        related = client.get(f"/api/calls/{alt_call}/customer-calls").json()
        self.assertEqual(related["key"], primary)
        self.assertEqual(len(related["calls"]), 2)

        self._add_call(owner, phone=alternate, name="Alternate Name", created_at="2026-05-12T12:00:00Z")
        profile = client.get(f"/api/customers/{primary}").json()
        self.assertEqual(profile["stat"]["calls"], 3)

        cleared = client.put(
            f"/api/customers/{primary}/profile",
            json={
                "name": "Primary Customer",
                "email": "",
                "alt_phones": [],
                "alt_emails": [],
                "text_ok": True,
            },
        )
        self.assertEqual(cleared.status_code, 200, cleared.text)
        after = client.get("/api/analytics/customers?include_all=true").json()
        self.assertEqual(after["total_customers"], 2)

    def test_driver_and_other_are_excluded_from_sales_metrics(self):
        client = _client()
        owner, _, _ = _signup(client, yard="Customer Type Yard")
        self._add_call(owner, phone="15550007501", name="Acme Collision", created_at="2026-05-10T12:00:00Z", outcome="won", order_value=100)
        self._add_call(owner, phone="15550007502", name="Test Driver", created_at="2026-05-11T12:00:00Z", outcome="won", order_value=50)
        self._add_call(owner, phone="15550007503", name="Mystery Caller", created_at="2026-05-12T12:00:00Z", outcome="won", order_value=75)
        tagged = client.put("/api/customers/15550007503/tag", json={"tag": "other"})
        self.assertEqual(tagged.status_code, 200, tagged.text)

        overview = client.get("/api/analytics/overview").json()
        self.assertEqual(overview["total_calls"], 3)
        self.assertEqual(overview["won"], 1)
        self.assertEqual(overview["conversion_rate"], 100.0)

        insights = client.get("/api/analytics/customers?include_all=true").json()
        tags = {c["key"]: c["tag"] for c in insights["all_customers"]}
        self.assertEqual(tags["15550007502"], "driver")
        self.assertEqual(tags["15550007503"], "other")
        breakdown = {row["tag"]: row for row in insights["type_breakdown"]}
        self.assertIn("driver", breakdown)
        self.assertIn("other", breakdown)

    def test_adjuster_is_non_sales_but_still_counts_as_vehicle_and_parts_request(self):
        client = _client()
        owner, _, _ = _signup(client, yard="Adjuster Yard")
        phone = "15550007701"
        self._add_call(
            owner,
            phone=phone,
            name="Progressive Claims",
            created_at=store.now_iso(),
            outcome="won",
            order_value=500,
            topics=["Jeep Grand Cherokee", "Front Door"],
            vehicle_year=2018,
            vehicle_make="Jeep",
            vehicle_model="Grand Cherokee",
            part_requested="Front Door",
        )

        overview = client.get("/api/analytics/overview").json()
        self.assertEqual(overview["total_calls"], 1)
        self.assertEqual(overview["won"], 0)
        self.assertEqual(overview["conversion_rate"], 0.0)

        customers = client.get("/api/analytics/customers?include_all=true").json()
        row = next(c for c in customers["all_customers"] if c["key"] == phone)
        self.assertEqual(row["tag"], "adjuster")

        vehicles = client.get("/api/analytics/vehicles?rank=calls").json()
        self.assertEqual(vehicles["total_calls"], 1)
        self.assertEqual(vehicles["tracked_calls"], 1)
        self.assertIn("Jeep Grand Cherokee", {f"{m['make']} {m['model']}".strip() for m in vehicles["models"]})

        parts = client.get("/api/analytics/parts-seasonal").json()
        door = next(p for p in parts["parts"] if p["part"] == "door")
        self.assertGreaterEqual(door["asked"], 1)
        self.assertEqual(door["sold"], 0)

    def test_bulk_confirm_suggested_tags(self):
        client = _client()
        owner, _, _ = _signup(client, yard="Suggested Tag Yard")
        phone = "15550007201"
        self._add_call(owner, phone=phone, name="Acme Collision", created_at="2026-05-10T12:00:00Z")

        untagged = client.get("/api/analytics/customers?include_all=true&tag=untagged").json()
        self.assertIn(phone, {c["key"] for c in untagged["all_customers"]})

        confirmed = client.post("/api/customers/confirm-suggested", json={"keys": [phone]})
        self.assertEqual(confirmed.status_code, 200, confirmed.text)
        self.assertEqual(confirmed.json()["updated"], 1)
        profile = client.get(f"/api/customers/{phone}").json()["stat"]
        self.assertEqual(profile["tag"], "body_shop")
        self.assertEqual(profile["tag_source"], "manual")

        untagged = client.get("/api/analytics/customers?include_all=true&tag=untagged").json()
        self.assertNotIn(phone, {c["key"] for c in untagged["all_customers"]})

    def test_customer_date_range_filters_calls(self):
        client = _client()
        owner, _, _ = _signup(client, yard="Customer Date Yard")
        self._add_call(owner, phone="15550007101", name="May Customer", created_at="2026-05-10T12:00:00Z")
        self._add_call(owner, phone="15550007102", name="June Customer", created_at="2026-06-10T12:00:00Z")

        may = client.get(
            "/api/analytics/customers?include_all=true&date_from=2026-05-01&date_to=2026-05-31"
        ).json()
        keys = {c["key"] for c in may["all_customers"]}
        self.assertIn("15550007101", keys)
        self.assertNotIn("15550007102", keys)

        june = client.get(
            "/api/analytics/customers?include_all=true&date_from=2026-06-01&date_to=2026-06-30"
        ).json()
        keys = {c["key"] for c in june["all_customers"]}
        self.assertIn("15550007102", keys)
        self.assertNotIn("15550007101", keys)


class RingCentralImportTests(unittest.TestCase):
    """The upload screen must really add calls, not just report success."""

    CSV = (
        "Interaction ID,Interaction Name,Host Name,Host Email,Inbound/Outbound,Date and Time,"
        "Duration,Interaction Category,Topics,Trackers,External Participants,Interaction Url,Score\n"
        "i-1001,Inbound parts call,Erica Import,erica@import.test,Inbound,2026-10-01T10:00:00Z,"
        "60,Sales Enquiry Calls,Parts Inquiry; Pricing,,Name: Acme Collision; Email: ; Phone: 15550008001,https://rc/1001,8\n"
        "i-1002,Outbound delivery,Bob Import,bob@import.test,Outbound,2026-10-02T11:00:00Z,"
        "90,Order Processing Calls,Delivery Update,,Name: Jane Doe; Email: ; Phone: 15550008002,https://rc/1002,9\n"
    )

    def test_import_adds_calls_and_dedupes_by_interaction_id(self):
        client = _client()
        owner, _, _ = _signup(client, yard="Import Yard")
        response = client.post(
            "/api/calls/import",
            files={"file": ("ringcentral.csv", self.CSV.encode("utf-8"), "text/csv")},
            data={"replace_demo": "false"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["total_rows"], 2)
        self.assertEqual(body["imported"], 2)
        self.assertEqual(body["updated"], 0)
        self.assertEqual(len(body["rep_logins"]), 2)
        self.assertEqual({login["email"] for login in body["rep_logins"]}, {"erica@import.test", "bob@import.test"})

        calls = client.get("/api/calls").json()
        imported = [c for c in calls if c.get("external_id") in ("i-1001", "i-1002")]
        self.assertEqual(len(imported), 2)
        by_external = {c["external_id"]: c for c in imported}
        self.assertEqual(by_external["i-1001"]["category"], "Sales Inquiry")
        self.assertEqual(by_external["i-1002"]["category"], "Delivery")
        self.assertTrue(by_external["i-1002"]["delivery_call"])
        self.assertEqual(by_external["i-1001"]["rep_name"], "Erica Import")
        self.assertEqual(by_external["i-1002"]["rep_name"], "Bob Import")
        self.assertEqual(by_external["i-1001"]["org_id"], owner["org_id"])

        again = client.post(
            "/api/calls/import",
            files={"file": ("ringcentral.csv", self.CSV.encode("utf-8"), "text/csv")},
            data={"replace_demo": "false"},
        )
        self.assertEqual(again.status_code, 200, again.text)
        second = again.json()
        self.assertEqual(second["imported"], 0)
        self.assertEqual(second["updated"], 2)
        calls_after = client.get("/api/calls").json()
        self.assertEqual(len([c for c in calls_after if c.get("external_id") in ("i-1001", "i-1002")]), 2)

    def test_import_rejects_empty_file(self):
        client = _client()
        _signup(client, yard="Empty Import Yard")
        response = client.post(
            "/api/calls/import",
            files={"file": ("empty.csv", b"Interaction ID,Host Name\n", "text/csv")},
            data={"replace_demo": "false"},
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("No call rows", response.json()["detail"])

    def test_imported_calls_have_coaching_fields(self):
        client = _client()
        _signup(client, yard="Coaching Import Yard")
        response = client.post(
            "/api/calls/import",
            files={"file": ("ringcentral.csv", self.CSV.encode("utf-8"), "text/csv")},
            data={"replace_demo": "false"},
        )
        self.assertEqual(response.status_code, 200, response.text)

        calls = client.get("/api/calls").json()
        imported = [c for c in calls if c.get("external_id") in ("i-1001", "i-1002")]
        self.assertEqual(len(imported), 2)
        for call in imported:
            detail = client.get(f"/api/calls/{call['id']}").json()
            self.assertTrue(str(detail.get("coaching_feedback") or "").strip())
            self.assertTrue(detail.get("strengths"))
            self.assertTrue(detail.get("improvements"))
            self.assertTrue(detail.get("insights"))


class CoachingFieldTests(unittest.TestCase):
    """Existing calls must never show blank coaching sections."""

    def test_existing_call_with_empty_coaching_is_filled_on_read(self):
        client = _client()
        owner, _, _ = _signup(client, yard="Coaching Fill Yard")
        cid = f"call-{uuid.uuid4().hex}"
        st = store.get_state()
        st.setdefault("calls", []).append({
            "id": cid,
            "org_id": owner["org_id"],
            "rep_id": owner["id"],
            "rep_name": owner["name"],
            "customer_name": "Acme Collision",
            "customer_phone": "15550009001",
            "direction": "inbound",
            "duration_sec": 60,
            "status": "analyzed",
            "source": "test",
            "category": "Sales Inquiry",
            "outcome": "won",
            "order_value": 420,
            "overall_score": 70,
            "vehicle": "2018 Jeep Grand Cherokee",
            "part_requested": "Front Door",
            "topics": ["Jeep Grand Cherokee", "Front Door"],
            "created_at": store.now_iso(),
        })
        st.setdefault("full_calls", {})[cid] = {
            "metrics": {
                "greeting": 90,
                "needs_discovery": 55,
                "product_knowledge": 80,
                "upsell_crosssell": 40,
                "objection_handling": 65,
                "closing": 70,
                "courtesy": 95,
            },
            "coaching_feedback": "",
            "strengths": [],
            "improvements": [],
            "insights": [],
        }
        store.save_state()

        detail = client.get(f"/api/calls/{cid}").json()
        self.assertTrue(str(detail.get("coaching_feedback") or "").strip())
        self.assertTrue(detail.get("strengths"))
        self.assertTrue(detail.get("improvements"))
        self.assertTrue(detail.get("insights"))
        self.assertTrue(any("Front Door" in item for item in detail["insights"]))

        # The filled values are persisted, not regenerated on every request.
        persisted = store.get_state()["full_calls"][cid]
        self.assertTrue(persisted.get("coaching_feedback"))
        self.assertTrue(persisted.get("strengths"))
        self.assertTrue(persisted.get("improvements"))
        self.assertTrue(persisted.get("insights"))


class RepQueueTests(unittest.TestCase):
    """Assigned callbacks must render as a known queue kind, once per call."""

    def test_assigned_callbacks_use_a_known_kind_and_do_not_duplicate(self):
        client = _client()
        owner, _, _ = _signup(client, yard="Queue Crash Yard")
        rep = client.post(
            "/api/users/reps",
            json={
                "name": "Queue Rep",
                "email": f"queue-{uuid.uuid4().hex[:8]}@example.test",
                "password": "RepPass!234",
            },
        ).json()

        cid = f"call-{uuid.uuid4().hex}"
        st = store.get_state()
        st.setdefault("calls", []).append({
            "id": cid,
            "org_id": owner["org_id"],
            "rep_id": owner["id"],
            "rep_name": owner["name"],
            "customer_name": "Queue Customer",
            "customer_phone": "15550009501",
            "direction": "inbound",
            "duration_sec": 20,
            "status": "analyzed",
            "source": "test",
            "category": "Sales Inquiry",
            "outcome": "pending",
            "overall_score": 70,
            "created_at": store.now_iso(),
        })
        store.save_state()

        for _ in range(2):
            assigned = client.post(
                "/api/callbacks/assign",
                json={"call_ids": [cid], "rep_id": rep["id"], "note": "Please call back"},
            )
            self.assertEqual(assigned.status_code, 200, assigned.text)

        login = client.post(
            "/api/auth/login",
            json={"email": rep["email"], "password": "RepPass!234"},
        )
        self.assertEqual(login.status_code, 200, login.text)

        queue = client.get("/api/queue").json()
        callback_items = [item for item in queue["items"] if item["kind"] == "callback"]
        self.assertEqual(len(callback_items), 1)
        self.assertEqual(queue["counts"]["missed"], 1)
        self.assertTrue(
            {item["kind"] for item in queue["items"]}
            <= {"arrival", "missed", "callback", "roleplay"}
        )


class CallbackCompletionTests(unittest.TestCase):
    """Checking off a callback closes its row, list, and team stats."""

    def _setup(self):
        client = _client()
        owner, _, _ = _signup(client, yard="Callback Completion Yard")
        rep_email = f"callback-rep-{uuid.uuid4().hex[:8]}@example.test"
        rep = client.post(
            "/api/users/reps",
            json={
                "name": "Callback Rep",
                "email": rep_email,
                "password": "RepPass!234",
                "role": "rep",
            },
        ).json()

        call_id = f"call-{uuid.uuid4().hex}"
        st = store.get_state()
        st.setdefault("calls", []).append({
            "id": call_id,
            "org_id": owner["org_id"],
            "rep_id": rep["id"],
            "rep_name": rep["name"],
            "customer_name": "Callback Customer",
            "customer_phone": "15550009601",
            "direction": "inbound",
            "duration_sec": 20,
            "status": "analyzed",
            "source": "test",
            "category": "Sales Inquiry",
            "outcome": "pending",
            "overall_score": 70,
            "created_at": store.now_iso(),
        })
        store.save_state()

        callback_list = client.post(
            "/api/callback-lists",
            json={"name": "Monday callbacks", "rep_id": rep["id"]},
        ).json()
        assigned = client.post(
            "/api/callbacks/assign",
            json={
                "call_ids": [call_id],
                "rep_id": rep["id"],
                "list_id": callback_list["id"],
                "note": "Please call back",
            },
        )
        self.assertEqual(assigned.status_code, 200, assigned.text)

        rep_client = _client()
        _login(rep_client, rep_email, "RepPass!234")
        return client, rep_client, rep, call_id, callback_list["id"]

    def test_done_closes_callback_and_updates_list_and_team(self):
        owner_client, rep, rep_user, call_id, list_id = self._setup()

        # Simulate an older duplicate assignment of the same call to the same rep.
        again = owner_client.post(
            "/api/callbacks/assign",
            json={
                "call_ids": [call_id],
                "rep_id": rep_user["id"],
                "list_id": list_id,
                "note": "Duplicate",
            },
        )
        self.assertEqual(again.status_code, 200, again.text)

        open_before = rep.get("/api/callbacks?status=open").json()
        self.assertEqual(len([c for c in open_before if c["id"] == call_id]), 2)

        done = rep.patch(f"/api/calls/{call_id}/callback", json={"done": True})
        self.assertEqual(done.status_code, 200, done.text)
        self.assertTrue(done.json()["callback_done"])
        self.assertTrue(done.json().get("resolved_at"))

        self.assertEqual(rep.get("/api/callbacks?status=open").json(), [])
        resolved = rep.get("/api/callbacks?status=resolved").json()
        self.assertEqual(len([c for c in resolved if c["id"] == call_id]), 1)

        lists = rep.get("/api/callback-lists").json()
        callback_list = next(l for l in lists if l["id"] == list_id)
        self.assertEqual(callback_list["open"], 0)
        self.assertEqual(callback_list["done"], 1)
        self.assertEqual(callback_list["total"], 1)

        board = rep.get("/api/leaderboards/team-player").json()
        row = next(r for r in board["reps"] if r["rep_id"] == rep_user["id"])
        self.assertEqual(row["handled"], 1)

        call = next(c for c in store.get_state()["calls"] if c["id"] == call_id)
        self.assertTrue(call["callback_done"])
        self.assertTrue(call.get("resolved_at"))

        reopened = rep.patch(f"/api/calls/{call_id}/callback", json={"done": False})
        self.assertEqual(reopened.status_code, 200, reopened.text)
        open_after = rep.get("/api/callbacks?status=open").json()
        self.assertEqual(len([c for c in open_after if c["id"] == call_id]), 1)
        self.assertEqual(rep.get("/api/callbacks?status=resolved").json(), [])
        callback_list = next(l for l in rep.get("/api/callback-lists").json() if l["id"] == list_id)
        self.assertEqual(callback_list["open"], 1)
        self.assertEqual(callback_list["done"], 0)
        board = rep.get("/api/leaderboards/team-player").json()
        row = next(r for r in board["reps"] if r["rep_id"] == rep_user["id"])
        self.assertEqual(row["handled"], 0)

        sold = rep.patch(f"/api/calls/{call_id}/callback", json={"done": True, "sold_price": 250})
        self.assertEqual(sold.status_code, 200, sold.text)
        callback_list = next(l for l in rep.get("/api/callback-lists").json() if l["id"] == list_id)
        self.assertEqual(callback_list["sold"], 1)
        self.assertEqual(callback_list["revenue"], 250.0)
        call = next(c for c in store.get_state()["calls"] if c["id"] == call_id)
        self.assertEqual(call["outcome"], "won")
        self.assertEqual(call["order_value"], 250.0)


class ArrivalQueueTests(unittest.TestCase):
    """Vehicle-arrival callers become callbacks and queue links open the call."""

    def test_arrival_callbacks_show_for_rep_and_link_to_source_call(self):
        client = _client()
        owner, _, _ = _signup(client, yard="Arrival Queue Yard")
        rep_email = f"arrival-rep-{uuid.uuid4().hex[:8]}@example.test"
        rep = client.post(
            "/api/users/reps",
            json={
                "name": "Arrival Rep",
                "email": rep_email,
                "password": "RepPass!234",
                "role": "rep",
            },
        ).json()

        call_id = f"call-{uuid.uuid4().hex}"
        st = store.get_state()
        st.setdefault("calls", []).append({
            "id": call_id,
            "org_id": owner["org_id"],
            "rep_id": rep["id"],
            "rep_name": rep["name"],
            "customer_name": "Ford Customer",
            "customer_phone": "15550009701",
            "direction": "inbound",
            "duration_sec": 60,
            "status": "analyzed",
            "source": "test",
            "category": "Sales Inquiry",
            "outcome": "pending",
            "overall_score": 70,
            "vehicle": "2018 Ford F-150",
            "vehicle_year": 2018,
            "vehicle_make": "Ford",
            "vehicle_model": "F-150",
            "part_requested": "Front Door",
            "topics": ["Ford F-150", "Front Door"],
            "created_at": store.now_iso(),
        })
        store.save_state()

        arrival = client.post(
            "/api/arrivals",
            json={"vehicle_year": 2018, "vehicle_make": "Ford", "vehicle_model": "F-150"},
        )
        self.assertEqual(arrival.status_code, 200, arrival.text)
        arrival_body = arrival.json()
        self.assertTrue(arrival_body["callers"])

        created = client.post(
            f"/api/arrivals/{arrival_body['id']}/callback-list",
            json={"rep_ids": [rep["id"]], "name": "Ford callers"},
        )
        self.assertEqual(created.status_code, 200, created.text)

        # A sales manager/owner assigning an arrival list still sees it in the
        # Sales Manager Assigned source.
        manager_items = client.get("/api/callbacks?status=open&source=sales_manager").json()
        self.assertTrue(any((c.get("reason") or "").startswith("Vehicle Arrival") for c in manager_items))

        rep_client = _client()
        _login(rep_client, rep_email, "RepPass!234")
        rep_callbacks = rep_client.get("/api/callbacks?status=open").json()
        callback = next(c for c in rep_callbacks if (c.get("reason") or "").startswith("Vehicle Arrival"))
        self.assertEqual(callback["original_call_id"], call_id)

        queue = rep_client.get("/api/queue").json()
        arrival_item = next(item for item in queue["items"] if item["kind"] == "arrival")
        callback_item = next(item for item in queue["items"] if item["kind"] == "callback")
        self.assertEqual(arrival_item["link"], f"/calls/{call_id}")
        self.assertEqual(callback_item["link"], f"/calls/{call_id}")
        self.assertEqual(rep_client.get(callback_item["link"]).status_code, 200)

    def test_arrival_caller_without_a_call_still_gets_a_callback(self):
        client = _client()
        owner, _, _ = _signup(client, yard="Arrival No Call Yard")
        rep_email = f"arrival-nocall-{uuid.uuid4().hex[:8]}@example.test"
        rep = client.post(
            "/api/users/reps",
            json={
                "name": "No Call Rep",
                "email": rep_email,
                "password": "RepPass!234",
                "role": "rep",
            },
        ).json()

        st = store.get_state()
        st.setdefault("arrivals", []).append({
            "id": f"arr-{uuid.uuid4().hex}",
            "org_id": owner["org_id"],
            "vehicle_year": 2020,
            "vehicle_make": "Honda",
            "vehicle_model": "Accord",
            "created_at": store.now_iso(),
            "callers": [{
                "key": "Walk-in caller",
                "customer_name": "Walk-in caller",
                "customer_phone": "15550009702",
                "status": "to_call",
                "last_call_id": "",
                "parts": ["Headlight"],
                "vehicle": "2020 Honda Accord",
            }],
        })
        store.save_state()
        arrival_id = st["arrivals"][-1]["id"]

        created = client.post(
            f"/api/arrivals/{arrival_id}/callback-list",
            json={"rep_ids": [rep["id"]], "name": "Walk-in callbacks"},
        )
        self.assertEqual(created.status_code, 200, created.text)
        rep_client = _client()
        _login(rep_client, rep_email, "RepPass!234")
        items = rep_client.get("/api/callbacks?status=open").json()
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["customer_name"], "Walk-in caller")
        self.assertEqual(items[0]["customer_phone"], "15550009702")


class FormLibraryTests(unittest.TestCase):
    """Forms are uploaded, listed, downloaded, deleted, and isolated per yard."""

    PDF = b"%PDF-1.4\n% salvage pulse test form\n"

    def _upload(self, client: TestClient, name: str = "Warranty Form.pdf", content: bytes = PDF):
        return client.post(
            "/api/forms/upload",
            files=[("files", (name, content, "application/pdf"))],
        )

    def test_owner_can_upload_download_and_delete_forms(self):
        client = _client()
        _signup(client, yard="Forms Yard")

        uploaded = self._upload(client)
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        body = uploaded.json()
        self.assertEqual(body["uploaded"], 1)
        item = body["items"][0]
        self.assertEqual(item["filename"], "Warranty Form.pdf")
        self.assertEqual(item["size_bytes"], len(self.PDF))

        listed = client.get("/api/forms").json()
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["id"], item["id"])

        download = client.get(item["download_url"])
        self.assertEqual(download.status_code, 200)
        self.assertEqual(download.content, self.PDF)

        deleted = client.delete(f"/api/forms/{item['id']}")
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertEqual(client.get("/api/forms").json(), [])
        self.assertEqual(client.get(item["download_url"]).status_code, 404)

    def test_sales_manager_can_manage_but_rep_cannot(self):
        owner = _client()
        _, _, _ = _signup(owner, yard="Forms Roles Yard")
        manager_email = f"forms-manager-{uuid.uuid4().hex[:8]}@example.test"
        rep_email = f"forms-rep-{uuid.uuid4().hex[:8]}@example.test"
        self.assertEqual(
            owner.post(
                "/api/users/reps",
                json={
                    "name": "Forms Manager",
                    "email": manager_email,
                    "password": "ManagerPass!234",
                    "role": "sales_manager",
                },
            ).status_code,
            200,
        )
        self.assertEqual(
            owner.post(
                "/api/users/reps",
                json={
                    "name": "Forms Rep",
                    "email": rep_email,
                    "password": "RepPass!234",
                    "role": "rep",
                },
            ).status_code,
            200,
        )

        manager = _client()
        _login(manager, manager_email, "ManagerPass!234")
        uploaded = self._upload(manager, "Delivery Sheet.docx", b"test form")
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        form_id = uploaded.json()["items"][0]["id"]

        rep = _client()
        _login(rep, rep_email, "RepPass!234")
        self.assertEqual(len(rep.get("/api/forms").json()), 1)
        self.assertEqual(rep.get(f"/api/forms/{form_id}/download").status_code, 200)
        self.assertEqual(self._upload(rep).status_code, 403)
        self.assertEqual(rep.delete(f"/api/forms/{form_id}").status_code, 403)
        self.assertEqual(manager.delete(f"/api/forms/{form_id}").status_code, 200)

    def test_forms_cannot_cross_yards(self):
        first = _client()
        _, _, _ = _signup(first, yard="Forms First Yard")
        uploaded = self._upload(first)
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        form_id = uploaded.json()["items"][0]["id"]

        second = _client()
        _, _, _ = _signup(second, yard="Forms Second Yard")
        self.assertEqual(second.get("/api/forms").json(), [])
        self.assertIn(second.get(f"/api/forms/{form_id}/download").status_code, (403, 404))
        self.assertIn(second.delete(f"/api/forms/{form_id}").status_code, (403, 404))

    def test_unsupported_file_type_is_rejected(self):
        client = _client()
        _signup(client, yard="Forms Types Yard")
        rejected = self._upload(client, "payload.exe", b"MZ")
        self.assertEqual(rejected.status_code, 400)
        self.assertIn("Unsupported file type", rejected.text)


class ScoringScopeTests(unittest.TestCase):
    """Custom AI evaluation is isolated to one location."""

    def _call(self, owner: dict, *, site_id: str, greeting: int, other: int) -> str:
        cid = f"call-{uuid.uuid4().hex}"
        st = store.get_state()
        metrics = {
            "greeting": greeting,
            "needs_discovery": other,
            "product_knowledge": other,
            "upsell_crosssell": other,
            "objection_handling": other,
            "closing": other,
            "compliance_warranty": other,
            "tone_empathy": other,
        }
        st.setdefault("calls", []).append({
            "id": cid,
            "org_id": owner["org_id"],
            "site_id": site_id,
            "rep_id": owner["id"],
            "rep_name": owner["name"],
            "customer_name": "Scoring Customer",
            "customer_phone": f"1555{uuid.uuid4().int % 10_000_000:07d}",
            "direction": "inbound",
            "duration_sec": 60,
            "status": "analyzed",
            "source": "test",
            "category": "Sales Inquiry",
            "outcome": "pending",
            "overall_score": 0,
            "created_at": store.now_iso(),
        })
        st.setdefault("full_calls", {})[cid] = {"metrics": metrics}
        store.save_state()
        return cid

    def test_location_scoring_is_isolated(self):
        client = _client()
        owner, _, _ = _signup(client, yard="Scoring Scope Yard")
        north = client.post("/api/sites", json={"name": "North scoring"}).json()["sites"][-1]
        south = client.post("/api/sites", json={"name": "South scoring"}).json()["sites"][-1]
        north_call = self._call(owner, site_id=north["id"], greeting=100, other=0)
        south_call = self._call(owner, site_id=south["id"], greeting=0, other=100)

        weights = {
            "greeting": 100,
            "needs_discovery": 0,
            "product_knowledge": 0,
            "upsell_crosssell": 0,
            "objection_handling": 0,
            "closing": 0,
            "courtesy": 0,
        }
        saved = client.put(
            "/api/settings/scoring",
            json={
                "site_id": north["id"],
                "custom_scoring": True,
                "weights": weights,
                "criteria": {"greeting": "North location greeting standard"},
                "instructions": "North location: always confirm the delivery address.",
            },
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        body = saved.json()
        self.assertTrue(body["custom_scoring"])
        self.assertEqual(body["criteria"]["greeting"], "North location greeting standard")
        self.assertEqual(body["instructions"], "North location: always confirm the delivery address.")
        self.assertGreaterEqual(body["recalculated_calls"], 1)

        north_settings = client.get(f"/api/settings/scoring?site_id={north['id']}").json()
        self.assertTrue(north_settings["custom_scoring"])
        self.assertEqual(north_settings["criteria"]["greeting"], "North location greeting standard")
        self.assertEqual(north_settings["weights"]["greeting"], 100)

        south_settings = client.get(f"/api/settings/scoring?site_id={south['id']}").json()
        self.assertFalse(south_settings["custom_scoring"])
        self.assertNotEqual(south_settings["criteria"]["greeting"], "North location greeting standard")

        yard_settings = client.get("/api/settings/scoring").json()
        self.assertFalse(yard_settings["custom_scoring"])

        calls = {c["id"]: c for c in client.get("/api/calls").json()}
        self.assertEqual(calls[north_call]["overall_score"], 100)
        self.assertEqual(calls[south_call]["overall_score"], 0)

        other_yard = _client()
        _signup(other_yard, yard="Other Scoring Yard")
        other_settings = other_yard.get("/api/settings/scoring").json()
        self.assertFalse(other_settings["custom_scoring"])
        self.assertNotEqual(other_settings["criteria"]["greeting"], "North location greeting standard")


class LocationScopeTests(unittest.TestCase):
    """Reps stay locked to their location; managers can compare locations."""

    def _call(self, owner: dict, rep: dict, *, site_id: str, value: float, when: str) -> str:
        cid = f"call-{uuid.uuid4().hex}"
        st = store.get_state()
        st.setdefault("calls", []).append({
            "id": cid,
            "org_id": owner["org_id"],
            "site_id": site_id,
            "rep_id": rep["id"],
            "rep_name": rep["name"],
            "customer_name": f"Customer {cid[-6:]}",
            "customer_phone": f"1555{uuid.uuid4().int % 10_000_000:07d}",
            "direction": "inbound",
            "duration_sec": 60,
            "status": "analyzed",
            "source": "test",
            "category": "Order/Sale",
            "outcome": "won",
            "order_value": value,
            "overall_score": 80,
            "created_at": when,
        })
        store.save_state()
        return cid

    def test_rep_is_locked_to_location_and_site_board_splits_sales(self):
        client = _client()
        owner, _, _ = _signup(client, yard="Location Scope Yard")
        north = client.post("/api/sites", json={"name": "North lot"}).json()["sites"][-1]
        south = client.post("/api/sites", json={"name": "South lot"}).json()["sites"][-1]
        created = client.post(
            "/api/users/reps",
            json={
                "name": "Locked Rep",
                "email": f"locked-{uuid.uuid4().hex[:8]}@example.test",
                "password": "RepPass!234",
                "site_id": north["id"],
            },
        )
        self.assertEqual(created.status_code, 200, created.text)
        rep = created.json()
        self._call(owner, rep, site_id=north["id"], value=100, when=store.now_iso())
        self._call(owner, rep, site_id=south["id"], value=200, when=store.now_iso())

        rep_client = _client()
        _login(rep_client, rep["email"], "RepPass!234")
        rep_calls = rep_client.get("/api/calls").json()
        self.assertEqual({c["site_id"] for c in rep_calls}, {north["id"]})

        north_overview = client.get(f"/api/analytics/overview?site_id={north['id']}").json()
        south_overview = client.get(f"/api/analytics/overview?site_id={south['id']}").json()
        all_overview = client.get("/api/analytics/overview").json()
        self.assertEqual(north_overview["won"], 1)
        self.assertEqual(south_overview["won"], 1)
        self.assertEqual(all_overview["won"], 2)

        board = client.get("/api/sites/leaderboard").json()
        by_site = {row["site_id"]: row for row in board["rows"]}
        self.assertEqual(by_site[north["id"]]["revenue"], 100)
        self.assertEqual(by_site[south["id"]]["revenue"], 200)

        moved = client.patch(f"/api/users/reps/{rep['id']}/site", json={"site_id": south["id"]})
        self.assertEqual(moved.status_code, 200, moved.text)
        self._call(owner, rep, site_id="", value=300, when=store.now_iso())
        rep_calls = rep_client.get("/api/calls").json()
        self.assertTrue(rep_calls)
        self.assertTrue(all(c["site_id"] != north["id"] for c in rep_calls))

        board = client.get("/api/sites/leaderboard").json()
        by_site = {row["site_id"]: row for row in board["rows"]}
        self.assertEqual(by_site[north["id"]]["revenue"], 100)
        self.assertEqual(by_site[south["id"]]["revenue"], 500)


class ClassificationAndTextTests(unittest.TestCase):
    """Manual category correction, review queue, and text permission."""

    def test_manual_category_override_clears_needs_review(self):
        client = _client()
        owner, _, _ = _signup(client, yard="Category Review Yard")
        call_id = f"call-{uuid.uuid4().hex}"
        st = store.get_state()
        st.setdefault("calls", []).append({
            "id": call_id,
            "org_id": owner["org_id"],
            "rep_id": owner["id"],
            "rep_name": owner["name"],
            "customer_name": "Review Customer",
            "customer_phone": "15550007301",
            "direction": "inbound",
            "duration_sec": 60,
            "status": "analyzed",
            "source": "ringcentral",
            "category": "Sales Inquiry",
            "category_source": "auto",
            "category_confidence": 0.4,
            "caller_intent": "buyer",
            "outcome": "pending",
            "overall_score": 70,
            "created_at": "2026-05-10T12:00:00Z",
        })
        store.save_state()

        review = client.get("/api/calls?needs_review=true")
        self.assertEqual(review.status_code, 200, review.text)
        self.assertIn(call_id, {c["id"] for c in review.json()})

        saved = client.patch(
            f"/api/calls/{call_id}/category",
            json={"category": "Warranty/Return", "outcome": "n/a"},
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        body = saved.json()
        self.assertEqual(body["category"], "Warranty/Return")
        self.assertEqual(body["outcome"], "n/a")
        self.assertEqual(body["category_source"], "manual")
        self.assertEqual(body["category_confidence"], 1.0)
        self.assertEqual(body["caller_intent"], "warranty")

        review = client.get("/api/calls?needs_review=true").json()
        self.assertNotIn(call_id, {c["id"] for c in review})
        audit = client.get("/api/calls/category-audit").json()
        self.assertGreaterEqual(
            next((s["count"] for s in audit["by_source"] if s["source"] == "manual"), 0),
            1,
        )

    def test_text_blast_only_includes_approved_callers(self):
        client = _client()
        owner, _, _ = _signup(client, yard="Text Permission Yard")
        created = client.post(
            "/api/arrivals",
            json={"vehicle_year": 2020, "vehicle_make": "Ford", "vehicle_model": "F-150"},
        )
        self.assertEqual(created.status_code, 200, created.text)
        arrival = created.json()
        aid = arrival["id"]

        st = store.get_state()
        target = next(a for a in st.get("arrivals", []) if a.get("id") == aid)
        target["callers"] = [
            {"key": "caller-a", "customer_name": "Caller A", "customer_phone": "15550007401", "status": "to_call", "text_ok": None, "sms_reply": ""},
            {"key": "caller-b", "customer_name": "Caller B", "customer_phone": "15550007402", "status": "to_call", "text_ok": True, "sms_reply": ""},
        ]
        store.save_state()

        sent = client.post(f"/api/arrivals/{aid}/text", json={"template": "Hello {name}"})
        self.assertEqual(sent.status_code, 200, sent.text)
        body = sent.json()
        self.assertEqual(body["blasts"][-1]["count"], 1)
        self.assertEqual(body["blasts"][-1]["skipped"], 1)
        self.assertTrue(body["callers"][1]["texted_at"])
        self.assertFalse(body["callers"][0].get("texted_at"))

        target = next(a for a in store.get_state().get("arrivals", []) if a.get("id") == aid)
        for caller in target["callers"]:
            caller["text_ok"] = None
            caller["texted_at"] = None
        store.save_state()
        blocked = client.post(f"/api/arrivals/{aid}/text", json={"template": "Hello again"})
        self.assertEqual(blocked.status_code, 400)


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
            keech.put(f"/api/customers/{customer}/tag", json={"tag": "fleet"}).status_code,
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
            other.put(f"/api/customers/{customer}/tag", json={"tag": "other"}).status_code,
            200,
        )

        keech_profile = keech.get(f"/api/customers/{customer}").json()
        other_profile = other.get(f"/api/customers/{customer}").json()
        self.assertEqual(keech_profile["stat"]["tag"], "fleet")
        self.assertEqual(other_profile["stat"]["tag"], "other")

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


class ThemePreferenceTests(unittest.TestCase):
    """Each user's mode and accent follow their account, not the browser or yard."""

    def test_user_mode_follows_account_and_stays_isolated(self):
        client = _client()
        owner, owner_email, owner_password = _signup(client, yard="Theme Yard")

        initial = client.get("/api/branding").json()
        self.assertEqual(initial["mode"], "dark")
        self.assertEqual(initial["accent"], "")
        self.assertEqual(initial["yard_accent"], "")
        self.assertEqual(initial["user_mode"], "")
        self.assertIsNone(initial["user_accent"])

        saved = client.put("/api/me/theme", json={"mode": "light"})
        self.assertEqual(saved.status_code, 200, saved.text)
        themed = saved.json()
        self.assertEqual(themed["mode"], "light")
        self.assertEqual(themed["user_mode"], "light")
        self.assertEqual(themed["accent"], "")

        # The mode preference survives a fresh sign-in.
        client.post("/api/auth/logout")
        _login(client, owner_email, owner_password)
        reloaded = client.get("/api/branding").json()
        self.assertEqual(reloaded["mode"], "light")

        rep_email = f"theme-rep-{uuid.uuid4().hex[:8]}@example.test"
        created = client.post(
            "/api/users/reps",
            json={
                "name": "Theme Rep",
                "email": rep_email,
                "password": "RepPass!234",
                "role": "rep",
            },
        )
        self.assertEqual(created.status_code, 200, created.text)

        rep = _client()
        _login(rep, rep_email, "RepPass!234")
        teammate = rep.get("/api/branding").json()
        self.assertEqual(teammate["mode"], "dark")
        self.assertEqual(teammate["accent"], "")

        # Accent is company branding, not a personal preference.
        blocked = rep.put("/api/me/theme", json={"accent": "#0EA5E9"})
        self.assertEqual(blocked.status_code, 403, blocked.text)

        rep_mode = rep.put("/api/me/theme", json={"mode": "light"})
        self.assertEqual(rep_mode.status_code, 200, rep_mode.text)
        self.assertEqual(rep_mode.json()["mode"], "light")
        self.assertEqual(client.get("/api/branding").json()["mode"], "light")

    def test_only_the_owner_controls_company_accent_and_staff_mode(self):
        client = _client()
        _signup(client, yard="Theme Defaults Yard")
        saved = client.put(
            "/api/branding",
            json={"accent": "#EF4444", "default_mode": "light"},
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        body = saved.json()
        self.assertEqual(body["yard_accent"], "#EF4444")
        self.assertEqual(body["accent"], "#EF4444")
        # The owner cannot set a light/dark default for staff.
        self.assertEqual(body["default_mode"], "dark")
        self.assertEqual(body["mode"], "dark")

        manager_email = f"theme-manager-{uuid.uuid4().hex[:8]}@example.test"
        manager = client.post(
            "/api/users/reps",
            json={
                "name": "Theme Manager",
                "email": manager_email,
                "password": "ManagerPass!234",
                "role": "sales_manager",
            },
        )
        self.assertEqual(manager.status_code, 200, manager.text)

        manager_client = _client()
        _login(manager_client, manager_email, "ManagerPass!234")
        denied = manager_client.put("/api/branding", json={"accent": "#0EA5E9"})
        self.assertEqual(denied.status_code, 403, denied.text)
        self.assertEqual(manager_client.get("/api/branding").json()["accent"], "#EF4444")


class ContactBugReportTests(unittest.TestCase):
    def test_bug_report_is_saved_with_the_bug_kind(self):
        client = _client()
        _signup(client, yard="Bug Report Yard")
        sent = client.post(
            "/api/contact",
            json={
                "kind": "bug",
                "subject": "Callback list not updating",
                "message": "Checking off a callback did not remove it from the list.",
                "page": "/callbacks",
            },
        )
        self.assertEqual(sent.status_code, 200, sent.text)
        mine = client.get("/api/contact/mine").json()
        report = next(m for m in mine if m["id"] == sent.json()["id"])
        self.assertEqual(report["kind"], "bug")
        self.assertEqual(report["subject"], "Callback list not updating")
        self.assertEqual(report["page"], "/callbacks")


class OrgPlanTests(unittest.TestCase):
    """Plan payloads must not make active yards look like limited trials."""

    def test_active_yard_has_no_trial_suggestion_cap(self):
        client = _client()
        _login(client, "salesmanager@keechauto.com", "salesmanager")
        org = client.get("/api/org/me").json()
        self.assertEqual(org["status"], "active")
        self.assertFalse(org["trial_limited"])
        self.assertIsNone(org["suggestion_cap"])
        self.assertIsNone(org["roleplay_daily_cap"])

    def test_limited_trial_still_gets_the_small_suggestion_cap(self):
        client = _client()
        owner, _, _ = _signup(client, yard="Limited Trial Yard")
        st = store.get_state()
        yard = next(o for o in st["admin_orgs"] if o["id"] == owner["org_id"])
        yard["status"] = "trialing"
        yard["limited_starts_at"] = "2020-01-01T00:00:00Z"
        store.save_state()

        org = client.get("/api/org/me").json()
        self.assertTrue(org["trial_limited"])
        self.assertEqual(org["suggestion_cap"], 3)
        self.assertEqual(org["roleplay_daily_cap"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)


class AttributionTests(unittest.TestCase):
    """Metrics must describe the caller's own yard, rep and calls."""

    def test_meta_exposes_only_actionable_call_categories(self):
        client = _client()
        _login(client, "owner@keechauto.com", "owner")
        response = client.get("/api/meta")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["categories"], CATEGORIES)

    def test_manager_and_owner_can_open_a_rep_radar_without_credentials(self):
        """The rep profile (and its 7-metric radar) must work for managers and owners."""
        for email, password, label in (
            ("owner@keechauto.com", "owner", "owner"),
            ("salesmanager@keechauto.com", "salesmanager", "sales manager"),
        ):
            client = _client()
            _login(client, email, password)
            response = client.get("/api/analytics/overview?rep_id=user-keech-rep")
            self.assertEqual(response.status_code, 200, f"{label}: {response.text}")
            body = response.json()
            self.assertEqual(body["rep"]["id"], "user-keech-rep")
            self.assertNotIn("password_hash", body["rep"])
            self.assertGreater(body["scored_calls"], 0)
            self.assertEqual(len(body["metric_averages"]), 8)
            self.assertTrue(any(metric["avg"] > 0 for metric in body["metric_averages"]))

    def test_vehicle_demand_is_computed_from_own_call_topics(self):
        yard_a = _client()
        user_a, _, _ = _signup(yard_a, yard="Attribution Yard A")
        yard_b = _client()
        user_b, _, _ = _signup(yard_b, yard="Attribution Yard B")
        st = store.get_state()
        st.setdefault("calls", []).extend([
            {
                "id": f"call-{uuid.uuid4().hex}",
                "org_id": user_a["org_id"],
                "rep_id": user_a["id"],
                "rep_name": user_a["name"],
                "customer_name": "A Customer",
                "customer_phone": "15550001001",
                "created_at": store.now_iso(),
                "duration_sec": 60,
                "outcome": "lost",
                "category": "Part Inquiry/Quote",
                "topics": ["Jeep Grand Cherokee", "Front Door"],
                "summary": "Inbound call with A Customer. Topics discussed: Jeep Grand Cherokee, Front Door.",
            },
            {
                "id": f"call-{uuid.uuid4().hex}",
                "org_id": user_b["org_id"],
                "rep_id": user_b["id"],
                "rep_name": user_b["name"],
                "customer_name": "B Customer",
                "customer_phone": "15550001002",
                "created_at": store.now_iso(),
                "duration_sec": 60,
                "outcome": "won",
                "category": "Part Inquiry/Quote",
                "topics": ["nissan rogue"],
                "summary": "Inbound call with B Customer. Topics discussed: nissan rogue.",
            },
        ])
        store.save_state()

        data_a = yard_a.get("/api/analytics/vehicles?rank=calls").json()
        labels_a = {f"{m['make']} {m['model']}".strip() for m in data_a["models"]}
        self.assertIn("Jeep Grand Cherokee", labels_a)
        self.assertNotIn("Nissan Rogue", labels_a)
        self.assertEqual(data_a["total_calls"], 1)
        self.assertEqual(data_a["tracked_calls"], 1)

        data_b = yard_b.get("/api/analytics/vehicles?rank=calls").json()
        labels_b = {f"{m['make']} {m['model']}".strip() for m in data_b["models"]}
        self.assertIn("Nissan Rogue", labels_b)
        self.assertNotIn("Jeep Grand Cherokee", labels_b)
        self.assertEqual(data_b["total_calls"], 1)

    def test_customer_metrics_are_per_rep_and_winback_is_persisted(self):
        yard = _client()
        owner, _, _ = _signup(yard, yard="Attribution Rep Yard")
        created = yard.post(
            "/api/users/reps",
            json={
                "name": "Rep One",
                "email": f"rep-{uuid.uuid4().hex[:8]}@example.test",
                "password": "RepPass!234",
            },
        )
        self.assertEqual(created.status_code, 200, created.text)
        rep = created.json()

        st = store.get_state()
        now = store.now_iso()
        st.setdefault("calls", []).extend([
            {
                "id": f"call-{uuid.uuid4().hex}",
                "org_id": owner["org_id"],
                "rep_id": owner["id"],
                "rep_name": owner["name"],
                "customer_name": "Owner Customer",
                "customer_phone": "15550002001",
                "created_at": now,
                "duration_sec": 30,
                "outcome": "won",
                "order_value": 100.0,
                "category": "Order/Sale",
            },
            {
                "id": f"call-{uuid.uuid4().hex}",
                "org_id": owner["org_id"],
                "rep_id": rep["id"],
                "rep_name": rep["name"],
                "customer_name": "Rep Customer",
                "customer_phone": "15550002002",
                "created_at": now,
                "duration_sec": 45,
                "outcome": "lost",
                "category": "Part Inquiry/Quote",
            },
        ])
        store.save_state()

        owner_data = yard.get(f"/api/analytics/customers?rep_id={rep['id']}").json()
        owner_keys = {c["key"] for c in owner_data["all_customers"]}
        self.assertIn("15550002002", owner_keys)
        self.assertNotIn("15550002001", owner_keys)

        rep_client = _client()
        _login(rep_client, rep["email"], "RepPass!234")
        rep_calls = rep_client.get("/api/calls").json()
        self.assertTrue(rep_calls)
        self.assertTrue(all(c["rep_id"] == rep["id"] for c in rep_calls))
        self.assertEqual(
            rep_client.get(f"/api/calls?rep_id={owner['id']}").status_code,
            403,
        )
        self.assertEqual(
            rep_client.get(f"/api/drill/calls?rep_id={owner['id']}").status_code,
            403,
        )

        mark = rep_client.post(
            "/api/customers/15550002002/winback",
            json={"outcome": "reached"},
        )
        self.assertEqual(mark.status_code, 200, mark.text)
        self.assertEqual(mark.json()["org_id"], owner["org_id"])
        self.assertEqual(mark.json()["rep_id"], rep["id"])

        results = yard.get("/api/analytics/winback").json()
        self.assertGreaterEqual(results["total"], 1)
        self.assertTrue(any(r["customer_key"] == "15550002002" for r in results["recent"]))

        from datetime import datetime, timedelta, timezone
        later = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
        st = store.get_state()
        st.setdefault("calls", []).append({
            "id": f"call-{uuid.uuid4().hex}",
            "org_id": owner["org_id"],
            "rep_id": rep["id"],
            "rep_name": rep["name"],
            "customer_name": "Rep Customer",
            "customer_phone": "15550002002",
            "created_at": later,
            "duration_sec": 60,
            "outcome": "won",
            "order_value": 250.0,
            "category": "Order/Sale",
        })
        store.save_state()

        confirmed = yard.get("/api/analytics/winback").json()
        row = next(r for r in confirmed["recent"] if r["customer_key"] == "15550002002")
        self.assertTrue(row["confirmed"])
        self.assertEqual(row["confirmed_value"], 250.0)

    def test_seasonal_part_cells_match_drill_down_exactly(self):
        """Every seasonal cell must equal the calls its dialog shows.

        A call that mentions several parts counts under each one, delivery
        calls never count as parts demand, and the drill-down must return the
        full list rather than the generic 200-row preview cap.
        """
        yard = _client()
        owner, _, _ = _signup(yard, yard="Attribution Parts Yard")
        now = store.now_iso()
        month = now[:7]
        base = {
            "org_id": owner["org_id"],
            "rep_id": owner["id"],
            "rep_name": owner["name"],
            "created_at": now,
            "duration_sec": 30,
            "category": "Part Inquiry/Quote",
        }
        st = store.get_state()
        st.setdefault("calls", []).extend([
            {
                **base,
                "id": f"call-{uuid.uuid4().hex}",
                "customer_name": "One",
                "customer_phone": "15550003001",
                "outcome": "won",
                "topics": ["Ford F-150", "Front Door", "Bumper"],
            },
            {
                **base,
                "id": f"call-{uuid.uuid4().hex}",
                "customer_name": "Two",
                "customer_phone": "15550003002",
                "outcome": "lost",
                "topics": ["Chevy Silverado", "door"],
            },
            {
                **base,
                "id": f"call-{uuid.uuid4().hex}",
                "customer_name": "Three",
                "customer_phone": "15550003003",
                "outcome": "won",
                "delivery_call": True,
                "topics": ["Front Door"],
            },
            {
                **base,
                "id": f"call-{uuid.uuid4().hex}",
                "customer_name": "Four",
                "customer_phone": "15550003004",
                "outcome": "won",
                "topics": ["Engine"],
            },
        ])
        store.save_state()

        seasonal = yard.get("/api/analytics/parts-seasonal").json()
        self.assertIn(month, seasonal["months"])
        by_part = {p["part"]: p for p in seasonal["parts"]}
        self.assertEqual(by_part["door"]["asked"], 2)  # delivery call excluded
        self.assertEqual(by_part["door"]["sold"], 1)
        self.assertEqual(by_part["bumper"]["asked"], 1)
        self.assertEqual(by_part["engine"]["asked"], 1)

        for part, row in by_part.items():
            for index, cell_month in enumerate(seasonal["months"]):
                for mode, outcome in (("asked", None), ("sold", "won")):
                    expected = row[f"{mode}_by_month"][index]
                    query = f"/api/drill/calls?part={part}&month={cell_month}"
                    if outcome:
                        query += f"&outcome={outcome}"
                    data = yard.get(query).json()
                    self.assertEqual(expected, data["total"], query)
                    self.assertEqual(expected, len(data["calls"]), query)
