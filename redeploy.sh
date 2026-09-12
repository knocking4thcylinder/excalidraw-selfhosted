#!/bin/bash
# One-shot redeploy of the forked app + shortcode service + caddy route.
set -euo pipefail
# tailscale lives in ~/.local/bin (login-shell PATH only); non-interactive
# ssh has a minimal PATH, so add it explicitly.
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
BASE=~/excalidraw
cd "$BASE"

echo "== 1/5 update checkout (monorepo; app source is ./app) =="
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git pull --ff-only
else
  echo "not a git checkout — expecting files synced from Mac; continuing with working tree as-is"
fi

echo "== 2/5 image build (yarn layers cached; src-only changes) =="
(cd app && sudo podman build -t excalidraw-selfhost .)
# vfs duplicates layers per build (120G pileup once); drop dangling images
# from older builds so the disk never fills again (tagged/used images kept)
sudo podman image prune -f >/dev/null 2>&1 || true

echo "== 3/5 shortcode service (codes persisted to ./shortcode-data/codes.json) =="
cp "$BASE/shortcode/server.js" "$BASE/shortcode-server.js"
sudo podman rm -f excalidraw-shortcode 2>/dev/null || true
mkdir -p "$BASE/shortcode-data"
sudo podman run -d --name excalidraw-shortcode --restart always --network host \
  -e PORT=3003 \
  -v "$BASE/shortcode-data:/data" \
  -v "$BASE/shortcode-server.js:/srv/server.js:ro" \
  docker.io/library/node:20-alpine node /srv/server.js

echo "== 4/5 caddy route update + restart =="
if [ -z "${FQDN:-}" ]; then
  FQDN=$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("Self",{}).get("DNSName","").rstrip("."))' 2>/dev/null || true)
fi
[ -z "${FQDN:-}" ] && { echo "ERROR: cannot determine MagicDNS name (export FQDN)"; exit 1; }
cat > "$BASE/Caddyfile" <<CDATA
$FQDN:8443 {
  tls /certs/$FQDN.crt /certs/$FQDN.key
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
CDATA
sudo podman restart excalidraw-shortcode 2>/dev/null || true
sudo podman restart excalidraw-caddy

echo "== 5/5 app container swap =="
sudo podman rm -f excalidraw 2>/dev/null || true
sudo podman run -d --name excalidraw --restart always --network host \
  -e FQDN_HOST="$FQDN" \
  excalidraw-selfhost \
  sh -c 'CFG=/etc/nginx/conf.d/default.conf; grep -q excalidraw-cache-policy $CFG || { printf "%s\n" "    # excalidraw-cache-policy" "    location = /index.html {" "        root /usr/share/nginx/html;" "        add_header Cache-Control \"no-store\";" "    }" "    location /assets/ {" "        root /usr/share/nginx/html;" "        add_header Cache-Control \"public, max-age=31536000, immutable\";" "    }" > /tmp/cachepol.conf; sed -i -e "/server_name  localhost;/r /tmp/cachepol.conf" $CFG; }; nginx -t && \
    find /etc/nginx -name "*.conf" -exec sed -i -E "s/listen[[:space:]]+80([^0-9])/listen 3000\\1/" {} + && \
    find /usr/share/nginx/html/assets -name "*.js" -exec \
      sed -i -e "s|https://oss-collab\\.excalidraw\\.com|wss://$FQDN_HOST:8443|g" \
             -e "s|wss://oss-collab\\.excalidraw\\.com|wss://$FQDN_HOST:8443|g" {} + && \
    R=$(grep -rlo "oss-collab" /usr/share/nginx/html/assets | wc -l) && \
    [ "$R" = "0" ] && echo "PATCH_OK_WSS" && \
    nginx -g "daemon off;"'
sudo systemctl restart excalidraw.service 2>/dev/null || true

echo "== shortcode systemd unit =="
printf "%s\n" \
  "[Unit]" \
  "Description=Excalidraw short-code service" \
  "Wants=network-online.target" \
  "After=network-online.target" \
  "" \
  "[Service]" \
  "ExecStart=/usr/bin/podman start -a excalidraw-shortcode" \
  "ExecStop=/usr/bin/podman stop excalidraw-shortcode" \
  "Restart=always" \
  "" \
  "[Install]" \
  "WantedBy=multi-user.target" | sudo tee /etc/systemd/system/excalidraw-shortcode.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now excalidraw-shortcode.service

echo "== checks =="
sleep 5
curl -s -o /dev/null -w "app: %{http_code}\n" http://localhost:3000/
curl -s -o /dev/null -w "shortcode svc: %{http_code}\n" http://localhost:3003/
sudo podman ps --format "{{.Names}}  {{.Status}}"
