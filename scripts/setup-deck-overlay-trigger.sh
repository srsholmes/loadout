#!/usr/bin/env bash
#
# setup-deck-overlay-trigger.sh — install the Steam Deck back-paddle ->
# overlay-toggle wiring (paddle -> InputPlumber -> F16 -> overlay QAM wake).
#
# See docs/steamos-deck-controller-overlay-trigger.md for the full rationale.
# Idempotent. Run with sudo. Reboot after.
#
# Usage:
#   sudo scripts/setup-deck-overlay-trigger.sh [BUTTON ...]
#     BUTTON defaults to all four back paddles
#     e.g. sudo scripts/setup-deck-overlay-trigger.sh RightPaddle1
#
#   sudo scripts/setup-deck-overlay-trigger.sh --uninstall
#
# All vendored assets live alongside this script under deck-overlay-trigger/.
# This wrapper copies them into place and renders one piece (the per-user
# button mapping) via deck-overlay-trigger/inputplumber/render-profile.sh.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "run with sudo" >&2; exit 1; fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ASSETS="$SCRIPT_DIR/deck-overlay-trigger"

# Destination paths — all under /etc so they survive ostree deployment
# switches on SteamOS.
DEV_OVERRIDE=/etc/inputplumber/devices.d/50-steam_deck.yaml
PROFILE_DIR=/etc/loadout/inputplumber
PROFILE=$PROFILE_DIR/overlay-profile.yaml
LOADER=$PROFILE_DIR/ip-load-profile.sh
UNIT=/etc/systemd/system/loadout-ip-profile.service
UDEV_RULE=/etc/udev/rules.d/71-loadout-inputplumber-uaccess.rules

if [ "${1:-}" = "--uninstall" ]; then
  systemctl disable --now loadout-ip-profile.service 2>/dev/null || true
  rm -f "$UNIT" "$DEV_OVERRIDE" "$UDEV_RULE" "$PROFILE" "$LOADER"
  rmdir "$PROFILE_DIR" 2>/dev/null || true
  systemctl disable --now inputplumber.service 2>/dev/null || true
  systemctl daemon-reload
  udevadm control --reload 2>/dev/null || true
  echo "Removed. Reboot to fully restore Steam Input."
  echo "(Group membership, if added via 'usermod -aG input', is left intact.)"
  exit 0
fi

BUTTONS=("$@")
[ ${#BUTTONS[@]} -eq 0 ] && BUTTONS=(RightPaddle1 RightPaddle2 LeftPaddle1 LeftPaddle2)

install_file() {
  # install_file SRC DST [MODE]
  local src="$1" dst="$2" mode="${3:-0644}"
  [ -f "$src" ] || { echo "missing vendored asset: $src" >&2; exit 1; }
  mkdir -p "$(dirname "$dst")"
  install -m "$mode" "$src" "$dst"
  echo "  installed $dst"
}

echo "== 1. device override (auto_manage)"
install_file "$ASSETS/inputplumber/devices/50-steam_deck.yaml" "$DEV_OVERRIDE"

echo "== 2. overlay-trigger profile  [buttons: ${BUTTONS[*]}]"
mkdir -p "$PROFILE_DIR"
"$ASSETS/inputplumber/render-profile.sh" \
  "$ASSETS/inputplumber/profiles/overlay-trigger.header.yaml" \
  "${BUTTONS[@]}" > "$PROFILE"
chmod 0644 "$PROFILE"
echo "  rendered  $PROFILE"

echo "== 3. boot loader script"
install_file "$ASSETS/bin/ip-load-profile.sh" "$LOADER" 0755

echo "== 4. boot one-shot unit"
install_file "$ASSETS/systemd/loadout-ip-profile.service" "$UNIT"

echo "== 5. uaccess udev rule"
install_file "$ASSETS/udev/71-inputplumber-uaccess.rules" "$UDEV_RULE"

echo "== 6. reload + enable"
udevadm control --reload && udevadm trigger --subsystem-match=input 2>/dev/null || true
systemctl daemon-reload
systemctl enable inputplumber.service loadout-ip-profile.service

cat <<DONE

Done. Reboot, then press any of (${BUTTONS[*]}) from the Steam UI.

If the overlay still doesn't open after reboot, the uaccess rule may not have
applied — fall back to adding your user to the input group (validated working):
    sudo usermod -aG input \$USER   # then reboot

Undo everything:  sudo $0 --uninstall
DONE
