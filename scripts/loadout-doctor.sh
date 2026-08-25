#!/usr/bin/env sh
# ============================================================
# loadout-doctor — one-shot support dump
# ============================================================
#
# Written for the case where a user reports "Loadout isn't working"
# and nothing in the release diff explains it. Everything here is
# READ-ONLY: no installs, no service restarts, no config writes. The
# output is meant to be pasted into a bug report wholesale, so it
# errs towards printing too much rather than deciding in advance
# which half of it matters.
#
#   curl -fsSL https://raw.githubusercontent.com/srsholmes/loadout/main/scripts/loadout-doctor.sh | sh
#
# or, if it's already checked out:  sh scripts/loadout-doctor.sh
#
# Redirect to a file to send it on:
#   ... | sh > ~/loadout-doctor.txt 2>&1
#
# Nothing below uses sudo. Reading the *system* loadout.service journal
# normally needs membership in `wheel`/`adm`/`systemd-journal`; where
# that's absent the journal sections come back empty and say so rather
# than prompting for a password inside a piped-to-sh script (there's no
# TTY for it — see the `!`-prefix/sudo note in the install docs).

INSTALL_DIR="$HOME/.local/share/loadout"
OVERLAY_INSTALL_DIR="$HOME/.local/share/loadout-overlay"
PORT="${LOADOUT_PORT:-33820}"

section() {
    echo ""
    echo "=============================================================="
    echo "  $1"
    echo "=============================================================="
}

# Print "yes"/"NO" for a command's presence, plus its path when found.
have() {
    if command -v "$1" >/dev/null 2>&1; then
        printf '  %-12s yes  (%s)\n' "$1" "$(command -v "$1")"
    else
        printf '  %-12s NO\n' "$1"
    fi
}

section "Loadout doctor"
echo "  date:    $(date -Is 2>/dev/null || date)"
echo "  user:    $(id -un) (uid $(id -u))"
echo "  groups:  $(id -Gn)"

# ---------------------------------------------------------------
section "1. System"
# ---------------------------------------------------------------
echo "  kernel:  $(uname -r)"
echo "  arch:    $(uname -m)"
if [ -r /etc/os-release ]; then
    # PRETTY_NAME alone loses the ID/VARIANT that decide package names.
    grep -E '^(NAME|PRETTY_NAME|ID|ID_LIKE|VARIANT_ID|BUILD_ID|VERSION_ID)=' /etc/os-release | sed 's/^/  /'
else
    echo "  /etc/os-release unreadable"
fi

# ---------------------------------------------------------------
section "2. Required tools"
# ---------------------------------------------------------------
# Same list the installer enforces (REQUIRED_TOOLS in install.sh). A
# missing xdotool is the single highest-yield thing in this whole dump:
# as of v0.8.2 the overlay REFUSES to open in Gaming Mode without it.
for t in xdotool xprop xrandr pgrep tar systemctl; do have "$t"; done
echo ""
echo "  optional:"
for t in zenity kdialog yad busctl flatpak nmcli iw unzip zip bsdtar \
         podman distrobox legendary openrgb ectool lsusb udevadm inputplumber; do
    have "$t"
done

# The shared libraries libNativeWrapper.so dlopens at startup. A missing one
# is fatal — the overlay exits(1) before drawing anything and systemd
# restarts it forever — and it is invisible to a binaries-only check, which
# is how a CachyOS report got as far as "reinstall and downgrade" before
# anyone looked at a journal. Bundled copies in the overlay's own bin/ count,
# so both locations are reported.
echo ""
echo "  libraries (system, or bundled in the overlay's bin/):"
for so in libwebkit2gtk-4.1.so.0 libjavascriptcoregtk-4.1.so.0 \
          libayatana-appindicator3.so.1; do
    if ldconfig -p 2>/dev/null | grep -q "$so"; then
        printf '  %-34s system\n' "$so"
    elif [ -e "$OVERLAY_INSTALL_DIR/bin/$so" ]; then
        printf '  %-34s bundled\n' "$so"
    else
        printf '  %-34s MISSING  <-- overlay cannot start\n' "$so"
    fi
done

# ---------------------------------------------------------------
section "3. Install layout"
# ---------------------------------------------------------------
for p in "$INSTALL_DIR" "$OVERLAY_INSTALL_DIR" \
         "$HOME/.local/bin/loadout" \
         "$HOME/.local/share/applications/loadout.desktop" \
         "$HOME/.config/systemd/user/loadout-overlay.service" \
         "/etc/systemd/system/loadout.service"; do
    if [ -e "$p" ]; then
        printf '  EXISTS  %s\n' "$p"
    else
        printf '  MISSING %s\n' "$p"
    fi
done

echo ""
echo "  --- binary ---"
# Installs are not all in one place: the current installer puts the binary
# under ~/.local/share/loadout, but older and packaged installs run it from
# /usr/local/bin (a CachyOS report showed a healthy backend there while this
# section claimed "no executable"). Check every known location, and print
# what the unit ACTUALLY executes so the two can be compared.
_found_bin=""
for _cand in "$INSTALL_DIR/loadout" /usr/local/bin/loadout /usr/bin/loadout \
             "$HOME/.local/bin/loadout"; do
    [ -x "$_cand" ] || continue
    # Resolve symlinks: ~/.local/bin/loadout is normally a link to the real
    # binary, and reporting the link twice hides which one is stale.
    _real="$(readlink -f "$_cand" 2>/dev/null || echo "$_cand")"
    ls -l "$_cand" | sed 's/^/  /'
    [ "$_real" = "$_cand" ] || echo "      -> $_real"
    echo "      version: $("$_cand" --version 2>&1 | head -1)"
    _found_bin=1
done
[ -n "$_found_bin" ] || echo "  NO loadout executable found in any known location"

echo ""
echo "  ExecStart of the installed unit:"
systemctl show loadout -p ExecStart --value 2>/dev/null \
    | cut -c1-200 | sed 's/^/    /' || echo "    (unit not readable)"

echo ""
echo "  --- overlay bundle ---"
if [ -d "$OVERLAY_INSTALL_DIR" ]; then
    ls -la "$OVERLAY_INSTALL_DIR" 2>/dev/null | head -20 | sed 's/^/  /'
else
    echo "  not installed"
fi

echo ""
echo "  --- plugins ---"
ls -1 "$INSTALL_DIR/plugins" 2>/dev/null | sed 's/^/  /' || echo "  none"

# ---------------------------------------------------------------
section "4. Services"
# ---------------------------------------------------------------
# `-n 0` drops the journal tail systemctl would otherwise append — the
# logs get their own sections below, and here they'd be pushed off by
# the CGroup listing. That listing is also why lines are truncated: each
# CEF helper's argv is ~1500 characters and would otherwise be the bulk
# of this report.
echo "  --- loadout.service (system, runs as root) ---"
systemctl status loadout --no-pager -l -n 0 2>&1 | cut -c1-200 | sed 's/^/  /'
echo ""
echo "  enabled: $(systemctl is-enabled loadout 2>&1)"
echo "  active:  $(systemctl is-active loadout 2>&1)"

echo ""
echo "  --- loadout-overlay.service (user) ---"
systemctl --user status loadout-overlay --no-pager -l -n 0 2>&1 | cut -c1-200 | sed 's/^/  /'
echo ""
echo "  enabled: $(systemctl --user is-enabled loadout-overlay 2>&1)"
echo "  active:  $(systemctl --user is-active loadout-overlay 2>&1)"

# ---------------------------------------------------------------
section "5. Backend reachability"
# ---------------------------------------------------------------
# The backend serves both the desktop UI and the overlay's data. If
# /up doesn't answer, nothing downstream can work and the overlay's
# ExecStartPre wait loop never completes — so this one check
# separates "backend is dead" from "UI can't display".
echo "  probing http://localhost:$PORT/up ..."
if command -v curl >/dev/null 2>&1; then
    curl -fsS -m 5 -o /dev/null -w '  HTTP %{http_code} in %{time_total}s\n' \
        "http://localhost:$PORT/up" 2>&1 || echo "  UNREACHABLE"
elif command -v wget >/dev/null 2>&1; then
    wget -q -T 5 -O /dev/null "http://localhost:$PORT/up" \
        && echo "  reachable" || echo "  UNREACHABLE"
else
    echo "  neither curl nor wget available"
fi

echo ""
echo "  --- who holds port $PORT ---"
if command -v ss >/dev/null 2>&1; then
    ss -lntp 2>/dev/null | grep ":$PORT" | sed 's/^/  /' || echo "  nothing listening"
else
    echo "  ss not available"
fi

# ---------------------------------------------------------------
section "6. Display / session"
# ---------------------------------------------------------------
echo "  DISPLAY=${DISPLAY:-<unset>}"
echo "  WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-<unset>}"
echo "  XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-<unset>}"
echo "  XDG_CURRENT_DESKTOP=${XDG_CURRENT_DESKTOP:-<unset>}"
echo "  GAMESCOPE_DISPLAY=${GAMESCOPE_DISPLAY:-<unset>}"

# Gaming Mode is detected from the /proc comm prefix, NOT from
# $GAMESCOPE_DISPLAY — the real comm is "gamescope-wl" and the env var
# is unset in plenty of working sessions.
if pgrep -a gamescope >/dev/null 2>&1; then
    echo "  gamescope: RUNNING (likely Gaming Mode)"
    pgrep -a gamescope 2>/dev/null | head -5 | sed 's/^/    /'
else
    echo "  gamescope: not running (likely Desktop Mode)"
fi

echo ""
echo "  steam: $(pgrep -c steam 2>/dev/null || echo 0) process(es)"

# ---------------------------------------------------------------
section "7. Logs — backend (this boot)"
# ---------------------------------------------------------------
journalctl -u loadout -b --no-pager -n 80 2>&1 | tail -80 | sed 's/^/  /'

# ---------------------------------------------------------------
section "8. Logs — overlay (this boot)"
# ---------------------------------------------------------------
journalctl --user -u loadout-overlay -b --no-pager -n 120 2>&1 | tail -120 | sed 's/^/  /'

# ---------------------------------------------------------------
section "9. Smoking guns"
# ---------------------------------------------------------------
# Greps for the specific strings the known failure modes emit, so a
# reporter who won't read 200 lines of journal still surfaces the
# one line that matters.
echo "  --- missing-tool banner (v0.8.2 preflight) ---"
journalctl --user -u loadout-overlay -b --no-pager 2>/dev/null \
    | grep -iE "MISSING REQUIRED TOOL|REFUSED|xdotool not found" \
    | tail -10 | sed 's/^/  /' || true
echo ""
echo "  --- shared-library / loader errors ---"
journalctl --user -u loadout-overlay -b --no-pager 2>/dev/null \
    | grep -iE "error while loading shared libraries|cannot open shared object|symbol lookup error|GLIBC_" \
    | tail -10 | sed 's/^/  /' || true
echo ""
echo "  --- crashes ---"
journalctl --user -u loadout-overlay -b --no-pager 2>/dev/null \
    | grep -iE "stack smashing|Segmentation fault|core-dumped|SIGSEGV|SIGABRT" \
    | tail -10 | sed 's/^/  /' || true
echo ""
echo "  --- start-limit / restart loops ---"
journalctl --user -u loadout-overlay -b --no-pager 2>/dev/null \
    | grep -iE "start-limit|Scheduled restart|too often recently|Failed with result" \
    | tail -10 | sed 's/^/  /' || true

# ---------------------------------------------------------------
section "10. Device hardware"
# ---------------------------------------------------------------
# Everything a "does my handheld work" report needs, in one paste.
#
# The recurring failure is a board whose kernel driver never bound: no
# oxpec/ayn-platform/etc. means no hwmon node, which means fan control has
# nothing to write to and its safety floor is inert. That is invisible in
# the sections above, and indistinguishable from a Loadout bug without it.
#
# DMI first: the exact product_name is what decides whether a driver's DMI
# table matches, which TDP profile is picked, and what an upstream patch
# would need to add.
echo "  --- DMI ---"
for f in sys_vendor product_name product_version board_name bios_version; do
    v=$(cat "/sys/class/dmi/id/$f" 2>/dev/null)
    printf "  %-16s %s\n" "$f:" "${v:-<unreadable>}"
done

echo ""
echo "  --- hwmon (fan control needs fanN_input + pwmN + pwmN_enable, or a writable fanN_target) ---"
found_hwmon=0
for d in /sys/class/hwmon/hwmon*; do
    [ -d "$d" ] || continue
    found_hwmon=1
    name=$(cat "$d/name" 2>/dev/null)
    attrs=""
    for a in fan1_input pwm1 pwm1_enable fan1_target temp1_input; do
        [ -e "$d/$a" ] && attrs="$attrs $a"
    done
    printf "  %-28s %s\n" "$(basename "$d") ${name:-?}" "${attrs:- (no fan/temp attrs)}"
done
[ "$found_hwmon" -eq 1 ] || echo "  no /sys/class/hwmon entries at all"

echo ""
echo "  --- platform / HID drivers ---"
if [ -r /proc/modules ]; then
    mods=$(grep -iE '^(oxpec|oxp_platform|oxp_sensors|hid_oxp|ayn_platform|ayaneo_platform|gpdfan|asus_wmi) ' /proc/modules | awk '{print $1}' | tr '\n' ' ')
    echo "  loaded: ${mods:-<none of the known handheld platform drivers>}"
else
    echo "  /proc/modules unreadable"
fi
if [ -f /etc/modprobe.d/hid-oxp.conf ]; then
    echo "  NOTE: /etc/modprobe.d/hid-oxp.conf present — hid-oxp is blacklisted."
    echo "        That disables rumble/gamepad-mode/button remapping. Remove it in the"
    echo "        OneXPlayer plugin; Loadout no longer recommends it."
fi

echo ""
echo "  --- ectool ---"
# `command -v ectool` is not enough: the binary exists on hardware where the
# handshake fails (no ChromeOS-style EC behind it), which is exactly the
# fallback fan-control probes with `ectool hello`.
if command -v ectool >/dev/null 2>&1; then
    if ectool hello >/dev/null 2>&1; then
        echo "  ectool hello: OK (usable fan fallback)"
    else
        echo "  ectool hello: FAILED (binary present but no usable EC — normal on OneXPlayer)"
    fi
else
    echo "  ectool: not installed"
fi

echo ""
echo "  --- HID device attributes ---"
found_hid=0
for d in /sys/bus/hid/devices/*; do
    [ -d "$d" ] || continue
    attrs=""
    for a in rumble_intensity rumble_intensity_range gamepad_mode; do
        [ -e "$d/$a" ] && attrs="$attrs $a=$(cat "$d/$a" 2>/dev/null | tr -d '\n')"
    done
    if [ -n "$attrs" ]; then
        found_hid=1
        printf "  %-30s %s\n" "$(basename "$d")" "$attrs"
    fi
done
[ "$found_hid" -eq 1 ] || echo "  no HID device exposes rumble/gamepad-mode attributes"

echo ""
echo "  --- temperatures now ---"
for d in /sys/class/hwmon/hwmon*; do
    [ -r "$d/temp1_input" ] || continue
    t=$(cat "$d/temp1_input" 2>/dev/null)
    [ -n "$t" ] || continue
    printf "  %-16s %s C\n" "$(cat "$d/name" 2>/dev/null)" "$((t / 1000))"
done

echo ""
echo "  --- backend plugin lines (hardware detection) ---"
journalctl -u loadout -b --no-pager 2>/dev/null \
    | grep -iE "\[fan-control\]|\[tdp-control\]|\[vibration\]|\[apex\]" \
    | tail -20 | sed 's/^/  /' || true

section "End of report"
echo "  Paste this whole output into the issue / thread."
echo ""
