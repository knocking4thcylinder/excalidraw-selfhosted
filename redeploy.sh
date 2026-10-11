#!/bin/bash
# One-shot redeploy of the forked app + shortcode service + caddy route.
set -euo pipefail
# tailscale lives in ~/.local/bin (login-shell PATH only); non-interactive
# ssh has a minimal PATH, so add it explicitly.
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
BASE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
APP_IMAGE=${DEPLOY_IMAGE_TAG:-excalidraw-selfhost}
cd "$BASE"
MODE=${1:-full}
case "$MODE" in full|app|backend) ;; *) echo 'Usage: ./redeploy.sh [full|app|backend] [--local]' >&2; exit 2 ;; esac
if [ "$#" -gt 0 ]; then shift; fi
LOCAL=false
if [ "${1:-}" = --local ]; then LOCAL=true; shift; fi
[ "$#" -eq 0 ] || { echo 'Usage: ./redeploy.sh [full|app|backend] [--local]' >&2; exit 2; }
BACKEND_IMAGE=${BACKEND_IMAGE:-excalidraw-api-elixir}
SCENE_SYNC_ENABLED=${SCENE_SYNC_ENABLED:-$(cat "$BASE/.scene-sync-enabled" 2>/dev/null || echo false)}
case "$SCENE_SYNC_ENABLED" in true|false) ;; *) echo 'SCENE_SYNC_ENABLED must be true or false.' >&2; exit 2 ;; esac
exec 9>"$BASE/.deploy.lock"
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 1; }
STARTED=$SECONDS
STAGE_STARTED=$SECONDS
STAGE_LABEL='update checkout'

stage() {
  printf 'TIMING: %s: %ss\n' "$STAGE_LABEL" "$((SECONDS - STAGE_STARTED))"
  printf '\n== %s ==\n' "$1"
  STAGE_STARTED=$SECONDS
  STAGE_LABEL=$1
}

echo "== $MODE deploy: update checkout =="
if "$LOCAL"; then
  echo 'Building local files; git pull skipped.'
elif git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git pull --ff-only
else
  echo "WARNING: not a git checkout — GitHub updates will NOT be downloaded; building local files."
fi
stage 'preflight'
if [ -z "${FQDN:-}" ]; then
  FQDN=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
fi
[ -n "$FQDN" ] || { echo 'Cannot determine Tailscale hostname; set FQDN.' >&2; exit 1; }
export FQDN
for service in excalidraw-room excalidraw-shortcode excalidraw excalidraw-caddy; do
  sudo podman container exists "$service" || { echo "Missing container $service. Run ./install.sh first." >&2; exit 1; }
done
if ! sudo systemctl cat excalidraw.service excalidraw-room.service excalidraw-shortcode.service excalidraw-caddy.service excalidraw-cleanup.service excalidraw-cleanup.timer >/dev/null 2>&1; then
  bash "$BASE/deploy.sh" start
else
  bash "$BASE/deploy.sh" renew-cert
  sudo systemctl start excalidraw-room.service excalidraw-shortcode.service excalidraw.service excalidraw-caddy.service
fi

if [ "$MODE" != backend ]; then
  stage 'app image build'
  bash "$BASE/deploy.sh" build
fi

if [ "$MODE" != app ]; then
  stage 'Elixir backend image build'
  sudo podman build --layers -t "$BACKEND_IMAGE" "$BASE/backend"
fi

PREVIOUS_BACKEND=
PREVIOUS_APP=
NEW_BACKEND_DATABASE=false
restore_services() {
  echo "Deployment failed; attempting to restart existing services." >&2
  if [ -n "$PREVIOUS_APP" ]; then
    sudo systemctl stop excalidraw.service || true
    sudo podman rm -f excalidraw || true
    sudo podman rename "$PREVIOUS_APP" excalidraw || true
  fi
  if [ -n "$PREVIOUS_BACKEND" ]; then
    sudo systemctl stop excalidraw-shortcode.service || true
    sudo podman rm -f excalidraw-shortcode || true
    if "$NEW_BACKEND_DATABASE"; then
      for suffix in '' -wal -shm; do
        database="$BASE/shortcode-data/whiteboard.sqlite3$suffix"
        if [ -e "$database" ]; then
          sudo mv "$database" "$BACKUP/failed-whiteboard.sqlite3$suffix" || true
        fi
      done
    fi
    sudo podman rename "$PREVIOUS_BACKEND" excalidraw-shortcode || true
  fi
  sudo systemctl start excalidraw.service excalidraw-shortcode.service excalidraw-caddy.service || true
}
trap restore_services ERR
if [ "$MODE" != app ]; then
  stage 'shortcode backend (persisted data retained)'
  sudo systemctl stop excalidraw-shortcode.service
  mkdir -p "$BASE/shortcode-data"
  BACKUP="$BASE/recovery/backend-$(date +%Y%m%d-%H%M%S)-$$"
  mkdir -p "$BACKUP"
  chmod 700 "$BACKUP"
  sudo cp -a "$BASE/shortcode-data" "$BACKUP/data"
  echo "Backend data backup: $BACKUP/data"
  if [ ! -e "$BASE/shortcode-data/whiteboard.sqlite3" ]; then NEW_BACKEND_DATABASE=true; fi
  previous_name="excalidraw-shortcode-previous-$$"
  sudo podman rename excalidraw-shortcode "$previous_name"
  PREVIOUS_BACKEND=$previous_name
  sudo podman create --name excalidraw-shortcode --restart always --network host \
    -e PORT=3003 -e LEGACY_DATA_DIR=/data -e SCENE_SYNC_ENABLED="$SCENE_SYNC_ENABLED" \
    -v "$BASE/shortcode-data:/data" \
    "$BACKEND_IMAGE"
  sudo systemctl start excalidraw-shortcode.service
fi

if [ "$MODE" = full ]; then
  stage 'caddy routes'
  CADDY_CONFIG=$(mktemp)
  sed "s|@@FQDN@@|$FQDN|g" "$BASE/Caddyfile.template" > "$CADDY_CONFIG"
  if ! cmp -s "$CADDY_CONFIG" "$BASE/Caddyfile"; then
    cat "$CADDY_CONFIG" > "$BASE/Caddyfile"
    sudo systemctl restart excalidraw-caddy.service
  else
    echo 'Caddy routes unchanged; restart skipped.'
  fi
  rm -f "$CADDY_CONFIG"
fi

if [ "$MODE" != backend ]; then
  stage 'app container swap'
  sudo systemctl stop excalidraw.service
  previous_app="excalidraw-previous-$$"
  sudo podman rename excalidraw "$previous_app"
  PREVIOUS_APP=$previous_app
  # The image carries its own nginx config (app/excalidraw-app/nginx.conf) and
  # connects to the room server on its own origin; nothing is patched here.
  sudo podman create --name excalidraw --restart always --network host "$APP_IMAGE"
  sudo systemctl start excalidraw.service
fi
stage 'HTTPS checks'
bash "$BASE/deploy.sh" check
if [ "$MODE" != app ]; then printf '%s\n' "$SCENE_SYNC_ENABLED" > "$BASE/.scene-sync-enabled"; fi
trap - ERR
if [ -n "$PREVIOUS_BACKEND" ]; then sudo podman rm -f "$PREVIOUS_BACKEND" || true; fi
if [ -n "$PREVIOUS_APP" ]; then sudo podman rm -f "$PREVIOUS_APP" || true; fi
# Keep the newest backend data backups only; each one is a full database copy.
if [ "$MODE" != app ] && [ -d "$BASE/recovery" ]; then
  find "$BASE/recovery" -maxdepth 1 -name 'backend-*' -type d -print | sort | head -n -"${BACKEND_BACKUPS_KEPT:-10}" |
    while IFS= read -r old_backup; do sudo rm -rf -- "$old_backup"; done
fi
printf 'TIMING: HTTPS checks: %ss\n' "$((SECONDS - STAGE_STARTED))"
printf 'TIMING: total %s deploy: %ss\n' "$MODE" "$((SECONDS - STARTED))"
