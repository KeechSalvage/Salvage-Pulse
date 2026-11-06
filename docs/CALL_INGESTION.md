# Provider-agnostic call ingestion

Salvage Pulse should not depend on one phone vendor. Instead of embedding a
RingCentral supervisor softphone or a Twilio-specific recorder, the platform
now exposes **one normalised ingest contract**. Any PBX, VoIP provider,
automation tool or custom integration can push calls into it.

```
provider webhook / audio upload
        │
        ▼
normalise (provider adapter)  ──►  de-dupe by provider + external call id
        │
        ▼
download recording (SSRF-safe)  ──►  speech-to-text (Gemini / Deepgram / AssemblyAI / OpenAI)
        │
        ▼
Salvage Pulse analyzer (yard rubric + custom weights)  ──►  call library
```

## Incoming-call screen pop

The dashboard listens for new ingest events and shows a caller card in the
browser. It does not depend on which provider sent the event.

- **Settings → Notifications** lets each user choose **Pop up immediately**,
  **Queue in corner** or **Off**, and includes a **Preview popup** button.
- Every open signed-in tab for that account polls
  `GET /api/call-popups/feed` every four seconds.
- The card shows the caller number, direction, matched customer and business
  type, which line was called, customer notes, and previous calls from any of
  the customer's numbers. Known customers link to their profile; completed
  calls link to the call detail page.
- If the provider sends a `call.started` event, the popup appears while the
  call is happening. Completed-call events still produce one popup.
- Reps only receive popups for calls credited to them or unassigned calls.
  Managers and owners see the whole yard.
- The feed remembers seen call ids in the browser session, so a start event and
  its later completion do not produce two popups.

## Two universal entry points

Both are token-authenticated. The token is generated per yard and can be
rotated from **Settings → Phone connectors → Call ingestion**. Rotating
immediately invalidates the old URL.

### 1. Webhook — `POST /api/ingest/webhook/{token}`

Optional provider path: `POST /api/ingest/webhook/{token}/{provider}` where
`provider` is `generic`, `twilio`, `ringcentral`, `telnyx` or `vonage`.
Unknown provider names fall through to the generic adapter, so `zoom`,
`dialpad`, `aircall`, `3cx`, etc. work without a new deployment.

Add `?wait=1` when testing if you want the HTTP response to include the final
scoring result. In production leave it off so providers get a fast 200/202.

Generic payload (all fields optional except an id and some content):

```json
{
  "call_id": "abc-123",
  "start_time": "2026-10-23T14:05:00Z",
  "direction": "inbound",
  "from": "+18605550123",
  "to": "+18605550199",
  "agent_email": "tyler@yourdomain.com",
  "agent_extension": "101",
  "caller_name": "Ridgeline Collision",
  "customer_phone": "+18605550123",
  "duration": 184,
  "status": "completed",
  "recording_url": "https://provider.example/recording.mp3",
  "transcript": "Rep: ...\nCustomer: ..."
}
```

Common aliases are accepted automatically (`callId`, `CallSid`, `session_id`,
`interaction_id`, `recordingUrl`, `audio_url`, `host_email`, `user_email`,
`date_and_time`, `Inbound/Outbound`, etc.). Payloads may be one object, a list,
or `{ "calls": [...] }` / `{ "data": [...] }`.

`transcript` is optional. When present, no speech-to-text key is needed and
the call is scored immediately. When absent, the adapter looks for
`recording_url` (or `RecordingUrl`, `recording`, `audio_url`, `media_url`).

Start / answer / end callbacks without audio are **not** turned into empty
calls. They are held and merged with the later recording callback for the same
external id.

### 2. Audio push — `POST /api/ingest/audio/{token}`

For systems that can upload a file but cannot expose a recording URL:

```bash
curl -X POST "https://your-app/api/ingest/audio/TOKEN" \
  -F "file=@call.mp3" \
  -F "external_id=call-123" \
  -F "agent_email=tyler@yourdomain.com" \
  -F "customer_name=Ridgeline Collision" \
  -F "direction=inbound"
```

The upload returns immediately with `queued`; poll the event log (or add
`?wait=1` when testing) to see the completed call. Webhooks also return
immediately by default; `?wait=1` is available for test harnesses.

The endpoint accepts the same metadata as the JSON payload, stores the
recording under the platform uploads directory, and runs the same AI pipeline.

## Provider notes

### Twilio

- Set the Voice **status callback URL** and/or **Recording status callback URL**
  to `.../api/ingest/webhook/{token}/twilio`.
- Status and recording callbacks are merged by `CallSid`.
- Twilio signs requests with `X-Twilio-Signature`. Put the Account Auth Token in
  **Provider authentication → Twilio Auth Token / signing secret**.
- Twilio's `RecordingUrl` requires Basic auth. Add the Account SID and Auth Token
  so the adapter can download it. The URL is automatically changed from the
  JSON metadata endpoint to `.mp3`.
- Twilio does not send an agent email. Send a custom parameter such as
  `agent_email=...` in your TwiML/status callback, or map the rep's phone number
  under Team, or set a default rep.

### RingCentral

- Create a webhook subscription for telephony sessions and point it at
  `.../api/ingest/webhook/{token}/ringcentral`.
- RingCentral's validation handshake (`Validation-Token`) is answered
  automatically; add the same token under **RingCentral verification token** if
  you configured one.
- RingCentral session events do not contain audio. Add a JWT app's Client ID,
  Client Secret and JWT under Provider authentication; the adapter then looks up
  the recording in the call log and downloads it with a bearer token.
- RingCentral often needs a few seconds after disconnect before the recording
  appears in the call log. The ingest worker retries the lookup automatically
  for about a minute instead of failing immediately.
- A telephony session contains both the caller and rep parties. The adapter
  emits **one** call per session, so you should no longer see duplicate waiting
  or call rows.
- The legacy call-log sync remains available at the bottom of the page for
  metadata and previously-recorded calls.

### Telnyx / Vonage

- Point the Call Control / Voice event webhook at the matching provider path.
- `call_control_id` / `call_id` is the de-duplication key.
- Add a shared signing secret if you want the extra header check.
- Telnyx recording downloads can use `TELNYX_API_KEY` (server env) or a
  per-provider bearer token in Settings.

### Everything else

Aircall, Dialpad, Zoom Phone, 8x8, Nextiva, 3CX, Zapier, Make and custom PBXs
can post the generic JSON payload. If a provider uses a unique nesting shape,
add a small adapter class in `backend/ingest/adapters.py` and register it in
`ADAPTERS`; signature verification, recording download, transcription,
de-duplication and retries are inherited automatically.

## AI transcription

One of these server-side environment variables is enough:

| Variable | Provider | Notes |
|---|---|---|
| `GEMINI_API_KEY` | Google Gemini | Default. Transcribes **and** scores in one call. |
| `DEEPGRAM_API_KEY` | Deepgram | Pre-recorded, diarised, `nova-3` by default. |
| `ASSEMBLYAI_API_KEY` | AssemblyAI | Pre-recorded, speaker labels. |
| `OPENAI_API_KEY` | OpenAI | `whisper-1` by default. |

`INGEST_STT_PROVIDER=auto|gemini|deepgram|assemblyai|openai` forces a provider;
`auto` picks the first configured one in that order. If the provider sends a
finished `transcript`, no key is used.

### “No transcription provider is configured”

That error means the **running process** cannot see any of the key variables.
The startup log and **Settings → Phone Connectors** now show which providers
were detected.

- **Proxmox / systemd:** edit `/opt/salvage-pulse/.env`, confirm the exact name
  `DEEPGRAM_API_KEY=...`, then `systemctl restart salvage-pulse`.
  `journalctl -u salvage-pulse -n 40 | grep -i transcription` should list
  `deepgram`.
- **Docker:** the container only receives variables listed in
  `docker-compose.yml`. Add `DEEPGRAM_API_KEY=${DEEPGRAM_API_KEY:-}` under
  `environment`, add the key to the host `.env`, then recreate with
  `docker compose up -d` (a plain `restart` keeps the old environment).
- **Local dev:** both `backend/.env` and the repo-root `.env` are now loaded,
  but the service must still be restarted after editing either file.
- Verify from inside the running environment:
  `printenv DEEPGRAM_API_KEY` (Docker) or
  `journalctl -u salvage-pulse -n 40 --no-pager` (Proxmox).

Secrets live in the server environment or in the per-yard settings store and
are never returned to the browser. The management API returns only
`signing_configured` / `media_auth_configured` booleans.

## Security

- Every URL contains a 24-byte random, per-yard token. Rotate it immediately if
  it leaks. A leaked token only exposes that yard's ingest endpoint, not the
  rest of the API.
- Optional provider authenticity:
  - Generic: HMAC-SHA256 of the raw body in `X-Call-Signature` (hex or `sha256=`).
  - Twilio: native `X-Twilio-Signature` HMAC-SHA1 verification.
  - RingCentral: `Verification-Token` header.
  - Others: shared secret in `X-Ingest-Secret`.
- Recording downloads: only http(s), no credentials in the URL, private /
  loopback / link-local / reserved IPs rejected at every redirect, max 3
  redirects, response size capped (`INGEST_MEDIA_MAX_MB`). Set
  `INGEST_ALLOW_PRIVATE_MEDIA_HOSTS=1` only for a trusted LAN PBX.
- Ingested calls inherit the existing platform tenant isolation. A webhook token
  for yard A can never write into yard B, even if the payload contains another
  yard's rep email.
- **Recording consent is still your responsibility.** Several states require
  all-party consent. Use an IVR recording disclosure, a rep script, and review
  retention with counsel before enabling production recording.

## Operational details

- Event log: the last 500 ingest attempts are shown on the Phone connectors
  page with status, provider, rep, linked call and failure reason. Failed jobs
  can be retried (the normalised job file is kept until the log rolls over).
- Job files live under `DATA_DIR/ingest_jobs/` and are `0600`; recordings live
  under `DATA_DIR/uploads/`.
- In-process worker: one daemon thread. For a large deployment, replace
  `backend/ingest/service.py::enqueue_job` with a queue (RQ/Celery/SQS); the
  provider adapters and `process_job` stay unchanged.
- `MAX_INGEST_MB` and `INGEST_MEDIA_MAX_MB` control upload/download size.
