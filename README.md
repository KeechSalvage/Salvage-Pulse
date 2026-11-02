# Salvage Pulse AI — Auto Recycler Call Intelligence & CRM

Full-stack application featuring:
- **Frontend**: React 19 + TypeScript + Vite + Tailwind v4 + `@base-ui/react` + `@dnd-kit` draggable dashboard
- **Backend**: FastAPI with full drill-down search, real audio playback generation, AI roleplay streaming, shift calendar, truck arrivals, multi-lot sites, and admin console
- **Architecture**: Self-contained single-container Docker deployment (SPA + API served from port `8000`)

---

## 🔐 First-run setup (important)

This app no longer accepts "any password" and does not ship default demo passwords.

1. Copy `.env.example` to `.env` and set a strong `INITIAL_MASTER_PASSWORD`, or leave it blank and read the generated password from `$DATA_DIR/initial_admin_password.txt` after first boot.
2. Set `APP_URL` to the public HTTPS URL and keep `COOKIE_SECURE=1` in production.
3. Rotate any Gemini API key or SMTP app password that was ever committed or shared.
4. Keep `SEED_DEMO_DATA=0` and `DEMO_LOGIN_ENABLED=0` unless you intentionally want a disposable demo instance.
5. Put the app behind HTTPS (Caddy, Nginx, Traefik, or Proxmox reverse proxy). Session cookies are `HttpOnly` and `SameSite=Lax`, and HSTS is enabled when `ENVIRONMENT=production`.

---

## 🚀 Docker Deployment

The app is packaged as a lightweight, self-contained multi-stage Docker container that builds the React frontend and serves both the SPA and FastAPI backend from a single port (`8000`).

### Method 1: Local Docker Compose (Cloned Repository)

Clone the repository and run:

```bash
cp .env.example .env
# edit .env: INITIAL_MASTER_PASSWORD, APP_URL, SMTP_*, GEMINI_API_KEY
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

This provisions an ultra-lightweight (~100MB RAM) Debian 12 LXC container with automatic startup, systemd management (`salvage-pulse.service`), and one-command updates via `salvage-pulse-update`. See [`proxmox/README.md`](proxmox/README.md) for full options.

The Proxmox service runs as the unprivileged `salvage-pulse` user. Put it behind an HTTPS reverse proxy before exposing it outside your LAN.

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

## 🔑 Initial Master Admin Account

- **Master Email**: configured by `INITIAL_MASTER_EMAIL` (default `brettk@salvagepulsepro.com`)
- **Role**: `master` (Platform Staff & Console Access)
- **Password**: `INITIAL_MASTER_PASSWORD` if set; otherwise a random password is generated at `$DATA_DIR/initial_admin_password.txt`
- The bootstrap password is only used when no master account exists. Existing accounts are never overwritten.

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
