#!/bin/sh
# Install the Loadout overlay from the local build tree.
#
# Copies the Electrobun bundle + plugin tree to ~/.local/share/loadout/,
# installs the systemd user unit, and starts it.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

INSTALL_DIR="$HOME/.local/share/loadout"
SERVICE_DIR="$HOME/.config/systemd/user"

# Pick the right Electrobun build output. `--release` produces
# build/release-linux-<arch>/loadout/, `--dev` (default) produces
# build/dev-linux-<arch>/loadout/.
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) EB_ARCH="x64" ;;
  aarch64) EB_ARCH="arm64" ;;
  *) echo "Unsupported arch: $ARCH"; exit 1 ;;
esac

BUILD_BASE="$PROJECT_ROOT/apps/overlay/build"
RELEASE_DIR="$BUILD_BASE/release-linux-$EB_ARCH/loadout"
DEV_DIR="$BUILD_BASE/dev-linux-$EB_ARCH/loadout-dev"

if [ -d "$RELEASE_DIR" ] && [ -x "$RELEASE_DIR/bin/launcher" ]; then
  SOURCE_DIR="$RELEASE_DIR"
elif [ -d "$DEV_DIR" ] && [ -x "$DEV_DIR/bin/launcher" ]; then
  SOURCE_DIR="$DEV_DIR"
else
  echo "ERROR: no Electrobun build at $RELEASE_DIR or $DEV_DIR" >&2
  echo "Run 'bun run build' first." >&2
  exit 1
fi

echo "Installing from: $SOURCE_DIR"

# Stop existing service before swapping files.
systemctl --user stop loadout 2>/dev/null || true

# Wipe + reinstall the bundle.
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cp -a "$SOURCE_DIR/." "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/bin/launcher"
echo "Installed launcher: $INSTALL_DIR/bin/launcher"

# Stage the plugin tree side-by-side with the binary. The Bun-side
# server reads from LOADOUT_PLUGINS_DIR (set in the unit file below).
PLUGINS_SRC="$PROJECT_ROOT/plugins"
PLUGINS_DST="$INSTALL_DIR/plugins"
mkdir -p "$PLUGINS_DST"
for plugin in "$PLUGINS_SRC"/*/; do
  [ -d "$plugin" ] || continue
  name="$(basename "$plugin")"
  echo "Copying plugin: $name"
  rm -rf "$PLUGINS_DST/$name"
  cp -a "$plugin" "$PLUGINS_DST/$name"
  # Keep .cache/backend.bundle.js — it's the pre-bundled backend produced
  # by scripts/build.sh, and the install layout has no workspace node_modules
  # to fall back on at runtime.
  rm -rf "$PLUGINS_DST/$name/node_modules"
  if [ -f "$plugin/backend.ts" ] && [ ! -f "$PLUGINS_DST/$name/.cache/backend.bundle.js" ]; then
    echo "ERROR: $name has backend.ts but no .cache/backend.bundle.js." >&2
    echo "Run 'bash scripts/build.sh' before install — it pre-bundles plugin backends." >&2
    exit 1
  fi
done

# Install systemd unit.
mkdir -p "$SERVICE_DIR"
cp "$PROJECT_ROOT/loadout.service" "$SERVICE_DIR/loadout.service"

systemctl --user daemon-reload
systemctl --user enable loadout

# Propagate gamescope/X11/Wayland env into the user systemd manager so the
# overlay service inherits DISPLAY/GAMESCOPE_DISPLAY/etc. Without this the
# Bun-side gamescope detection sees an empty env and falls back to desktop
# mode even under a gamescope session.
if [ -n "${GAMESCOPE_DISPLAY:-}${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  systemctl --user import-environment \
    DISPLAY WAYLAND_DISPLAY \
    GAMESCOPE_DISPLAY GAMESCOPE_WAYLAND_DISPLAY \
    XDG_RUNTIME_DIR XDG_SESSION_TYPE \
    XAUTHORITY 2>/dev/null || true
fi

systemctl --user restart loadout

echo "Done. Check status: systemctl --user status loadout"
echo "Logs:               journalctl --user -u loadout -f"

# Steam Deck back-paddle wake hint. The Deck's controller HID is owned by
# Steam Input under gamescope; the only way to fire an evdev key event the
# overlay can see is to route a button through InputPlumber → F16. That
# requires root, so install-local.sh (user-level) can't do it itself.
PRODUCT="$(cat /sys/class/dmi/id/product_name 2>/dev/null || true)"
VENDOR="$(cat /sys/class/dmi/id/sys_vendor 2>/dev/null || true)"
case "$VENDOR/$PRODUCT" in
  Valve/Galileo|Valve/Jupiter)
    if [ ! -f /etc/systemd/system/loadout-ip-profile.service ]; then
      echo
      echo "Steam Deck detected ($PRODUCT). To toggle the overlay from a back paddle:"
      echo "  sudo bash $PROJECT_ROOT/scripts/setup-deck.sh"
      echo
      echo "(Reboot after; defaults to all four paddles. See docs/steam-deck-overlay-trigger.md.)"
    fi
    ;;
esac
