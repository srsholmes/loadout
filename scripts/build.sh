#!/bin/sh
# Loadout build script.
#
# Loadout ships as a single Electrobun bundle. The Bun-side main process
# spawns @loadout/server in-process, so there's no separate `bun build
# --compile` step — Vite + Electrobun handle everything.
#
# Output: apps/overlay/build/dev-linux-x64/loadout/  (full Electrobun tree)
#
# Prereqs: Bun >= 1.3, dependencies installed (bun install at repo root).

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OVERLAY_DIR="$PROJECT_ROOT/apps/overlay"

if [ -t 1 ]; then
  GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
else
  GREEN=''; BLUE=''; YELLOW=''; RED=''; NC=''
fi

info()    { printf "${BLUE}[BUILD]${NC} %s\n" "$1"; }
success() { printf "${GREEN}[OK]${NC} %s\n" "$1"; }
warn()    { printf "${YELLOW}[WARN]${NC} %s\n" "$1"; }
err()     { printf "${RED}[ERROR]${NC} %s\n" "$1" >&2; }

command -v bun >/dev/null 2>&1 || { err "Bun is not installed. Install from https://bun.sh"; exit 1; }

VERSION="$(grep '"version"' "$PROJECT_ROOT/package.json" 2>/dev/null | head -1 | sed 's/.*"version": *"//;s/".*//')"
[ -z "$VERSION" ] && VERSION="dev"
ARCH="$(uname -m)"

info "Loadout build"
info "  Version:  $VERSION"
info "  Arch:     $ARCH"
info "  Overlay:  $OVERLAY_DIR"

if [ ! -d "$PROJECT_ROOT/node_modules" ]; then
  warn "node_modules missing — running bun install..."
  (cd "$PROJECT_ROOT" && bun install)
fi

info "Building webview (vite)..."
(cd "$OVERLAY_DIR" && bunx vite build)

info "Bundling overlay (electrobun)..."
RELEASE_FLAG=""
case "${1:-}" in
  --release) RELEASE_FLAG="--release" ;;
esac
(cd "$OVERLAY_DIR" && bunx electrobun build $RELEASE_FLAG)

success "Build complete. Tree under: $OVERLAY_DIR/build/"
