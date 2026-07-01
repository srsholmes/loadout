#!/bin/sh
# Restart both loadout services in the right order:
#   1. loadout.service   — the ROOT backend system service (re-bundles plugins
#                          from the staged source; needs sudo).
#   2. loadout-overlay   — the user-session overlay (CEF). The backend restart
#                          drops its RPC connection, so it must bounce too to
#                          reconnect and re-fetch plugin bundles.
#
# Use after re-staging plugins (scripts/prepare-plugins.sh) or a rebuild so the
# changes actually go live.
#
# The backend restart needs sudo. If you've run
# scripts/enable-sudoless-loadout.sh it won't prompt; otherwise sudo asks for
# your password once. Run this as your normal user (NOT via sudo) so the
# `systemctl --user` step targets your session.
set -eu

if [ "$(id -u)" = "0" ]; then
    echo "ERROR: run as your normal user, not root/sudo (it sudo's the backend step itself)." >&2
    exit 1
fi

echo "Restarting backend (loadout.service)…"
sudo systemctl restart loadout.service

echo "Restarting overlay (loadout-overlay)…"
systemctl --user restart loadout-overlay

# Let both settle, then report status.
sleep 2
BACKEND="$(systemctl is-active loadout.service 2>/dev/null || true)"
OVERLAY="$(systemctl --user is-active loadout-overlay 2>/dev/null || true)"
echo "backend:  $BACKEND"
echo "overlay:  $OVERLAY"

if [ "$BACKEND" = "active" ] && [ "$OVERLAY" = "active" ]; then
    echo "Both services restarted."
else
    echo "WARNING: a service is not active — check 'systemctl status loadout.service' / 'systemctl --user status loadout-overlay'." >&2
    exit 1
fi
