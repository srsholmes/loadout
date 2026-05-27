#!/bin/sh
# Install Loadout from local build output (dist/)
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$PROJECT_ROOT/dist"
INSTALL_DIR="$HOME/.local/share/loadout"
OVERLAY_INSTALL_DIR="$HOME/.local/share/loadout-overlay"
OVERLAY_BUILD_DIR="$PROJECT_ROOT/apps/loadout-overlay/build/dev-linux-x64/loadout-overlay-dev"
SERVICE_DIR="$HOME/.config/systemd/user"
LEGACY_OVERLAY_INSTALL_DIR="$HOME/.local/share/loadout-overlay-electrobun"

if [ ! -f "$DIST_DIR/loadout" ]; then
    echo "ERROR: dist/loadout not found. Run 'bun run build' first."
    exit 1
fi

# Stop existing services. Includes the transitional Electrobun unit
# name (loadout-overlay-electrobun) so pre-collapse installs
# upgrade cleanly — both units would otherwise race for evdev grabs.
systemctl --user stop loadout-overlay 2>/dev/null || true
systemctl --user stop loadout-overlay-electrobun 2>/dev/null || true
systemctl --user stop loadout 2>/dev/null || true

# Copy binaries
mkdir -p "$INSTALL_DIR/plugins"
cp "$DIST_DIR/loadout" "$INSTALL_DIR/loadout"
chmod +x "$INSTALL_DIR/loadout"
echo "Installed $INSTALL_DIR/loadout"

# Smoke-check the just-copied binary. A truncated / corrupted build still
# passes cp + chmod, then the service silently fails on next start with
# a confusing "Exec format error" or similar. Catch that here so the
# operator gets a clear error pointing at re-running the build, instead
# of a cryptic systemd failure later. Audit 2026-05 H-008.
#
# `set -e` would exit on `--version` failure before we got a chance to
# print a nice error, so capture stdout+stderr+rc explicitly and gate
# the failure ourselves.
SMOKE_OUT=""
SMOKE_RC=0
SMOKE_OUT="$("$INSTALL_DIR/loadout" --version 2>&1)" || SMOKE_RC=$?
if [ "$SMOKE_RC" -ne 0 ]; then
    echo "ERROR: '$INSTALL_DIR/loadout --version' exited $SMOKE_RC." >&2
    echo "       Output: $SMOKE_OUT" >&2
    echo "       The binary may be corrupted or truncated. Re-run 'bun run build'." >&2
    exit 1
fi
# Recognisable line is "loadout <version>" — see apps/loadout/src/index.ts
if ! printf '%s' "$SMOKE_OUT" | grep -q '^loadout '; then
    echo "ERROR: '$INSTALL_DIR/loadout --version' did not print a recognisable version line." >&2
    echo "       Got: $SMOKE_OUT" >&2
    echo "       Re-run 'bun run build' to produce a fresh dist/loadout." >&2
    exit 1
fi
echo "Smoke check OK: $SMOKE_OUT"

# Stage the plugin tree + a single hoisted node_modules/ shared by every
# plugin. The PR-48 design: one copy of react / react-dom / scheduler /
# react-icons / @loadout/* at the install root, resolved upward by
# Bun.build() at runtime. Avoids the ~1.85 GB duplication from copying
# react-icons into each of 22 plugins' own node_modules.
sh "$SCRIPT_DIR/prepare-plugins.sh" "$INSTALL_DIR"

# Install the overlay tree. The Electrobun build produces Resources/,
# bin/ with CEF libs, symlinks to libcef.so, etc. — not a single
# binary — so we copy the whole tree to its own prefix.
if [ -d "$OVERLAY_BUILD_DIR" ] && [ -x "$OVERLAY_BUILD_DIR/bin/launcher" ]; then
    # Legacy-path cleanup: earlier installs landed under a
    # "-electrobun" suffix. Nuking it here prevents stale binaries
    # from ever getting picked up by misconfigured unit overrides.
    if [ -d "$LEGACY_OVERLAY_INSTALL_DIR" ]; then
        echo "Removing legacy install at $LEGACY_OVERLAY_INSTALL_DIR..."
        rm -rf "$LEGACY_OVERLAY_INSTALL_DIR"
    fi
    echo "Installing overlay to $OVERLAY_INSTALL_DIR..."
    rm -rf "$OVERLAY_INSTALL_DIR"
    mkdir -p "$OVERLAY_INSTALL_DIR"
    # Preserve symlinks + executable bits from the build tree.
    cp -a "$OVERLAY_BUILD_DIR/." "$OVERLAY_INSTALL_DIR/"
    chmod +x "$OVERLAY_INSTALL_DIR/bin/launcher"
    echo "Installed $OVERLAY_INSTALL_DIR/"
else
    echo "ERROR: overlay build not found at $OVERLAY_BUILD_DIR. Run 'bun run build' first." >&2
    exit 1
fi

# Copy service files. The Electrobun-named unit (loadout-overlay-
# electrobun.service) from the previous transitional layout is removed
# on every install; we now ship a single loadout-overlay.service.
mkdir -p "$SERVICE_DIR"
cp "$PROJECT_ROOT/loadout.service" "$SERVICE_DIR/loadout.service"
cp "$PROJECT_ROOT/loadout-overlay.service" "$SERVICE_DIR/loadout-overlay.service"
rm -f "$SERVICE_DIR/loadout-overlay-electrobun.service"

# Disable + enable what we actually want running. daemon-reload picks
# up the rewritten unit file so `restart` below uses the new paths.
systemctl --user disable loadout-overlay-electrobun 2>/dev/null || true
systemctl --user daemon-reload
systemctl --user enable loadout
systemctl --user enable loadout-overlay
systemctl --user restart loadout

# Wait for the plugin server to be up before kicking the overlay so
# the webview doesn't race its initial fetch. Honour LOADOUT_PORT
# so the wait targets the same port the server is actually bound to
# (Audit 2026-05 H-006).
PORT="${LOADOUT_PORT:-33820}"
echo "Waiting for server on port ${PORT}..."
for i in $(seq 1 30); do
    curl -sf "http://localhost:${PORT}/up" >/dev/null 2>&1 && break
    sleep 1
done

systemctl --user restart loadout-overlay
echo "Services restarted."
