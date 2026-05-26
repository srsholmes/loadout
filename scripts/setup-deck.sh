#!/usr/bin/env bash
#
# setup-deck.sh — install the Steam Deck back-paddle → overlay toggle
# wiring (paddle → InputPlumber → F16 → Loadout's evdev QAM wake).
#
# Run once on a Steam Deck. Idempotent. Reboot after.
#
# Usage:
#   sudo bash scripts/setup-deck.sh [BUTTON ...]
#     BUTTON defaults to all four back paddles:
#       RightPaddle1 RightPaddle2 LeftPaddle1 LeftPaddle2
#     e.g. sudo bash scripts/setup-deck.sh RightPaddle1
#
#   sudo bash scripts/setup-deck.sh --uninstall
#
# See docs/steam-deck-overlay-trigger.md for the full rationale.

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "run with sudo: sudo bash $0" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ASSETS="$SCRIPT_DIR/deck-overlay-trigger"

# Destination paths — under /etc so they survive ostree deployment switches.
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
  exit 0
fi

# DMI sanity check — refuse to write Deck-specific config on non-Deck hardware.
PRODUCT="$(cat /sys/class/dmi/id/product_name 2>/dev/null || true)"
VENDOR="$(cat /sys/class/dmi/id/sys_vendor 2>/dev/null || true)"
case "$VENDOR/$PRODUCT" in
  Valve/Galileo|Valve/Jupiter) ;;
  *)
    echo "WARN: this machine reports $VENDOR/$PRODUCT, not a Steam Deck (Valve/Galileo or Valve/Jupiter)." >&2
    echo "      Pass --force to install anyway. Otherwise nothing was changed." >&2
    [ "${2:-${1:-}}" = "--force" ] || exit 1
    ;;
esac

BUTTONS=()
for arg in "$@"; do
  case "$arg" in --force) ;; *) BUTTONS+=("$arg") ;; esac
done
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

Done. Reboot, then press any of (${BUTTONS[*]}) — the Loadout overlay should
open via the same F16 wake path used by handheld QAM buttons elsewhere.

If the overlay still doesn't open after reboot, the uaccess rule may not have
applied — fall back to adding your user to the input group:
    sudo usermod -aG input \$USER   # then reboot

Undo everything:  sudo bash $0 --uninstall
DONE
