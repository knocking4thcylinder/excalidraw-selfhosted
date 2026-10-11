#!/bin/bash
# Mac-side setup: persistent Tailscale route fixer + hosts entry
# Usage: sudo ./install-mac.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

# 1. route-fixer daemon
install -m 755 "$HERE/fix_ts_routes.sh" /usr/local/sbin/fix_ts_routes.sh
cp "$HERE/com.fixtsroutes.plist" /Library/LaunchDaemons/com.fixtsroutes.plist
chown root:wheel /Library/LaunchDaemons/com.fixtsroutes.plist
launchctl bootstrap system /Library/LaunchDaemons/com.fixtsroutes.plist 2>/dev/null || true
launchctl enable system/user.fixtsroutes 2>/dev/null || true
launchctl kickstart system/user.fixtsroutes 2>/dev/null || true

# 2. hosts entry for the current Deck name (edit/remove if FQDN changes)
FQDN_DEFAULT="steamdeck.example.ts.net"
read -rp "Deck MagicDNS name [$FQDN_DEFAULT]: " FQDN
FQDN="${FQDN:-$FQDN_DEFAULT}"

if ! grep -qwF "$FQDN" /etc/hosts; then
  # discover the Deck's tailnet IP via tailscale on this Mac (works even without sudo)
  TIP=$(tailscale status 2>/dev/null | awk -v n="${FQDN%%.*}" '$2 == n && $1 ~ /^100\./ {print $1; exit}')
  [ -z "$TIP" ] && read -rp "Tailscale IP for $FQDN: " TIP
  [ -z "$TIP" ] && { echo "no IP, skipping hosts entry"; exit 0; }
  echo "$TIP $FQDN" | tee -a /etc/hosts
fi

echo "== installed =="
echo "route daemon: launchctl list | grep fixtsroutes"
grep "$FQDN" /etc/hosts
