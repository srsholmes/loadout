#!/bin/bash
# Migrate from HHD to InputPlumber on OneXPlayer Apex (Bazzite).
#
# This script:
#   1. Builds and installs the hid-oxp kernel module
#   2. Stops and masks HHD services
#   3. Enables and starts InputPlumber
#
# Prerequisites:
#   - InputPlumber must already be installed (Bazzite ships it)
#   - Kernel headers for the running kernel
#
# Usage:
#   sudo ./scripts/migrate-to-inputplumber.sh
#
# Rollback:
#   sudo ./scripts/rollback-to-hhd.sh
# Not pipefail — we intentionally use `lsmod | grep -q`, `ldconfig -p | awk 'exit'`,
# `find | head -1` etc, all of which SIGPIPE the producer when the consumer closes
# the pipe early. pipefail would surface those as 141 exits and crash the script on
# correct behavior. The script has explicit `exit 1` on every real failure path.
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: Must run as root (sudo $0)"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$REPO_DIR/kernel-patches/hid-oxp/build"
KERNEL="$(uname -r)"
INSTALL_DIR="/var/lib/hid-oxp"
INSTALL_KO="$INSTALL_DIR/hid-oxp.ko"
SERVICE_NAME="hid-oxp-load.service"
SERVICE_PATH="/etc/systemd/system/$SERVICE_NAME"

# InputPlumber install roots — deliberately on /var and /etc only, NOT /usr.
# rpm-ostree's hotfix overlay on /usr is scoped to the *current* deployment:
# a second deployment created by a pending rpm-ostree transaction (kargs,
# package layering, upgrades) will boot WITHOUT our overlay, and anything we
# put in /usr vanishes. /var and /etc are shared across deployments, so they
# survive the boot-selection dance.
IP_ROOT="/var/lib/inputplumber"
IP_BIN_DST="$IP_ROOT/bin/inputplumber"
IP_LIB_DIR="$IP_ROOT/lib"                    # libiio.so.0 lands here
IP_DATA_DIR="$IP_ROOT/data/inputplumber"     # profiles / devices / capability_maps
IP_SERVICE_PATH="/etc/systemd/system/inputplumber.service"
IP_DBUS_POLICY="/etc/dbus-1/system.d/org.shadowblip.InputPlumber.conf"
IP_ETC_DEVICES_D="/etc/inputplumber/devices.d"
# Polkit splits across /usr (action descriptors, no /etc override path) and
# /etc (rules — admin override). The .policy file lives in /usr because polkit
# only scans /usr/share/polkit-1/actions/; relies on the hotfix overlay just
# like the dbus policy does, and the migrate is the resync anyway.
IP_POLKIT_ACTIONS="/usr/share/polkit-1/actions/org.shadowblip.InputPlumber.policy"
IP_POLKIT_RULES="/etc/polkit-1/rules.d/org.shadowblip.InputPlumber.rules"

echo "============================================"
echo "  HHD → InputPlumber Migration"
echo "  Kernel: $KERNEL"
echo "============================================"
echo

# ─── Step 0: Unlock ostree deployment ────────────────────────────────
#
# On ostree systems /usr is read-only unless the current deployment is unlocked.
# Steps 4/4b write to /usr/bin, /usr/share/inputplumber, /usr/share/dbus-1, and
# /usr/lib64 (libiio), so the deployment must be hotfix-unlocked first.
#
# `ostree admin unlock --hotfix` is idempotent-ish: if the deployment is already
# unlocked it's a no-op; if it isn't, it mounts a writable overlayfs on /usr and
# creates a non-hotfixed rollback deployment. Safe to run every time.

echo "── Step 0: Ensure /usr is writable (ostree hotfix unlock) ──"

if [ ! -r /run/ostree-booted ]; then
    echo "Not an ostree system — skipping unlock"
elif touch /usr/.ip-write-check 2>/dev/null; then
    rm -f /usr/.ip-write-check
    echo "/usr is already writable — skipping unlock"
else
    echo "/usr is read-only. Running: ostree admin unlock --hotfix"
    ostree admin unlock --hotfix
    if ! touch /usr/.ip-write-check 2>/dev/null; then
        echo "ERROR: unlock ran but /usr is still read-only"
        exit 1
    fi
    rm -f /usr/.ip-write-check
    echo "/usr is now writable"
fi
echo

# ─── Step 1: Build hid-oxp.ko ────────────────────────────────────────

echo "── Step 1: Build hid-oxp kernel module ──"

KERNEL_KO="$REPO_DIR/kernel-patches/hid-oxp/$KERNEL/hid-oxp.ko"

# Always build+install the pre-built .ko to /var/lib/hid-oxp/ so the
# hid-oxp-load.service picks up the latest on next boot — even when the current
# boot has an older hid_oxp already loaded (we deliberately DON'T try to rmmod,
# since known-buggy older versions oops on unload; reboot to pick up fixes).
if [ ! -f "$KERNEL_KO" ]; then
    echo "Building hid-oxp.ko for $KERNEL..."
    # Run build as the repo owner, not root
    REPO_OWNER="$(stat -c '%U' "$REPO_DIR")"
    su - "$REPO_OWNER" -c "cd '$REPO_DIR' && bash scripts/build-hid-oxp.sh"

    if [ ! -f "$KERNEL_KO" ]; then
        echo "ERROR: Build failed — no module produced"
        exit 1
    fi
else
    echo "Pre-built module found for $KERNEL"
fi

echo "Installing to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
cp "$KERNEL_KO" "$INSTALL_KO"
chcon -t modules_object_t "$INSTALL_KO" 2>/dev/null || true
echo "Installed: $INSTALL_KO"

# Check /proc/modules directly rather than `lsmod | grep -q`. Under
# `set -o pipefail`, grep -q's early pipe-close gives lsmod SIGPIPE (rc
# 141), which pipefail surfaces as a failed pipeline — so the script
# would misread "hid_oxp is loaded" as "not loaded". Reading /proc/modules
# has no pipe and is immune.
if grep -q "^hid_oxp " /proc/modules; then
    echo "hid-oxp already loaded — leaving running module alone (reboot to pick up any source updates)"
else
    echo "Loading hid-oxp..."
    if modprobe hid_oxp 2>/dev/null; then
        echo "Loaded via modprobe"
    elif insmod "$INSTALL_KO" 2>/dev/null; then
        echo "Loaded via insmod"
    else
        echo "insmod returned error (may already be loaded)"
    fi
    sleep 2
fi

# Verify module loaded
if ! grep -q "^hid_oxp " /proc/modules; then
    # Also check dmesg — module may bind to devices without appearing in lsmod
    # if it's built into the HID subsystem differently
    # dmesg | tail | grep -q has the same SIGPIPE + pipefail trap as
    # lsmod | grep -q — capture into a var and test instead.
    if [ -n "$(dmesg 2>/dev/null | tail -20 | grep 'hid-oxp' || true)" ]; then
        echo "hid-oxp driver active (found in dmesg)"
    else
        echo "ERROR: hid-oxp module did not load"
        exit 1
    fi
else
    echo "hid-oxp module loaded OK"
fi
echo

# ─── Step 2: Create boot service ─────────────────────────────────────

echo "── Step 2: Create hid-oxp boot service ──"

cat > "$SERVICE_PATH" <<EOF
[Unit]
Description=Load hid-oxp HID driver for OneXPlayer
# /var/lib/hid-oxp/hid-oxp.ko lives on /var, so we need local-fs mounted first.
# Without this ordering the service runs before /var is up and insmod fails with
# "No such file or directory" even though the file is present.
After=local-fs.target
Requires=local-fs.target
Before=inputplumber.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'grep -q "^hid_oxp " /proc/modules && exit 0; modprobe hid_oxp 2>/dev/null || insmod $INSTALL_KO'
ExecStop=/sbin/rmmod hid_oxp

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
echo "Created and enabled $SERVICE_NAME"
echo

# ─── Step 3: Stop and mask HHD ───────────────────────────────────────

echo "── Step 3: Disable HHD ──"

# Find all HHD service units
HHD_UNITS=()
while IFS= read -r unit; do
    [ -n "$unit" ] && HHD_UNITS+=("$unit")
done < <(systemctl list-units --plain --no-legend --type=service 'hhd*' 2>/dev/null | awk '{print $1}')

# Also check for common unit names that might not be running
for u in hhd.service "hhd@$(logname 2>/dev/null || echo '').service"; do
    if systemctl list-unit-files "$u" &>/dev/null; then
        # Only add if not already in list
        if [[ ! " ${HHD_UNITS[*]:-} " =~ " $u " ]]; then
            HHD_UNITS+=("$u")
        fi
    fi
done

if [ ${#HHD_UNITS[@]} -eq 0 ]; then
    echo "No HHD services found"
else
    for unit in "${HHD_UNITS[@]}"; do
        echo "Stopping and masking $unit..."
        systemctl stop "$unit" 2>/dev/null || true
        systemctl disable "$unit" 2>/dev/null || true
        systemctl mask "$unit" 2>/dev/null || true
    done
    echo "HHD services masked"
fi
echo

# ─── Step 3b: Install build deps for InputPlumber ─────────────────────
#
# Bazzite ships libiio's runtime SONAME but not its -devel headers, and
# cargo/bindgen need the headers to link. Install the devel packages via
# the same rpm-ivh-into-ostree-overlay flow we use for runtime libs at
# the tail of Step 4 — keeps one mechanism for layering RPMs.
#
# This must run BEFORE Step 4's `su $REPO_OWNER -c "...build-inputplumber.sh"`
# because the build script's pre-flight check fails hard if libiio.so isn't
# on disk.

install_rpm_overlay() {
    # Args: one or more package names.
    # Downloads the RPMs and installs them via `rpm -ivh --nodeps` so they
    # sit on the ostree hotfix overlay we unlocked in Step 0. No-op if the
    # packages appear already installed (check via rpm -q).
    local pkgs=("$@")
    local need=()
    for p in "${pkgs[@]}"; do
        if ! rpm -q "$p" &>/dev/null; then
            need+=("$p")
        fi
    done
    if [ ${#need[@]} -eq 0 ]; then
        echo "build deps already present: ${pkgs[*]}"
        return 0
    fi

    if command -v dnf5 &>/dev/null; then DNF=dnf5
    elif command -v dnf &>/dev/null; then DNF=dnf
    else echo "ERROR: dnf/dnf5 not available to fetch ${need[*]}"; return 1
    fi

    local dl
    dl="$(mktemp -d)"
    trap 'rm -rf "'"$dl"'"' RETURN
    echo "Downloading ${need[*]} via $DNF..."
    "$DNF" download --destdir="$dl" "${need[@]}"
    echo "Installing into /usr overlay (rpm -ivh --nodeps)..."
    rpm -ivh --nodeps --replacepkgs "$dl"/*.rpm
    ldconfig
}

IP_DIR="$REPO_DIR/vendor/InputPlumber"
IP_BINARY_SRC="$IP_DIR/target/release/inputplumber"
IP_ROOTFS="$IP_DIR/rootfs"

# ─── Step 3b: Install InputPlumber build deps (only if rebuild needed) ─
#
# libiio-devel (headers + /usr/lib64/libiio.so link) is what bindgen needs
# at build time — only pay the overlay install if we actually need to build.
# The devel packages land in the hotfix overlay on /usr; we tolerate them
# being lost on the next ostree transaction because by then the binary has
# already been staged on /var.

echo "── Step 3b: Install InputPlumber build deps ──"
if [ -f "$IP_BINARY_SRC" ]; then
    echo "Binary already built at $IP_BINARY_SRC — skipping build-dep install"
else
    # libcap-devel is a transitive dep: libudev.pc lists `Requires.private:
    # libcap`, so pkg-config needs libcap.pc on disk before the libudev-sys
    # crate's build.rs can resolve libudev. The libcap runtime is on stock
    # Bazzite; only the .pc file is missing.
    install_rpm_overlay libiio libiio-devel systemd-devel libcap-devel
fi
echo

# ─── Step 4: Build InputPlumber ──────────────────────────────────────

echo "── Step 4: InputPlumber build (upstream main) ──"

if [ ! -f "$IP_BINARY_SRC" ]; then
    echo "InputPlumber not built yet — building from upstream main..."
    REPO_OWNER="$(stat -c '%U' "$REPO_DIR")"
    su - "$REPO_OWNER" -c "cd '$REPO_DIR' && LIBCLANG_PATH=/usr/lib64/rocm/llvm/lib LD_LIBRARY_PATH=/usr/lib64/rocm/llvm/lib:\${LD_LIBRARY_PATH:-} bash scripts/build-inputplumber.sh"
    if [ ! -f "$IP_BINARY_SRC" ]; then
        echo "ERROR: InputPlumber build failed"
        exit 1
    fi
fi
echo

# ─── Step 5: Install to /var + /etc (ostree-safe) ─────────────────────
#
# Nothing below this point writes to /usr. Every path is on /var (binary,
# libraries, profiles, capability_maps, upstream devices) or /etc (systemd
# unit, dbus policy, Apex device override) — both of which survive
# deployment switches and hotfix overlay resets on Bazzite.

echo "── Step 5: Install InputPlumber (ostree-safe, /var + /etc) ──"

# Stop any existing service first — running ELF gives "Text file busy" on cp.
if systemctl is-active --quiet inputplumber.service; then
    echo "Stopping inputplumber.service so the binary can be replaced..."
    systemctl stop inputplumber.service
fi

# 5a. Binary → /var/lib/inputplumber/bin/inputplumber
#
# Files under /var/lib inherit var_lib_t by default, which systemd_t is
# not permitted to exec. Relabel the binary to bin_t and the library dir
# to lib_t so SELinux (when enforcing) lets the service start. No-op if
# chcon is unavailable or SELinux is disabled.
echo "Installing binary → $IP_BIN_DST"
mkdir -p "$(dirname "$IP_BIN_DST")"
cp "$IP_BINARY_SRC" "$IP_BIN_DST"
chmod 755 "$IP_BIN_DST"
chcon -t bin_t "$IP_BIN_DST" 2>/dev/null || true

# 5b. Runtime libraries → /var/lib/inputplumber/lib/
#
# `ldd` resolves the binary against the hotfix overlay (where libiio was
# just layered in Step 3b). We snapshot every "not found from default
# search paths" lib and any libiio.* into /var so that after the next
# ostree transaction strips /usr/lib64/libiio.so.0, the service still
# resolves it via LD_LIBRARY_PATH.
mkdir -p "$IP_LIB_DIR"
stage_lib() {
    local soname="$1"
    local src
    src="$(ldconfig -p | awk -v s="$soname" '$1 == s {print $NF; exit}')"
    if [ -z "$src" ] || [ ! -f "$src" ]; then
        # Fallback glob — libiio ships libiio.so.0.26 with libiio.so.0 symlink.
        src="$(find /usr/lib64 -maxdepth 2 -name "$soname*" -type f 2>/dev/null | head -1)"
    fi
    if [ -z "$src" ]; then
        echo "WARNING: $soname not found on disk — skipping stage"
        return
    fi
    echo "Staging $soname ← $src"
    cp -L "$src" "$IP_LIB_DIR/$soname"
    chcon -t lib_t "$IP_LIB_DIR/$soname" 2>/dev/null || true
}

# Probe the binary's DT_NEEDED entries and snapshot ones that came from
# the hotfix overlay (libiio + anything else missing from stock Bazzite).
for lib in $(ldd "$IP_BIN_DST" 2>/dev/null | awk '/=>/ {print $1}'); do
    case "$lib" in
        libiio.so.*) stage_lib "$lib" ;;
    esac
done

# 5c. Data dirs → /var/lib/inputplumber/data/inputplumber/{profiles,devices,capability_maps,schema}
#
# InputPlumber (pastaq 7.1) reads config paths via xdg::BaseDirectories
# with the "inputplumber" prefix, so pointing XDG_DATA_DIRS at
# /var/lib/inputplumber/data in the systemd unit makes IP find every
# vendor-shipped file here.
echo "Installing upstream configs → $IP_DATA_DIR"
if [ -d "$IP_ROOTFS/usr/share/inputplumber" ]; then
    rm -rf "$IP_DATA_DIR"
    mkdir -p "$(dirname "$IP_DATA_DIR")"
    cp -r "$IP_ROOTFS/usr/share/inputplumber" "$IP_DATA_DIR"
else
    echo "WARNING: upstream rootfs missing — no devices/profiles shipped"
    mkdir -p "$IP_DATA_DIR"
fi

# 5d. dbus policy → /etc/dbus-1/system.d/
echo "Installing dbus policy → $IP_DBUS_POLICY"
DBUS_POLICY_INSTALLED=0
if [ -f "$IP_ROOTFS/usr/share/dbus-1/system.d/org.shadowblip.InputPlumber.conf" ]; then
    mkdir -p "$(dirname "$IP_DBUS_POLICY")"
    cp "$IP_ROOTFS/usr/share/dbus-1/system.d/org.shadowblip.InputPlumber.conf" \
       "$IP_DBUS_POLICY"
    DBUS_POLICY_INSTALLED=1
fi

# 5d-bis. polkit policy + rules
#
# IP gates every CompositeDevice/Source/Target property and method behind a
# polkit action (see vendor/InputPlumber/src/dbus/polkit.rs). Without these
# files installed, *every* property read fails with
# `PolicyKit1.Error.Failed: Action ... is not registered`, breaking any
# client that introspects via `busctl get-property` — including the
# disable-controller-input plugin's UI.
echo "Installing polkit policy → $IP_POLKIT_ACTIONS"
POLKIT_POLICY_INSTALLED=0
if [ -f "$IP_ROOTFS/usr/share/polkit-1/actions/org.shadowblip.InputPlumber.policy" ]; then
    mkdir -p "$(dirname "$IP_POLKIT_ACTIONS")"
    cp "$IP_ROOTFS/usr/share/polkit-1/actions/org.shadowblip.InputPlumber.policy" \
       "$IP_POLKIT_ACTIONS"
    POLKIT_POLICY_INSTALLED=1
fi
echo "Installing polkit rules  → $IP_POLKIT_RULES"
POLKIT_RULES_INSTALLED=0
if [ -f "$IP_ROOTFS/usr/share/polkit-1/rules.d/org.shadowblip.InputPlumber.rules" ]; then
    mkdir -p "$(dirname "$IP_POLKIT_RULES")"
    cp "$IP_ROOTFS/usr/share/polkit-1/rules.d/org.shadowblip.InputPlumber.rules" \
       "$IP_POLKIT_RULES"
    POLKIT_RULES_INSTALLED=1
fi
if [ "$POLKIT_POLICY_INSTALLED" = "1" ] || [ "$POLKIT_RULES_INSTALLED" = "1" ]; then
    systemctl reload polkit 2>/dev/null || true
fi

# 5e. systemd unit → /etc/systemd/system/inputplumber.service
#
# We synthesize the unit rather than cp'ing upstream's so we can inject
# XDG_DATA_DIRS (points IP at /var data) and LD_LIBRARY_PATH (finds our
# staged libiio). If upstream's unit were in /usr/lib it would get wiped
# anyway, so this is both necessary and preferable.
echo "Installing systemd unit → $IP_SERVICE_PATH"
mkdir -p "$(dirname "$IP_SERVICE_PATH")"
cat > "$IP_SERVICE_PATH" <<IPEOF
[Unit]
Description=InputPlumber — Open source input manager (apex-fixes install)
# hid-oxp-load.service brings up the OXP HID driver we rely on for back
# paddles and RGB. If it ever fails, IP still starts but with reduced
# capability — After= but not Requires=.
After=dbus.service $SERVICE_NAME
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
IPEOF

systemctl daemon-reload
echo

# ─── Step 5b: Apex-specific overrides ────────────────────────────────
#
# The Apex profile + device override land in two different places because
# InputPlumber's config loader treats them differently:
#
#   - profiles: no /etc lookup path, only XDG_DATA_DIRS base/profiles/ →
#     overwrite in place at /var/lib/inputplumber/data/inputplumber/profiles/default.yaml
#   - devices: read from /etc/inputplumber/devices.d/ AND base/devices/
#     (/etc wins because it's listed earlier) → drop at
#     /etc/inputplumber/devices.d/50-onexplayer_apex.yaml (persists cleanly
#     via /etc, never tied to an overlay)
APEX_CFG_SRC="$REPO_DIR/config/inputplumber"

echo "── Step 5b: Apply Apex-specific overrides ──"

install_profile_override() {
    local rel="$1"
    local src="$APEX_CFG_SRC/$rel"
    local dst="$IP_DATA_DIR/$rel"
    if [ ! -f "$src" ]; then
        echo "WARNING: missing vendored override $src — skipping $rel"
        return
    fi
    mkdir -p "$(dirname "$dst")"
    echo "Overriding $rel (profile in /var/lib/inputplumber/data)"
    cp "$src" "$dst"
}

install_device_override() {
    # Apex device config sits in /etc/inputplumber/devices.d/ where it
    # takes priority over the upstream 50-onexplayer_apex.yaml in /var.
    local src="$APEX_CFG_SRC/devices/50-onexplayer_apex.yaml"
    if [ ! -f "$src" ]; then
        echo "WARNING: missing vendored device override $src"
        return
    fi
    mkdir -p "$IP_ETC_DEVICES_D"
    echo "Overriding 50-onexplayer_apex.yaml (device in /etc/inputplumber/devices.d)"
    cp "$src" "$IP_ETC_DEVICES_D/50-onexplayer_apex.yaml"
    # Wipe the upstream copy inside /var so there's only one source of
    # truth — otherwise which file wins depends on alphabetical sort
    # across the two dirs.
    rm -f "$IP_DATA_DIR/devices/50-onexplayer_apex.yaml"
}

install_profile_override "profiles/default.yaml"
install_device_override
echo

# Reload dbus so the freshly-installed policy is picked up before we start.
if [ "$DBUS_POLICY_INSTALLED" = "1" ]; then
    echo "Reloading dbus to pick up InputPlumber policy..."
    systemctl reload dbus.service 2>/dev/null || systemctl reload dbus-broker.service 2>/dev/null || true
fi

# Restart (not just enable --now) so Apex overrides take effect even on
# re-runs where the service was already running from a prior invocation.
systemctl enable inputplumber.service
systemctl restart inputplumber.service
echo "InputPlumber installed, enabled, and started"
echo

# Garbage-collect any legacy /usr install from pre-ostree-safe migrations.
# These files would be dormant (the deployment they're overlay'd into
# rarely boots) but they're confusing during debugging.
for legacy in /usr/bin/inputplumber /usr/share/inputplumber \
              /usr/share/dbus-1/system.d/org.shadowblip.InputPlumber.conf; do
    if [ -e "$legacy" ] && [ -w "$(dirname "$legacy")" ]; then
        echo "Cleaning legacy $legacy from hotfix overlay"
        rm -rf "$legacy"
    fi
done
echo

# ─── Step 6: Verify ──────────────────────────────────────────────────

echo "── Step 6: Verification ──"

echo -n "inputplumber binary (/var): "
[ -x "$IP_BIN_DST" ] && echo "PRESENT" || echo "MISSING (error)"

echo -n "libiio staged (/var/lib/inputplumber/lib): "
ls "$IP_LIB_DIR"/libiio.so.* &>/dev/null && echo "PRESENT" || echo "MISSING (warning — binary will fail to start after next ostree reset)"

echo -n "Apex device override (/etc): "
[ -f "$IP_ETC_DEVICES_D/50-onexplayer_apex.yaml" ] && echo "PRESENT" || echo "MISSING (warning)"

echo -n "Apex profile override (/var): "
[ -f "$IP_DATA_DIR/profiles/default.yaml" ] && echo "PRESENT" || echo "MISSING (warning)"

echo -n "hid-oxp module: "
if grep -q "^hid_oxp " /proc/modules; then
    echo "LOADED"
else
    echo "NOT LOADED (warning)"
fi

echo -n "hid-oxp service: "
if systemctl is-enabled "$SERVICE_NAME" &>/dev/null; then
    echo "ENABLED"
else
    echo "NOT ENABLED (warning)"
fi

echo -n "HHD: "
if systemctl is-active hhd.service &>/dev/null; then
    echo "STILL RUNNING (warning — should be stopped)"
else
    echo "STOPPED"
fi

echo -n "InputPlumber: "
if systemctl is-active inputplumber.service &>/dev/null; then
    echo "RUNNING"
else
    echo "NOT RUNNING (warning)"
fi

# Check USB devices
echo -n "Vendor HID (1a86:fe00): "
if lsusb -d 1a86:fe00 &>/dev/null; then echo "PRESENT"; else echo "NOT FOUND"; fi

echo -n "Xbox gamepad (045e:028e): "
if lsusb -d 045e:028e &>/dev/null; then echo "PRESENT"; else echo "NOT FOUND"; fi

# Check sysfs
echo -n "RGB LED sysfs: "
if ls /sys/class/leds/oxp:rgb:joystick_rings/ &>/dev/null; then
    echo "PRESENT"
else
    echo "NOT FOUND (may appear after device rebind)"
fi

echo
echo "============================================"
echo "  Migration complete!"
echo "  Binary:   $IP_BIN_DST"
echo "  Configs:  $IP_DATA_DIR + $IP_ETC_DEVICES_D"
echo "  Reboot to have hid-oxp-load.service bring up the driver cleanly."
echo "============================================"
