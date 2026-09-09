#!/bin/bash
# Restores tailnet routes shadowed by proxy/TUN apps (Happ/Xray etc.)
# Idempotent: only adds routes that are missing or misrouted.

LOG="/var/log/ts_routes_fix.log"
ts() { date "+%F %T"; }
log() { echo "$(ts) $*" >> "$LOG" 2>/dev/null; }

# Discover the tailscale utun interface robustly: it's the interface that a
# /32 route to our own tailnet IP (100.89.x) resolves through.
TAILSCALE_IF=$(route -n get 100.64.0.11 2>/dev/null | awk '/interface:/{print $2}')
if [ -z "$TAILSCALE_IF" ]; then
  log "no tailscale interface (route to own tailnet IP unresolved) — skipping"
  exit 0
fi

# 1. whole-CGNAT route to the tailscale utun (fixes 100.64/10 → en0 shadowing)
CURRENT_IF=$(route -n get 100.64.0.10 2>/dev/null | awk '/interface:/{print $2}')
if [ "$CURRENT_IF" = "$TAILSCALE_IF" ]; then
  exit 0   # already correct, silent no-op
fi

route -n delete -net 100.64.0.0/10 >/dev/null 2>&1
route add -net 100.64.0.0/10 -interface "$TAILSCALE_IF" >/dev/null 2>&1

CUR_AFTER=$(route -n get 100.64.0.10 2>/dev/null | awk '/interface:/{print $2}')
log "route 100.64/10 was '$CURRENT_IF', re-added via '$TAILSCALE_IF'; now: '$CUR_AFTER'"
