# Proxmox VE Deployment Guide for Salvage Pulse AI

This directory contains the turnkey scripts for running **Salvage Pulse AI** as an
unprivileged **Proxmox VE LXC container**.

The installer is designed for a real production install:

- Debian 12 LXC (Debian 13 via `CT_TEMPLATE_PATTERN`), unprivileged, with
  `nesting=1,keyctl=1`
- Node.js 22 + Python 3 virtual environment
- The service runs as the unprivileged `salvage-pulse` user, not root
- `.env` is `0640` (`root:salvage-pulse`), data is `0700`, and the service has
  systemd sandboxing
- Demo data and one-click demo logins are **off** by default
- The container root password is chosen during deployment, or generated and
  printed once
- Three platform masters are prepopulated by default:
  `brettk@salvagepulsepro.com`, `benk@salvagepulsepro.com`, and
  `genk@salvagepulsepro.com`
- Per-account master passwords are generated once and written to
  `backend/data/initial_admin_password.txt` (mode `0600`) unless you supply one

---

## Requirements

- Proxmox VE 8.x or newer
- Root shell on the PVE node
- A storage pool that supports `rootdir` and another (or the same) pool that
  supports `vztmpl`
- At least **2 vCPU / 4 GB RAM / 16 GB disk** for a comfortable build. The
  frontend build is the memory peak; 2 GB may work but is tight.
- Network access from the container to Debian, NodeSource, PyPI, and npm

---

## Option 1: One-command LXC creation (recommended)

Run this in the **PVE node shell** (GUI: select the node → **Shell**, or SSH to
the host):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/KeechSalvage/Salvage-Pulse/main/proxmox/create-lxc.sh)"
```

The script prompts for:

| Setting | Default |
|---|---|
| Container ID | next free ID |
| Hostname | `salvage-pulse` |
| RAM | `4096` MB |
| vCPU cores | `2` |
| Disk | `16` GB |
| Rootfs storage | first `rootdir` storage |
| Bridge | `vmbr0` |
| Network | `dhcp` |
| Platform master emails | `brettk@`, `benk@`, and `genk@salvagepulsepro.com` |
| Container root password | prompt (blank = generate) |
| Public URL | blank (LAN-only HTTP) |
| Gemini API key | blank (heuristic fallback) |
| Primary master password | blank (unique passwords generated) |

It then:

1. Downloads the Debian 12 (or 13) standard LXC template if needed.
2. Creates an unprivileged container with `nesting=1,keyctl=1` and starts it.
3. Sets the container root password you chose (or a generated one).
4. Pushes the in-guest installer and a temporary config file into the container.
5. Installs system packages, Node.js 22, Python venv, and Python requirements.
6. Builds the React frontend and publishes it to `backend/static`.
7. Creates the `salvage-pulse` service user and hardened systemd unit.
8. Starts the service and waits for `/api/health`.
9. Prints the container IP, root password, master logins, initial credentials,
   and next steps.

The temporary config file is deleted from the container after installation.

### Non-interactive install

Every prompt can be supplied as an environment variable or flag:

```bash
CT_ID=120 \
CT_HOSTNAME=salvage-pulse \
CT_RAM=4096 CT_CORES=2 CT_DISK=16 \
CT_STORAGE=local-lvm CT_BRIDGE=vmbr0 CT_NET=dhcp \
CT_ROOT_PASSWORD='choose-a-strong-root-password' \
INITIAL_MASTER_EMAILS='brettk@salvagepulsepro.com,benk@salvagepulsepro.com,genk@salvagepulsepro.com' \
APP_URL=https://pulse.example.com \
GEMINI_API_KEY='your-key' \
bash proxmox/create-lxc.sh --yes
```

Useful extra variables: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
`SMTP_PASSWORD`, `SMTP_FROM`, `SMTP_FROM_NAME`, `GOOGLE_CLIENT_ID`,
`ALLOWED_HOSTS`, `APP_BIND_HOST`, `SEED_DEMO_DATA`, `DEMO_LOGIN_ENABLED`,
`COOKIE_SECURE`, `TRUST_PROXY_HEADERS`, `NODE_MAJOR`, `INITIAL_MASTER_NAMES`.

If `CT_ROOT_PASSWORD` is blank, the installer generates a 32-character root
password and prints it in the summary. If `INITIAL_MASTER_PASSWORD` is blank,
each master receives a unique generated password.

If you run the script from a local checkout, it uses the adjacent
`proxmox/build-lxc.sh` instead of downloading it. That is useful for testing
unreleased changes:

```bash
sudo bash proxmox/create-lxc.sh
```

---

## Option 2: Install inside an existing Debian/Ubuntu LXC

If you already have a blank Debian 12/13 or Ubuntu 22.04/24.04 container:

```bash
pct enter <CTID>
bash -c "$(curl -fsSL https://raw.githubusercontent.com/KeechSalvage/Salvage-Pulse/main/proxmox/build-lxc.sh)"
```

Or from the PVE host:

```bash
pct exec <CTID> -- bash -c "$(curl -fsSL https://raw.githubusercontent.com/KeechSalvage/Salvage-Pulse/main/proxmox/build-lxc.sh)"
```

The installer is idempotent. Re-running it keeps an existing `.env` and data,
rebuilds the frontend, refreshes the systemd unit, and restarts the service.

---

## First login

- **URL:** `http://<CONTAINER_IP>:8000`
- **Container root password:** the value you entered at the prompt, or the
  generated value printed by the installer. Use it with `pct console <CTID>` or
  SSH if you enable it.
- **Master emails:** `INITIAL_MASTER_EMAILS` (default:
  `brettk@salvagepulsepro.com`, `benk@salvagepulsepro.com`, and
  `genk@salvagepulsepro.com`).
- **Master passwords:** `INITIAL_MASTER_PASSWORD` applies to the first master
  only. Read the generated per-account credentials with:

```bash
pct exec <CTID> -- cat /opt/salvage-pulse/backend/data/initial_admin_password.txt
```

Every new master must change its password on first login. After saving the
credentials, delete the file:

```bash
pct exec <CTID> -- rm -f /opt/salvage-pulse/backend/data/initial_admin_password.txt
```

Platform console: `http://<CONTAINER_IP>:8000/admin`

---

## Configuration (`.env`)

The live configuration is `/opt/salvage-pulse/.env` (mode `0640`,
`root:salvage-pulse`).
The service reads it through systemd's `EnvironmentFile`, so the app itself does
not need read access to the file.

```bash
pct exec <CTID> -- nano /opt/salvage-pulse/.env
pct exec <CTID> -- systemctl restart salvage-pulse
```

Important settings:

```dotenv
ENVIRONMENT=production
PORT=8000
APP_BIND_HOST=0.0.0.0
DATA_DIR=/opt/salvage-pulse/backend/data
APP_URL=https://pulse.example.com
COOKIE_SECURE=1
TRUST_PROXY_HEADERS=1
ALLOWED_HOSTS=pulse.example.com

SEED_DEMO_DATA=0
DEMO_LOGIN_ENABLED=0

INITIAL_MASTER_EMAILS=brettk@salvagepulsepro.com,benk@salvagepulsepro.com,genk@salvagepulsepro.com
INITIAL_MASTER_NAMES=Brett K,Ben K,Gen K
INITIAL_MASTER_PASSWORD=
```

`INITIAL_MASTER_EMAILS` is authoritative. `INITIAL_MASTER_EMAIL` remains
supported for a custom single-master install. `INITIAL_MASTER_PASSWORD` applies
only to the first configured master; the others receive unique generated
passwords. Configured masters are added to an existing state once, and a master
deleted later is not recreated on restart. Changing the password variable later
does not change an existing password.

On an existing install the updater adds `INITIAL_MASTER_EMAILS` to `.env` if it
is missing. A custom legacy `INITIAL_MASTER_EMAIL` is preserved as a
single-master list; the default `brettk@`-only configuration adopts all three
platform masters.

### Gemini AI scoring

1. Get a key at [Google AI Studio](https://aistudio.google.com/).
2. Add it to `.env`:

```dotenv
GEMINI_API_KEY=AIzaSy...
GEMINI_MODEL=gemini-2.5-flash
```

3. Restart: `systemctl restart salvage-pulse`.

Without a key the app falls back to rule-based scoring.

### Google sign-in and email

```dotenv
GOOGLE_CLIENT_ID=...apps.googleusercontent.com

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASSWORD=your-app-password
SMTP_FROM=you@gmail.com
SMTP_FROM_NAME=Salvage Pulse
SUPPORT_EMAIL=support@salvagepulsepro.com
```

Google sign-in stays disabled when `GOOGLE_CLIENT_ID` is blank. For Gmail, use
an **App Password**, not your normal account password.

In Google Cloud Console the OAuth client must be a **Web application**. Add
every URL users open the app from under **Authorized JavaScript origins** (for
example `https://app.salvagepulsepro.com` and `http://localhost:8000`). No
redirect URI is needed for the Google Identity Services token flow.

Verify the running service picked up the client ID:

```bash
curl -sS http://127.0.0.1:8000/api/auth/google/config
# {"configured":true,"client_id":"...apps.googleusercontent.com","accounts":[]}
```

If it reports `configured:false`, `GOOGLE_CLIENT_ID` is blank in the
environment the service actually reads. Check `/opt/salvage-pulse/.env`, then
`systemctl restart salvage-pulse`. If the button opens Google but returns
`origin_mismatch`, add the exact scheme/host/port shown in the error to the
OAuth client's Authorized JavaScript origins.

Google Identity Services only runs on a secure origin: **HTTPS**, or
`http://localhost`. A plain-HTTP LAN address such as
`http://10.1.11.181:8000` cannot complete Google sign-in even when the client ID
is configured. Use the public HTTPS URL, or tunnel the app to localhost
(`ssh -L 8000:10.1.11.181:8000 root@pve-host` then open
`http://localhost:8000`). Email and password sign-in still works over plain
HTTP.

---

## HTTPS with Caddy (recommended before exposing publicly)

Point a DNS `A`/`AAAA` record at the container, forward ports 80 and 443, then
inside the container:

```bash
apt-get update
apt-get install -y caddy

cat >/etc/caddy/Caddyfile <<'EOF'
pulse.example.com {
    reverse_proxy 127.0.0.1:8000
    encode zstd gzip
}
EOF

systemctl enable --now caddy
systemctl reload caddy
```

Edit `/opt/salvage-pulse/.env`:

```dotenv
APP_URL=https://pulse.example.com
COOKIE_SECURE=1
TRUST_PROXY_HEADERS=1
ALLOWED_HOSTS=pulse.example.com
APP_BIND_HOST=127.0.0.1
```

Then restart the app:

```bash
systemctl restart salvage-pulse
```

Caddy obtains and renews the certificate automatically. Because the app now
binds only to `127.0.0.1`, port 8000 is no longer reachable from the LAN; use
the HTTPS URL. Restrict ports 80/443 at the Proxmox firewall as appropriate.

For a LAN-only self-signed certificate, use `tls internal` in the Caddy site
block instead of a public domain. Browsers will warn unless the CA is trusted.

> `TRUST_PROXY_HEADERS=1` is only safe when a reverse proxy **overwrites**
> `X-Forwarded-For` / `X-Forwarded-Proto`. Caddy does. Do not enable it when
> clients can reach uvicorn directly.

---

## Updating

Inside the container:

```bash
salvage-pulse-update
```

From the PVE host:

```bash
pct exec <CTID> -- salvage-pulse-update
```

The updater fetches `origin/main` (or the configured ref), rebuilds the
frontend, refreshes the unit, and restarts the service. It **refuses to run** if
there are local tracked changes in `/opt/salvage-pulse`; commit/stash them, or
force the update with:

```bash
SP_FORCE=1 salvage-pulse-update
```

The installer does not overwrite `.env`, `backend/data`, or uploads.

---

## Service management

Inside the container:

```bash
systemctl status salvage-pulse
systemctl restart salvage-pulse
journalctl -u salvage-pulse -f
systemctl stop salvage-pulse
```

Useful paths:

| Path | Purpose |
|---|---|
| `/opt/salvage-pulse` | Application checkout |
| `/opt/salvage-pulse/.env` | Secrets and runtime config (`0640`, `root:salvage-pulse`) |
| `/opt/salvage-pulse/backend/data` | State, SQLite DB, uploads, bootstrap password (`0700`) |
| `/etc/salvage-pulse.conf` | Installer settings (`0600`, no secrets) |
| `/etc/systemd/system/salvage-pulse.service` | Generated unit |

---

## Backups and data persistence

Back up the whole data directory:

```text
/opt/salvage-pulse/backend/data
```

It contains:

- `preview_state.json` — users, sessions, calls, CRM state
- `salvage_pulse.db` (plus WAL/SHM files) — SQLite database
- `uploads/` — uploaded audio
- `initial_admin_password.txt` — first-run credential (delete after use)

Also back up `/opt/salvage-pulse/.env` separately and securely, because it
contains API keys and SMTP credentials.

For Proxmox-level backups, use **Datacenter → Backup** with mode **Snapshot**.
LXC snapshots are fast and can be restored without rebuilding the app.

---

## Security notes

- The service runs as `salvage-pulse`, not root, with `NoNewPrivileges`,
  `ProtectSystem=full`, `ProtectHome`, an empty capability set, and a
  `0077` umask.
- `.env` is `0640` `root:salvage-pulse` (readable by the service, never
  world-readable); `backend/data` is `0700` owned by the service user.
- Demo seeding and demo logins are off by default. Do not enable them on a
  production instance.
- Set `APP_URL`, `COOKIE_SECURE=1`, `TRUST_PROXY_HEADERS=1`, and
  `ALLOWED_HOSTS` once HTTPS is in place.
- Restrict inbound ports with the Proxmox firewall. Only expose 80/443 when
  using a reverse proxy.
- Delete `initial_admin_password.txt` after the first login.
- Rotate `GEMINI_API_KEY` and `SMTP_PASSWORD` if they were ever committed,
  pasted into a chat, or included in an image.

---

## Troubleshooting

**The frontend build is killed / OOM**

Give the container more RAM (4 GB recommended) and rerun:

```bash
pct set <CTID> --memory 4096
pct exec <CTID> -- bash /opt/salvage-pulse/proxmox/build-lxc.sh
```

**The service is not healthy**

```bash
pct exec <CTID> -- journalctl -u salvage-pulse -n 100 --no-pager
pct exec <CTID> -- systemctl status salvage-pulse
```

**I cannot log in as master**

Check whether a bootstrap password was generated:

```bash
pct exec <CTID> -- ls -l /opt/salvage-pulse/backend/data/initial_admin_password.txt
pct exec <CTID> -- cat /opt/salvage-pulse/backend/data/initial_admin_password.txt
```

The bootstrap file is only created when at least one configured master still
needs an initial password. Reset a password explicitly as the service user (do
not run this as root, or the state file will become root-owned):

```bash
pct exec <CTID> -- su -s /bin/bash salvage-pulse -c \
  'cd /opt/salvage-pulse/backend && DATA_DIR=/opt/salvage-pulse/backend/data .venv/bin/python set_password.py brettk@salvagepulsepro.com'
```

**HTTPS certificate is not issued**

- Confirm DNS points at the container.
- Confirm ports 80 and 443 reach the container.
- Check `journalctl -u caddy -n 100 --no-pager`.
- Caddy needs a public domain for automatic ACME certificates; use
  `tls internal` for LAN-only.

**The app is reachable on port 8000 after adding Caddy**

Set `APP_BIND_HOST=127.0.0.1` in `.env` and restart, then block port 8000 at the
firewall.
