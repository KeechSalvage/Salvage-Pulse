#!/usr/bin/env bash
# ==============================================================================
# Salvage Pulse AI - in-guest installer for a Debian / Ubuntu LXC container
#
# Run inside the container as root:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/KeechSalvage/Salvage-Pulse/main/proxmox/build-lxc.sh)"
#
# The installer is idempotent. It keeps an existing .env and existing data,
# rebuilds the frontend, refreshes the systemd unit, and restarts the service.
# Set SP_UPDATE=1 to skip system-package installation during an update.
# ==============================================================================
set -Eeuo pipefail

GREEN=$'\033[0;32m'
BLUE=$'\033[0;34m'
YELLOW=$'\033[1;33m'
RED=$'\033[0;31m'
BOLD=$'\033[1m'
NC=$'\033[0m'

log()  { printf '%b\n' "${BLUE}==>${NC} $*"; }
ok()   { printf '%b\n' "${GREEN}✓${NC} $*"; }
warn() { printf '%b\n' "${YELLOW}!${NC} $*" >&2; }
die()  { printf '%b\n' "${RED}✗${NC} $*" >&2; exit 1; }

trap 'rc=$?; if (( rc != 0 )); then printf "\n%b\n" "${RED}✗ Installation failed at line ${LINENO} (exit ${rc}).${NC}" >&2; fi; exit $rc' ERR
ENV_TMP=""
cleanup_tmp() { if [[ -n "${ENV_TMP}" && -f "${ENV_TMP}" ]]; then rm -f "${ENV_TMP}"; fi; }
trap cleanup_tmp EXIT

# ------------------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------------------
read_env_value() {
  local key="$1" file="$2" line val
  [[ -f "${file}" ]] || return 1
  line="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "${file}" | tail -n 1 || true)"
  [[ -n "${line}" ]] || return 1
  val="${line#*=}"
  val="${val#"${val%%[![:space:]]*}"}"
  val="${val%"${val##*[![:space:]]}"}"
  if [[ ${#val} -ge 2 && ( "${val}" == \"*\" || "${val}" == \'*\' ) ]]; then
    val="${val:1:${#val}-2}"
  fi
  printf '%s' "${val}"
}

env_line() {
  local key="$1" val="${2-}"
  [[ "${val}" != *$'\n'* && "${val}" != *$'\r'* ]] || die "The value for ${key} may not contain a newline."
  [[ "${val}" != *"'"* ]] || die "The value for ${key} may not contain a single quote."
  printf "%s='%s'\n" "${key}" "${val}"
}

# ------------------------------------------------------------------------------
# Configuration (environment variables override the saved install config)
# ------------------------------------------------------------------------------
INSTALL_CONF="${INSTALL_CONF:-/etc/salvage-pulse.conf}"
SP_UPDATE="${SP_UPDATE:-0}"

if [[ "${SP_UPDATE}" == "1" && -f "${INSTALL_CONF}" ]]; then
  # shellcheck disable=SC1090
  . "${INSTALL_CONF}"
fi

APP_DIR="${APP_DIR:-/opt/salvage-pulse}"
APP_USER="${APP_USER:-salvage-pulse}"
APP_PORT="${APP_PORT:-}"
APP_BIND_HOST="${APP_BIND_HOST:-}"
DATA_DIR="${DATA_DIR:-}"
SP_REPO_URL="${SP_REPO_URL:-https://github.com/KeechSalvage/Salvage-Pulse.git}"
SP_REF="${SP_REF:-main}"
NODE_MAJOR="${NODE_MAJOR:-22}"
SP_SKIP_SYSTEM="${SP_SKIP_SYSTEM:-${SP_UPDATE}}"
ENV_FILE="${APP_DIR}/.env"

# An existing .env is authoritative for runtime paths and ports. This prevents a
# rerun with different shell variables from silently moving the data directory.
if [[ -f "${ENV_FILE}" ]]; then
  env_value="$(read_env_value PORT "${ENV_FILE}" 2>/dev/null || true)"
  APP_PORT="${env_value:-8000}"
  env_value="$(read_env_value APP_BIND_HOST "${ENV_FILE}" 2>/dev/null || true)"
  APP_BIND_HOST="${env_value:-0.0.0.0}"
  env_value="$(read_env_value DATA_DIR "${ENV_FILE}" 2>/dev/null || true)"
  DATA_DIR="${env_value:-${APP_DIR}/backend/data}"
fi
APP_PORT="${APP_PORT:-8000}"
APP_BIND_HOST="${APP_BIND_HOST:-0.0.0.0}"
DATA_DIR="${DATA_DIR:-${APP_DIR}/backend/data}"

INITIAL_MASTER_EMAIL="${INITIAL_MASTER_EMAIL:-brettk@salvagepulsepro.com}"
INITIAL_MASTER_NAME="${INITIAL_MASTER_NAME:-Brett K}"
INITIAL_MASTER_PASSWORD="${INITIAL_MASTER_PASSWORD:-}"
APP_URL="${APP_URL:-}"
GEMINI_API_KEY="${GEMINI_API_KEY:-}"
GEMINI_MODEL="${GEMINI_MODEL:-gemini-2.5-flash}"
GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-}"
SUPPORT_EMAIL="${SUPPORT_EMAIL:-support@salvagepulsepro.com}"
SMTP_HOST="${SMTP_HOST:-smtp.gmail.com}"
SMTP_PORT="${SMTP_PORT:-587}"
SMTP_USER="${SMTP_USER:-}"
SMTP_PASSWORD="${SMTP_PASSWORD:-}"
SMTP_FROM_NAME="${SMTP_FROM_NAME:-Salvage Pulse}"
SMTP_FROM="${SMTP_FROM:-}"
SEED_DEMO_DATA="${SEED_DEMO_DATA:-0}"
DEMO_LOGIN_ENABLED="${DEMO_LOGIN_ENABLED:-0}"
MAX_UPLOAD_MB="${MAX_UPLOAD_MB:-25}"
AUTH_RATE_LIMIT="${AUTH_RATE_LIMIT:-10}"
AUTH_RATE_WINDOW_SECONDS="${AUTH_RATE_WINDOW_SECONDS:-300}"
SIGNUP_RATE_LIMIT="${SIGNUP_RATE_LIMIT:-5}"
SIGNUP_RATE_WINDOW_SECONDS="${SIGNUP_RATE_WINDOW_SECONDS:-3600}"
ALLOWED_HOSTS="${ALLOWED_HOSTS:-}"
COOKIE_SECURE="${COOKIE_SECURE:-}"
TRUST_PROXY_HEADERS="${TRUST_PROXY_HEADERS:-}"

# ------------------------------------------------------------------------------
# Preflight
# ------------------------------------------------------------------------------
[[ "$(id -u)" -eq 0 ]] || die "Run this installer as root inside the container."

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in
    debian|ubuntu) ;;
    *) warn "This installer is tested on Debian/Ubuntu; ${ID:-this OS} may need manual package names." ;;
  esac
fi

[[ "${APP_DIR}" == /* && "${DATA_DIR}" == /* ]] || die "APP_DIR and DATA_DIR must be absolute paths."
[[ "${APP_DIR}" != *" "* && "${DATA_DIR}" != *" "* ]] || die "APP_DIR and DATA_DIR may not contain spaces."
[[ "${APP_DIR}" != *"'"* && "${DATA_DIR}" != *"'"* ]] || die "APP_DIR and DATA_DIR may not contain single quotes."
[[ "${SP_REPO_URL}" != *"'"* && "${SP_REF}" != *"'"* ]] || die "SP_REPO_URL and SP_REF may not contain single quotes."
[[ "${APP_PORT}" =~ ^[0-9]+$ ]] || die "APP_PORT/PORT must be numeric."
(( APP_PORT >= 1 && APP_PORT <= 65535 )) || die "APP_PORT/PORT must be between 1 and 65535."
if (( APP_PORT < 1024 )); then
  die "Ports below 1024 need CAP_NET_BIND_SERVICE. Use port 8000 behind a reverse proxy instead."
fi

# Normalize paths and refuse system locations. The installer runs as root and
# chowns DATA_DIR recursively; a bad path here must not be able to damage the OS.
if command -v realpath >/dev/null 2>&1; then
  APP_DIR="$(realpath -m "${APP_DIR}")"
  DATA_DIR="$(realpath -m "${DATA_DIR}")"
fi
case "${APP_DIR}" in
  /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/media|/mnt|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var|/var/lib|/var/log|/var/cache|/var/tmp|/var/run|/usr/local|/usr/share|/usr/lib)
    die "Refusing to install the application directly into ${APP_DIR}." ;;
  /bin/*|/boot/*|/dev/*|/etc/*|/home/*|/lib/*|/lib64/*|/proc/*|/root/*|/run/*|/sbin/*|/sys/*|/tmp/*|/usr/*)
    die "Refusing to install the application under ${APP_DIR}." ;;
esac
case "${DATA_DIR}" in
  /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/media|/mnt|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var|/var/lib|/var/log|/var/cache|/var/tmp|/var/run|/usr/local|/usr/share|/usr/lib)
    die "Refusing to use ${DATA_DIR} as the data directory." ;;
  /bin/*|/boot/*|/dev/*|/etc/*|/home/*|/lib/*|/lib64/*|/proc/*|/root/*|/run/*|/sbin/*|/sys/*|/tmp/*|/usr/*)
    die "Refusing to use ${DATA_DIR} as the data directory." ;;
esac
if [[ "${DATA_DIR}" == "${APP_DIR}" ]]; then
  die "DATA_DIR must be a subdirectory of APP_DIR (for example ${APP_DIR}/backend/data), not APP_DIR itself."
fi
case "${APP_DIR}/" in
  "${DATA_DIR}"/*) die "DATA_DIR may not be a parent of APP_DIR." ;;
esac

if [[ "${SP_UPDATE}" == "1" && ! -d "${APP_DIR}/.git" ]]; then
  die "${APP_DIR} is not a git checkout. Run the installer without SP_UPDATE=1 first."
fi

# ------------------------------------------------------------------------------
# System packages
# ------------------------------------------------------------------------------
if [[ "${SP_SKIP_SYSTEM}" != "1" ]]; then
  log "Installing system packages..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    build-essential \
    python3 \
    python3-dev \
    python3-pip \
    python3-venv
else
  log "Skipping system package installation (update mode)."
fi

for cmd in curl git python3; do
  command -v "${cmd}" >/dev/null 2>&1 || die "Required command not found: ${cmd}"
done

NODE_MAJOR_FOUND=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR_FOUND="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  NODE_MAJOR_FOUND="${NODE_MAJOR_FOUND:-0}"
fi

if (( NODE_MAJOR_FOUND < 20 )); then
  [[ "${SP_SKIP_SYSTEM}" != "1" ]] || die "Node.js 20+ is required. Run the installer without SP_UPDATE=1 to install it."
  log "Installing Node.js ${NODE_MAJOR}.x from NodeSource..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi

command -v npm >/dev/null 2>&1 || die "npm was not installed with Node.js."
ok "Node.js $(node -v) | npm $(npm -v) | $(python3 --version)"

# ------------------------------------------------------------------------------
# Repository
# ------------------------------------------------------------------------------
if [[ ! -d "${APP_DIR}/.git" ]]; then
  if [[ -d "${APP_DIR}" ]] && find "${APP_DIR}" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
    die "${APP_DIR} exists but is not a git checkout. Move it aside and rerun."
  fi
  log "Cloning ${SP_REPO_URL} (${SP_REF}) into ${APP_DIR}..."
  install -d -m 755 "$(dirname "${APP_DIR}")"
  git clone --branch "${SP_REF}" --depth 1 "${SP_REPO_URL}" "${APP_DIR}"
else
  if [[ "${SP_UPDATE}" != "1" ]]; then
    if [[ -n "$(git -C "${APP_DIR}" status --porcelain --untracked-files=no -- . ':(exclude)backend/static')" ]]; then
      if [[ "${SP_FORCE:-0}" != "1" ]]; then
        die "Local tracked changes exist in ${APP_DIR}. Commit/stash them, or rerun with SP_FORCE=1."
      fi
      warn "Discarding local tracked changes (SP_FORCE=1)."
    fi
    log "Updating existing checkout to origin/${SP_REF}..."
    git -C "${APP_DIR}" fetch --prune origin "+refs/heads/${SP_REF}:refs/remotes/origin/${SP_REF}"
    git -C "${APP_DIR}" checkout -q -B "${SP_REF}" "origin/${SP_REF}"
    git -C "${APP_DIR}" reset --hard "origin/${SP_REF}"
  fi
fi

[[ -f "${APP_DIR}/backend/requirements.txt" ]] || die "backend/requirements.txt is missing from the checkout."
[[ -f "${APP_DIR}/frontend/package.json" ]] || die "frontend/package.json is missing from the checkout."

# ------------------------------------------------------------------------------
# Service account and data directories
# ------------------------------------------------------------------------------
umask 022
if ! getent group "${APP_USER}" >/dev/null 2>&1; then
  groupadd --system "${APP_USER}"
fi
if ! id "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --gid "${APP_USER}" --home-dir "${APP_DIR}" --shell /usr/sbin/nologin "${APP_USER}"
fi
APP_GROUP="$(id -gn "${APP_USER}")"

log "Preparing ${DATA_DIR}..."
install -d -m 755 "${APP_DIR}"
install -d -m 700 -o "${APP_USER}" -g "${APP_GROUP}" "${DATA_DIR}"
install -d -m 700 -o "${APP_USER}" -g "${APP_GROUP}" "${DATA_DIR}/uploads"
chown -R "${APP_USER}:${APP_GROUP}" "${DATA_DIR}"
chmod 700 "${DATA_DIR}" "${DATA_DIR}/uploads"

# Older installs wrote audio to backend/uploads. Copy (never delete) any files
# into the DATA_DIR/uploads location the application actually uses.
LEGACY_UPLOADS="${APP_DIR}/backend/uploads"
if [[ -d "${LEGACY_UPLOADS}" && "${LEGACY_UPLOADS}" != "${DATA_DIR}/uploads" ]]; then
  if find "${LEGACY_UPLOADS}" -mindepth 1 -print -quit | grep -q .; then
    log "Copying legacy uploads from ${LEGACY_UPLOADS} into ${DATA_DIR}/uploads..."
    cp -an "${LEGACY_UPLOADS}/." "${DATA_DIR}/uploads/" || warn "Some legacy uploads could not be copied."
    chown -R "${APP_USER}:${APP_GROUP}" "${DATA_DIR}/uploads"
  fi
fi

# ------------------------------------------------------------------------------
# Python environment
# ------------------------------------------------------------------------------
VENV="${APP_DIR}/backend/.venv"
if [[ ! -x "${VENV}/bin/python" ]]; then
  log "Creating Python virtual environment..."
  python3 -m venv "${VENV}"
fi
log "Installing Python requirements..."
"${VENV}/bin/pip" install --upgrade pip setuptools wheel
"${VENV}/bin/pip" install -r "${APP_DIR}/backend/requirements.txt"

# ------------------------------------------------------------------------------
# Frontend build
# ------------------------------------------------------------------------------
log "Building the frontend bundle..."
cd "${APP_DIR}/frontend"

MEM_MB="$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo 2>/dev/null || echo 2048)"
CGROUP_LIMIT=""
if [[ -r /sys/fs/cgroup/memory.max ]]; then
  CGROUP_LIMIT="$(cat /sys/fs/cgroup/memory.max 2>/dev/null || true)"
elif [[ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]]; then
  CGROUP_LIMIT="$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || true)"
fi
if [[ "${CGROUP_LIMIT}" =~ ^[0-9]+$ ]] && (( CGROUP_LIMIT > 0 && CGROUP_LIMIT < 9223372036854771712 )); then
  CGROUP_MB=$(( CGROUP_LIMIT / 1024 / 1024 ))
  if (( CGROUP_MB < MEM_MB )); then MEM_MB="${CGROUP_MB}"; fi
fi
NODE_HEAP=$(( MEM_MB * 60 / 100 ))
if (( NODE_HEAP < 512 )); then NODE_HEAP=512; fi
if (( NODE_HEAP > 2048 )); then NODE_HEAP=2048; fi
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=${NODE_HEAP}}"

if [[ -f package-lock.json ]]; then
  npm ci --legacy-peer-deps --no-audit --no-fund || npm install --legacy-peer-deps --no-audit --no-fund
else
  npm install --legacy-peer-deps --no-audit --no-fund
fi
npm run build

[[ -f "${APP_DIR}/frontend/dist/index.html" ]] || die "Frontend build did not produce dist/index.html."

STATIC_DIR="${APP_DIR}/backend/static"
log "Publishing frontend assets to ${STATIC_DIR}..."
rm -rf "${STATIC_DIR}.new" "${STATIC_DIR}.old"
cp -a "${APP_DIR}/frontend/dist" "${STATIC_DIR}.new"
if [[ -d "${STATIC_DIR}" ]]; then
  mv "${STATIC_DIR}" "${STATIC_DIR}.old"
fi
mv "${STATIC_DIR}.new" "${STATIC_DIR}"
rm -rf "${STATIC_DIR}.old"
chmod -R a+rX "${STATIC_DIR}"

# ------------------------------------------------------------------------------
# Environment file
# ------------------------------------------------------------------------------
APP_URL="${APP_URL%/}"
if [[ -z "${COOKIE_SECURE}" ]]; then
  if [[ "${APP_URL}" == https://* ]]; then COOKIE_SECURE=1; else COOKIE_SECURE=0; fi
fi
if [[ -z "${TRUST_PROXY_HEADERS}" ]]; then
  if [[ "${APP_URL}" == https://* || "${SP_BEHIND_PROXY:-0}" == "1" ]]; then
    TRUST_PROXY_HEADERS=1
  else
    TRUST_PROXY_HEADERS=0
  fi
fi
if [[ -n "${INITIAL_MASTER_PASSWORD}" && ${#INITIAL_MASTER_PASSWORD} -lt 8 ]]; then
  die "INITIAL_MASTER_PASSWORD must be at least 8 characters."
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  log "Writing ${ENV_FILE}..."
  ENV_TMP="$(mktemp "${APP_DIR}/.env.XXXXXX")"
  chmod 600 "${ENV_TMP}"
  {
    printf '# Salvage Pulse AI configuration\n'
    printf '# Generated by proxmox/build-lxc.sh on %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '# Keep this file private (chmod 600) and never commit it.\n\n'
    printf '# --- Runtime ---\n'
    env_line ENVIRONMENT production
    env_line PORT "${APP_PORT}"
    env_line APP_BIND_HOST "${APP_BIND_HOST}"
    env_line DATA_DIR "${DATA_DIR}"
    env_line APP_URL "${APP_URL}"
    if [[ -n "${ALLOWED_HOSTS}" ]]; then env_line ALLOWED_HOSTS "${ALLOWED_HOSTS}"; fi
    env_line COOKIE_SECURE "${COOKIE_SECURE}"
    env_line TRUST_PROXY_HEADERS "${TRUST_PROXY_HEADERS}"
    env_line SEED_DEMO_DATA "${SEED_DEMO_DATA}"
    env_line DEMO_LOGIN_ENABLED "${DEMO_LOGIN_ENABLED}"
    printf '\n# --- Initial master account ---\n'
    env_line INITIAL_MASTER_EMAIL "${INITIAL_MASTER_EMAIL}"
    env_line INITIAL_MASTER_NAME "${INITIAL_MASTER_NAME}"
    env_line INITIAL_MASTER_PASSWORD "${INITIAL_MASTER_PASSWORD}"
    printf '\n# --- Limits ---\n'
    env_line AUTH_RATE_LIMIT "${AUTH_RATE_LIMIT}"
    env_line AUTH_RATE_WINDOW_SECONDS "${AUTH_RATE_WINDOW_SECONDS}"
    env_line SIGNUP_RATE_LIMIT "${SIGNUP_RATE_LIMIT}"
    env_line SIGNUP_RATE_WINDOW_SECONDS "${SIGNUP_RATE_WINDOW_SECONDS}"
    env_line MAX_UPLOAD_MB "${MAX_UPLOAD_MB}"
    printf '\n# --- Google Gemini ---\n'
    env_line GEMINI_API_KEY "${GEMINI_API_KEY}"
    env_line GEMINI_MODEL "${GEMINI_MODEL}"
    env_line GOOGLE_CLIENT_ID "${GOOGLE_CLIENT_ID}"
    printf '\n# --- Outbound email ---\n'
    env_line SUPPORT_EMAIL "${SUPPORT_EMAIL}"
    env_line SMTP_HOST "${SMTP_HOST}"
    env_line SMTP_PORT "${SMTP_PORT}"
    env_line SMTP_USER "${SMTP_USER}"
    env_line SMTP_PASSWORD "${SMTP_PASSWORD}"
    env_line SMTP_FROM_NAME "${SMTP_FROM_NAME}"
    env_line SMTP_FROM "${SMTP_FROM}"
  } > "${ENV_TMP}"
  chown root:root "${ENV_TMP}"
  chmod 600 "${ENV_TMP}"
  mv -f "${ENV_TMP}" "${ENV_FILE}"
  ENV_TMP=""
else
  ok "Keeping existing ${ENV_FILE} (not overwriting your configuration)."
fi
chown root:root "${ENV_FILE}" 2>/dev/null || true
chmod 600 "${ENV_FILE}"

# ------------------------------------------------------------------------------
# systemd unit
# ------------------------------------------------------------------------------
UNIT_FILE="/etc/systemd/system/salvage-pulse.service"
log "Installing ${UNIT_FILE}..."
cat > "${UNIT_FILE}" <<EOF
[Unit]
Description=Salvage Pulse AI - Auto Recycler Call Intelligence & CRM
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_GROUP}
WorkingDirectory=${APP_DIR}/backend
Environment=PORT=8000
Environment=APP_BIND_HOST=0.0.0.0
EnvironmentFile=-${ENV_FILE}
Environment=PYTHONDONTWRITEBYTECODE=1
Environment=PYTHONUNBUFFERED=1
ExecStart=${VENV}/bin/uvicorn main:app --host \${APP_BIND_HOST} --port \${PORT}
Restart=always
RestartSec=5s
UMask=0077
LimitNOFILE=65536

# Sandboxing
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=full
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF
chmod 644 "${UNIT_FILE}"

# Save non-secret install settings so update.sh can reuse custom paths/ports.
cat > "${INSTALL_CONF}" <<EOF
APP_DIR='${APP_DIR}'
APP_USER='${APP_USER}'
APP_PORT='${APP_PORT}'
APP_BIND_HOST='${APP_BIND_HOST}'
DATA_DIR='${DATA_DIR}'
SP_REPO_URL='${SP_REPO_URL}'
SP_REF='${SP_REF}'
EOF
chmod 600 "${INSTALL_CONF}"

# ------------------------------------------------------------------------------
# Start and verify
# ------------------------------------------------------------------------------
log "Starting salvage-pulse.service..."
systemctl daemon-reload
systemctl enable salvage-pulse.service >/dev/null
systemctl restart salvage-pulse.service

HEALTH_HOST="${APP_BIND_HOST}"
if [[ "${HEALTH_HOST}" == "0.0.0.0" ]]; then HEALTH_HOST="127.0.0.1"; fi
if [[ "${HEALTH_HOST}" == "::" ]]; then HEALTH_HOST="[::1]"; fi
HEALTH_OK=0
for _ in $(seq 1 90); do
  if curl -fsS --max-time 2 "http://${HEALTH_HOST}:${APP_PORT}/api/health" >/dev/null 2>&1; then
    HEALTH_OK=1
    break
  fi
  if ! systemctl is-active --quiet salvage-pulse.service; then
    break
  fi
  sleep 2
done

if [[ "${HEALTH_OK}" != "1" ]]; then
  warn "The service did not become healthy. Recent logs:"
  journalctl -u salvage-pulse.service -n 80 --no-pager || true
  die "Installation finished, but the health check failed."
fi

# Health checks do not touch application state. Hit a public endpoint that
# loads it so the first-run master password is generated before we summarize.
log "Initializing application state..."
curl -fsS --max-time 30 "http://${HEALTH_HOST}:${APP_PORT}/api/billing/plans" >/dev/null 2>&1 \
  || warn "State initialization request failed; the password will be generated on first login."

# Install the update shortcut.
chmod +x "${APP_DIR}/proxmox/update.sh" 2>/dev/null || true
ln -sf "${APP_DIR}/proxmox/update.sh" /usr/local/bin/salvage-pulse-update

# Clean package caches to keep the LXC disk small.
"${VENV}/bin/pip" cache purge >/dev/null 2>&1 || true
npm cache clean --force >/dev/null 2>&1 || true

# ------------------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------------------
CT_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
CT_IP="${CT_IP:-<container-ip>}"
BOOTSTRAP_FILE="${DATA_DIR}/initial_admin_password.txt"

printf '\n%b\n' "${GREEN}==============================================================================${NC}"
printf '%b\n' "${GREEN}🎉 Salvage Pulse AI is installed and running.${NC}"
printf '%b\n' "${GREEN}==============================================================================${NC}"
printf '  URL              : %bhttp://%s:%s%b\n' "${BOLD}" "${CT_IP}" "${APP_PORT}" "${NC}"
if [[ -n "${APP_URL}" ]]; then
  printf '  Public URL       : %b%s%b\n' "${BOLD}" "${APP_URL}" "${NC}"
fi
printf '  Master login     : %b%s%b\n' "${BOLD}" "${INITIAL_MASTER_EMAIL}" "${NC}"
if [[ -n "${INITIAL_MASTER_PASSWORD}" ]]; then
  printf '  Master password  : the value you supplied as INITIAL_MASTER_PASSWORD\n'
elif [[ -f "${BOOTSTRAP_FILE}" ]]; then
  BOOTSTRAP_PW="$(sed -n 's/^Password:[[:space:]]*//p' "${BOOTSTRAP_FILE}" | head -n 1)"
  printf '  Master password  : %b%s%b (first login forces a change)\n' "${BOLD}" "${BOOTSTRAP_PW:-see ${BOOTSTRAP_FILE}}" "${NC}"
  printf '  Credential file  : %s\n' "${BOOTSTRAP_FILE}"
  printf '  Delete it after  : rm -f %s\n' "${BOOTSTRAP_FILE}"
else
  printf '  Master password  : unchanged (existing install)\n'
fi
printf '  Data directory   : %s\n' "${DATA_DIR}"
printf '  Config file      : %s (mode 600)\n' "${ENV_FILE}"
printf '  Service          : %s\n' "$(systemctl is-active salvage-pulse.service)"
printf '\n  Useful commands:\n'
printf '    systemctl status salvage-pulse\n'
printf '    journalctl -u salvage-pulse -f\n'
printf '    salvage-pulse-update\n'
printf '%b\n\n' "${GREEN}==============================================================================${NC}"
