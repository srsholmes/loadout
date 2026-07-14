#!/bin/bash
# Install InputPlumber on distros that don't ship it natively.
#
# Strategy:
#   1. Already installed? exit 0.
#   2. Package manager fast path:
#        - Arch / CachyOS: `pacman -S --noconfirm inputplumber`
#        - Mutable Fedora: `dnf install -y inputplumber`
#      rpm-ostree is deliberately skipped — the upstream COPR build
#      declares `Conflicts: hhd`, which blocks layering on Bazzite-style
#      images that ship HHD as a base package.
#   3. Tarball fallback (works everywhere): download the latest
#      `inputplumber-x86_64.tar.gz` release from ShadowBlip/InputPlumber,
#      verify against the published sha256, and install to /var/lib +
#      /etc using the ostree-safe pattern (no /usr writes that would
#      vanish on the next deployment switch). Synthesizes a systemd
#      unit with LD_LIBRARY_PATH and XDG_DATA_DIRS pointing into /var.
#
# Idempotent — re-running converges. The script does its own detection
# and short-circuits when InputPlumber is already on disk.
#
# Usage: bash scripts/install-inputplumber.sh
#        IP_ENABLE=0 bash scripts/install-inputplumber.sh   # install only
#
# IP_ENABLE=0 installs InputPlumber but leaves the unit disabled and
# stopped. SteamOS needs this: IP ships with the image but deliberately
# disabled, and enabling it claims the Deck's built-in controller — a
# choice that belongs to the user in-app when they pick a wake button,
# not to the installer. Defaults to 1 (install + enable) everywhere else.
#
# The loadout backend runs as root, so no sudo / id-check is needed —
# the script is invoked directly by the plugin backend.
#
# pipefail OFF: we use `lsmod | grep -q`, `awk … exit`, and similar
# patterns that SIGPIPE the producer when grep closes the pipe early.
# Under pipefail those become exit 141 and trip set -e on correct
# behaviour. Real failure paths use explicit `exit 1`.
set -eu

# Install-only mode (see the header). Every path that would start the
# daemon goes through ip_enable() so there is one place to honour this.
IP_ENABLE="${IP_ENABLE:-1}"

# Enable + start inputplumber.service, unless we were asked to install
# only. Called at the end of each install path.
ip_enable() {
    systemctl daemon-reload
    if [ "$IP_ENABLE" = "0" ]; then
        log "IP_ENABLE=0 — installed but leaving inputplumber.service disabled"
        log "enable it later with: systemctl enable --now inputplumber.service"
        return 0
    fi
    log "enabling and starting inputplumber.service"
    systemctl enable inputplumber.service
    systemctl restart inputplumber.service
    log "done — inputplumber.service is running"
}

REPO="ShadowBlip/InputPlumber"
TARBALL="inputplumber-x86_64.tar.gz"
SHA256_FILE="${TARBALL}.sha256.txt"

IP_ROOT="/var/lib/inputplumber"
IP_BIN_DST="$IP_ROOT/bin/inputplumber"
IP_LIB_DIR="$IP_ROOT/lib"
IP_DATA_DIR="$IP_ROOT/data/inputplumber"
IP_SERVICE_PATH="/etc/systemd/system/inputplumber.service"
IP_DBUS_POLICY="/etc/dbus-1/system.d/org.shadowblip.InputPlumber.conf"
IP_POLKIT_RULES="/etc/polkit-1/rules.d/org.shadowblip.InputPlumber.rules"
# ──────────────────────────────────────────────────────────────────────
# Polkit action-descriptor placement (immutable-/usr aware)
# ──────────────────────────────────────────────────────────────────────
# Polkit historically scans /usr/share/polkit-1/actions/ ONLY, but on
# distros where /usr is immutable (rpm-ostree: Bazzite, SteamOS, Silverblue)
# we can't write there without `bootc usr-overlay` / `rpm-ostree usroverlay`.
#
# In practice modern polkit (>=0.105 — every supported distro) ALSO honours
# /etc/polkit-1/actions/, so when the /usr write fails we fall back there.
# This keeps `busctl get-property` working for plugin clients on Bazzite
# and SteamOS without forcing the user to unlock /usr.
#
# Refs:
#   - https://www.freedesktop.org/software/polkit/docs/latest/ (action layout)
#   - project_inputplumber_polkit_install.md (2026-05-03 fix that
#     surfaced the "Action not registered" symptom on Bazzite)
IP_POLKIT_ACTIONS_USR="/usr/share/polkit-1/actions/org.shadowblip.InputPlumber.policy"
IP_POLKIT_ACTIONS_ETC="/etc/polkit-1/actions/org.shadowblip.InputPlumber.policy"

log()  { printf '[install-inputplumber] %s\n' "$*"; }
warn() { printf '[install-inputplumber] WARN: %s\n' "$*" >&2; }
die()  { printf '[install-inputplumber] ERROR: %s\n' "$*" >&2; exit 1; }

# ── 1. Already installed? ───────────────────────────────────────────
detect_installed() {
    # Any of: distro-packaged (rpm/dpkg/pacman), our own /var install,
    # or a stray /usr/local/bin install from an earlier run.
    if command -v inputplumber >/dev/null 2>&1; then return 0; fi
    [ -x "$IP_BIN_DST" ] && return 0
    return 1
}

if detect_installed; then
    bin="$(command -v inputplumber 2>/dev/null || echo "$IP_BIN_DST")"
    log "InputPlumber already installed at $bin — nothing to do."
    log "(re-run with --force to reinstall — not implemented yet; remove $IP_BIN_DST and rerun for now)"
    exit 0
fi

# ── 2. Package manager fast path ────────────────────────────────────

# rpm-ostree is detected before parsing /etc/os-release because some
# atomic Fedora variants still report ID=fedora.
IS_RPM_OSTREE=0
[ -e /run/ostree-booted ] && IS_RPM_OSTREE=1

ID="$(. /etc/os-release 2>/dev/null && echo "${ID:-unknown}")"
ID_LIKE="$(. /etc/os-release 2>/dev/null && echo "${ID_LIKE:-}")"
HAYSTACK="$ID $ID_LIKE"

if [ "$IS_RPM_OSTREE" -eq 0 ] && command -v pacman >/dev/null 2>&1 && [[ "$HAYSTACK" == *arch* ]]; then
    log "── pacman -S inputplumber ──"
    if pacman -Qi inputplumber >/dev/null 2>&1; then
        log "pacman reports inputplumber already installed"
    else
        pacman -S --noconfirm --needed inputplumber || die "pacman install failed"
    fi
    ip_enable
    exit 0
fi

if [ "$IS_RPM_OSTREE" -eq 0 ] && command -v dnf >/dev/null 2>&1 && [[ "$HAYSTACK" == *fedora* ]]; then
    log "── dnf install inputplumber ──"
    # `dnf install` is non-interactive with -y and no-op if installed.
    if dnf install -y inputplumber 2>&1; then
        ip_enable
        exit 0
    fi
    warn "dnf could not install inputplumber from configured repos — falling through to tarball"
fi

# ── 3. Tarball fallback ─────────────────────────────────────────────
#
# Resolves latest release tag from GitHub API, verifies the published
# sha256, and lays out the binary + assets under /var/lib/inputplumber/.
# The systemd unit at /etc/systemd/system/inputplumber.service is
# synthesised so its LD_LIBRARY_PATH and XDG_DATA_DIRS point into /var.

log "── tarball fallback: building install under $IP_ROOT ──"

for cmd in curl sha256sum tar systemctl; do
    command -v "$cmd" >/dev/null 2>&1 || die "missing required command: $cmd"
done

log "resolving latest release tag"
RELEASE_JSON="$(curl -fsSL -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${REPO}/releases/latest")"
TAG="$(printf '%s' "$RELEASE_JSON" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"tag_name": *"//;s/"//')"
[ -n "$TAG" ] || die "could not parse tag_name from GitHub API"
log "latest release: $TAG"

BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"
TMP_TAR="$(mktemp /tmp/inputplumber-XXXXXX.tar.gz)"
TMP_SHA="${TMP_TAR}.sha256.txt"
trap 'rm -f "$TMP_TAR" "$TMP_SHA"' EXIT

log "downloading $TARBALL"
curl -fL --retry 3 -o "$TMP_TAR" "${BASE_URL}/${TARBALL}"
log "downloading $SHA256_FILE"
curl -fL --retry 3 -o "$TMP_SHA" "${BASE_URL}/${SHA256_FILE}"

EXPECTED="$(awk '{print $1; exit}' "$TMP_SHA")"
ACTUAL="$(sha256sum "$TMP_TAR" | awk '{print $1}')"
[ "$EXPECTED" = "$ACTUAL" ] || die "sha256 mismatch (expected $EXPECTED, got $ACTUAL)"
log "sha256 OK"

# Extract to a temp dir, then move pieces into place. /var/lib path is
# preferable to extracting straight to a final dir because it lets us
# inspect layout before commit.
EXTRACT_DIR="$(mktemp -d /tmp/inputplumber-extract.XXXXXX)"
trap 'rm -f "$TMP_TAR" "$TMP_SHA"; rm -rf "$EXTRACT_DIR"' EXIT
log "extracting to $EXTRACT_DIR"
tar -xzf "$TMP_TAR" --strip-components=1 -C "$EXTRACT_DIR"

# Stop existing service before swapping the binary; "Text file busy"
# otherwise on re-runs.
if systemctl is-active --quiet inputplumber.service; then
    log "stopping existing inputplumber.service"
    systemctl stop inputplumber.service
fi

log "installing binary → $IP_BIN_DST"
mkdir -p "$(dirname "$IP_BIN_DST")"
cp -f "$EXTRACT_DIR/usr/bin/inputplumber" "$IP_BIN_DST"
chmod 755 "$IP_BIN_DST"
# Files under /var/lib inherit var_lib_t by default, which systemd_t
# is not permitted to exec. Relabel the binary to bin_t so SELinux
# (when enforcing) lets the service start. No-op if chcon is missing
# or SELinux is disabled.
chcon -t bin_t "$IP_BIN_DST" 2>/dev/null || true

# Stage libiio.so.0 next to the binary and use LD_LIBRARY_PATH in the
# unit. This avoids a system-wide libiio dep on rpm-ostree (where the
# ostree image may not include it) and survives deployment switches.
mkdir -p "$IP_LIB_DIR"
stage_lib() {
    local soname="$1"
    local src
    src="$(ldconfig -p 2>/dev/null | awk -v s="$soname" '$1 == s {print $NF; exit}')"
    if [ -z "$src" ] || [ ! -f "$src" ]; then
        src="$(find /usr/lib64 /usr/lib -maxdepth 2 -name "$soname*" -type f 2>/dev/null | head -1)"
    fi
    if [ -z "$src" ]; then
        warn "$soname not found on disk — daemon will fail to start until libiio is installed"
        return
    fi
    log "staging $soname ← $src"
    cp -L "$src" "$IP_LIB_DIR/$soname"
    chcon -t lib_t "$IP_LIB_DIR/$soname" 2>/dev/null || true
}
for lib in $(ldd "$IP_BIN_DST" 2>/dev/null | awk '/=>/ {print $1}'); do
    case "$lib" in
        libiio.so.*) stage_lib "$lib" ;;
    esac
done

log "installing data → $IP_DATA_DIR"
rm -rf "$IP_DATA_DIR"
mkdir -p "$(dirname "$IP_DATA_DIR")"
if [ -d "$EXTRACT_DIR/usr/share/inputplumber" ]; then
    cp -r "$EXTRACT_DIR/usr/share/inputplumber" "$IP_DATA_DIR"
else
    warn "tarball missing usr/share/inputplumber — devices/profiles/capability_maps won't load"
    mkdir -p "$IP_DATA_DIR"
fi

log "installing dbus policy → $IP_DBUS_POLICY"
mkdir -p "$(dirname "$IP_DBUS_POLICY")"
if [ -f "$EXTRACT_DIR/usr/share/dbus-1/system.d/org.shadowblip.InputPlumber.conf" ]; then
    cp -f "$EXTRACT_DIR/usr/share/dbus-1/system.d/org.shadowblip.InputPlumber.conf" "$IP_DBUS_POLICY"
fi

log "installing polkit rules → $IP_POLKIT_RULES"
mkdir -p "$(dirname "$IP_POLKIT_RULES")"
if [ -f "$EXTRACT_DIR/usr/share/polkit-1/rules.d/org.shadowblip.InputPlumber.rules" ]; then
    cp -f "$EXTRACT_DIR/usr/share/polkit-1/rules.d/org.shadowblip.InputPlumber.rules" "$IP_POLKIT_RULES"
fi

# Polkit action descriptor — try /usr first (the historical location),
# fall back to /etc on immutable-/usr systems (Bazzite/SteamOS/Silverblue).
# Modern polkit honours both. Without the descriptor, clients calling
# privileged dbus methods get "Action not registered".
SRC_POLICY="$EXTRACT_DIR/usr/share/polkit-1/actions/org.shadowblip.InputPlumber.policy"
if [ -f "$SRC_POLICY" ]; then
    if mkdir -p "$(dirname "$IP_POLKIT_ACTIONS_USR")" 2>/dev/null \
       && cp -f "$SRC_POLICY" "$IP_POLKIT_ACTIONS_USR" 2>/dev/null; then
        log "installed polkit action → $IP_POLKIT_ACTIONS_USR"
    elif [ "$IS_RPM_OSTREE" -eq 1 ] \
         && mkdir -p "$(dirname "$IP_POLKIT_ACTIONS_ETC")" 2>/dev/null \
         && cp -f "$SRC_POLICY" "$IP_POLKIT_ACTIONS_ETC" 2>/dev/null; then
        log "installed polkit action → $IP_POLKIT_ACTIONS_ETC (immutable /usr fallback)"
    elif mkdir -p "$(dirname "$IP_POLKIT_ACTIONS_ETC")" 2>/dev/null \
         && cp -f "$SRC_POLICY" "$IP_POLKIT_ACTIONS_ETC" 2>/dev/null; then
        # Non-ostree systems with a hardened /usr (or NixOS, or read-only
        # bind mounts) still get the /etc fallback as a last resort.
        log "installed polkit action → $IP_POLKIT_ACTIONS_ETC (/usr not writable)"
    else
        warn "could not write polkit action to either $IP_POLKIT_ACTIONS_USR or $IP_POLKIT_ACTIONS_ETC"
        warn "privileged dbus methods may report 'Action not registered'."
        if [ "$IS_RPM_OSTREE" -eq 1 ]; then
            warn "rpm-ostree detected — unlock /usr with 'sudo bootc usr-overlay' (or 'sudo rpm-ostree usroverlay' on older releases) and re-run."
        fi
    fi
fi

log "installing udev rules → /etc/udev/rules.d"
mkdir -p /etc/udev/rules.d
if [ -d "$EXTRACT_DIR/usr/lib/udev/rules.d" ]; then
    cp -rf "$EXTRACT_DIR/usr/lib/udev/rules.d/." /etc/udev/rules.d/
fi
udevadm control --reload || true
udevadm trigger || true

log "synthesising systemd unit → $IP_SERVICE_PATH"
mkdir -p "$(dirname "$IP_SERVICE_PATH")"
cat > "$IP_SERVICE_PATH" <<EOF
[Unit]
Description=InputPlumber — input routing daemon (steam-loader install)
After=dbus.service
Wants=dbus.service

[Service]
Type=dbus
BusName=org.shadowblip.InputPlumber
Environment=XDG_DATA_DIRS=$(dirname "$IP_DATA_DIR"):/usr/local/share:/usr/share
Environment=LD_LIBRARY_PATH=$IP_LIB_DIR
ExecStart=$IP_BIN_DST
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Reload dbus so the new policy is in effect before the daemon starts.
systemctl reload dbus.service 2>/dev/null || systemctl reload dbus-broker.service 2>/dev/null || true

ip_enable

log "verify with: systemctl status inputplumber.service"
