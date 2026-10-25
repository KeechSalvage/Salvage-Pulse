# Salvage Pulse AI — Auto Recycler Call Intelligence & CRM

Full-stack recreation of `recycler-call-scorer.preview.emergentagent.com` featuring:
- **Frontend**: React 19 + TypeScript + Vite + Tailwind v4 + `@base-ui/react` + `@dnd-kit` draggable dashboard
- **Backend**: FastAPI with 239 routes, full drill-down search, real audio playback generation, AI roleplay streaming, shift calendar, truck arrivals, multi-lot sites, and admin console
- **Data**: Pre-seeded with 979 calls, 459 customer accounts, 5 sales reps, vehicle demand models, keywords, and leaderboards

---

## 🚀 Docker Deployment (Recommended)

The app is packaged as a lightweight, self-contained multi-stage Docker container that builds the React frontend and serves both the SPA and FastAPI backend from a single port (`8000`).

### Quick Start with Docker Compose

```bash
docker compose up -d --build
```
Once started, visit: **[http://localhost:8000](http://localhost:8000)**

To stop the container:
```bash
docker compose down
```

### Standalone Docker Commands

1. **Build the image**:
   ```bash
   docker build -t salvage-pulse-ai .
   ```

2. **Run the container**:
   ```bash
   docker run -d -p 8000:8000 --name salvage-pulse-app salvage-pulse-ai
   ```

3. **Check status and logs**:
   ```bash
   docker ps
   docker logs -f salvage-pulse-app
   ```

4. **Stop the container**:
   ```bash
   docker stop salvage-pulse-app && docker rm salvage-pulse-app
   ```

---

## 💻 Local Development (Without Docker)

You can also run backend and frontend separately in development mode:

```bash
chmod +x start.sh
./start.sh
```

- **Frontend Dev Server**: `http://127.0.0.1:5173` (with Vite HMR and automatic `/api` proxy)
- **Backend API Server**: `http://127.0.0.1:8000`

---

## 🔑 Demo Accounts & One-Click Sign In

On the sign-in page at `/login`:
- **One-Tap Manager**: Click the **Manager** button to sign in as **Linda Carter** (`benkeech800+manager@gmail.com`)
- **One-Tap Sales Rep**: Click the **Sales Rep** button to sign in as **Tyler Grant** (`benkeech800+tyler@gmail.com`)

Or enter any of the following accounts with any password:
- **Master Admin**: `benkeech800@gmail.com` (Ben Keech, access to `/admin` Console)
- **Sales Manager**: `benkeech800+manager@gmail.com` (Linda Carter)
- **Sales Rep**: `benkeech800+tyler@gmail.com` (Tyler Grant)
- **Sales Rep**: `benkeech800+dana@gmail.com` (Dana Ortiz)
- **Sales Rep**: `benkeech800+jess@gmail.com` (Jess Moreno)
- **Sales Rep**: `benkeech800+marcus@gmail.com` (Marcus Bell)
