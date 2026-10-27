# Proxmox VE Deployment Guide for Salvage Pulse AI

This directory contains turnkey scripts and configuration to deploy **Salvage Pulse AI** on **Proxmox Virtual Environment (PVE)**.

---

## ⚡ Option 1: 1-Click Automated LXC Creation (Recommended)

Run this single command directly in your **Proxmox VE Node Shell** (via PVE Web GUI -> Select Node -> **Shell**, or via SSH to the PVE host):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Keechb/Salvage-Pulse/main/proxmox/create-lxc.sh)"
```

### What this script does automatically:
1. Detects your storage pools and queries the next available Container ID (e.g., `110`).
2. Prompts for resource allocation (defaults: **2 vCPUs**, **2048 MB RAM**, **10 GB Disk**, **DHCP**).
3. Downloads the official Debian 12 standard LXC template.
4. Creates and boots an unprivileged, nested LXC container (`nesting=1,keyctl=1`).
5. Installs Node.js 20 LTS, Python 3 virtual environment, and system dependencies.
6. Builds the production React 19 frontend bundle and configures the FastAPI backend.
7. Registers and starts the native systemd daemon (`salvage-pulse.service`).
8. Prints your container IP address and instant login link.

---

## 🛠️ Option 2: Install Inside an Existing Debian / Ubuntu LXC

If you already created a blank Debian 12 or Ubuntu 22.04/24.04 container:

1. Open the console or SSH into your container:
   ```bash
   pct enter <CTID>
   ```
2. Run the in-guest installation script:
   ```bash
   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Keechb/Salvage-Pulse/main/proxmox/build-lxc.sh)"
   ```

---

## 🔑 Default Credentials & Access

- **URL:** `http://<CONTAINER_IP>:8000`
- **Master Admin Email:** `brettk@salvagepulsepro.com` (or `brettk`)
- **Initial Password:** Any password on first startup (can be updated in `/settings`)
- **Platform Console:** `http://<CONTAINER_IP>:8000/admin`

---

## ⚙️ Configuration & Environment (`.env`)

The application configuration file is located at:
```text
/opt/salvage-pulse/.env
```

### Adding Google Gemini 2.5 Flash for Real AI Scoring:
To enable real AI call transcript evaluation, caller sentiment analysis, and roleplay grading:
1. Get a free API key at [Google AI Studio](https://aistudio.google.com/).
2. Edit `/opt/salvage-pulse/.env`:
   ```bash
   nano /opt/salvage-pulse/.env
   ```
3. Add your key:
   ```dotenv
   GEMINI_API_KEY=AIzaSy...
   GEMINI_MODEL=gemini-2.5-flash
   ```
4. Restart the service:
   ```bash
   systemctl restart salvage-pulse
   ```

*(Note: If no Gemini key is provided, Salvage Pulse seamlessly falls back to its built-in rule-based scoring engine.)*

---

## 🔄 Updating Salvage Pulse

Whenever you push new updates to the repository, you can update your LXC in one step:

```bash
# Inside the container:
salvage-pulse-update

# Or from the Proxmox host shell:
pct exec <CTID> -- salvage-pulse-update
```

This automatically pulls the latest git commits, updates Python packages, rebuilds the frontend distribution, and restarts the service.

---

## 📋 Service Management Commands

Inside the container:
- **Check Status:** `systemctl status salvage-pulse`
- **Restart Service:** `systemctl restart salvage-pulse`
- **View Live Logs:** `journalctl -u salvage-pulse -f`
- **Stop Service:** `systemctl stop salvage-pulse`

---

## 💾 Backups & Data Persistence

- Application data (calls, scenarios, custom passwords, uploaded audio) is persisted in:
  ```text
  /opt/salvage-pulse/backend/data
  /opt/salvage-pulse/backend/uploads
  ```
- **Proxmox Backups:** Use Proxmox VE's built-in **Backup** feature (**Datacenter > Backup**) with Mode: **Snapshot**. Because this is an LXC container, snapshots are instantaneous and zero-downtime.
