#!/bin/bash
# Assert /32 routes for every peer in `tailscale status`, keeping them pointed
# at the current tailscale utun interface. /32 host routes are the most specific
# possible, so no proxy/TUN app (Happ, Xray, etc.) can shadow them.
# Runs as root from LaunchDaemon (com.fixtsroutes.plist, every 20s).

LOG="/var/log/ts_routes_fix.log"
ts() { date "+%F %T"; }
log() { echo "$(ts) $*" >> "$LOG" 2>/dev/null; }

# 1. tailscale utun interface = whatever the /32 route to our own tailnet IP goes through
TAILSCALE_IF=$(route -n get 100.64.0.11 2>/dev/null | awk '/interface:/{print $2}')
if [ -z "$TAILSCALE_IF" ]; then
  exit 0   # tailscale not up yet; silent
fi

# 2. every peer IP currently known
PEERS=$(tailscale status 2>/dev/null | awk '$1 ~ /^100\./ && $1 != "100.64.0.11" {print $1}')
[ -z "$PEERS" ] && exit 0

for IP in $PEERS; do
  CUR_IF=$(route -n get "$IP" 2>/dev/null | awk '/interface:/{print $2}')
  [ "$CUR_IF" = "$TAILSCALE_IF" ] && continue
  route -n delete -host "$IP" >/dev/null 2>&1
  route add -host "$IP" -interface "$TAILSCALE_IF" >/dev/null 2>&1
  AFT_IF=$(route -n get "$IP" 2>/dev/null | awk '/interface:/{print $2}')
  log "peer route $IP was '$CUR_IF' → re-added via '$TAILSCALE_IF' (now: '$AFT_IF')"
done
exit 0
