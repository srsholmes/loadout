#!/bin/sh
# Install Loadout from local build output (dist/)
set -e

# Run as your normal user — NOT via sudo. The backend is installed as a
# root *system* service, but the script elevates only the few steps that
# need it (via `sudo` internally). Running the whole thing as root would
# resolve $HOME / `id -un` to root and bake the wrong paths into the unit.
if [ "$(id -u)" = "0" ]; then
    echo "ERROR: run this as your normal user, not root/sudo." >&2
    echo "       It will prompt for sudo only for the system-service step." >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$PROJECT_ROOT/dist"
INSTALL_DIR="$HOME/.local/share/loadout"
OVERLAY_INSTALL_DIR="$HOME/.local/share/loadout-overlay"
OVERLAY_BUILD_DIR="$PROJECT_ROOT/apps/loadout-overlay/build/dev-linux-x64/loadout-overlay-dev"
SERVICE_DIR="$HOME/.config/systemd/user"

if [ ! -f "$DIST_DIR/loadout" ]; then
    echo "ERROR: dist/loadout not found. Run 'bun run build' first."
    exit 1
fi

# Stop running services before we replace their files. The backend used
# to be a `--user` service; it's now a root system unit, so stop the old
# user one here (the system one is restarted at the end).
systemctl --user stop loadout-overlay 2>/dev/null || true
systemctl --user stop loadout 2>/dev/null || true

# Pick the binary install path based on host distro — there is no single
# path that works everywhere. See docs/install-locations.md for the full
# rationale.
#
#   SteamOS — $INSTALL_DIR/loadout (under ~/.local/share):
#     /usr is read-only by default and `steamos-readonly disable` is the
#     wrong fix — the next SteamOS A/B image swap would wipe it. SteamOS
#     does NOT enforce SELinux, so the data_home_t / init_t exec restriction
#     that bites on Bazzite doesn't apply here, and a binary in the home
#     dir execs fine from a root unit. /home is persistent across SteamOS
#     image updates.
#
#   Bazzite / Fedora-ostree / generic (Arch, CachyOS, Ubuntu, ...) —
#   /usr/local/bin/loadout:
#     Writable on ostree systems (→ /var/usrlocal), labelled bin_t. Bazzite
#     runs SELinux in enforcing mode, where a root systemd unit (init_t) is
#     denied `execute` on a binary labelled data_home_t (everything under
#     ~/.local/share / ~/.config). The binary must live at a bin_t-labelled
#     system path — exactly like HHD's RPM-installed /usr/bin/hhd. On non-
#     SELinux distros it just works; same path keeps things consistent.
DISTRO_ID=""
[ -r /etc/os-release ] && DISTRO_ID="$(. /etc/os-release && printf '%s' "${ID:-}")"
case "$DISTRO_ID" in
    steamos)
        BIN_PATH="$INSTALL_DIR/loadout"
        BIN_NEEDS_SUDO=0
        ;;
    *)
        BIN_PATH="/usr/local/bin/loadout"
        BIN_NEEDS_SUDO=1
        ;;
esac

mkdir -p "$INSTALL_DIR/plugins"
# Remove any stale binary at the *other* possible location — handles
# users moving between distros (e.g. dual-booting SteamOS desktop mode
# into a Bazzite-installed copy) and the older "binary in $INSTALL_DIR"
# layout. Idempotent — the install step below puts a fresh one at the
# chosen $BIN_PATH for this distro.
if [ "$BIN_PATH" = "/usr/local/bin/loadout" ]; then
    rm -f "$INSTALL_DIR/loadout"
fi

# Smoke-check the freshly built binary BEFORE installing it system-wide.
# A truncated / corrupted build still copies fine, then the service
# silently fails on next start with a confusing "Exec format error".
# Catch it here with a clear pointer to re-run the build (Audit H-008).
# `set -e` would exit on `--version` failure before we print a nice
# error, so capture stdout+stderr+rc explicitly and gate it ourselves.
SMOKE_OUT=""
SMOKE_RC=0
SMOKE_OUT="$("$DIST_DIR/loadout" --version 2>&1)" || SMOKE_RC=$?
if [ "$SMOKE_RC" -ne 0 ]; then
    echo "ERROR: '$DIST_DIR/loadout --version' exited $SMOKE_RC." >&2
    echo "       Output: $SMOKE_OUT" >&2
    echo "       The binary may be corrupted or truncated. Re-run 'bun run build'." >&2
    exit 1
fi
# Recognisable line is "loadout <version>" — see apps/loadout/src/index.ts
if ! printf '%s' "$SMOKE_OUT" | grep -q '^loadout '; then
    echo "ERROR: '$DIST_DIR/loadout --version' did not print a recognisable version line." >&2
    echo "       Got: $SMOKE_OUT" >&2
    echo "       Re-run 'bun run build' to produce a fresh dist/loadout." >&2
    exit 1
fi
echo "Smoke check OK: $SMOKE_OUT"

# Install the binary at the chosen path. On a system path (/usr/local/bin)
# this needs sudo + restorecon to force the bin_t label so init_t can exec
# it even if the default context drifts. On SteamOS the binary lives in
# the user's home and is plain user-owned — no sudo, no SELinux concern.
if [ "$BIN_NEEDS_SUDO" = "1" ]; then
    echo "Installing the backend binary to $BIN_PATH (needs sudo)..."
    sudo install -m 0755 "$DIST_DIR/loadout" "$BIN_PATH"
    command -v restorecon >/dev/null 2>&1 && sudo restorecon -F "$BIN_PATH" 2>/dev/null || true
else
    echo "Installing the backend binary to $BIN_PATH (user-writable on this distro)..."
    install -m 0755 "$DIST_DIR/loadout" "$BIN_PATH"
fi
echo "Installed $BIN_PATH"

# The root service writes plugin build caches (.cache/) into this tree as
# root. Reclaim ownership before staging so the user-run prepare-plugins
# can overwrite them. Needs sudo; no-op on a fresh install.
sudo chown -R "$(id -un):$(id -gn)" "$INSTALL_DIR" 2>/dev/null || true

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

# SteamOS lacks libwebkit2gtk-4.1 (and the JSC + appindicator deps Electrobun's
# native wrapper dlopens at startup). Fetch the closure from a Fedora container
# the first time and cache the tarball; subsequent installs reuse it. No-op on
# Bazzite/CachyOS/Fedora — those ship the libs in the base image.
sh "$SCRIPT_DIR/fetch-deck-overlay-libs.sh" "$OVERLAY_INSTALL_DIR/bin"

# --- Steam CEF remote debugging ---
# Drop the empty `.cef-enable-remote-debugging` marker in Steam's root so
# Steam opens its Chromium DevTools Protocol endpoint on localhost:8080.
# Same mechanism Decky Loader uses. The overlay needs it to close the QAM
# via CDP before claiming gamescope overlay focus (without it gamescope
# gets into a focus-fight that can freeze input until reboot), and the
# theme-loader / steamgriddb / protondb / quick-links plugins all talk to
# this port. Mirrors setup_steam_cef_debugging() in install.sh.
echo ""
echo "Enabling Steam CEF remote debugging (for overlay focus + plugins)..."
CEF_DEBUG_CREATED=0
CEF_DEBUG_EXISTED=0
for STEAM_ROOT in \
    "$HOME/.steam/steam" \
    "$HOME/.local/share/Steam" \
    "$HOME/.var/app/com.valvesoftware.Steam/data/Steam"; do
    [ -d "$STEAM_ROOT" ] || continue
    CEF_FLAG="$STEAM_ROOT/.cef-enable-remote-debugging"
    if [ -e "$CEF_FLAG" ]; then
        CEF_DEBUG_EXISTED=1
        continue
    fi
    if : > "$CEF_FLAG" 2>/dev/null; then
        echo "Created $CEF_FLAG"
        CEF_DEBUG_CREATED=1
    else
        echo "WARNING: could not write $CEF_FLAG (check permissions)." >&2
    fi
done
if [ "$CEF_DEBUG_CREATED" = "0" ] && [ "$CEF_DEBUG_EXISTED" = "0" ]; then
    echo "WARNING: no Steam install dir found — skipped CEF debugging flag." >&2
    echo "         Create an empty .cef-enable-remote-debugging in Steam's root," >&2
    echo "         then restart Steam." >&2
elif [ "$CEF_DEBUG_CREATED" = "1" ]; then
    echo "Restart Steam for CEF remote debugging to take effect."
else
    echo "CEF remote debugging already enabled."
fi

# --- Backend: root system service ---
# The backend runs as root so plugins can write hardware sysfs / run
# privileged tools without per-op sudo prompts at runtime (HHD/Decky
# model). A system unit can't expand %h — that would be root's home — so
# substitute the concrete home + user into the template and install it
# system-wide. This is the ONE step that needs admin rights.
TARGET_USER="$(id -un)"
SYSTEM_UNIT="/etc/systemd/system/loadout.service"

echo ""
echo "Installing the backend as a root system service (loadout.service)."
echo "sudo is needed once here — the backend then writes hardware directly,"
echo "so plugins never trigger a password prompt at runtime."

# The backend moved from a --user service to this root system unit, so
# disable + remove the old per-user one.
systemctl --user disable loadout 2>/dev/null || true
rm -f "$SERVICE_DIR/loadout.service"

GENERATED_UNIT="$(mktemp)"
sed -e "s#__HOME__#${HOME}#g" -e "s#__USER__#${TARGET_USER}#g" -e "s#__BIN__#${BIN_PATH}#g" \
    "$PROJECT_ROOT/loadout.service" > "$GENERATED_UNIT"
sudo cp "$GENERATED_UNIT" "$SYSTEM_UNIT"
rm -f "$GENERATED_UNIT"
sudo systemctl daemon-reload
sudo systemctl enable loadout
sudo systemctl restart loadout

# --- Overlay: user service ---
mkdir -p "$SERVICE_DIR"
cp "$PROJECT_ROOT/loadout-overlay.service" "$SERVICE_DIR/loadout-overlay.service"
systemctl --user daemon-reload
systemctl --user enable loadout-overlay

# Wait for the (root) server to be up before kicking the overlay so the
# webview doesn't race its initial fetch. Honour LOADOUT_PORT so the wait
# targets the same port the server is actually bound to (Audit H-006).
PORT="${LOADOUT_PORT:-33820}"
echo "Waiting for server on port ${PORT}..."
for i in $(seq 1 30); do
    curl -sf "http://localhost:${PORT}/up" >/dev/null 2>&1 && break
    sleep 1
done

systemctl --user restart loadout-overlay
echo "Services restarted."
