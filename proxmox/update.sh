#!/usr/bin/env bash
# ==============================================================================
# Salvage Pulse AI - update an existing LXC installation
#
# Usage (inside the container):
#   salvage-pulse-update
#
# Set SP_FORCE=1 to discard local tracked changes before updating.
# ==============================================================================
set -Eeuo pipefail

GREEN=$'\033[0;32m'
BLUE=$'\033[0;34m'
YELLOW=$'\033[1;33m'
RED=$'\033[0;31m'
NC=$'\033[0m'

log()  { printf '%b\n' "${BLUE}==>${NC} $*"; }
warn() { printf '%b\n' "${YELLOW}!${NC} $*" >&2; }
die()  { printf '%b\n' "${RED}✗${NC} $*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die "Run this update as root inside the container."

INSTALL_CONF="${INSTALL_CONF:-/etc/salvage-pulse.conf}"
if [[ -f "${INSTALL_CONF}" ]]; then
  # shellcheck disable=SC1090
  . "${INSTALL_CONF}"
fi

APP_DIR="${APP_DIR:-/opt/salvage-pulse}"
SP_REF="${SP_REF:-main}"

[[ -d "${APP_DIR}/.git" ]] || die "No git checkout found at ${APP_DIR}."
cd "${APP_DIR}"

# backend/static is a build output that is committed for Docker/offline use.
# The installer regenerates it, so ignore it when checking for local edits.
if [[ -n "$(git status --porcelain --untracked-files=no -- . ':(exclude)backend/static')" ]]; then
  if [[ "${SP_FORCE:-0}" != "1" ]]; then
    die "Local tracked changes exist in ${APP_DIR}. Commit/stash them, or rerun with SP_FORCE=1 to discard them."
  fi
  warn "Discarding local tracked changes (SP_FORCE=1)."
fi

log "Fetching origin/${SP_REF}..."
git fetch --prune origin "+refs/heads/${SP_REF}:refs/remotes/origin/${SP_REF}"
git checkout -q -B "${SP_REF}" "origin/${SP_REF}"
git reset --hard "origin/${SP_REF}"

log "Rebuilding and restarting..."
SP_UPDATE=1 exec bash "${APP_DIR}/proxmox/build-lxc.sh"
