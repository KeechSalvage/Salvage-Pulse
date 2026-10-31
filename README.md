# Salvage Pulse AI — Auto Recycler Call Intelligence & CRM

Full-stack application featuring:
- **Frontend**: React 19 + TypeScript + Vite + Tailwind v4 + `@base-ui/react` + `@dnd-kit` draggable dashboard
- **Backend**: FastAPI with full drill-down search, real audio playback generation, AI roleplay streaming, shift calendar, truck arrivals, multi-lot sites, and admin console
- **Architecture**: Self-contained single-container Docker deployment (SPA + API served from port `8000`)
- **Initial Master Admin**: `brettk@salvagepulsepro.com` (Brett K)

---

## 🚀 Docker Deployment

The app is packaged as a lightweight, self-contained multi-stage Docker container that builds the React frontend and serves both the SPA and FastAPI backend from a single port (`8000`).

### Method 1: Local Docker Compose (Cloned Repository)

Clone the repository and run:

```bash
docker compose up -d --build
```

Once started, open your browser to: **[http://localhost:8000](http://localhost:8000)** (or `http://YOUR_SERVER_IP:8000`).

- Sign in as Master: `brettk@salvagepulsepro.com` (any password in demo/dev mode)
- Access the **Platform Console** at `/admin` to add yards, configure plans, and manage users.

To stop the container:
```bash
docker compose down
```

---

### Method 3: Proxmox VE (LXC Container 1-Click)

Run this command directly in your **Proxmox VE Node Shell**:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/KeechSalvage/Salvage-Pulse/main/proxmox/create-lxc.sh)"
```

This provisions an ultra-lightweight (~100MB RAM) Debian 12 LXC container with automatic startup, systemd management (`salvage-pulse.service`), and one-command updates via `salvage-pulse-update`. See [`proxmox/README.md`](proxmox/README.md) for full options.

---

If you are using **ZimaOS** or **CasaOS** at home:

1. **Option A (Terminal / SSH into ZimaOS)**:
   ```bash
   git clone https://github.com/KeechSalvage/Salvage-Pulse.git
   cd Salvage-Pulse
   docker compose up -d --build
   ```

2. **Option B (ZimaOS Web GUI "Install Custom App")**:
   - In ZimaOS App Store, click **Install Custom App** -> **Import**.
   - Copy and paste the contents of `docker-compose.zimaos.yml`.
   - Click **Install**.

---

## 🔑 Initial Master Admin Account

- **Master Email**: `brettk@salvagepulsepro.com`
- **Name**: Brett K
- **Role**: `master` (Platform Staff & Console Access)
- **Password**: Any password on first startup (can be changed in `/settings`)
- **Direct Login**: You can enter `brettk@salvagepulsepro.com` or simply `brettk` / `master` in the email input.

---

## 💻 Local Development (Without Docker)

You can run backend and frontend separately in development mode:

```bash
chmod +x start.sh
./start.sh
```

- **Frontend Dev Server**: `http://127.0.0.1:5173` (with Vite HMR and automatic `/api` proxy)
- **Backend API Server**: `http://127.0.0.1:8000`
