#!/bin/bash
# One-shot redeploy of the forked app + shortcode service + caddy route.
set -euo pipefail
BASE=~/excalidraw
cd "$BASE"

echo "== 1/5 fresh fork clone =="
rm -rf fork
git clone -q fork.bundle fork -b selfhost

echo "== 2/5 image build (yarn layers cached; src-only changes) =="
(cd fork && sudo podman build -t excalidraw-selfhost .)

echo "== 3/5 shortcode service (codes persisted to ./shortcode-data/codes.json) =="
sudo podman rm -f excalidraw-shortcode 2>/dev/null || true
mkdir -p "$BASE/shortcode-data"
sudo podman run -d --name excalidraw-shortcode --restart always --network host \
  -e PORT=3003 \
  -v "$BASE/shortcode-data:/data" \
  -v "$BASE/shortcode-server.js:/srv/server.js:ro" \
  docker.io/library/node:20-alpine node /srv/server.js

echo "== 4/5 caddy route update + restart =="
FQDN=$(tailscale status --json | grep -o '"DNSName": *"steamdeck[^"]*"' | head -1 | sed 's/.*: *"//; s/"$//; s/\.$//')
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
  handle /socket.io/* {
    reverse_proxy localhost:3002
  }
  handle {
    reverse_proxy localhost:3000
  }
}
CDATA
sudo podman restart excalidraw-shortcode 2>/dev/null || true
sudo podman restart excalidraw-shortcode 2>/dev/null || true
sudo podman restart excalidraw-caddy

echo "== 5/5 app container swap =="
sudo podman rm -f excalidraw 2>/dev/null || true
sudo podman run -d --name excalidraw --restart always --network host \
  -e FQDN_HOST="$FQDN" \
  excalidraw-selfhost \
  sh -c 'find /etc/nginx -name "*.conf" -exec sed -i -E "s/listen[[:space:]]+80([^0-9])/listen 3000\\1/" {} + && \
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
