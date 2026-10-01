#!/bin/bash
set -euo pipefail
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
BASE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
SERVICES=(excalidraw-room excalidraw-shortcode excalidraw excalidraw-caddy)
APP_IMAGE=${DEPLOY_IMAGE_TAG:-excalidraw-selfhost}

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
    timed 'dependency installation' sudo podman exec -e HUSKY=0 excalidraw-builder yarn --frozen-lockfile --network-timeout 600000
    printf '%s\n' "$dependency_hash" > "$cache/dependencies.sha256"
  else
    echo 'Dependencies unchanged; installation skipped.'
  fi
  timed 'frontend compilation' sudo podman exec -e NODE_ENV=production excalidraw-builder yarn build:app:docker
  timed 'runtime image' sudo podman build --layers -f "$BASE/app/Dockerfile.runtime" -t "$APP_IMAGE" "$cache/source/excalidraw-app"
}

build_app() {
  lock_deploy
  local mode=${DEPLOY_BUILD_MODE:-auto}
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
    build_fast
    return
  fi
  check_build_storage 12582912
  cd "$BASE/app"
  timed 'dependency image (cached unless manifests change)' sudo podman build --layers --target dependencies -t excalidraw-build-deps .
  timed 'app image' sudo podman build --layers -t "$APP_IMAGE" .
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
    if sudo systemctl is-active --quiet excalidraw-caddy.service; then
      sudo systemctl restart excalidraw-caddy.service
    else
      sudo podman restart excalidraw-caddy >/dev/null
    fi
  fi
}

start_stack() {
  hostname_for_stack
  local service
  for service in "${SERVICES[@]}"; do
    sudo podman container exists "$service" || {
      echo "Missing container $service. Run ./install.sh first." >&2
      exit 1
    }
  done
  renew_certificate
  for service in "${SERVICES[@]}"; do
    sudo tee "/etc/systemd/system/$service.service" >/dev/null <<EOF
[Unit]
Description=Excalidraw $service
PartOf=excalidraw-stack.service
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=0

[Service]
ExecStartPre=-/usr/bin/podman stop -t 10 $service
ExecStart=/usr/bin/podman start -a $service
ExecStop=/usr/bin/podman stop -t 10 $service
Restart=always
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF
  done
  sudo tee /etc/systemd/system/excalidraw-stack.service >/dev/null <<'EOF'
[Unit]
Description=Excalidraw self-hosted stack
Wants=excalidraw.service excalidraw-room.service excalidraw-shortcode.service excalidraw-caddy.service
After=excalidraw.service excalidraw-room.service excalidraw-shortcode.service excalidraw-caddy.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/true

[Install]
WantedBy=multi-user.target
EOF
  sudo tee /etc/systemd/system/excalidraw-deploy.service >/dev/null <<EOF
[Unit]
Description=Build and deploy self-hosted Excalidraw
Wants=network-online.target
After=network-online.target tailscaled.service

[Service]
Type=oneshot
User=$(id -un)
Environment="HOME=$HOME"
Environment="PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
Environment="FQDN=$FQDN"
WorkingDirectory=$BASE
ExecStart=/bin/bash "$BASE/deploy.sh" deploy
TimeoutStartSec=infinity
EOF
  sudo tee /etc/systemd/system/excalidraw-cert-renew.service >/dev/null <<EOF
[Unit]
Description=Renew Excalidraw Tailscale TLS certificate
Wants=network-online.target
After=network-online.target tailscaled.service

[Service]
Type=oneshot
User=$(id -un)
Environment="HOME=$HOME"
Environment="PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
Environment="FQDN=$FQDN"
ExecStart=/bin/bash "$BASE/deploy.sh" renew-cert
EOF
  sudo tee /etc/systemd/system/excalidraw-cert-renew.timer >/dev/null <<'EOF'
[Unit]
Description=Check Excalidraw TLS certificate daily

[Timer]
OnBootSec=5min
OnUnitActiveSec=1d

[Install]
WantedBy=timers.target
EOF
  sudo tee /etc/systemd/system/excalidraw-cleanup.service >/dev/null <<EOF
[Unit]
Description=Clean unused Excalidraw build images

[Service]
Type=oneshot
User=$(id -un)
Environment="HOME=$HOME"
Environment="PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
ExecStart=/bin/bash "$BASE/deploy.sh" cleanup
TimeoutStartSec=infinity
EOF
  sudo tee /etc/systemd/system/excalidraw-cleanup.timer >/dev/null <<'EOF'
[Unit]
Description=Clean unused Excalidraw build images weekly

[Timer]
OnCalendar=weekly
Persistent=true

[Install]
WantedBy=timers.target
EOF
  sudo systemctl daemon-reload
  for service in "${SERVICES[@]}"; do
    sudo systemctl enable --now "$service.service"
  done
  sudo systemctl enable --now excalidraw-stack.service
  sudo systemctl enable --now excalidraw-cert-renew.timer
  sudo systemctl enable --now excalidraw-cleanup.timer
  check_stack
}

case "${1:-deploy}" in
  deploy|full|app|backend)
    hostname_for_stack
    mode=${1:-full}
    [ "$mode" != deploy ] || mode=full
    if [ "$#" -gt 0 ]; then shift; fi
    exec bash "$BASE/redeploy.sh" "$mode" "$@"
    ;;
  start) start_stack ;;
  build) build_app ;;
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
  -h|--help|help) echo 'Usage: ./deploy.sh [deploy|full|app|backend] [--local] | [start|status|check|logs|build|cleanup|renew-cert]' ;;
  *) echo 'Usage: ./deploy.sh [deploy|full|app|backend] [--local] | [start|status|check|logs|build|cleanup|renew-cert]' >&2; exit 2 ;;
esac
