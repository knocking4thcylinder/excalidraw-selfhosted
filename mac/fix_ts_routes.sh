#!/bin/bash
# Assert /32 routes for every peer in `tailscale status`, keeping them pointed
# at the current tailscale utun interface. /32 host routes are the most specific
# possible, so no proxy/TUN app (Happ, Xray, etc.) can shadow them.
# Runs as root from LaunchDaemon (com.fixtsroutes.plist, every 20s).
#
# Lesson 2026-09: this ran SILENTLY DEAD for 3 days (bare `tailscale` not on
# the daemon PATH + hardcoded self-IP + silent exits). Now: explicit binary
# discovery, dynamic self-IP, and once-per-boot loud errors instead of silence.

LOG="/var/log/ts_routes_fix.log"
ts() { date "+%F %T"; }
log() { echo "$(ts) $*" >> "$LOG" 2>/dev/null; }

# notify-once-per-boot helper (markers live in /tmp: cleared on reboot)
notify_once() { # key, message...
  local key="$1"; shift
  [ -f "/tmp/tsroutes-$key" ] && return 0
  log "ERROR: $*"
  touch "/tmp/tsroutes-$key" 2>/dev/null || true
}

export PATH="/opt/homebrew/opt/tailscale/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
TS="$(command -v tailscale 2>/dev/null || true)"
if [ -z "$TS" ]; then
  notify_once "no-binary" "tailscale binary not found on PATH ($PATH)"
  exit 1
fi

SELF="$("$TS" ip -4 2>/dev/null | head -1)"
if [ -z "$SELF" ]; then
  notify_once "no-selfip" "tailscale up but no self IPv4 (logged out?)"
  exit 1
fi

# 1. tailscale utun interface = whatever the route to our own tailnet IP uses
TAILSCALE_IF=$(route -n get "$SELF" 2>/dev/null | awk '/interface:/{print $2}')
if [ -z "$TAILSCALE_IF" ]; then
  notify_once "no-utun" "no route to self $SELF yet (tailscale starting?)"
  exit 0
fi

# 2. every peer IP currently known (other than ourselves)
PEERS=$("$TS" status 2>/dev/null | awk -v self="$SELF" '$1 ~ /^100\./ && $1 != self {print $1}')
if [ -z "$PEERS" ]; then
  exit 0   # nothing to fix (peers show up with delay after login)
fi

# healthy run: clear any past once-per-boot notifications
rm -f /tmp/tsroutes-no-binary /tmp/tsroutes-no-selfip /tmp/tsroutes-no-utun 2>/dev/null || true

for IP in $PEERS; do
  CUR_IF=$(route -n get "$IP" 2>/dev/null | awk '/interface:/{print $2}')
  [ "$CUR_IF" = "$TAILSCALE_IF" ] && continue
  route -n delete -host "$IP" >/dev/null 2>&1
  OUT=$(route add -host "$IP" -interface "$TAILSCALE_IF" 2>&1) || true
  AFT_IF=$(route -n get "$IP" 2>/dev/null | awk '/interface:/{print $2}')
  log "peer $IP was '$CUR_IF' → route add: [$OUT] (now: '$AFT_IF')"
done
exit 0
