#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Salvage Pulse AI - LXC Container In-Guest Provisioning Script
# Designed for Debian 12 (Bookworm) / Ubuntu 22.04+ LXC Container
# ==============================================================================

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}======================================================${NC}"
echo -e "${BLUE}  Salvage Pulse AI - In-Guest LXC Provisioning        ${NC}"
echo -e "${BLUE}======================================================${NC}"

# Check root
if [ "$(id -u)" -ne 0 ]; then
  echo -e "${RED}[ERROR] This script must be run as root within the container.${NC}"
  exit 1
fi

APP_DIR="/opt/salvage-pulse"
REPO_URL="https://github.com/Keechb/Salvage-Pulse.git"

echo -e "${YELLOW}--> Updating system packages...${NC}"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  curl \
  wget \
  git \
  ca-certificates \
  build-essential \
  python3 \
  python3-pip \
  python3-venv \
  python3-dev

# Install Node.js 20 LTS if not present or < 20
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d'.' -f1 | tr -d 'v')" -lt 20 ]; then
  echo -e "${YELLOW}--> Installing Node.js 20 LTS from NodeSource...${NC}"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo -e "${GREEN}✓ Node.js version: $(node -v) | npm version: $(npm -v)${NC}"
echo -e "${GREEN}✓ Python version: $(python3 --version)${NC}"

# Clone or update repository
if [ ! -d "$APP_DIR/.git" ]; then
  echo -e "${YELLOW}--> Cloning Salvage Pulse repository to ${APP_DIR}...${NC}"
  mkdir -p "$APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
else
  echo -e "${YELLOW}--> Repository exists in ${APP_DIR}. Pulling latest changes...${NC}"
  cd "$APP_DIR"
  git pull origin main || true
fi

cd "$APP_DIR"

# Set up Python virtual environment
echo -e "${YELLOW}--> Setting up Python virtual environment...${NC}"
python3 -m venv "$APP_DIR/backend/.venv"
"$APP_DIR/backend/.venv/bin/pip" install --upgrade pip setuptools wheel
"$APP_DIR/backend/.venv/bin/pip" install -r "$APP_DIR/backend/requirements.txt"

# Build Frontend Assets
echo -e "${YELLOW}--> Building frontend production bundle (Vite + React 19)...${NC}"
cd "$APP_DIR/frontend"
npm install --legacy-peer-deps
npm run build

# Mirror built files to backend/static for production serving
mkdir -p "$APP_DIR/backend/static"
cp -a "$APP_DIR/frontend/dist/." "$APP_DIR/backend/static/"

# Ensure required directories exist
mkdir -p "$APP_DIR/backend/data"
mkdir -p "$APP_DIR/backend/uploads"

# Create /opt/salvage-pulse/.env if it doesn't exist
if [ ! -f "$APP_DIR/.env" ]; then
  echo -e "${YELLOW}--> Initializing /opt/salvage-pulse/.env configuration...${NC}"
  cat <<EOF > "$APP_DIR/.env"
# ============================================================
# Salvage Pulse AI - Environment Configuration
# ============================================================
PORT=8000
DATA_DIR=/opt/salvage-pulse/backend/data
INITIAL_MASTER_EMAIL=brettk@salvagepulsepro.com
INITIAL_MASTER_NAME="Brett K"

# Google Gemini API for Real AI Call Scoring & Roleplay
# Get your free key at: https://aistudio.google.com/
GEMINI_API_KEY=${GEMINI_API_KEY:-}
GEMINI_MODEL=${GEMINI_MODEL:-gemini-2.5-flash}

# Google OAuth 2.0 Client ID (Sign in with Google)
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID:-}

# Gmail SMTP Configuration
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=${SMTP_USER:-}
SMTP_PASSWORD=${SMTP_PASSWORD:-}
SMTP_FROM_NAME="Salvage Pulse"
SMTP_FROM=${SMTP_FROM:-}
EOF
fi

# Install systemd service
echo -e "${YELLOW}--> Installing systemd unit /etc/systemd/system/salvage-pulse.service...${NC}"
cp "$APP_DIR/proxmox/salvage-pulse.service" /etc/systemd/system/salvage-pulse.service
systemctl daemon-reload
systemctl enable salvage-pulse.service
systemctl restart salvage-pulse.service

# Create global update command shortcut
chmod +x "$APP_DIR/proxmox/update.sh"
ln -sf "$APP_DIR/proxmox/update.sh" /usr/local/bin/salvage-pulse-update

echo -e "${GREEN}======================================================${NC}"
echo -e "${GREEN}✓ Salvage Pulse AI is successfully installed!        ${NC}"
echo -e "${GREEN}✓ Service status: $(systemctl is-active salvage-pulse)${NC}"
echo -e "${GREEN}======================================================${NC}"
