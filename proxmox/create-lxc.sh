#!/usr/bin/env bash
# ==============================================================================
# Salvage Pulse AI - Proxmox VE LXC creation and installation
#
# Run on the Proxmox VE host as root:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/KeechSalvage/Salvage-Pulse/main/proxmox/create-lxc.sh)"
#
# Non-interactive example:
#   CT_ID=120 CT_RAM=4096 CT_DISK=16 CT_STORAGE=local-lvm \
#   CT_ROOT_PASSWORD='choose-a-strong-root-password' \
#   INITIAL_MASTER_EMAILS=you@example.com,ops@example.com \
#   bash proxmox/create-lxc.sh --yes
# ==============================================================================
set -Eeuo pipefail

GREEN=$'\033[0;32m'
BLUE=$'\033[0;34m'
YELLOW=$'\033[1;33m'
CYAN=$'\033[0;36m'
RED=$'\033[0;31m'
BOLD=$'\033[1m'
NC=$'\033[0m'

log()  { printf '%b\n' "${BLUE}==>${NC} $*"; }
ok()   { printf '%b\n' "${GREEN}✓${NC} $*"; }
warn() { printf '%b\n' "${YELLOW}!${NC} $*" >&2; }
die()  { printf '%b\n' "${RED}✗${NC} $*" >&2; exit 1; }

ENV_TMP=""
INSTALLER_TMP=""
ENV_PUSHED=0
cleanup() {
  if [[ -n "${ENV_TMP}" && -f "${ENV_TMP}" ]]; then rm -f "${ENV_TMP}"; fi
  if [[ -n "${INSTALLER_TMP}" && -f "${INSTALLER_TMP}" ]]; then rm -f "${INSTALLER_TMP}"; fi
  if [[ "${ENV_PUSHED}" == "1" && -n "${CT_ID:-}" ]]; then
    pct exec "${CT_ID}" -- rm -f /root/salvage-pulse-install.env >/dev/null 2>&1 || true
  fi
  return 0
}
trap cleanup EXIT
trap 'rc=$?; if (( rc != 0 )); then printf "\n%b\n" "${RED}✗ Failed at line ${LINENO} (exit ${rc}).${NC}" >&2; fi; exit $rc' ERR

usage() {
  cat <<'EOF'
Usage: create-lxc.sh [options]

Options:
  -y, --yes                 Non-interactive: accept defaults and env values
      --ctid ID             Container ID (default: next free ID)
      --hostname NAME       Container hostname (default: salvage-pulse)
      --ram MB              Memory in MB (default: 4096)
      --cores N             vCPU cores (default: 2)
      --disk GB             Root disk in GB (default: 16)
      --swap MB             Swap in MB (default: 512)
      --storage NAME        Rootfs storage (default: auto-detect)
      --bridge NAME         Network bridge (default: vmbr0)
      --net SPEC            dhcp, or 192.168.1.50/24,gw=192.168.1.1
      --email ADDRESS       Single platform master email (legacy)
      --masters EMAILS      Comma-separated platform master emails
      --root-password PW    Root password inside the container (blank = generate)
      --app-url URL         Public URL, e.g. https://pulse.example.com
      --ref REF             Git branch to install (default: main)
      --repo URL            Git repository URL
      --installer PATH      Use a specific in-guest build-lxc.sh
  -h, --help                Show this help

Environment variables are also accepted (CT_ID, CT_RAM, CT_DISK, CT_STORAGE,
CT_BRIDGE, CT_NET, CT_ROOT_PASSWORD, INITIAL_MASTER_EMAILS, APP_URL,
GEMINI_API_KEY, SMTP_*, GOOGLE_CLIENT_ID, ALLOWED_HOSTS, APP_BIND_HOST, ...).
EOF
}

# ------------------------------------------------------------------------------
# Arguments and defaults
# ------------------------------------------------------------------------------
ASSUME_YES="${ASSUME_YES:-0}"
CT_ID="${CT_ID:-}"
CT_HOSTNAME="${CT_HOSTNAME:-salvage-pulse}"
CT_RAM="${CT_RAM:-4096}"
CT_CORES="${CT_CORES:-2}"
CT_DISK="${CT_DISK:-16}"
CT_SWAP="${CT_SWAP:-512}"
CT_STORAGE="${CT_STORAGE:-}"
CT_BRIDGE="${CT_BRIDGE:-vmbr0}"
CT_NET="${CT_NET:-dhcp}"
CT_TEMPLATE_PATTERN="${CT_TEMPLATE_PATTERN:-debian-12-standard.*amd64.tar.zst}"
CT_ROOT_PASSWORD="${CT_ROOT_PASSWORD:-}"
SP_REF="${SP_REF:-main}"
SP_REPO_URL="${SP_REPO_URL:-https://github.com/KeechSalvage/Salvage-Pulse.git}"
DEFAULT_MASTER_EMAILS="brettk@salvagepulsepro.com,benk@salvagepulsepro.com,genk@salvagepulsepro.com"
INITIAL_MASTER_EMAILS="${INITIAL_MASTER_EMAILS:-}"
INITIAL_MASTER_NAMES="${INITIAL_MASTER_NAMES:-}"
INITIAL_MASTER_EMAIL="${INITIAL_MASTER_EMAIL:-}"
INITIAL_MASTER_NAME="${INITIAL_MASTER_NAME:-}"
INITIAL_MASTER_PASSWORD="${INITIAL_MASTER_PASSWORD:-}"
APP_URL="${APP_URL:-}"
APP_BIND_HOST="${APP_BIND_HOST:-0.0.0.0}"
GEMINI_API_KEY="${GEMINI_API_KEY:-}"
INSTALLER_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes) ASSUME_YES=1; shift ;;
    --ctid) CT_ID="${2:?--ctid requires a value}"; shift 2 ;;
    --hostname) CT_HOSTNAME="${2:?--hostname requires a value}"; shift 2 ;;
    --ram) CT_RAM="${2:?--ram requires a value}"; shift 2 ;;
    --cores) CT_CORES="${2:?--cores requires a value}"; shift 2 ;;
    --disk) CT_DISK="${2:?--disk requires a value}"; shift 2 ;;
    --swap) CT_SWAP="${2:?--swap requires a value}"; shift 2 ;;
    --storage) CT_STORAGE="${2:?--storage requires a value}"; shift 2 ;;
    --bridge) CT_BRIDGE="${2:?--bridge requires a value}"; shift 2 ;;
    --net) CT_NET="${2:?--net requires a value}"; shift 2 ;;
    --email) INITIAL_MASTER_EMAILS="${2:?--email requires a value}"; shift 2 ;;
    --masters) INITIAL_MASTER_EMAILS="${2:?--masters requires a value}"; shift 2 ;;
    --root-password) CT_ROOT_PASSWORD="${2:?--root-password requires a value}"; shift 2 ;;
    --app-url) APP_URL="${2:?--app-url requires a value}"; shift 2 ;;
    --ref) SP_REF="${2:?--ref requires a value}"; shift 2 ;;
    --repo) SP_REPO_URL="${2:?--repo requires a value}"; shift 2 ;;
    --installer) INSTALLER_OVERRIDE="${2:?--installer requires a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (use --help)" ;;
  esac
done

ask() {
  local var="$1" prompt="$2" default="$3" current answer
  current="${!var:-}"
  [[ -n "${current}" ]] && default="${current}"
  if [[ "${ASSUME_YES}" == "1" ]]; then
    printf -v "${var}" '%s' "${default}"
    return 0
  fi
  read -rp "${prompt} [${default}]: " answer || true
  printf -v "${var}" '%s' "${answer:-${default}}"
}

ask_secret() {
  local var="$1" prompt="$2" current answer
  current="${!var:-}"
  if [[ "${ASSUME_YES}" == "1" ]]; then
    printf -v "${var}" '%s' "${current}"
    return 0
  fi
  read -rsp "${prompt}${current:+ [keep current]}: " answer || true
  printf '\n'
  if [[ -n "${answer}" ]]; then
    printf -v "${var}" '%s' "${answer}"
  fi
}

# ------------------------------------------------------------------------------
# Preflight
# ------------------------------------------------------------------------------
[[ "$(id -u)" -eq 0 ]] || die "Run this script as root on the Proxmox VE host."
command -v pveversion >/dev/null 2>&1 || die "This script must run on a Proxmox VE host."
command -v pct >/dev/null 2>&1 || die "The 'pct' command is missing."
ok "Proxmox VE: $(pveversion)"

DEFAULT_CTID="$(pvesh get /cluster/nextid 2>/dev/null | tr -d '[:space:]' || true)"
DEFAULT_CTID="${DEFAULT_CTID:-110}"
ask CT_ID "Container ID" "${DEFAULT_CTID}"
ask CT_HOSTNAME "Container hostname" "salvage-pulse"
ask CT_RAM "Memory (MB)" "4096"
ask CT_CORES "CPU cores" "2"
ask CT_DISK "Disk size (GB)" "16"
ask CT_SWAP "Swap (MB)" "512"

if [[ -z "${CT_STORAGE}" ]]; then
  CT_STORAGE="$(pvesm status -content rootdir 2>/dev/null | awk 'NR>1 {print $1}' | head -n 1 || true)"
fi
ask CT_STORAGE "Rootfs storage" "${CT_STORAGE:-local-lvm}"
ask CT_BRIDGE "Network bridge" "vmbr0"
ask CT_NET "IP assignment (dhcp or 192.168.1.50/24,gw=192.168.1.1)" "dhcp"

if [[ -z "${INITIAL_MASTER_EMAILS}" ]]; then
  if [[ -n "${INITIAL_MASTER_EMAIL}" && "${INITIAL_MASTER_EMAIL}" != "brettk@salvagepulsepro.com" ]]; then
    INITIAL_MASTER_EMAILS="${INITIAL_MASTER_EMAIL}"
  else
    INITIAL_MASTER_EMAILS="${DEFAULT_MASTER_EMAILS}"
  fi
fi
ask INITIAL_MASTER_EMAILS "Platform master emails (comma-separated)" "${DEFAULT_MASTER_EMAILS}"
ask APP_URL "Public URL (blank for LAN-only HTTP)" ""
ask_secret GEMINI_API_KEY "Google Gemini API key (optional)"
ask_secret INITIAL_MASTER_PASSWORD "Primary master password (blank = auto-generate)"
ask_secret CT_ROOT_PASSWORD "Container root password (blank = auto-generate)"

[[ "${CT_ID}" =~ ^[0-9]+$ ]] || die "Container ID must be numeric."
if pct status "${CT_ID}" >/dev/null 2>&1; then
  die "Container ${CT_ID} already exists. Choose another ID or remove it first."
fi
[[ "${CT_RAM}" =~ ^[0-9]+$ ]] && (( CT_RAM >= 1024 )) || die "RAM must be at least 1024 MB."
[[ "${CT_CORES}" =~ ^[0-9]+$ ]] && (( CT_CORES >= 1 )) || die "CPU cores must be at least 1."
[[ "${CT_DISK}" =~ ^[0-9]+$ ]] && (( CT_DISK >= 8 )) || die "Disk must be at least 8 GB."
[[ "${CT_SWAP}" =~ ^[0-9]+$ ]] || die "Swap must be numeric."
master_emails_normalized=""
IFS=',' read -r -a _master_emails <<< "${INITIAL_MASTER_EMAILS}"
for _email in "${_master_emails[@]}"; do
  _email="${_email#"${_email%%[![:space:]]*}"}"
  _email="${_email%"${_email##*[![:space:]]}"}"
  [[ -n "${_email}" ]] || continue
  [[ "${_email}" == *@* ]] || die "Invalid platform master email: ${_email}"
  [[ "${_email}" != *"'"* ]] || die "Platform master emails may not contain single quotes."
  master_emails_normalized="${master_emails_normalized:+${master_emails_normalized},}${_email}"
done
[[ -n "${master_emails_normalized}" ]] || die "At least one platform master email is required."
INITIAL_MASTER_EMAILS="${master_emails_normalized}"
INITIAL_MASTER_EMAIL="${INITIAL_MASTER_EMAIL:-${INITIAL_MASTER_EMAILS%%,*}}"
unset _master_emails _email

if [[ -n "${INITIAL_MASTER_PASSWORD}" && ${#INITIAL_MASTER_PASSWORD} -lt 8 ]]; then
  die "Initial master password must be at least 8 characters."
fi

# Root password for the container. chpasswd splits on ':', so a colon (or a
# newline) cannot be represented safely in a password line.
if [[ -n "${CT_ROOT_PASSWORD}" ]]; then
  [[ "${CT_ROOT_PASSWORD}" != *$'\n'* && "${CT_ROOT_PASSWORD}" != *$'\r'* ]] || die "The container root password may not contain a newline."
  [[ "${CT_ROOT_PASSWORD}" != *":"* ]] || die "The container root password may not contain a colon."
  (( ${#CT_ROOT_PASSWORD} >= 8 )) || die "The container root password must be at least 8 characters."
else
  if command -v openssl >/dev/null 2>&1; then
    CT_ROOT_PASSWORD="$(openssl rand -hex 16)"
  else
    # od reads a fixed number of bytes, so pipefail cannot trip on SIGPIPE.
    CT_ROOT_PASSWORD="$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
  fi
fi
if [[ -n "${APP_URL}" ]]; then
  [[ "${APP_URL}" == http://* || "${APP_URL}" == https://* ]] || die "APP_URL must start with http:// or https://."
  APP_URL="${APP_URL%/}"
  if [[ "${APP_URL}" == https://* ]]; then
    warn "APP_URL is HTTPS: set up the reverse proxy before signing in, or leave APP_URL blank for initial HTTP LAN access."
  fi
fi

pvesm status -storage "${CT_STORAGE}" >/dev/null 2>&1 || die "Storage '${CT_STORAGE}' was not found."
ip link show "${CT_BRIDGE}" >/dev/null 2>&1 || die "Bridge '${CT_BRIDGE}' was not found."

TMPL_STORAGE="${TMPL_STORAGE:-$(pvesm status -content vztmpl 2>/dev/null | awk 'NR>1 {print $1}' | head -n 1 || true)}"
[[ -n "${TMPL_STORAGE}" ]] || die "No storage supports LXC templates (content type vztmpl)."
pvesm status -storage "${TMPL_STORAGE}" >/dev/null 2>&1 || die "Template storage '${TMPL_STORAGE}' was not found."

if [[ "${CT_NET}" == "dhcp" ]]; then
  NET_CONFIG="ip=dhcp"
else
  NET_CONFIG="${CT_NET}"
  [[ "${NET_CONFIG}" == ip=* ]] || NET_CONFIG="ip=${NET_CONFIG}"
fi

# ------------------------------------------------------------------------------
# Template
# ------------------------------------------------------------------------------
log "Looking for a Debian LXC template on ${TMPL_STORAGE}..."
TEMPLATE="$(pveam list "${TMPL_STORAGE}" 2>/dev/null | awk 'NR>1 {print $1}' | grep -E "${CT_TEMPLATE_PATTERN}" | sort -V | tail -n 1 || true)"

if [[ -z "${TEMPLATE}" ]]; then
  log "Refreshing the Proxmox appliance index..."
  pveam update >/dev/null 2>&1 || true
  AVAILABLE_TMPL="$(pveam available -section system 2>/dev/null | awk '{print $2}' | grep -E "${CT_TEMPLATE_PATTERN}" | sort -V | tail -n 1 || true)"
  [[ -n "${AVAILABLE_TMPL}" ]] || die "No matching Debian standard template is available."
  log "Downloading ${AVAILABLE_TMPL} to ${TMPL_STORAGE}..."
  pveam download "${TMPL_STORAGE}" "${AVAILABLE_TMPL}"
  TEMPLATE="${TMPL_STORAGE}:vztmpl/${AVAILABLE_TMPL}"
fi
ok "Template: ${TEMPLATE}"

# ------------------------------------------------------------------------------
# Summary and confirmation
# ------------------------------------------------------------------------------
printf '\n%b\n' "${CYAN}================ Configuration ================${NC}"
printf '  Container ID : %b%s%b\n' "${BOLD}" "${CT_ID}" "${NC}"
printf '  Hostname     : %b%s%b\n' "${BOLD}" "${CT_HOSTNAME}" "${NC}"
printf '  Resources    : %b%s MB RAM / %s vCPU / %s GB disk%b\n' "${BOLD}" "${CT_RAM}" "${CT_CORES}" "${CT_DISK}" "${NC}"
printf '  Storage      : %b%s%b\n' "${BOLD}" "${CT_STORAGE}" "${NC}"
printf '  Network      : %b%s (%s)%b\n' "${BOLD}" "${CT_BRIDGE}" "${NET_CONFIG}" "${NC}"
printf '  Masters      : %b%s%b\n' "${BOLD}" "${INITIAL_MASTER_EMAILS}" "${NC}"
printf '  Root password: %b%s%b\n' "${BOLD}" "${CT_ROOT_PASSWORD}" "${NC}"
printf '  Public URL   : %b%s%b\n' "${BOLD}" "${APP_URL:-LAN-only HTTP}" "${NC}"
printf '%b\n\n' "${CYAN}==============================================${NC}"

if [[ "${ASSUME_YES}" != "1" ]]; then
  read -rp "Create container ${CT_ID} and install Salvage Pulse? [Y/n] " CONFIRM || true
  CONFIRM="${CONFIRM:-y}"
  [[ "${CONFIRM}" =~ ^[Yy]$ ]] || { warn "Aborted."; exit 0; }
fi

# ------------------------------------------------------------------------------
# Create and start the container
# ------------------------------------------------------------------------------
log "Creating unprivileged container ${CT_ID}..."
pct create "${CT_ID}" "${TEMPLATE}" \
  --ostype debian \
  --hostname "${CT_HOSTNAME}" \
  --description "Salvage Pulse AI" \
  --cores "${CT_CORES}" \
  --memory "${CT_RAM}" \
  --swap "${CT_SWAP}" \
  --features nesting=1,keyctl=1 \
  --net0 "name=eth0,bridge=${CT_BRIDGE},firewall=1,${NET_CONFIG}" \
  --rootfs "${CT_STORAGE}:${CT_DISK}" \
  --unprivileged 1 \
  --onboot 1

log "Starting container ${CT_ID}..."
pct start "${CT_ID}"

READY=0
for _ in $(seq 1 60); do
  if pct exec "${CT_ID}" -- true >/dev/null 2>&1; then READY=1; break; fi
  sleep 1
done
[[ "${READY}" == "1" ]] || die "Container ${CT_ID} did not start. Check: pct status ${CT_ID}"

NET_OK=0
for _ in $(seq 1 60); do
  if pct exec "${CT_ID}" -- getent hosts deb.debian.org >/dev/null 2>&1; then NET_OK=1; break; fi
  sleep 2
done
if [[ "${NET_OK}" != "1" ]]; then
  warn "The container could not resolve deb.debian.org yet; installation may fail."
fi

log "Setting the container root password..."
if ! printf 'root:%s\n' "${CT_ROOT_PASSWORD}" | pct exec "${CT_ID}" -- chpasswd; then
  die "Could not set the root password inside container ${CT_ID}."
fi
ok "Container root password set."

# ------------------------------------------------------------------------------
# Push and run the in-guest installer
# ------------------------------------------------------------------------------
SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd || true)"
fi
if [[ -n "${INSTALLER_OVERRIDE}" ]]; then
  INSTALLER="${INSTALLER_OVERRIDE}"
elif [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/build-lxc.sh" ]]; then
  INSTALLER="${SCRIPT_DIR}/build-lxc.sh"
else
  INSTALLER_TMP="$(mktemp)"
  log "Downloading the in-guest installer (${SP_REF})..."
  curl -fsSL "https://raw.githubusercontent.com/KeechSalvage/Salvage-Pulse/${SP_REF}/proxmox/build-lxc.sh" -o "${INSTALLER_TMP}"
  INSTALLER="${INSTALLER_TMP}"
fi
[[ -s "${INSTALLER}" ]] || die "Installer script is empty or missing."

pct push "${CT_ID}" "${INSTALLER}" /root/salvage-pulse-build.sh --perms 700

APP_DIR="${APP_DIR:-/opt/salvage-pulse}"
DATA_DIR="${DATA_DIR:-${APP_DIR}/backend/data}"
APP_PORT="${APP_PORT:-${PORT:-8000}}"

ENV_TMP="$(mktemp)"
chmod 600 "${ENV_TMP}"

add_env() {
  local key="$1" val="${2-}"
  [[ "${val}" != *$'\n'* && "${val}" != *$'\r'* ]] || die "The value for ${key} may not contain a newline."
  [[ "${val}" != *"'"* ]] || die "The value for ${key} may not contain a single quote."
  printf "%s='%s'\n" "${key}" "${val}" >> "${ENV_TMP}"
}

add_env APP_DIR "${APP_DIR}"
add_env APP_USER "salvage-pulse"
add_env APP_PORT "${APP_PORT}"
add_env APP_BIND_HOST "${APP_BIND_HOST}"
add_env DATA_DIR "${DATA_DIR}"
add_env SP_REPO_URL "${SP_REPO_URL}"
add_env SP_REF "${SP_REF}"
add_env SP_UPDATE "0"
add_env INITIAL_MASTER_EMAILS "${INITIAL_MASTER_EMAILS}"
add_env INITIAL_MASTER_NAMES "${INITIAL_MASTER_NAMES}"
add_env INITIAL_MASTER_EMAIL "${INITIAL_MASTER_EMAIL:-${INITIAL_MASTER_EMAILS%%,*}}"
add_env INITIAL_MASTER_NAME "${INITIAL_MASTER_NAME}"
add_env INITIAL_MASTER_PASSWORD "${INITIAL_MASTER_PASSWORD}"
add_env APP_URL "${APP_URL}"
add_env GEMINI_API_KEY "${GEMINI_API_KEY}"

for key in \
  COOKIE_SECURE TRUST_PROXY_HEADERS ALLOWED_HOSTS SEED_DEMO_DATA DEMO_LOGIN_ENABLED \
  GEMINI_MODEL GOOGLE_CLIENT_ID SUPPORT_EMAIL SMTP_HOST SMTP_PORT SMTP_USER \
  SMTP_PASSWORD SMTP_FROM_NAME SMTP_FROM MAX_UPLOAD_MB AUTH_RATE_LIMIT \
  AUTH_RATE_WINDOW_SECONDS SIGNUP_RATE_LIMIT SIGNUP_RATE_WINDOW_SECONDS NODE_MAJOR \
  INGEST_STT_PROVIDER DEEPGRAM_API_KEY DEEPGRAM_MODEL ASSEMBLYAI_API_KEY \
  OPENAI_API_KEY OPENAI_STT_MODEL TELNYX_API_KEY MAX_INGEST_MB INGEST_MEDIA_MAX_MB; do
  if [[ -n "${!key:-}" ]]; then add_env "${key}" "${!key}"; fi
done

pct push "${CT_ID}" "${ENV_TMP}" /root/salvage-pulse-install.env --perms 600
ENV_PUSHED=1
rm -f "${ENV_TMP}"
ENV_TMP=""

log "Running the installer inside container ${CT_ID} (this can take several minutes)..."
if ! pct exec "${CT_ID}" -- bash -c 'set -a; . /root/salvage-pulse-install.env; set +a; bash /root/salvage-pulse-build.sh'; then
  pct exec "${CT_ID}" -- rm -f /root/salvage-pulse-install.env >/dev/null 2>&1 || true
  ENV_PUSHED=0
  die "Installation failed inside CT ${CT_ID}. Inspect: pct exec ${CT_ID} -- journalctl -u salvage-pulse -n 100 --no-pager"
fi
pct exec "${CT_ID}" -- rm -f /root/salvage-pulse-install.env >/dev/null 2>&1 || true
ENV_PUSHED=0

# ------------------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------------------
CT_IP="$(pct exec "${CT_ID}" -- hostname -I 2>/dev/null | awk '{print $1}' || true)"
CT_IP="${CT_IP:-<container-ip>}"

REMOTE_CFG="$(pct exec "${CT_ID}" -- bash -c '. /etc/salvage-pulse.conf 2>/dev/null || true; printf "%s|%s|%s" "${APP_DIR:-/opt/salvage-pulse}" "${DATA_DIR:-/opt/salvage-pulse/backend/data}" "${APP_PORT:-8000}"' 2>/dev/null || true)"
REMOTE_APP_DIR="${REMOTE_CFG%%|*}"
REMOTE_REST="${REMOTE_CFG#*|}"
REMOTE_DATA_DIR="${REMOTE_REST%%|*}"
REMOTE_PORT="${REMOTE_REST##*|}"
REMOTE_APP_DIR="${REMOTE_APP_DIR:-/opt/salvage-pulse}"
REMOTE_DATA_DIR="${REMOTE_DATA_DIR:-/opt/salvage-pulse/backend/data}"
REMOTE_PORT="${REMOTE_PORT:-8000}"

BOOTSTRAP_PATH="${REMOTE_DATA_DIR}/initial_admin_password.txt"
BOOTSTRAP_CREDS="$(pct exec "${CT_ID}" -- sed -n 's/^Email:[[:space:]]*/    /p; s/^Password:[[:space:]]*/      /p' "${BOOTSTRAP_PATH}" 2>/dev/null || true)"

printf '\n%b\n' "${GREEN}==============================================================================${NC}"
printf '%b\n' "${GREEN}🎉 SALVAGE PULSE LXC INSTALLATION COMPLETED${NC}"
printf '%b\n' "${GREEN}==============================================================================${NC}"
printf '  Application URL  : %bhttp://%s:%s%b\n' "${BOLD}" "${CT_IP}" "${REMOTE_PORT}" "${NC}"
if [[ -n "${APP_URL}" ]]; then
  printf '  Public URL       : %b%s%b\n' "${BOLD}" "${APP_URL}" "${NC}"
fi
printf '  Master logins    : %b%s%b\n' "${BOLD}" "${INITIAL_MASTER_EMAILS}" "${NC}"
if [[ -n "${INITIAL_MASTER_PASSWORD}" ]]; then
  printf '  Master password  : supplied (primary master only; others generated)\n'
fi
if [[ -n "${BOOTSTRAP_CREDS}" ]]; then
  printf '  Credentials      : (first login forces a password change)\n'
  printf '%s\n' "${BOOTSTRAP_CREDS}"
  printf '  Credential file  : %s\n' "${BOOTSTRAP_PATH}"
  printf '  Delete it after  : %bpct exec %s -- rm -f %s%b\n' "${CYAN}" "${CT_ID}" "${BOOTSTRAP_PATH}" "${NC}"
elif [[ -z "${INITIAL_MASTER_PASSWORD}" ]]; then
  printf '  Master password  : unchanged (existing state)\n'
fi
printf '  Root password    : %b%s%b\n' "${BOLD}" "${CT_ROOT_PASSWORD}" "${NC}"
printf '  Container ID     : %b%s%b\n' "${BOLD}" "${CT_ID}" "${NC}"
printf '  Service          : %bsalvage-pulse.service%b\n' "${BOLD}" "${NC}"
printf '  Config file      : %b%s/.env%b\n' "${BOLD}" "${REMOTE_APP_DIR}" "${NC}"
printf '\n  Next steps:\n'
printf '    - Open the URL and sign in as each master. Change the initial password when prompted.\n'
printf '    - Root shell: pct console %s (use the root password above).\n' "${CT_ID}"
printf '    - Put HTTPS in front before exposing this to the internet (see proxmox/README.md).\n'
printf '    - Restrict port %s at the Proxmox firewall if you add a reverse proxy.\n' "${REMOTE_PORT}"
printf '\n  Useful commands:\n'
printf '    pct enter %s\n' "${CT_ID}"
printf '    pct exec %s -- systemctl status salvage-pulse\n' "${CT_ID}"
printf '    pct exec %s -- journalctl -u salvage-pulse -f\n' "${CT_ID}"
printf '    pct exec %s -- salvage-pulse-update\n' "${CT_ID}"
printf '%b\n\n' "${GREEN}==============================================================================${NC}"
