#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Salvage Pulse AI - Fast Update Script
# Updates repository, Python dependencies, and rebuilds frontend.
# ==============================================================================

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}======================================================${NC}"
echo -e "${BLUE}  Updating Salvage Pulse AI                           ${NC}"
echo -e "${BLUE}======================================================${NC}"

if [ "$(id -u)" -ne 0 ]; then
  echo -e "${RED}[ERROR] This script must be run as root.${NC}"
  exit 1
fi

APP_DIR="/opt/salvage-pulse"

if [ ! -d "$APP_DIR" ]; then
  echo -e "${RED}[ERROR] Salvage Pulse not found at ${APP_DIR}.${NC}"
  exit 1
fi

cd "$APP_DIR"

echo -e "${YELLOW}--> Syncing with latest git commits...${NC}"
git fetch origin main
git reset --hard origin/main

echo -e "${YELLOW}--> Updating Python requirements...${NC}"
"$APP_DIR/backend/.venv/bin/pip" install -U -r "$APP_DIR/backend/requirements.txt"

echo -e "${YELLOW}--> Rebuilding Frontend distribution...${NC}"
cd "$APP_DIR/frontend"
npm install --legacy-peer-deps
npm run build
mkdir -p "$APP_DIR/backend/static"
cp -a "$APP_DIR/frontend/dist/." "$APP_DIR/backend/static/"

echo -e "${YELLOW}--> Restarting systemd service...${NC}"
systemctl restart salvage-pulse.service

echo -e "${GREEN}======================================================${NC}"
echo -e "${GREEN}✓ Update Complete! Salvage Pulse is running.          ${NC}"
echo -e "${GREEN}✓ Status: $(systemctl is-active salvage-pulse)        ${NC}"
echo -e "${GREEN}======================================================${NC}"
