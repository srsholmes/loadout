#!/usr/bin/env sh
#
# Recovery for a hung / deadlocked overlay.
#
# When something traps input — clipboard contention with another CEF
# client (Chrome + the overlay both racing on the X11 PRIMARY/CLIPBOARD
# selections under gamescope is one observed cause), a stuck on-screen
# keyboard, a focus-grab that never released — the overlay process
# stops responding but systemd's plain `restart` won't fix it because
# SIGTERM gets ignored (process is wedged in a syscall) and CEF state
# in `~/.cache/com.loadout.overlay/` may be torn from a previous
# SIGABRT.
#
# Sequence:
#   1. Stop both services. systemd will SIGTERM then SIGABRT after the
#      configured timeout — we wait it out.
#   2. SIGKILL any lingering launcher processes the service couldn't
#      reap (defence against the CEF zygote outliving its parent).
#   3. Wipe the per-user CEF cache. Holds the on-disk lock files +
#      partition state that a half-aborted run can leave inconsistent;
#      the overlay rebuilds it from scratch on next launch.
#   4. Start backend, wait briefly so the overlay's first /up probe
#      hits an already-listening server, then start overlay.
#   5. Report final service state so the caller knows what happened.
#
# Safe to run when nothing's hung — `systemctl stop` on an already-
# stopped unit is a no-op, `pkill -9 -f` on a missing name returns
# non-zero but `|| true` swallows it.

set -e

USER_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/com.loadout.overlay"

echo "[recover-overlay] Stopping services..."
systemctl --user stop loadout-overlay.service loadout.service 2>/dev/null || true

# A wedged launcher won't respond to SIGTERM. Give systemd's stop-
# sigterm timeout time to expire so it can fall through to SIGABRT,
# then sweep up anything still alive ourselves.
sleep 1

if pgrep -f loadout-overlay/bin >/dev/null 2>&1; then
    echo "[recover-overlay] SIGKILLing leftover CEF processes..."
    pkill -9 -f loadout-overlay/bin || true
    sleep 1
fi

if [ -d "$USER_CACHE" ]; then
    echo "[recover-overlay] Wiping CEF cache at $USER_CACHE..."
    rm -rf "$USER_CACHE"
fi

echo "[recover-overlay] Starting loadout..."
systemctl --user start loadout.service

# The overlay service's ExecStartPre polls /up — wait long enough for
# the backend's WS server to bind before kicking the launcher so we
# don't race the first connect.
PORT="${LOADOUT_PORT:-33820}"
for i in $(seq 1 30); do
    curl -sf "http://localhost:${PORT}/up" >/dev/null 2>&1 && break
    sleep 1
done

echo "[recover-overlay] Starting loadout-overlay..."
systemctl --user start loadout-overlay.service

# A couple of seconds for the launcher to actually come up; without
# the sleep `is-active` can race the daemon's state transition and
# report `activating`.
sleep 2

LOADER_STATE=$(systemctl --user is-active loadout.service 2>&1 || true)
OVERLAY_STATE=$(systemctl --user is-active loadout-overlay.service 2>&1 || true)

echo "[recover-overlay] loadout:         $LOADER_STATE"
echo "[recover-overlay] loadout-overlay: $OVERLAY_STATE"

if [ "$LOADER_STATE" = "active" ] && [ "$OVERLAY_STATE" = "active" ]; then
    echo "[recover-overlay] OK — both services running."
    exit 0
fi

echo "[recover-overlay] At least one service didn't come back up — check journalctl:" >&2
echo "  journalctl --user -u loadout.service -n 50 --no-pager" >&2
echo "  journalctl --user -u loadout-overlay.service -n 50 --no-pager" >&2
exit 1
