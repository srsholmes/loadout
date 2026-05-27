#!/usr/bin/env bash
#
# Dev mode: starts the Bun backend server + Electrobun overlay with
# hot-reload. Ctrl+C kills both processes.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PORT="${LOADOUT_PORT:-33820}"

cleanup() {
  echo "[dev] Shutting down..."
  kill $SERVER_PID 2>/dev/null || true
  kill $OVERLAY_PID 2>/dev/null || true
  wait 2>/dev/null
}
trap cleanup EXIT

# Kill anything on the port already
fuser -k "${PORT}/tcp" 2>/dev/null || true
sleep 0.5

# Start Bun backend server
echo "[dev] Starting Bun server on port ${PORT}..."
bun run "$PROJECT_DIR/apps/loadout/src/index.ts" &
SERVER_PID=$!

# Wait for server to be ready
for i in $(seq 1 30); do
  if curl -sf "http://localhost:${PORT}/up" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! curl -sf "http://localhost:${PORT}/up" >/dev/null 2>&1; then
  echo "[dev] Server failed to start"
  exit 1
fi

echo "[dev] Bun server ready"

# Start Electrobun in dev mode (includes vite for the webview side).
echo "[dev] Starting Electrobun..."
cd "$PROJECT_DIR/apps/loadout-overlay"

if pgrep -f "gamescope[- ]" >/dev/null 2>&1; then
  echo "[dev] Gamescope detected"
  # Overlay must run on gamescope's inner X (same display as Steam).
  # In a desktop terminal DISPLAY is usually :1 (KDE outer); Steam +
  # gamescope use :0 (inner). Read Steam's DISPLAY to match.
  STEAM_PID=$(pgrep -x steam | head -1)
  if [ -n "$STEAM_PID" ]; then
    STEAM_DISPLAY=$(cat /proc/$STEAM_PID/environ 2>/dev/null | tr '\0' '\n' | grep '^DISPLAY=' | cut -d= -f2)
    if [ -n "$STEAM_DISPLAY" ] && [ "$STEAM_DISPLAY" != "${DISPLAY:-}" ]; then
      echo "[dev] Overriding DISPLAY=${DISPLAY:-} -> $STEAM_DISPLAY (matching Steam)"
      export DISPLAY="$STEAM_DISPLAY"
    fi
  fi
fi

# CEF remote DevTools — connect from any Chromium at http://localhost:9222
echo "[dev] CEF DevTools available at http://localhost:9222 (see chromiumFlags in electrobun.config.ts)"

bunx electrobun dev &
OVERLAY_PID=$!

echo "[dev] Electrobun dev running. Ctrl+C to stop."
wait
