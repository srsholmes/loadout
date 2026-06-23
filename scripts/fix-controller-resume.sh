#!/bin/bash
#
# fix-controller-resume.sh — bring the gamepad back after sleep/resume.
#
# On this hardware (OneXPlayer Apex internal pad) the xHCI USB host
# controller can die on resume from s2idle:
#
#   xhci_hcd 0000:65:00.4: xHCI host controller not responding, assume dead
#   xhci_hcd 0000:65:00.4: HC died; cleaning up
#   usb 1-1: USB disconnect ...
#
# When that happens the internal gamepad (1a86:fe00 HID MCU +
# 045e:028e Xbox 360 pad) falls off the bus entirely, so the device
# node is GONE — restarting InputPlumber can't help, there is nothing
# left for it to grab. The only reliable recovery is to unbind and
# rebind the xHCI PCI controller so the whole bus re-enumerates.
#
# This is the manual, run-it-yourself version of the recovery logic
# from PR #85 (no plugin, no persistent service). Just run it after a
# wake where the controller is dead:
#
#   ./scripts/fix-controller-resume.sh
#
# It elevates with sudo only for the sysfs writes / IP restart.
#
# Override the controller address if your hardware differs:
#   XHCI_PCI=0000:xx:xx.x ./scripts/fix-controller-resume.sh
#
set -euo pipefail

# --- config ----------------------------------------------------------------

# Known xHCI controller for the Apex internal gamepad. Stable across
# firmware revisions. Override via env if needed.
DEFAULT_XHCI_PCI="0000:65:00.4"

# Internal gamepad USB IDs — used to confirm recovery worked.
GAMEPAD_IDS=("1a86:fe00" "045e:028e")

DRIVER_DIR="/sys/bus/pci/drivers/xhci_hcd"

log() { printf '\033[36m[fix-controller]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[fix-controller]\033[0m %s\n' "$*" >&2; }

# --- pick the controller ---------------------------------------------------

# If the caller didn't pin one, try to spot a controller the kernel just
# declared dead; otherwise fall back to the known Apex address.
detect_dead_controller() {
  dmesg 2>/dev/null \
    | grep -iE "xhci_hcd [0-9a-f:.]+: HC died|assume dead" \
    | grep -oE "0000:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]" \
    | tail -1
}

XHCI_PCI="${XHCI_PCI:-}"
if [ -z "$XHCI_PCI" ]; then
  XHCI_PCI="$(detect_dead_controller || true)"
  if [ -n "$XHCI_PCI" ]; then
    log "Detected dead xHCI controller from kernel log: $XHCI_PCI"
  else
    XHCI_PCI="$DEFAULT_XHCI_PCI"
    log "No dead controller in dmesg; using default $XHCI_PCI"
  fi
fi

if [ ! -e "/sys/bus/pci/devices/$XHCI_PCI" ]; then
  err "PCI device $XHCI_PCI does not exist. Set XHCI_PCI=<addr> and retry."
  err "Available xhci_hcd controllers:"
  ls "$DRIVER_DIR" 2>/dev/null | grep -E "^0000:" >&2 || true
  exit 1
fi

# --- helpers ---------------------------------------------------------------

gamepad_present() {
  local id
  for id in "${GAMEPAD_IDS[@]}"; do
    lsusb -d "$id" >/dev/null 2>&1 || return 1
  done
  return 0
}

# --- rebind ----------------------------------------------------------------

log "Rebinding xHCI controller $XHCI_PCI ..."

# Unbind only if currently bound (driver symlink present).
if [ -e "/sys/bus/pci/devices/$XHCI_PCI/driver" ]; then
  log "  unbind"
  echo -n "$XHCI_PCI" | sudo tee "$DRIVER_DIR/unbind" >/dev/null || true
  sleep 1
fi

log "  bind"
echo -n "$XHCI_PCI" | sudo tee "$DRIVER_DIR/bind" >/dev/null || true
sleep 2

# Second attempt if the controller didn't re-attach the first time.
if [ ! -e "/sys/bus/pci/devices/$XHCI_PCI/driver" ]; then
  log "  bind didn't stick — retrying"
  echo -n "$XHCI_PCI" | sudo tee "$DRIVER_DIR/bind" >/dev/null || true
  sleep 2
fi

# --- verify ----------------------------------------------------------------

# Give the bus a moment to enumerate downstream devices.
for _ in 1 2 3 4 5; do
  gamepad_present && break
  sleep 1
done

if gamepad_present; then
  log "Gamepad USB devices are back:"
  for id in "${GAMEPAD_IDS[@]}"; do
    log "  $(lsusb -d "$id" | sed 's/^/    /')"
  done
else
  err "Gamepad USB IDs still missing after rebind (${GAMEPAD_IDS[*]})."
  err "The controller may need a physical reconnect, or this is a"
  err "different failure than the xHCI resume death. Check: dmesg | tail"
  exit 1
fi

# Nudge InputPlumber so it re-grabs the freshly enumerated source device.
if systemctl is-active --quiet inputplumber 2>/dev/null; then
  log "Restarting InputPlumber so it re-grabs the gamepad ..."
  sudo systemctl reset-failed inputplumber 2>/dev/null || true
  sudo systemctl restart inputplumber 2>/dev/null || true
fi

log "Done. Controller should be working again."
