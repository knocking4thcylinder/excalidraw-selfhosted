#!/bin/bash
# Restores tailnet routes shadowed by proxy/TUN apps (Happ/Xray etc.)
# Idempotent: only adds routes that are missing or misrouted.

LOG="/var/log/ts_routes_fix.log"
ts() { date "+%F %T"; }
log() { echo "$(ts) $*" >> "$LOG" 2>/dev/null; }

TAILSCALE_IF=$(ifconfig 2>/dev/null | awk -F: '/^utun[0-9]+:/{i=$1; getline; if ($0 ~ /inet 100\./) {gsub(":","",i); print i; exit}}')
if [ -z "$TAILSCALE_IF" ]; then
  log "no tailscale utun interface with 100.x address yet — skipping"
  exit 0
fi

# 1. whole-CGNAT route to tailscale utun (fixes 100.64/10 → en0 shadowing)
WANT_ROUTE="100.64.0.0/10"
TARGET_IF="$TAILSCALE_IF"
CURRENT_IF=$(route -n get "$WANT_ROUTE_NET" 2>/dev/null | awk '/interface:/{print $2}')
WANT_ROUTE_NET=100.64.0.0/10
CURRENT_IF=$(route -n get 100.64.0.10 2>/dev/null | awk '/interface:/{print $2}')

if [ "$CURRENT_IF" = "$TARGET_IF" ]; then
  exit 0   # already correct, silent no-op
fi

# remove wrong/broad route if owned by other interface
route -n delete "$WANT_ROUTE_NET" >/dev/null 2>&1
route add -net "$WANT_ROUTE_NET" -interface "$TARGET_IF" >/dev/null 2>&1

CUR_AFTER=$(route -n get 100.64.0.0/10 2>/dev/null | awk '/interface:/{print $2}')
log "route 100.64/10 was '$CURRENT_IF', added via '$TARGET_IF'; now: '$CUR_AFTER'"
