#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Salvage Pulse AI - Proxmox VE LXC Creation & Installation Script
# Run directly in the Proxmox VE (PVE) Node Shell
# ==============================================================================

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

clear || true
cat << "EOF"
  ____        _                             ____        _          
 / ___|  __ _| |_   ____ _  __ _  ___     |  _ \ _   _| |___  ___ 
 \___ \ / _` | \ \ / / _` |/ _` |/ _ \    | |_) | | | | / __|/ _ \
  ___) | (_| | |\ V / (_| | (_| |  __/    |  __/| |_| | \__ \  __/
 |____/ \__,_|_| \_/ \__,_|\__, |\___|    |_|    \__,_|_|___/\___|
                           |___/                                  
 Proxmox VE LXC Automated Deployment
==============================================================================
EOF

# 1. Verify Proxmox VE environment
if ! command -v pveversion >/dev/null 2>&1; then
  echo -e "${RED}[ERROR] This script must be executed directly on a Proxmox VE host shell.${NC}"
  exit 1
fi

echo -e "${GREEN}✓ Verified Proxmox VE Host: $(pveversion)${NC}\n"

# 2. Container Configuration Parameters (Interactive with Smart Defaults)
DEFAULT_CTID=$(pvesh get /cluster/nextid 2>/dev/null || echo "110")
read -rp "Container ID [${DEFAULT_CTID}]: " CT_ID
CT_ID=${CT_ID:-$DEFAULT_CTID}

DEFAULT_HOSTNAME="salvage-pulse"
read -rp "Container Hostname [${DEFAULT_HOSTNAME}]: " HOSTNAME
HOSTNAME=${HOSTNAME:-$DEFAULT_HOSTNAME}

DEFAULT_RAM=2048
read -rp "Memory (RAM in MB) [${DEFAULT_RAM}]: " RAM
RAM=${RAM:-$DEFAULT_RAM}

DEFAULT_CORES=2
read -rp "CPU Cores [${DEFAULT_CORES}]: " CORES
CORES=${CORES:-$DEFAULT_CORES}

DEFAULT_DISK=10
read -rp "Disk Size (GB) [${DEFAULT_DISK}]: " DISK_SIZE
DISK_SIZE=${DISK_SIZE:-$DEFAULT_DISK}

# Detect Storage Pools
DETECTED_STORAGE=$(pvesm status -content rootdir 2>/dev/null | awk 'NR>1 {print $1}' | head -n 1)
DETECTED_STORAGE=${DETECTED_STORAGE:-"local-lvm"}
read -rp "Target Storage Pool for RootFS [${DETECTED_STORAGE}]: " STORAGE
STORAGE=${STORAGE:-$DETECTED_STORAGE}

TMPL_STORAGE=$(pvesm status -content vztmpl 2>/dev/null | awk 'NR>1 {print $1}' | head -n 1)
TMPL_STORAGE=${TMPL_STORAGE:-"local"}

DEFAULT_BRIDGE="vmbr0"
read -rp "Network Bridge [${DEFAULT_BRIDGE}]: " NET_BRIDGE
NET_BRIDGE=${NET_BRIDGE:-$DEFAULT_BRIDGE}

DEFAULT_NET="dhcp"
read -rp "IP Assignment (dhcp or e.g. 192.168.1.50/24,gw=192.168.1.1) [${DEFAULT_NET}]: " NET_IP
NET_IP=${NET_IP:-$DEFAULT_NET}
if [[ "$NET_IP" != "dhcp" && "$NET_IP" != *"ip="* ]]; then
  NET_CONFIG="ip=${NET_IP}"
else
  NET_CONFIG="ip=${NET_IP}"
fi

read -rp "Optional Google Gemini API Key (Enter to skip): " GEMINI_KEY
GEMINI_KEY=${GEMINI_KEY:-""}

echo -e "\n${CYAN}================ Configuration Summary ================${NC}"
echo -e " Container ID : ${BOLD}${CT_ID}${NC}"
echo -e " Hostname     : ${BOLD}${HOSTNAME}${NC}"
echo -e " RAM / Cores  : ${BOLD}${RAM} MB / ${CORES} vCPU${NC}"
echo -e " Disk / Pool  : ${BOLD}${DISK_SIZE} GB on ${STORAGE}${NC}"
echo -e " Network      : ${BOLD}${NET_BRIDGE} (${NET_CONFIG})${NC}"
echo -e "${CYAN}======================================================${NC}\n"

read -rp "Proceed with LXC creation? [Y/n] " CONFIRM
CONFIRM=${CONFIRM:-"y"}
if [[ "${CONFIRM,,}" != "y" ]]; then
  echo -e "${YELLOW}Aborted.${NC}"
  exit 0
fi

# 3. Locate or Download Debian 12 Template
echo -e "\n${YELLOW}--> Checking Debian 12 LXC template...${NC}"
TEMPLATE=$(pveam list "$TMPL_STORAGE" 2>/dev/null | awk '{print $1}' | grep -E "debian-12-standard.*tar\.zst" | head -n 1 || true)

if [ -z "$TEMPLATE" ]; then
  echo -e "${YELLOW}--> Updating Proxmox appliance template index...${NC}"
  pveam update >/dev/null 2>&1 || true
  AVAILABLE_TMPL=$(pveam available -section system 2>/dev/null | awk '{print $2}' | grep -E "debian-12-standard.*tar\.zst" | tail -n 1)
  if [ -z "$AVAILABLE_TMPL" ]; then
    echo -e "${RED}[ERROR] Could not find official Debian 12 standard template in appliance catalog.${NC}"
    exit 1
  fi
  echo -e "${YELLOW}--> Downloading ${AVAILABLE_TMPL} to storage ${TMPL_STORAGE}...${NC}"
  pveam download "$TMPL_STORAGE" "$AVAILABLE_TMPL"
  TEMPLATE="${TMPL_STORAGE}:vztmpl/${AVAILABLE_TMPL}"
fi

echo -e "${GREEN}✓ Using template: ${TEMPLATE}${NC}"

# 4. Create the LXC Container
echo -e "\n${YELLOW}--> Creating LXC Container ${CT_ID}...${NC}"
pct create "$CT_ID" "$TEMPLATE" \
  --ostype debian \
  --hostname "$HOSTNAME" \
  --cores "$CORES" \
  --memory "$RAM" \
  --swap 512 \
  --features nesting=1,keyctl=1 \
  --net0 "name=eth0,bridge=${NET_BRIDGE},firewall=1,${NET_CONFIG}" \
  --rootfs "${STORAGE}:${DISK_SIZE}" \
  --unprivileged 1 \
  --onboot 1

echo -e "${GREEN}✓ Container ${CT_ID} created.${NC}"

# 5. Start Container & Wait for Network
echo -e "${YELLOW}--> Starting Container ${CT_ID}...${NC}"
pct start "$CT_ID"

echo -e "${YELLOW}--> Waiting for container network to initialize...${NC}"
for i in {1..30}; do
  if pct exec "$CT_ID" -- ping -c 1 -W 2 1.1.1.1 >/dev/null 2>&1; then
    echo -e "${GREEN}✓ Container network is online.${NC}"
    break
  fi
  sleep 1
done

# 6. Execute Provisioning inside Container
echo -e "\n${YELLOW}--> Running Salvage Pulse installer inside container...${NC}"
INSTALLER_URL="https://raw.githubusercontent.com/Keechb/Salvage-Pulse/main/proxmox/build-lxc.sh"

pct exec "$CT_ID" -- env GEMINI_API_KEY="$GEMINI_KEY" bash -c "$(curl -fsSL "$INSTALLER_URL")"

# 7. Retrieve IP Address
CT_IP=$(pct exec "$CT_ID" -- hostname -I 2>/dev/null | awk '{print $1}' || echo "UNKNOWN")

# 8. Done!
echo -e "\n${GREEN}==============================================================================${NC}"
echo -e "${GREEN}🎉 SALVAGE PULSE LXC INSTALLATION COMPLETED!${NC}"
echo -e "${GREEN}==============================================================================${NC}"
echo -e " Application URL    : ${BOLD}http://${CT_IP}:8000${NC}"
echo -e " Master Admin Login : ${BOLD}brettk@salvagepulsepro.com${NC} (or 'brettk')"
echo -e " Platform Console   : ${BOLD}http://${CT_IP}:8000/admin${NC}"
echo -e " Container ID       : ${BOLD}${CT_ID}${NC}"
echo -e " Service Name       : ${BOLD}salvage-pulse.service${NC}"
echo -e " Configuration File : ${BOLD}/opt/salvage-pulse/.env${NC}"
echo -e ""
echo -e " Useful Commands (on Proxmox or inside CT):"
echo -e "   - Open container console : ${CYAN}pct enter ${CT_ID}${NC}"
echo -e "   - Check service status   : ${CYAN}pct exec ${CT_ID} -- systemctl status salvage-pulse${NC}"
echo -e "   - Update Salvage Pulse   : ${CYAN}pct exec ${CT_ID} -- salvage-pulse-update${NC}"
echo -e "==============================================================================\n"
