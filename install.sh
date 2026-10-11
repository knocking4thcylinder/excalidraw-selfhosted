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

[ -f "$BASE/backend/mix.exs" ] || { echo 'Missing backend/; use the complete repository.' >&2; exit 1; }
SCENE_SYNC_ENABLED=${SCENE_SYNC_ENABLED:-$(cat "$BASE/.scene-sync-enabled" 2>/dev/null || echo false)}
case "$SCENE_SYNC_ENABLED" in true|false) ;; *) echo 'SCENE_SYNC_ENABLED must be true or false.' >&2; exit 2 ;; esac

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
BACKEND_IMAGE="excalidraw-api-elixir"
sudo podman build --layers -t "$BACKEND_IMAGE" "$BASE/backend"

# 1. tailscale cert (as deck user, userspace daemon)
cd "$BASE/certs"
tailscale cert "$FQDN"
chmod 644 "$FQDN".crt
chmod 600 "$FQDN".key  # Caddy runs as root under rootful podman

# 2. caddyfile
cd "$BASE"
sed "s|@@FQDN@@|$FQDN|g" "$BASE/Caddyfile.template" > Caddyfile

# 3. containers
sudo systemctl stop excalidraw.service excalidraw-room.service excalidraw-shortcode.service excalidraw-caddy.service 2>/dev/null || true
sudo podman rm -f excalidraw excalidraw-room excalidraw-caddy 2>/dev/null || true

# Pinned to the digest the stack was verified with; the client speaks this
# relay's protocol, so update it deliberately.
sudo podman run -d --name excalidraw-room --restart always --network host \
  -e PORT=3002 docker.io/excalidraw/excalidraw-room@sha256:2fe999f9be4379e3ee282fc45d75d84a691a6383dde33544514cc395287c7a70

sudo podman run -d --name excalidraw --restart always --network host "$IMAGE"

sudo podman run -d --name excalidraw-caddy --restart always --network host \
  -v "$BASE/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "$BASE/certs:/certs:ro" \
  docker.io/library/caddy:2-alpine

sudo podman rm -f excalidraw-shortcode 2>/dev/null || true
# SQLite lives in shortcode-data; JSON files from the retired Node service are
# imported once on first start (LEGACY_DATA_DIR) and never modified.
sudo podman run -d --name excalidraw-shortcode --restart always --network host \
  -e PORT=3003 -e LEGACY_DATA_DIR=/data -e SCENE_SYNC_ENABLED="$SCENE_SYNC_ENABLED" \
  -v "$BASE/shortcode-data:/data" \
  "$BACKEND_IMAGE"

bash "$BASE/deploy.sh" start

# 5. reinstall.sh for post-OS-update recovery — just re-run this installer (idempotent)
cat > "$BASE/reinstall.sh" <<'REEOF'
#!/bin/bash
set -euo pipefail
"$(cd "$(dirname "$0")" && pwd)/install.sh"
REEOF
chmod +x "$BASE/reinstall.sh"

bash "$BASE/deploy.sh" check
