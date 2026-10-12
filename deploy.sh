#!/bin/bash
set -Eeuo pipefail
# tailscale lives in ~/.local/bin (login-shell PATH only); non-interactive
# ssh has a minimal PATH, so add it explicitly.
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
BASE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
SERVICES=(excalidraw-room excalidraw-shortcode excalidraw excalidraw-caddy)
APP_IMAGE=excalidraw-selfhost
BACKEND_IMAGE=excalidraw-api-elixir
QUADLET_DIR=${QUADLET_DIR:-/etc/containers/systemd}
UNIT_DIR=${UNIT_DIR:-/etc/systemd/system}
# Hand-written units from before the Quadlet migration; same-named files in
# /etc/systemd/system would shadow the generated ones.
LEGACY_UNITS=(excalidraw.service excalidraw-room.service excalidraw-shortcode.service excalidraw-caddy.service
  excalidraw-stack.service excalidraw-deploy.service excal-redeploy.service)
USAGE='Usage: ./deploy.sh [deploy|full|app|backend] [--local] | [start|status|check|logs|build|cleanup|renew-cert]'

lock_deploy() {
  if [ "$(readlink /proc/self/fd/9 2>/dev/null || true)" != "$BASE/.deploy.lock" ]; then
    exec 9>"$BASE/.deploy.lock"
  fi
  flock -n 9 || { echo 'Another deployment or cleanup is running.' >&2; exit 1; }
}

timed() {
  local label=$1 started=$SECONDS
  shift
  "$@"
  printf 'TIMING: %s: %ss\n' "$label" "$((SECONDS - started))"
}

# The Deck grants passwordless sudo for podman, systemctl and tee only; any
# other sudo command blocks on a password prompt. Root-owned files (backend
# data, system unit directories) are handled by a throwaway container instead.
root_files() {
  local mount=$1 command=$2
  shift 2
  sudo podman run --rm --network none -v "$mount:$mount" --entrypoint "$command" "$BACKEND_IMAGE" "$@"
}

check_build_storage() {
  local graph_root available_kb minimum_kb=$1 storage_path
  graph_root=$(sudo podman info --format '{{.Store.GraphRoot}}')
  minimum_kb=${DEPLOY_MIN_FREE_KB:-$minimum_kb}
  [[ "$minimum_kb" =~ ^[0-9]+$ ]] || { echo 'DEPLOY_MIN_FREE_KB must be an integer.' >&2; exit 1; }
  for storage_path in "$graph_root" "$BASE"; do
    available_kb=$(df -Pk "$storage_path" | awk 'END {print $4}')
    if [ "$available_kb" -lt "$minimum_kb" ]; then
      echo "Not enough build storage at $storage_path: ${available_kb} KiB free; need ${minimum_kb} KiB. Run ./deploy.sh cleanup, or adjust DEPLOY_MIN_FREE_KB." >&2
      exit 1
    fi
  done
}

build_fast() {
  local image=$1
  command -v rsync >/dev/null || { echo 'Fast builds require rsync; use DEPLOY_BUILD_MODE=container instead.' >&2; exit 1; }
  check_build_storage 6291456
  local cache="$BASE/.build-cache" builder_image builder_config dependency_hash
  builder_image=$(awk '$1 == "FROM" && $NF == "dependencies" {print $3}' "$BASE/app/Dockerfile")
  [ -n "$builder_image" ] || { echo 'Cannot determine the pinned Node builder image.' >&2; exit 1; }
  mkdir -p "$cache/source" "$cache/yarn"
  timed 'source sync' rsync -a --delete \
    --exclude='node_modules/' --exclude='build/' --exclude='dist/' --exclude='.git/' \
    --include='/excalidraw-app/***' --include='/packages/***' --include='/public/***' --include='/scripts/***' \
    --include='/package.json' --include='/yarn.lock' --include='/.npmrc' --include='/tsconfig.json' \
    --include='/.env.development' --include='/.env.production' --include='/.eslintrc.json' --include='/.prettierrc' \
    --exclude='*' "$BASE/app/" "$cache/source/"
  builder_config=$(sudo podman inspect --format '{{index .Config.Labels "org.excalidraw.builder-base"}}{{println}}{{index .Config.Labels "org.excalidraw.builder-workspace"}}' excalidraw-builder 2>/dev/null || true)
  if [ "$builder_config" != "$(printf '%s\n%s' "$builder_image" "$cache/source")" ]; then
    sudo podman rm -f excalidraw-builder 2>/dev/null || true
    sudo podman create --name excalidraw-builder --user "$(id -u):$(id -g)" \
      --label "org.excalidraw.builder-base=$builder_image" \
      --label "org.excalidraw.builder-workspace=$cache/source" \
      --workdir /opt/node_app -e YARN_CACHE_FOLDER=/cache/yarn \
      -v "$cache/source:/opt/node_app" -v "$cache/yarn:/cache/yarn" \
      "$builder_image" sleep infinity
  fi
  sudo podman start excalidraw-builder >/dev/null
  trap 'sudo podman stop -t 1 excalidraw-builder >/dev/null 2>&1 || true' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  dependency_hash=$({
    printf '%s\n' "$builder_image"
    uname -m
    (cd "$cache/source" && sha256sum package.json yarn.lock .npmrc excalidraw-app/package.json packages/*/package.json)
  } | sha256sum | awk '{print $1}')
  if [ "$dependency_hash" != "$(cat "$cache/dependencies.sha256" 2>/dev/null || true)" ] || [ ! -f "$cache/source/node_modules/.yarn-integrity" ]; then
    timed 'dependency installation' sudo podman exec -e HUSKY=0 -e NODE_OPTIONS=--no-deprecation excalidraw-builder yarn --frozen-lockfile --silent --network-timeout 600000
    printf '%s\n' "$dependency_hash" > "$cache/dependencies.sha256"
  else
    echo 'Dependencies unchanged; installation skipped.'
  fi
  timed 'frontend compilation' sudo podman exec -e NODE_ENV=production -e NODE_OPTIONS=--no-deprecation -e BROWSERSLIST_IGNORE_OLD_DATA=1 excalidraw-builder yarn build:app:docker
  timed 'runtime image' sudo podman build --layers -f "$BASE/app/Dockerfile.runtime" -t "$image" "$cache/source/excalidraw-app"
}

build_app() {
  local image=$1 mode=${DEPLOY_BUILD_MODE:-auto}
  lock_deploy
  case "$mode" in
    auto)
      if [ "$(sudo podman info --format '{{.Store.GraphDriverName}}')" = vfs ] && command -v rsync >/dev/null; then
        mode=fast
      else
        mode=container
      fi
      ;;
    fast|container) ;;
    *) echo 'DEPLOY_BUILD_MODE must be auto, fast, or container.' >&2; exit 2 ;;
  esac
  printf 'Build mode: %s\n' "$mode"
  if [ "$mode" = fast ]; then
    build_fast "$image"
    return
  fi
  check_build_storage 12582912
  (
    cd "$BASE/app"
    timed 'dependency image (cached unless manifests change)' sudo podman build --layers --target dependencies -t excalidraw-build-deps .
    timed 'app image' sudo podman build --layers -t "$image" .
  )
}

hostname_for_stack() {
  if [ -z "${FQDN:-}" ]; then
    FQDN=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
  fi
  [ -n "$FQDN" ] || { echo 'Cannot determine Tailscale hostname; set FQDN.' >&2; exit 1; }
  export FQDN
}

check_stack() {
  hostname_for_stack
  local route
  for route in / '/socket.io/?EIO=4&transport=polling' /api/rooms; do
    curl --fail --silent --show-error --max-time 10 \
      --retry 5 --retry-connrefused --retry-delay 1 \
      --output /dev/null "https://$FQDN:8443$route"
    printf 'OK: %s\n' "$route"
  done
  printf '\nTablet URL: https://%s:8443\nBoth devices must be connected to Tailscale.\n' "$FQDN"
}

renew_certificate() {
  hostname_for_stack
  if ! openssl x509 -checkend 604800 -noout -in "$BASE/certs/$FQDN.crt" >/dev/null 2>&1; then
    (cd "$BASE/certs" && tailscale cert --min-validity 168h "$FQDN")
    sudo systemctl try-restart excalidraw-caddy.service
  fi
}

write_backend_env() {
  printf 'SCENE_SYNC_ENABLED=%s\n' "$1" > "$BASE/.backend.env"
}

# Installs systemd/ (Quadlet .container files and plain units) with this
# checkout's paths filled in. Unchanged files are left alone; running
# containers whose definition changed are restarted.
install_units() {
  local file name destination rendered legacy=() changed=false restart=()
  for name in "${LEGACY_UNITS[@]}"; do
    if [ -e "$UNIT_DIR/$name" ]; then legacy+=("$name"); fi
  done
  if [ "${#legacy[@]}" -gt 0 ]; then
    echo "Replacing hand-written units with Quadlet: ${legacy[*]}"
    sudo systemctl disable --now "${legacy[@]}"
    root_files "$UNIT_DIR" rm -f "${legacy[@]/#/$UNIT_DIR/}"
    changed=true
  fi
  if [ ! -d "$QUADLET_DIR" ]; then
    root_files "$(dirname "$QUADLET_DIR")" mkdir -p "$QUADLET_DIR"
  fi
  mkdir -p "$BASE/shortcode-data"
  [ -f "$BASE/.backend.env" ] || write_backend_env "$(cat "$BASE/.scene-sync-enabled" 2>/dev/null || echo false)"
  for file in "$BASE"/systemd/*; do
    name=$(basename "$file")
    case "$name" in
      *.container) destination="$QUADLET_DIR/$name" ;;
      *) destination="$UNIT_DIR/$name" ;;
    esac
    rendered=$(sed -e "s|@BASE@|$BASE|g" -e "s|@HOME@|$HOME|g" -e "s|@USER@|$(id -un)|g" -e "s|@FQDN@|$FQDN|g" "$file")
    if [ "$rendered" != "$(cat "$destination" 2>/dev/null || true)" ]; then
      printf '%s\n' "$rendered" | sudo tee "$destination" >/dev/null
      changed=true
      if [[ "$name" == *.container ]]; then restart+=("${name%.container}.service"); fi
    fi
  done
  if "$changed"; then
    sudo systemctl daemon-reload
    sudo systemctl enable excalidraw-stack.target excalidraw-cert-renew.timer excalidraw-cleanup.timer
    if [ "${#restart[@]}" -gt 0 ]; then sudo systemctl try-restart "${restart[@]}"; fi
  fi
}

require_images() {
  local image
  for image in "$APP_IMAGE" "$BACKEND_IMAGE"; do
    sudo podman image exists "$image" || { echo "Missing image $image. Run ./install.sh first." >&2; exit 1; }
  done
}

start_stack() {
  hostname_for_stack
  require_images
  install_units
  renew_certificate
  sudo systemctl start excalidraw-stack.target excalidraw-cert-renew.timer excalidraw-cleanup.timer
}

# Keeps the running image as :previous so a failed deploy can switch back.
keep_previous() {
  sudo podman tag "$1:latest" "$1:previous"
}

deploy() {
  local mode=$1 local_files=false started=$SECONDS scene_sync
  shift
  if [ "${1:-}" = --local ]; then local_files=true; shift; fi
  [ "$#" -eq 0 ] || { echo "$USAGE" >&2; exit 2; }
  scene_sync=${SCENE_SYNC_ENABLED:-$(cat "$BASE/.scene-sync-enabled" 2>/dev/null || echo false)}
  case "$scene_sync" in true|false) ;; *) echo 'SCENE_SYNC_ENABLED must be true or false.' >&2; exit 2 ;; esac
  lock_deploy
  cd "$BASE"

  if ! "$local_files"; then
    printf '== %s deploy: update checkout ==\n' "$mode"
    if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      git pull --ff-only
      # Run the version of this script that was just pulled.
      exec bash "$BASE/deploy.sh" "$mode" --local
    fi
    echo "WARNING: not a git checkout — GitHub updates will NOT be downloaded; building local files."
  fi

  STAGE_LABEL=
  STAGE_STARTED=$SECONDS
  stage() {
    if [ -n "$STAGE_LABEL" ]; then printf 'TIMING: %s: %ss\n' "$STAGE_LABEL" "$((SECONDS - STAGE_STARTED))"; fi
    printf '\n== %s ==\n' "$1"
    STAGE_STARTED=$SECONDS
    STAGE_LABEL=$1
  }

  stage "$mode deploy: preflight"
  start_stack

  APP_KEPT=false BACKEND_KEPT=false APP_SWAPPED=false BACKEND_SWAPPED=false NEW_BACKEND_DATABASE=false BACKUP=
  restore_previous() {
    # Subshells inherit the trap (set -E); roll back once, from the deploy itself.
    [ "$BASHPID" = "$$" ] || return 0
    trap - ERR
    echo 'Deployment failed; switching back to the previous images.' >&2
    if "$APP_KEPT"; then sudo podman tag "$APP_IMAGE:previous" "$APP_IMAGE:latest" || true; fi
    if "$BACKEND_KEPT"; then sudo podman tag "$BACKEND_IMAGE:previous" "$BACKEND_IMAGE:latest" || true; fi
    if "$BACKEND_SWAPPED"; then
      sudo systemctl stop excalidraw-shortcode.service || true
      if "$NEW_BACKEND_DATABASE"; then
        local suffix database
        for suffix in '' -wal -shm; do
          database="$BASE/shortcode-data/whiteboard.sqlite3$suffix"
          if [ -e "$database" ]; then
            root_files "$BASE" mv "$database" "$BACKUP/failed-whiteboard.sqlite3$suffix" || true
          fi
        done
      fi
      write_backend_env "$(cat "$BASE/.scene-sync-enabled" 2>/dev/null || echo false)"
      sudo systemctl start excalidraw-shortcode.service || true
    fi
    if "$APP_SWAPPED"; then sudo systemctl restart excalidraw.service || true; fi
  }
  trap restore_previous ERR

  if [ "$mode" != backend ]; then
    stage 'app image build'
    keep_previous "$APP_IMAGE"
    APP_KEPT=true
    build_app "$APP_IMAGE"
  fi

  if [ "$mode" != app ]; then
    stage 'Elixir backend image build'
    keep_previous "$BACKEND_IMAGE"
    BACKEND_KEPT=true
    sudo podman build --layers -t "$BACKEND_IMAGE" "$BASE/backend"

    stage 'backend restart (persisted data retained)'
    sudo systemctl stop excalidraw-shortcode.service
    BACKEND_SWAPPED=true
    BACKUP="$BASE/recovery/backend-$(date +%Y%m%d-%H%M%S)-$$"
    mkdir -p "$BACKUP"
    chmod 700 "$BACKUP"
    root_files "$BASE" cp -a "$BASE/shortcode-data" "$BACKUP/data"
    echo "Backend data backup: $BACKUP/data"
    if [ ! -e "$BASE/shortcode-data/whiteboard.sqlite3" ]; then NEW_BACKEND_DATABASE=true; fi
    write_backend_env "$scene_sync"
    sudo systemctl start excalidraw-shortcode.service
  fi

  if [ "$mode" = full ]; then
    stage 'caddy routes'
    local caddy_config
    caddy_config=$(sed "s|@@FQDN@@|$FQDN|g" "$BASE/Caddyfile.template")
    if [ "$caddy_config" != "$(cat "$BASE/Caddyfile" 2>/dev/null || true)" ]; then
      printf '%s\n' "$caddy_config" > "$BASE/Caddyfile"
      sudo systemctl restart excalidraw-caddy.service
    else
      echo 'Caddy routes unchanged; restart skipped.'
    fi
  fi

  if [ "$mode" != backend ]; then
    stage 'app restart'
    APP_SWAPPED=true
    sudo systemctl restart excalidraw.service
  fi

  stage 'HTTPS checks'
  check_stack
  trap - ERR
  if [ "$mode" != app ]; then printf '%s\n' "$scene_sync" > "$BASE/.scene-sync-enabled"; fi
  # Keep the newest backend data backups only; each one is a full database copy.
  if [ "$mode" != app ] && [ -d "$BASE/recovery" ]; then
    find "$BASE/recovery" -maxdepth 1 -name 'backend-*' -type d -print | sort | head -n -"${BACKEND_BACKUPS_KEPT:-10}" |
      while IFS= read -r old_backup; do root_files "$BASE" rm -rf -- "$old_backup"; done
  fi
  printf 'TIMING: HTTPS checks: %ss\n' "$((SECONDS - STAGE_STARTED))"
  printf 'TIMING: total %s deploy: %ss\n' "$mode" "$((SECONDS - started))"
}

case "${1:-deploy}" in
  deploy|full|app|backend)
    mode=${1:-full}
    [ "$mode" != deploy ] || mode=full
    if [ "$#" -gt 0 ]; then shift; fi
    deploy "$mode" "$@"
    ;;
  start)
    start_stack
    check_stack
    ;;
  build) build_app "${DEPLOY_IMAGE_TAG:-$APP_IMAGE}" ;;
  cleanup)
    lock_deploy
    timed 'image cleanup' sudo podman image prune -f
    ;;
  renew-cert) renew_certificate ;;
  status)
    sudo podman ps -a --format '{{.Names}}  {{.Status}}'
    for service in "${SERVICES[@]}"; do
      printf '%s: ' "$service"
      sudo systemctl is-active "$service.service" || true
    done
    check_stack
    ;;
  check) check_stack ;;
  logs)
    for service in "${SERVICES[@]}"; do
      printf '\n== %s ==\n' "$service"
      sudo podman logs --tail 50 "$service"
    done
    ;;
  -h|--help|help) echo "$USAGE" ;;
  *) echo "$USAGE" >&2; exit 2 ;;
esac
