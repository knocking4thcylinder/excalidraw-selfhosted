#!/bin/bash
set -euo pipefail
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
BASE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
SERVICES=(excalidraw-room excalidraw-shortcode excalidraw excalidraw-caddy)

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
  sudo systemctl daemon-reload
  for service in "${SERVICES[@]}"; do
    sudo systemctl enable --now "$service.service"
  done
  sudo systemctl enable --now excalidraw-stack.service
  sudo systemctl enable --now excalidraw-cert-renew.timer
  check_stack
}

case "${1:-deploy}" in
  deploy)
    hostname_for_stack
    exec bash "$BASE/redeploy.sh"
    ;;
  start) start_stack ;;
  build) cd "$BASE/app"; exec sudo podman build -t excalidraw-selfhost . ;;
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
  -h|--help|help) echo 'Usage: ./deploy.sh [deploy|start|status|check|logs|build|renew-cert]' ;;
  *) echo 'Usage: ./deploy.sh [deploy|start|status|check|logs|build|renew-cert]' >&2; exit 2 ;;
esac
