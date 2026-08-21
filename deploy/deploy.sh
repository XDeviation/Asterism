#!/usr/bin/env bash
# Asterism deploy script — no Docker.
# Builds workspaces from a source checkout and restarts the systemd services.
#
# Usage:
#   ./deploy/deploy.sh            # deploy everything that is installed
#   ./deploy/deploy.sh app room   # only these targets
#   ./deploy/deploy.sh bot
#
# Targets:
#   app   -> /opt/asterism/current  + asterism-app.service
#   room  -> /opt/asterism/current  + asterism-room.service
#   bot   -> /opt/asterism-bot      + asterism-bot.service
#
# The app/room share one release directory because the web dist is served by
# the app process. Services are restarted only when their target was deployed.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_RELEASE_DIR="${ASTERISM_APP_RELEASE_DIR:-/opt/asterism/current}"
BOT_RELEASE_DIR="${ASTERISM_BOT_RELEASE_DIR:-/opt/asterism-bot}"

ALL_TARGETS=(app room bot)
requested=("$@")
if [ ${#requested[@]} -eq 0 ]; then
  requested=("${ALL_TARGETS[@]}")
fi

log() { printf '\n==> %s\n' "$*"; }

want() {
  local target
  for target in "${requested[@]}"; do
    [ "$target" = "$1" ] && return 0
  done
  return 1
}

service_installed() {
  systemctl list-unit-files "$1" 2>/dev/null | grep -q "$1"
}

service_restart_if_installed() {
  local unit="$1"
  if service_installed "$unit"; then
    log "Restarting $unit"
    sudo systemctl restart "$unit"
  else
    echo "!! $unit is not installed; skipping restart."
  fi
}

build() {
  log "Installing dependencies"
  (cd "$REPO_ROOT" && npm ci --no-audit --no-fund)

  log "Building all workspaces"
  (cd "$REPO_ROOT" && npm run build)

  log "Typecheck"
  (cd "$REPO_ROOT" && npm run typecheck)
}

deploy_app_room() {
  log "Deploying app/room/web to $APP_RELEASE_DIR"
  sudo mkdir -p "$APP_RELEASE_DIR"
  sudo rsync -a --delete \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude '*/node_modules' \
    --exclude 'deploy' \
    --exclude 'apps/*/src' \
    --exclude 'packages/*/src' \
    --exclude '*.test.ts' \
    "$REPO_ROOT"/ "$APP_RELEASE_DIR"/
  # Production dependencies for the runtime workspaces only.
  sudo sh -c "cd '$APP_RELEASE_DIR' && npm ci --omit=dev --no-audit --no-fund --workspace @asterism/shared --workspace @asterism/app --workspace @asterism/room >/dev/null"

  service_restart_if_installed asterism-app.service
  service_restart_if_installed asterism-room.service
}

deploy_bot() {
  log "Deploying bot to $BOT_RELEASE_DIR"
  sudo mkdir -p "$BOT_RELEASE_DIR"
  sudo rsync -a --delete \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude '*/node_modules' \
    --exclude 'deploy' \
    --exclude 'apps/*/src' \
    --exclude 'packages/*/src' \
    --exclude '*.test.ts' \
    "$REPO_ROOT"/ "$BOT_RELEASE_DIR"/
  sudo sh -c "cd '$BOT_RELEASE_DIR' && npm ci --omit=dev --no-audit --no-fund --workspace @asterism/shared --workspace @asterism/bot >/dev/null"

  service_restart_if_installed asterism-bot.service
}

for target in "${requested[@]}"; do
  case "$target" in
    app | room) ;;
    bot) ;;
    *)
      echo "Unknown target: $target (expected: ${ALL_TARGETS[*]})" >&2
      exit 2
      ;;
  esac
done

build

if want app || want room; then
  deploy_app_room
fi
if want bot; then
  deploy_bot
fi

log "Done."
