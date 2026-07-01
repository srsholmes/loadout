#!/bin/sh
# Enable passwordless sudo for managing the loadout backend service.
#
# Why: the backend runs as a ROOT system service (loadout.service). Every dev
# re-deploy has to restart it to pick up a new frontend/backend bundle, which
# means `sudo systemctl restart loadout.service` — and that needs an
# interactive TTY for the password, which agent/non-interactive shells don't
# have. This drops in a narrowly-scoped sudoers rule so those restarts stop
# prompting.
#
# SECURITY — this is NOT blanket passwordless sudo. It whitelists ONLY a fixed
# set of `systemctl … loadout.service` commands (plus `daemon-reload`) for your
# user, and the rule is validated with `visudo` before it's installed so a typo
# can never lock you out of sudo. Remove it any time with:
#
#     sudo rm /etc/sudoers.d/loadout-dev
#
# Usage:  sh scripts/enable-sudoless-loadout.sh
set -eu

# Resolve the real (non-root) user the rule should apply to. Works whether the
# script is run plainly or via sudo.
TARGET_USER="${SUDO_USER:-$(id -un)}"
if [ "$TARGET_USER" = "root" ]; then
    echo "ERROR: run this as your normal user (it sudo's internally), not as root." >&2
    exit 1
fi

# sudoers requires absolute command paths.
SYSTEMCTL="$(command -v systemctl 2>/dev/null || echo /usr/bin/systemctl)"
if [ ! -x "$SYSTEMCTL" ]; then
    echo "ERROR: systemctl not found at $SYSTEMCTL." >&2
    exit 1
fi

SERVICE="loadout.service"
# sudo applies the LAST matching rule, and /etc/sudoers.d files are read in
# lexical order. Distros (incl. SteamOS) grant the user broad access via a
# `wheel` drop-in (`%wheel ALL=(ALL) ALL`, needs a password). If our file
# sorts BEFORE `wheel`, that broad rule is read later and overrides our
# NOPASSWD — so the prompt never goes away. The `zzz-` prefix makes our file
# sort last, so our NOPASSWD is the final matching rule and wins.
DROPIN="/etc/sudoers.d/zzz-loadout-dev"
# Older versions of this script installed under this name (sorts too early).
OLD_DROPIN="/etc/sudoers.d/loadout-dev"

# Whitelisted commands — scoped to the loadout unit only. NOPASSWD applies to
# the whole comma-separated list.
RULE="$TARGET_USER ALL=(root) NOPASSWD: \
$SYSTEMCTL restart $SERVICE, \
$SYSTEMCTL start $SERVICE, \
$SYSTEMCTL stop $SERVICE, \
$SYSTEMCTL status $SERVICE, \
$SYSTEMCTL daemon-reload"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
{
    echo "# Managed by scripts/enable-sudoless-loadout.sh"
    echo "# Passwordless loadout.service control for '$TARGET_USER'. Remove with: sudo rm $DROPIN"
    echo "$RULE"
} > "$TMP"

echo "This installs a scoped passwordless-sudo rule for '$TARGET_USER':"
echo "    sudo systemctl {restart,start,stop,status} $SERVICE"
echo "    sudo systemctl daemon-reload"
echo "sudo will prompt for your password ONCE now to install + validate the rule."
echo

# Validate the candidate file BEFORE it goes live — a bad sudoers file that
# reaches /etc/sudoers.d can break sudo entirely, so never skip this.
if ! sudo visudo -cf "$TMP" >/dev/null; then
    echo "ERROR: generated rule failed 'visudo -c'; NOT installing. Contents:" >&2
    cat "$TMP" >&2
    exit 1
fi

# Install with the perms sudo requires (0440 root:root) and re-check the whole
# sudoers set for good measure. Drop any earlier, wrongly-sorted copy first.
sudo install -m 0440 -o root -g root "$TMP" "$DROPIN"
sudo rm -f "$OLD_DROPIN"
sudo visudo -c >/dev/null

echo "OK — installed $DROPIN and validated sudoers."
echo "Try it:  sudo -n systemctl restart $SERVICE   # should NOT prompt"
echo "Undo:    sudo rm $DROPIN"
