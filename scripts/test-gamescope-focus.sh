#!/usr/bin/env bash
# Test whether prepending an appId to GAMESCOPECTRL_BASELAYER_APPID
# is enough to make gamescope switch focus to that app's window.
#
# Usage:
#   scripts/test-gamescope-focus.sh                  # dump only
#   scripts/test-gamescope-focus.sh <appId>          # dump + try to focus
#   DISPLAY=:1 scripts/test-gamescope-focus.sh <id>  # override display
#
# Exit code is 0 iff the write succeeded AND gamescope's focused-app
# changed to the requested appId within 1s.

set -u

# Default display: outer X is :0 on most gamescope-session-plus setups.
# `xprop -root` will fail loud if this is wrong; user can re-run with DISPLAY=...
: "${DISPLAY:=:0}"
export DISPLAY

dump() {
  echo "=== gamescope state on DISPLAY=$DISPLAY ==="
  xprop -root \
    GAMESCOPECTRL_BASELAYER_APPID \
    GAMESCOPE_FOCUSED_APP \
    GAMESCOPE_FOCUSED_WINDOW \
    GAMESCOPE_FOCUSABLE_APPS \
    GAMESCOPE_FOCUSABLE_WINDOWS \
    2>&1 || {
      echo "xprop -root failed — wrong DISPLAY?"
      return 1
    }
}

dump
echo

if [[ $# -eq 0 ]]; then
  echo "(dump only — pass an appId to attempt a focus switch)"
  echo
  echo "Tip: copy a value out of GAMESCOPE_FOCUSABLE_APPS above and re-run as:"
  echo "  $0 <appId>"
  exit 0
fi

target="$1"
if ! [[ "$target" =~ ^[0-9]+$ ]]; then
  echo "appId must be a positive integer; got: $target" >&2
  exit 2
fi

# Read current list, dedupe target, prepend it.
current=$(xprop -root GAMESCOPECTRL_BASELAYER_APPID 2>/dev/null \
  | sed -n 's/.* = //p')
if [[ -z "$current" ]]; then
  echo "Couldn't read GAMESCOPECTRL_BASELAYER_APPID — wrong DISPLAY?" >&2
  exit 3
fi

echo "Current BASELAYER_APPID: $current"
# Strip target if already present, then prepend.
filtered=$(echo "$current" | tr -d ' ' | tr ',' '\n' | grep -v "^$target$" | paste -sd,)
new="$target${filtered:+,$filtered}"
echo "Writing      BASELAYER_APPID: $new"

xprop -root \
  -f GAMESCOPECTRL_BASELAYER_APPID 32c \
  -set GAMESCOPECTRL_BASELAYER_APPID "$new"
write_status=$?

if [[ $write_status -ne 0 ]]; then
  echo "xprop -set failed (exit=$write_status)" >&2
  exit 4
fi

# Wait for gamescope to react.
sleep 1
echo
echo "=== state after write ==="
xprop -root \
  GAMESCOPECTRL_BASELAYER_APPID \
  GAMESCOPE_FOCUSED_APP \
  GAMESCOPE_FOCUSED_WINDOW \
  2>&1

focused=$(xprop -root GAMESCOPE_FOCUSED_APP 2>/dev/null \
  | sed -n 's/.* = //p' | tr -d ' ')

echo
if [[ "$focused" == "$target" ]]; then
  echo "✓ FOCUS SWITCHED to $target"
  exit 0
else
  echo "✗ FOCUS DID NOT SWITCH (focused=$focused, expected=$target)"
  echo
  echo "If the target appId isn't in GAMESCOPE_FOCUSABLE_APPS above, gamescope"
  echo "doesn't have a focusable window for it — Steam may not have registered"
  echo "the shortcut's window yet, or the app hasn't fully started."
  exit 5
fi
