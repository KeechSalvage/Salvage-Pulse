"""Unit tests for provider normalisation (no app or network needed)."""

from __future__ import annotations

import base64
import hashlib
import hmac
import unittest

from ingest.adapters import (
    adapter_for,
    detect_provider,
    GenericAdapter,
    RingCentralAdapter,
    TwilioAdapter,
)
from ingest.media import MediaFetchError, audio_extension, fetch_recording


class GenericAdapterTests(unittest.TestCase):
    def test_common_aliases_are_normalised(self):
        payload = {
            "call_id": "abc-123",
            "start_time": "2026-10-23T14:05:00Z",
            "direction": "Inbound",
            "from": "+1 (860) 555-0123",
            "to": "+18605550199",
            "agent_email": "tyler@yard.test",
            "caller_name": "Ridgeline Collision",
            "duration": 184,
            "status": "completed",
            "recording_url": "https://media.example.test/call.mp3",
        }
        calls = adapter_for("generic").parse(payload, {})
        self.assertEqual(len(calls), 1)
        call = calls[0]
        self.assertEqual(call.provider, "generic")
        self.assertEqual(call.external_id, "abc-123")
        self.assertEqual(call.direction, "inbound")
        self.assertEqual(call.from_number, "+18605550123")
        self.assertEqual(call.agent_email, "tyler@yard.test")
        self.assertEqual(call.customer_name, "Ridgeline Collision")
        self.assertEqual(call.duration_sec, 184.0)
        self.assertEqual(call.event, "completed")
        self.assertEqual(call.recording_url, "https://media.example.test/call.mp3")

    def test_wrapped_lists_and_outbound_direction(self):
        payload = {
            "calls": [
                {
                    "id": "call-1",
                    "direction": "outbound",
                    "from_number": "+18605550100",
                    "to_number": "+18605550123",
                    "transcript": "Rep: Hi, this is Tyler.\nCustomer: Thanks.",
                }
            ]
        }
        calls = GenericAdapter().parse(payload, {})
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].direction, "outbound")
        self.assertEqual(calls[0].customer_phone, "+18605550123")
        self.assertTrue(calls[0].is_processable)

    def test_never_invents_media_from_an_end_event(self):
        calls = GenericAdapter().parse({"call_id": "x", "status": "completed"}, {})
        self.assertFalse(calls[0].is_processable)

    def test_generic_hmac_signature(self):
        secret = "shhh"
        body = b'{"call_id":"1"}'
        signature = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
        config = {"providers": {"generic": {"signing_secret": secret}}}
        GenericAdapter().verify(
            raw_body=body,
            headers={"x-call-signature": signature},
            form={},
            url="https://example.test/api/ingest/webhook/token",
            config=config,
        )
        with self.assertRaises(ValueError):
            GenericAdapter().verify(
                raw_body=body,
                headers={"x-call-signature": "nope"},
                form={},
                url="https://example.test/api/ingest/webhook/token",
                config=config,
            )


class TwilioAdapterTests(unittest.TestCase):
    FORM = {
        "CallSid": "CA123",
        "CallStatus": "completed",
        "From": "+15551112222",
        "To": "+15553334444",
        "Direction": "inbound",
        "CallDuration": "95",
        "RecordingUrl": "https://api.twilio.com/2010-04-01/Accounts/AC123/Recordings/RE123",
    }

    def test_form_parse_and_recording_extension(self):
        calls = TwilioAdapter().parse(self.FORM, {})
        self.assertEqual(len(calls), 1)
        call = calls[0]
        self.assertEqual(call.provider, "twilio")
        self.assertEqual(call.external_id, "CA123")
        self.assertEqual(call.recording_url, "https://api.twilio.com/2010-04-01/Accounts/AC123/Recordings/RE123.mp3")
        self.assertEqual(call.duration_sec, 95.0)

    def test_signature_verification(self):
        secret = "twilio-auth-token"
        url = "https://app.example.test/api/ingest/webhook/token/twilio"
        data = url + "".join(f"{key}{self.FORM[key]}" for key in sorted(self.FORM))
        signature = base64.b64encode(hmac.new(secret.encode(), data.encode(), hashlib.sha1).digest()).decode()
        config = {"providers": {"twilio": {"signing_secret": secret}}}
        TwilioAdapter().verify(
            raw_body=b"",
            headers={"x-twilio-signature": signature},
            form=self.FORM,
            url=url,
            config=config,
        )
        with self.assertRaises(ValueError):
            TwilioAdapter().verify(
                raw_body=b"",
                headers={"x-twilio-signature": "bad"},
                form=self.FORM,
                url=url,
                config=config,
            )

    def test_detection(self):
        self.assertEqual(detect_provider(self.FORM, {}, "application/x-www-form-urlencoded", self.FORM), "twilio")
        self.assertEqual(detect_provider({"call_id": "x", "status": "completed"}, {}, "application/json", {}), "generic")


class RingCentralAdapterTests(unittest.TestCase):
    SESSION = {
        "event": "/restapi/v1.0/account/~/telephony/sessions",
        "body": {
            "telephonySessionId": "s-123",
            "parties": [
                {
                    "id": "p-caller",
                    "direction": "Inbound",
                    "status": {"code": "Answered"},
                    "from": {"phoneNumber": "+15550001111"},
                    "to": {"phoneNumber": "+15550002222"},
                },
                {
                    "id": "p-rep",
                    "direction": "Inbound",
                    "extensionId": "101",
                    "extensionNumber": "101",
                    "name": "Tyler Grant",
                    "status": {"code": "Answered"},
                    "from": {"phoneNumber": "+15550001111"},
                    "to": {"extensionNumber": "101"},
                },
            ],
        },
        "timestamp": "2026-10-23T14:05:00Z",
    }

    def test_a_session_with_two_parties_emits_one_call(self):
        calls = RingCentralAdapter().parse(self.SESSION, {})
        self.assertEqual(len(calls), 1)
        call = calls[0]
        self.assertEqual(call.provider, "ringcentral")
        self.assertEqual(call.external_id, "s-123")
        self.assertEqual(call.event, "started")
        self.assertEqual(call.direction, "inbound")
        self.assertEqual(call.agent_extension, "101")
        self.assertEqual(call.agent_name, "Tyler Grant")
        self.assertEqual(call.customer_phone, "+15550001111")
        self.assertEqual(call.to_number, "101")

    def test_ringing_is_ignored_and_disconnect_completes_the_call(self):
        ringing = {
            **self.SESSION,
            "body": {
                **self.SESSION["body"],
                "parties": [
                    {**party, "status": {"code": "Ringing"}}
                    for party in self.SESSION["body"]["parties"]
                ],
            },
        }
        self.assertEqual(RingCentralAdapter().parse(ringing, {}), [])

        ended = {
            **self.SESSION,
            "body": {
                **self.SESSION["body"],
                "parties": [
                    {**party, "status": {"code": "Disconnected"}}
                    for party in self.SESSION["body"]["parties"]
                ],
            },
        }
        calls = RingCentralAdapter().parse(ended, {})
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].event, "completed")


class MediaTests(unittest.TestCase):
    def test_extension_sniffing(self):
        self.assertEqual(audio_extension(b"RIFF\x00\x00\x00\x00WAVEfmt ", "application/octet-stream", ""), ".wav")
        self.assertEqual(audio_extension(b"ID3\x04\x00", "application/octet-stream", ""), ".mp3")
        self.assertEqual(audio_extension(b"OggS\x00", "application/octet-stream", ""), ".ogg")

    def test_private_recording_hosts_are_blocked(self):
        with self.assertRaises(MediaFetchError):
            fetch_recording("http://127.0.0.1/recording.wav")
        with self.assertRaises(MediaFetchError):
            fetch_recording("file:///etc/passwd")


if __name__ == "__main__":
    unittest.main()
