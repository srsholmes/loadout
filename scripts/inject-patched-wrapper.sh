#!/bin/sh
# Inject the patched libNativeWrapper.so over the stock one that
# `electrobun build` downloads. The patched wrapper fixes a 100%-CPU busy-loop
# in CEF's browser process — see apps/loadout-overlay/vendor/README.md for the
# root cause and how the binary is produced.
#
# This is the single source of truth for the swap, called from every build
# entry point (scripts/build.sh and apps/loadout-overlay's package.json build
# scripts) so no path can silently ship the stock (spinning) wrapper. Run it
# AFTER `electrobun build`. POSIX-sh, guarded, and idempotent: a missing vendor
# file just warns and leaves the stock wrapper in place.
#
# Usage: inject-patched-wrapper.sh [OVERLAY_APP_DIR]
#   OVERLAY_APP_DIR defaults to the apps/loadout-overlay sibling of this
#   script's directory, so it works regardless of the caller's cwd.
set -eu

if [ -n "${1:-}" ]; then
    ELECTROBUN_DIR="$1"
else
    SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
    ELECTROBUN_DIR="$SCRIPT_DIR/../apps/loadout-overlay"
fi

PATCHED="$ELECTROBUN_DIR/vendor/libNativeWrapper.so"
if [ ! -f "$PATCHED" ]; then
    echo "[inject-wrapper] WARNING: no vendored wrapper at $PATCHED — using stock wrapper (overlay will spin at 100% CPU)." >&2
    exit 0
fi

# The build emits the wrapper under build/<variant>/loadout-overlay-*/bin/.
# Replace every libNativeWrapper*.so the build produced (the runtime dlopen's
# libNativeWrapper.so; the _cef.so variant, if present, is harmless to match).
# Build paths contain no spaces, so an unquoted find expansion is safe here.
injected=0
for so in $(find "$ELECTROBUN_DIR/build" -type f -name 'libNativeWrapper*.so' 2>/dev/null); do
    cp -f "$PATCHED" "$so"
    injected=$((injected + 1))
done

if [ "$injected" -gt 0 ]; then
    echo "[inject-wrapper] injected patched libNativeWrapper.so into $injected build artifact(s) (CEF CPU-spin fix)."
else
    echo "[inject-wrapper] WARNING: patched wrapper present but no build artifact found under $ELECTROBUN_DIR/build — did 'electrobun build' run?" >&2
fi
