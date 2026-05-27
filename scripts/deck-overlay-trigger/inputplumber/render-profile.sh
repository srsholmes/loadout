#!/usr/bin/env bash
#
# render-profile.sh — emit an InputPlumber DeviceProfile to stdout that maps
# the given gamepad button source names to KEY_F16 (the overlay's QAM wake).
#
# Usage:
#   render-profile.sh HEADER_PATH BUTTON [BUTTON ...]
#
# Example:
#   render-profile.sh ./overlay-trigger.header.yaml RightPaddle1 LeftPaddle1
#
# The header file supplies version/kind/name/target_devices and the bare
# `mapping:` key; this script appends one entry per button below it. Kept as
# a separate script (not inlined into the installer) so a future TS backend
# can shell out to the same renderer when the overlay UI lets the user
# re-pick buttons live.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 HEADER_PATH BUTTON [BUTTON ...]" >&2
  exit 2
fi

HEADER="$1"; shift

if [ ! -f "$HEADER" ]; then
  echo "render-profile: header not found: $HEADER" >&2
  exit 1
fi

cat "$HEADER"
for button in "$@"; do
  printf '  - name: %s -> F16\n' "$button"
  printf '    source_event: { gamepad: { button: %s } }\n' "$button"
  printf '    target_events: [ { keyboard: KeyF16 } ]\n'
done
