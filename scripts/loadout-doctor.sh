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
if [ -x "$INSTALL_DIR/loadout" ]; then
    ls -l "$INSTALL_DIR/loadout" | sed 's/^/  /'
    # --version is the ground truth for what's installed. The GitHub
    # release tag and the on-disk binary can disagree if an install
    # half-failed, which is exactly the case this script is for.
    echo "  version: $("$INSTALL_DIR/loadout" --version 2>&1 | head -3)"
else
    echo "  no executable at $INSTALL_DIR/loadout"
fi

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

section "End of report"
echo "  Paste this whole output into the issue / thread."
echo ""
