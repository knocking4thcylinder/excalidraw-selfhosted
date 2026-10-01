#!/bin/bash
# Excalidraw self-hosted on SteamOS (Deck) — full stack installer
# - app + collab room over Caddy HTTPS on :8443 (Tailscale cert, MagicDNS name)
# - systemd units for boot persistence
# - reinstall.sh kept in home dir to restore after SteamOS updates
set -euo pipefail
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"

FQDN=${FQDN:-$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')}
[ -z "$FQDN" ] && { echo "ERROR: no MagicDNS name for this host (enable MagicDNS in tailnet admin)"; exit 1; }
echo "== FQDN: $FQDN"

# 0a. podman root store → /home (SteamOS /var is a 230MB partition; images + patched JS need room)
#     overlay driver fails on /home's FS on this hardware → use vfs
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

# 0b. free the old full store if it still exists
if [ -d /var/lib/containers/storage ] && grep -q 'graphroot = "/home/containers/storage"' /etc/containers/storage.conf; then
  sudo rm -rf /var/lib/containers/storage
  echo "== freed /var/lib/containers/storage (old store)"
fi

BASE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
mkdir -p "$BASE/certs" "$BASE/shortcode-data"
cd "$BASE"

[ -f "$BASE/shortcode/server.js" ] || { echo 'Missing shortcode/server.js; use the complete repository.' >&2; exit 1; }
cp "$BASE/shortcode/server.js" "$BASE/shortcode-server.js"

# 0c. writable rootfs is required for /etc/systemd/system units and /etc/containers/storage.conf
if [ "$(findmnt -n -o OPTIONS -T /etc/systemd/system | cut -d, -f1)" = ro ]; then
  echo "run: sudo steamos-readonly disable   (once, before this script)"
  exit 1
fi

# 0f. app image is built from ./app (monorepo: the fork lives here as a git
#     subtree with full history; no clone, no bundle — this script runs from
#     the repo root, and ~/excalidraw on the Deck IS this repo's checkout).
HERE="$(cd "$(dirname "$0")" && pwd)"
IMAGE="excalidraw-selfhost"
(cd "$HERE/app" && sudo podman build -t "$IMAGE" .)

# 1. tailscale cert (as deck user, userspace daemon)
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
sudo systemctl stop excalidraw.service excalidraw-room.service excalidraw-shortcode.service excalidraw-caddy.service 2>/dev/null || true
sudo podman rm -f excalidraw excalidraw-room excalidraw-caddy 2>/dev/null || true

sudo podman run -d --name excalidraw-room --restart always --network host \
  -e PORT=3002 docker.io/excalidraw/excalidraw-room:latest

sudo podman run -d --name excalidraw --restart always --network host \
  -e FQDN_HOST="$FQDN" \
  "$IMAGE" \
  sh -c 'find /etc/nginx -name "*.conf" -exec sed -i -E "s/listen[[:space:]]+80([^0-9])/listen 3000\1/" {} + && \
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

sudo podman rm -f excalidraw-shortcode 2>/dev/null || true
sudo podman run -d --name excalidraw-shortcode --restart always --network host \
  -e PORT=3003 \
  -v "$BASE/shortcode-data:/data" \
  -v "$BASE/shortcode-server.js:/srv/server.js:ro" \
  docker.io/library/node:20-alpine node /srv/server.js

bash "$BASE/deploy.sh" start

# 5. reinstall.sh for post-OS-update recovery — just re-run this installer (idempotent)
cat > "$BASE/reinstall.sh" <<'REEOF'
#!/bin/bash
set -euo pipefail
"$(cd "$(dirname "$0")" && pwd)/install.sh"
REEOF
chmod +x "$BASE/reinstall.sh"

bash "$BASE/deploy.sh" check
