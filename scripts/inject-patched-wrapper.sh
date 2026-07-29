#!/bin/sh
# Post-build fixes injected over the artifacts `electrobun build` downloads.
#
#   1. Patched libNativeWrapper.so — fixes a 100%-CPU busy-loop in CEF's
#      browser process; see apps/loadout-overlay/vendor/README.md for the
#      root cause and how the binary is produced.
#   2. libstdc++ preload shim around the bun binary — see the comment at
#      that step below.
#
# This is the single source of truth for both, called from every build
# entry point (scripts/build.sh and apps/loadout-overlay's package.json build
# scripts) so no path can silently ship the stock artifacts. Run it
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

# --- libstdc++ preload shim -------------------------------------------------
# libNativeWrapper.so links webkit2gtk even in CEF mode, which pulls
# libjavascriptcoregtk into the overlay process ahead of libstdc++. Arch's
# webkit2gtk 2.52.5-1 regressed to EXPORTING libstdc++'s std::call_once
# internals (__once_proxy / __once_callable / __once_call) from JSC, so
# libstdc++'s own __once_proxy reads JSC's TLS slot while a deepbind-scoped
# writer (mesa's libLLVM, during radeonsi shader-compiler init) writes
# libstdc++'s — the callback reads back NULL and the process jumps to 0x0.
# Symptom: the overlay segfaults ~200ms in during CEF GL init on AMD.
#
# Preloading the real libstdc++ puts it first in the global lookup scope, so
# every object binds the once-machinery to the same copy and the split brain
# is gone. Bare soname so the loader resolves the right path per distro
# (/usr/lib on Arch, /usr/lib64 on Fedora/Bazzite). Harmless where the bug
# is absent: libstdc++ is in the process either way.
#
# The launcher REPLACES LD_PRELOAD for its bun child (upstream electrobun
# issue), so a unit-level Environment= can't reach the process that matters —
# hence this shim wrapping the bun binary itself. The real fix is rebuilding
# the wrapper without the webkit link; patchelf --remove-needed does NOT work
# (Zig emits eager GLOB_DAT relocs for address-taken webkit symbols).
# This step runs before the wrapper guard below so it applies even when the
# vendored wrapper is absent.
# The CEF tree contains space-laden names ("bun Helper (Renderer)", …), so
# iterate the find output line-by-line rather than word-splitting it.
shimmed=0
while IFS= read -r bun; do
    [ -n "$bun" ] || continue
    # Idempotent: skip if this bun is already our shim script.
    if head -c2 "$bun" 2>/dev/null | grep -q '#!'; then
        continue
    fi
    mv "$bun" "$bun.real"
    cat > "$bun" <<'SHIM'
#!/bin/sh
# libstdc++ must win symbol interposition over webkit2gtk's JSC, which
# (as of Arch webkit2gtk 2.52.5-1) leaks libstdc++'s std::call_once
# internals and splits its TLS state — crashing mesa's LLVM init on
# radeonsi. Preloading the real libstdc++ restores consistent bindings.
# See scripts/inject-patched-wrapper.sh for the full story.
export LD_PRELOAD="libstdc++.so.6${LD_PRELOAD:+:$LD_PRELOAD}"
exec "$(dirname "$0")/bun.real" "$@"
SHIM
    chmod +x "$bun"
    shimmed=$((shimmed + 1))
done <<EOF
$(find "$ELECTROBUN_DIR/build" -type f -name bun -path '*/bin/*' 2>/dev/null)
EOF

if [ "$shimmed" -gt 0 ]; then
    echo "[inject-wrapper] installed libstdc++ preload shim over $shimmed bun binary(ies) (webkit2gtk JSC __once_proxy interposition fix)."
fi

PATCHED="$ELECTROBUN_DIR/vendor/libNativeWrapper.so"
if [ ! -f "$PATCHED" ]; then
    echo "[inject-wrapper] WARNING: no vendored wrapper at $PATCHED — using stock wrapper (overlay will spin at 100% CPU)." >&2
    exit 0
fi

# The build emits the wrapper under build/<variant>/loadout-overlay-*/bin/.
# Replace every libNativeWrapper*.so the build produced (the runtime dlopen's
# libNativeWrapper.so; the _cef.so variant, if present, is harmless to match).
# Line-by-line for the same space-safety reason as the shim loop above.
injected=0
while IFS= read -r so; do
    [ -n "$so" ] || continue
    cp -f "$PATCHED" "$so"
    injected=$((injected + 1))
done <<EOF
$(find "$ELECTROBUN_DIR/build" -type f -name 'libNativeWrapper*.so' 2>/dev/null)
EOF

if [ "$injected" -gt 0 ]; then
    echo "[inject-wrapper] injected patched libNativeWrapper.so into $injected build artifact(s) (CEF CPU-spin fix)."
else
    echo "[inject-wrapper] WARNING: patched wrapper present but no build artifact found under $ELECTROBUN_DIR/build — did 'electrobun build' run?" >&2
fi
