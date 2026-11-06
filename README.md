# Salvage Pulse AI — Auto Recycler Call Intelligence & CRM

Full-stack application featuring:
- **Frontend**: React 19 + TypeScript + Vite + Tailwind v4 + `@base-ui/react` + `@dnd-kit` draggable dashboard
- **Backend**: FastAPI with full drill-down search, real audio playback generation, AI roleplay streaming, shift calendar, truck arrivals, multi-lot sites, and admin console
- **Architecture**: Self-contained single-container Docker deployment (SPA + API served from port `8000`)

---

## 🔐 First-run setup (important)

This app no longer accepts "any password" and does not ship default demo passwords.

1. Copy `.env.example` to `.env`. The default `INITIAL_MASTER_EMAILS` list creates three platform masters (`brettk@`, `benk@`, and `genk@salvagepulsepro.com`). Set `INITIAL_MASTER_PASSWORD` to give the first master a known password, or leave it blank and read the generated per-account passwords from `$DATA_DIR/initial_admin_password.txt` after first boot.
2. Set `APP_URL` to the public HTTPS URL and keep `COOKIE_SECURE=1` in production.
3. Rotate any Gemini API key or SMTP app password that was ever committed or shared.
4. Keep `SEED_DEMO_DATA=0` and `DEMO_LOGIN_ENABLED=0` unless you intentionally want a disposable demo instance.
5. Put the app behind HTTPS (Caddy, Nginx, Traefik, or Proxmox reverse proxy). Session cookies are `HttpOnly` and `SameSite=Lax`, and HSTS is enabled when `ENVIRONMENT=production`.

---

## 📞 Provider-agnostic call ingestion

The platform now has a **VoIP-agnostic ingest pipeline** instead of depending on
one phone vendor. Any PBX, VoIP provider, Zapier/Make flow or custom integration
can POST a finished call to one of two universal, per-yard token-authenticated
endpoints:

- `POST /api/ingest/webhook/{token}` — normalised JSON webhook (generic,
  Twilio, RingCentral, Telnyx and Vonage adapters built in; unknown provider
  names fall through to the forgiving generic adapter).
- `POST /api/ingest/audio/{token}` — multipart audio upload for systems that
  cannot expose a recording URL.

The pipeline de-duplicates by provider call id, safely downloads the recording,
transcribes it with Gemini / Deepgram / AssemblyAI / OpenAI (or accepts a
transcript in the payload), then hands it to the existing yard scoring engine.
Configure it in **Settings → Phone connectors**. See
[`docs/CALL_INGESTION.md`](docs/CALL_INGESTION.md) for payload examples,
provider setup, security and how to add a new adapter.

## 🚀 Docker Deployment

The app is packaged as a lightweight, self-contained multi-stage Docker container that builds the React frontend and serves both the SPA and FastAPI backend from a single port (`8000`).

### Method 1: Local Docker Compose (Cloned Repository)

Clone the repository and run:

```bash
cp .env.example .env
# edit .env: INITIAL_MASTER_EMAILS, INITIAL_MASTER_PASSWORD, APP_URL, SMTP_*, GEMINI_API_KEY
docker compose up -d --build
```

Once started, open your browser to: **[http://localhost:8000](http://localhost:8000)** (or `http://YOUR_SERVER_IP:8000`).

- Sign in with the master email and the password you configured.
- Access the **Platform Console** at `/admin` to add yards, configure plans, and manage users.

To stop the container:
```bash
docker compose down
```

The container runs as an unprivileged user and persists state in the `app-data` volume.

---

### Method 3: Proxmox VE (LXC Container 1-Click)

Run this command directly in your **Proxmox VE Node Shell**:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/KeechSalvage/Salvage-Pulse/main/proxmox/create-lxc.sh)"
```

This creates an unprivileged Debian 12 LXC container (defaults: 4 GB RAM, 2 vCPU, 16 GB disk), installs the app as the unprivileged `salvage-pulse` user, hardens the systemd unit, disables demo data, and starts `salvage-pulse.service`. During deployment you choose the container root password (or let the installer generate one), and the installer prepopulates the platform masters from `INITIAL_MASTER_EMAILS` (default: `brettk@`, `benk@`, and `genk@salvagepulsepro.com`). It prints the container URL and one-time credentials for each master. Updates run with `salvage-pulse-update`. See [`proxmox/README.md`](proxmox/README.md) for all options, HTTPS setup, and troubleshooting.

---

If you are using **ZimaOS** or **CasaOS** at home:

1. **Option A (Terminal / SSH into ZimaOS)**:
   ```bash
   git clone https://github.com/KeechSalvage/Salvage-Pulse.git
   cd Salvage-Pulse
   cp .env.example .env
   docker compose up -d --build
   ```

2. **Option B (ZimaOS Web GUI "Install Custom App")**:
   - In ZimaOS App Store, click **Install Custom App** -> **Import**.
   - Copy and paste the contents of `docker-compose.zimaos.yml`.
   - Click **Install**.

---

## 🔑 Initial Platform Masters

- **Master Emails**: configured by `INITIAL_MASTER_EMAILS` (comma-separated). Defaults to `brettk@salvagepulsepro.com`, `benk@salvagepulsepro.com`, and `genk@salvagepulsepro.com`. `INITIAL_MASTER_EMAIL` remains supported for a custom single-master install.
- **Role**: `master` (Platform Staff & Console Access)
- **Passwords**: `INITIAL_MASTER_PASSWORD` applies to the first configured master only. Other masters get unique random passwords. All generated credentials are written to `$DATA_DIR/initial_admin_password.txt`, and every new master must change its password at first sign-in.
- Configured masters are added to an existing installation once. A master deleted later through the Platform Console is not recreated on restart.

---

## 💻 Local Development (Without Docker)

You can run backend and frontend separately in development mode:

```bash
chmod +x start.sh
./start.sh
```

- **Frontend Dev Server**: `http://127.0.0.1:5173` (with Vite HMR and automatic `/api` proxy)
- **Backend API Server**: `http://127.0.0.1:8000`

---

## 🧪 Security regression tests

The backend ships with a self-contained security suite. It uses a temporary `DATA_DIR` and disables SMTP, so it never touches real yard data or sends mail:

```bash
cd backend
.venv/bin/python -m unittest discover -s tests -v
```

The tests cover unauthenticated admin access, Google token handling, demo-seeding defaults, master bootstrap, single-use reset tokens, forced password changes, cross-yard IDOR, role escalation, session-scoped impersonation, CSRF, security headers, upload/body limits, and SPA path traversal.
