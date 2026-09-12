#!/bin/bash
# Excalidraw self-hosted on generic Linux — full stack installer
# - app + collab room over Caddy HTTPS on :8443 (Tailscale cert, MagicDNS name)
# - systemd units for boot persistence
# - reinstall.sh kept in home dir to restore after OS updates
#
# Prereqs: podman, tailscale (logged in, MagicDNS enabled), git.
# FQDN defaults to this host's Tailscale MagicDNS name; override with
# FQDN=host.tailnet.ts.net when python3 is unavailable for detection.
set -euo pipefail

if [ -z "${FQDN:-}" ]; then
  FQDN=$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("Self",{}).get("DNSName","").rstrip("."))' 2>/dev/null || true)
fi
[ -z "${FQDN:-}" ] && { echo "ERROR: no MagicDNS name for this host (enable MagicDNS in tailnet admin, install python3, or export FQDN)"; exit 1; }
echo "== FQDN: $FQDN"

IS_STEAMOS=0
grep -qiE '^(ID|ID_LIKE)=.*steamos' /etc/os-release 2>/dev/null && IS_STEAMOS=1 || true

if [ "$IS_STEAMOS" = 1 ]; then
  # SteamOS: /var is a ~230MB partition and overlay fails on /home's FS,
  # so the podman root store moves to /home with the vfs driver.
  if ! grep -q 'graphroot = "/home/containers/storage"' /etc/containers/storage.conf 2>/dev/null; then
    sudo mkdir -p /home/containers/storage
    sudo tee /etc/containers/storage.conf > /dev/null <<'STO'
[storage]
  driver = "vfs"
  graphroot = "/home/containers/storage"
  runroot = "/run/containers/storage"
STO
    echo "== storage.conf: root store moved to /home/containers/storage (vfs, wipes old overlay state)"
  fi

  # free the old full store if it still exists
  if [ -d /var/lib/containers/storage ] && grep -q 'graphroot = "/home/containers/storage"' /etc/containers/storage.conf; then
    sudo rm -rf /var/lib/containers/storage
    echo "== freed /var/lib/containers/storage (old store)"
  fi
else
  # Generic Linux: podman defaults are fine unless /var is cramped (<2G free
  # and no storage.conf yet) — then move just the graphroot to /home,
  # keeping the default overlay driver.
  VAR_FREE_MB=$(df --output=avail -m /var 2>/dev/null | tail -1 | tr -dc '0-9')
  if [ -n "${VAR_FREE_MB:-}" ] && [ "$VAR_FREE_MB" -lt 2048 ] && [ ! -f /etc/containers/storage.conf ]; then
    sudo mkdir -p /home/containers/storage
    sudo tee /etc/containers/storage.conf > /dev/null <<'STO'
[storage]
  graphroot = "/home/containers/storage"
  runroot = "/run/containers/storage"
STO
    echo "== storage.conf: /var is cramped (${VAR_FREE_MB}M free), root store moved to /home/containers/storage"
  fi
fi

BASE="$HOME/excalidraw"
mkdir -p "$BASE/certs" "$BASE/shortcode-data"
cd "$BASE"

# 0d. shortcode service source (same directory as this script: shortcode/server.js;
#     or as a file: shortcode-server.js)
if [ ! -f "$BASE/shortcode-server.js" ]; then
  HERE="$(cd "$(dirname "$0")" && pwd)"
  if [ -f "$HERE/shortcode/server.js" ]; then
    cp "$HERE/shortcode/server.js" "$BASE/shortcode-server.js"
  elif [ -f "$HERE/shortcode-server.js" ]; then
    cp "$HERE/shortcode-server.js" "$BASE/shortcode-server.js"
  fi
fi
SHORTCODE_OK=0
if [ -f "$BASE/shortcode-server.js" ]; then
  SHORTCODE_OK=1
else
  echo "WARN: shortcode/server.js not found next to install.sh — shortcode service will be skipped"
fi

# 0c. writable rootfs is required for /etc/systemd/system units and
#     /etc/containers/storage.conf
if [ ! -w /etc/systemd/system ]; then
  if [ "$IS_STEAMOS" = 1 ]; then
    echo "run: sudo steamos-readonly disable   (once, before this script)"
  else
    echo "ERROR: /etc/systemd/system is not writable (read-only rootfs?)"
  fi
  exit 1
fi

# 0f. app image is built from ./app (monorepo: the fork lives here as a git
#     subtree with full history; no clone, no bundle — this script runs from
#     the repo root, and ~/excalidraw on the host IS this repo's checkout).
HERE="$(cd "$(dirname "$0")" && pwd)"
IMAGE="excalidraw-selfhost"
(cd "$HERE/app" && sudo podman build -t "$IMAGE" .)

# 1. tailscale cert for the host's MagicDNS name
cd "$BASE/certs"
tailscale cert "$FQDN"
chmod a+r "$FQDN".crt "$FQDN".key

# 2. caddyfile
cd "$BASE"
cat > Caddyfile <<'EOF'
@@FQDN@@:8443 {
  tls /certs/@@FQDN@@.crt /certs/@@FQDN@@.key
  handle /s/* {
    reverse_proxy localhost:3003
  }
  handle /api/code* {
    reverse_proxy localhost:3003
  }
  handle /api/resolve* {
    reverse_proxy localhost:3003
  }
  handle /api/rooms* {
    reverse_proxy localhost:3003
  }
  handle /socket.io/* {
    reverse_proxy localhost:3002
  }
  handle {
    reverse_proxy localhost:3000
  }
}
EOF
sed -i "s|@@FQDN@@|$FQDN|g" Caddyfile

# 3. containers
sudo podman rm -f excalidraw excalidraw-room excalidraw-caddy 2>/dev/null || true

sudo podman run -d --name excalidraw-room --restart always --network host \
  -e PORT=3002 docker.io/excalidraw/excalidraw-room:latest

sudo podman run -d --name excalidraw --restart always --network host \
  -e FQDN_HOST="$FQDN" \
  "$IMAGE" \
  sh -c 'CFG=/etc/nginx/conf.d/default.conf; grep -q excalidraw-cache-policy $CFG || { printf "%s\n" "    # excalidraw-cache-policy" "    location = /index.html {" "        root /usr/share/nginx/html;" "        add_header Cache-Control \"no-store\";" "    }" "    location /assets/ {" "        root /usr/share/nginx/html;" "        add_header Cache-Control \"public, max-age=31536000, immutable\";" "    }" > /tmp/cachepol.conf; sed -i -e "/server_name  localhost;/r /tmp/cachepol.conf" $CFG; }; nginx -t && \
    find /etc/nginx -name "*.conf" -exec sed -i -E "s/listen[[:space:]]+80([^0-9])/listen 3000\1/" {} + && \
    find /usr/share/nginx/html/assets -name "*.js" -exec \
      sed -i -e "s|https://oss-collab\.excalidraw\.com|wss://$FQDN_HOST:8443|g" \
             -e "s|wss://oss-collab\.excalidraw\.com|wss://$FQDN_HOST:8443|g" {} + && \
    R=$(grep -rlo "oss-collab" /usr/share/nginx/html/assets | wc -l) && \
    [ "$R" = "0" ] && echo "PATCH_OK_WSS (0 residual oss-collab refs)" && \
    nginx -g "daemon off;"'

sudo podman run -d --name excalidraw-caddy --restart always --network host \
  -v "$BASE/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "$BASE/certs:/certs:ro" \
  docker.io/library/caddy:2-alpine

# shortcode container only when its source was staged; failure here aborts loudly (set -e)
if [ "$SHORTCODE_OK" = "1" ]; then
  sudo podman rm -f excalidraw-shortcode 2>/dev/null || true
  sudo podman run -d --name excalidraw-shortcode --restart always --network host \
    -e PORT=3003 \
    -v "$BASE/shortcode-data:/data" \
    -v "$BASE/shortcode-server.js:/srv/server.js:ro" \
    docker.io/library/node:20-alpine node /srv/server.js
else
  echo "  shortcode skipped (server.js missing)"
fi

# 4. systemd system units (root podman) — shortcode unit only when its container was created
SVCS="excalidraw-room excalidraw excalidraw-caddy"
if [ "$SHORTCODE_OK" = "1" ]; then
  SVCS="$SVCS excalidraw-shortcode"
fi
for SVC in $SVCS; do
  printf '%s\n' \
"[Unit]" \
"Description=Excalidraw $SVC" \
"Wants=network-online.target" \
"After=network-online.target" \
"" \
"[Service]" \
"ExecStart=/usr/bin/podman start -a $SVC" \
"ExecStop=/usr/bin/podman stop $SVC" \
"Restart=always" \
"" \
"[Install]" \
"WantedBy=multi-user.target" | sudo tee "/etc/systemd/system/$SVC.service" >/dev/null
done
# ensure caddy starts after app (nice, not strictly needed)
sudo sed -i 's/^After=network-online.target$/After=network-online.target excalidraw.service/' /etc/systemd/system/excalidraw-caddy.service
sudo systemctl daemon-reload
sudo systemctl enable --now excalidraw-room.service excalidraw.service excalidraw-caddy.service
if [ "$SHORTCODE_OK" = "1" ]; then
  sudo systemctl enable --now excalidraw-shortcode.service
fi

# 5. reinstall.sh for post-OS-update recovery — just re-run this installer (idempotent)
cat > "$BASE/reinstall.sh" <<'REEOF'
#!/bin/bash
set -euo pipefail
"$(cd "$(dirname "$0")" && pwd)/install.sh"
REEOF
chmod +x "$BASE/reinstall.sh"

# 6. verify
sleep 6
echo "== verification =="
sudo podman ps --format "{{.Names}}  {{.Status}}"
curl -sk -o /dev/null -w "https app: %{http_code}\n" https://localhost:8443/ --resolve "$FQDN:8443:127.0.0.1"
curl -sk -o /dev/null -w "https room: %{http_code}\n" --resolve "$FQDN:8443:127.0.0.1" "https://localhost:8443/socket.io/?EIO=4&transport=polling"
sudo journalctl -u excalidraw --no-pager -n 2 | tail -2
echo "== DONE. URL: https://$FQDN:8443 =="
