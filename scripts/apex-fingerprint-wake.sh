#!/usr/bin/env bash
# apex-fingerprint-wake.sh — block/unblock the OneXPlayer Apex fingerprint
# reader as a wake source. Prototype for the loadout `apex` plugin (PR 2);
# mirrors how scripts/fix-controller-resume.sh prototyped the xHCI fix.
#
# On the Apex the power-button fingerprint sensor (FocalTech 2808:c652) wakes
# the device from sleep on a light TOUCH, via TWO independent paths:
#
#   Path 1 — GPIO wake line (pinctrl_amd, ACPI dev AMDI0030:00, pin 58).
#     Disarmed only by a kernel arg: gpiolib_acpi.ignore_wake=AMDI0030:00@58
#     Boot-time → needs a reboot to take effect / to undo.
#
#   Path 2 — PCIe PME from the fingerprint's xHCI controller.
#     Disarmed at runtime: power/wakeup=disabled on that controller,
#     persisted with a udev rule. No reboot.
#
# A power-button PRESS still wakes the device (separate ACPI fixed event),
# and the internal gamepad's controller (a different xHCI) is untouched.
#
# Usage:
#   sudo ./apex-fingerprint-wake.sh status     # show current wake state
#   sudo ./apex-fingerprint-wake.sh disable    # block fingerprint wake
#   sudo ./apex-fingerprint-wake.sh enable      # restore fingerprint wake
#
# Auto-detects the fingerprint's xHCI controller. The GPIO pin/ACPI device
# are the known Apex values (overridable below) — the plugin will derive the
# pin from the wake-source report instead of hardcoding.

set -euo pipefail

FP_VID="2808"
FP_PID="c652"
GPIO_ACPI_DEV="AMDI0030:00"
GPIO_PIN="58"
KARG="gpiolib_acpi.ignore_wake=${GPIO_ACPI_DEV}@${GPIO_PIN}"
UDEV_RULE="/etc/udev/rules.d/90-loadout-fingerprint-no-wake.rules"

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[1;33m'; NC=$'\033[0m'
info() { printf '%s[*]%s %s\n' "$GRN" "$NC" "$*"; }
warn() { printf '%s[!]%s %s\n' "$YEL" "$NC" "$*"; }
err()  { printf '%s[x]%s %s\n' "$RED" "$NC" "$*" >&2; }

[ "$(id -u)" -eq 0 ] || { err "Run with sudo."; exit 1; }

# --- detection ---------------------------------------------------------------

# Find the fingerprint USB device node (e.g. "3-4").
find_fp_dev() {
  local d
  for d in /sys/bus/usb/devices/*; do
    [ -f "$d/idVendor" ] || continue
    if [ "$(cat "$d/idVendor")" = "$FP_VID" ] && [ "$(cat "$d/idProduct" 2>/dev/null)" = "$FP_PID" ]; then
      basename "$d"; return 0
    fi
  done
  return 1
}

# Resolve the xHCI PCI controller (e.g. "0000:67:00.0") hosting a USB device
# by walking from its root hub up to the PCI parent.
find_fp_controller() {
  local fpdev busnum real
  fpdev="$(find_fp_dev)" || return 1
  busnum="$(cat "/sys/bus/usb/devices/${fpdev}/busnum")"
  real="$(readlink -f "/sys/bus/usb/devices/usb${busnum}")" || return 1
  basename "$(dirname "$real")"
}

karg_active()  { grep -qw "$KARG" /proc/cmdline; }

# Is the karg staged in the SteamOS grub source (pending a reboot)?
karg_staged_steamos() { [ -f /etc/default/grub-steamos ] && grep -q "$KARG" /etc/default/grub-steamos; }

distro_id() { [ -r /etc/os-release ] && ( . /etc/os-release && printf '%s' "${ID:-}" ); }

# --- status ------------------------------------------------------------------

cmd_status() {
  local fpdev ctrl
  fpdev="$(find_fp_dev || true)"
  ctrl="$(find_fp_controller || true)"
  echo "Fingerprint device : ${fpdev:-NOT FOUND} (${FP_VID}:${FP_PID})"
  echo "xHCI controller    : ${ctrl:-NOT FOUND}"
  if [ -n "$ctrl" ]; then
    echo "  controller wakeup: $(cat "/sys/bus/pci/devices/${ctrl}/power/wakeup" 2>/dev/null || echo '?')   (path 2 / PCIe PME)"
  fi
  echo "udev rule          : $([ -f "$UDEV_RULE" ] && echo present || echo absent)"
  echo "GPIO karg active   : $(karg_active && echo "yes ($KARG)" || echo no)   (path 1 / GPIO wake)"
  if command -v sudo >/dev/null && [ -e /sys/kernel/debug/gpio ]; then
    local row
    row="$(grep -E "#${GPIO_PIN}\b" /sys/kernel/debug/gpio 2>/dev/null | head -1 || true)"
    [ -n "$row" ] && echo "GPIO #${GPIO_PIN} line     : ${row}"
  fi
  echo
  if karg_active && [ -n "$ctrl" ] && [ "$(cat "/sys/bus/pci/devices/${ctrl}/power/wakeup" 2>/dev/null)" = "disabled" ]; then
    info "Both wake paths are BLOCKED — a fingerprint touch should not wake the device."
  else
    warn "At least one wake path is OPEN — a fingerprint touch may still wake the device."
  fi
}

# --- path 2: controller PME (runtime + udev) ---------------------------------

disable_pme() {
  local ctrl="$1"
  echo disabled > "/sys/bus/pci/devices/${ctrl}/power/wakeup"
  info "Runtime: ${ctrl} power/wakeup = disabled"
  cat > "$UDEV_RULE" <<EOF
# Block wake from the xHCI controller hosting the FocalTech fingerprint reader.
# A fingerprint touch makes this controller raise a PCIe PME that wakes the
# device from sleep; the device's own power/wakeup does not stop it. The
# gamepad is on a different controller and is unaffected; a power-button press
# (ACPI fixed event) still wakes. Managed by apex-fingerprint-wake.sh.
ACTION=="add", SUBSYSTEM=="pci", KERNEL=="${ctrl}", ATTR{power/wakeup}="disabled"
EOF
  udevadm control --reload-rules >/dev/null 2>&1 || true
  info "Persisted: ${UDEV_RULE}"
}

enable_pme() {
  local ctrl="$1"
  [ -n "$ctrl" ] && echo enabled > "/sys/bus/pci/devices/${ctrl}/power/wakeup" 2>/dev/null || true
  [ -f "$UDEV_RULE" ] && { rm -f "$UDEV_RULE"; udevadm control --reload-rules >/dev/null 2>&1 || true; }
  info "Restored controller wake; removed udev rule."
}

# --- path 1: GPIO karg (per-distro; SteamOS implemented here) ----------------

add_karg_steamos() {
  if karg_active || karg_staged_steamos; then
    info "GPIO karg already present (active or staged) — nothing to do."
    return 0
  fi
  steamos-readonly disable
  # Append the karg inside the GRUB_CMDLINE_LINUX="...\n...\n" block in
  # grub-steamos (each karg on its own backslash-continued line).
  cp /etc/default/grub-steamos "/etc/default/grub-steamos.bak.$(date +%s)"
  awk -v karg="$KARG" '
    /^GRUB_CMDLINE_LINUX="/ { ingrub=1 }
    ingrub && /"[[:space:]]*$/ && !done {
      sub(/"[[:space:]]*$/, karg " \\\n\"")
      done=1; ingrub=0
    }
    { print }
  ' /etc/default/grub-steamos > /tmp/grub-steamos.new
  cp /tmp/grub-steamos.new /etc/default/grub-steamos
  update-grub
  steamos-readonly enable
  warn "GPIO karg staged. REBOOT required for path 1 to take effect."
}

remove_karg_steamos() {
  if ! karg_staged_steamos && ! karg_active; then
    info "GPIO karg not present — nothing to remove."
    return 0
  fi
  steamos-readonly disable
  cp /etc/default/grub-steamos "/etc/default/grub-steamos.bak.$(date +%s)"
  # Drop the whole continued line that carries the karg.
  grep -v "$KARG" /etc/default/grub-steamos > /tmp/grub-steamos.new
  cp /tmp/grub-steamos.new /etc/default/grub-steamos
  update-grub
  steamos-readonly enable
  warn "GPIO karg removed from grub. REBOOT required for path 1 to revert."
}

karg_note_other() {
  warn "Distro '$(distro_id)' karg automation not implemented in this prototype."
  warn "Add this kernel arg manually, then reboot:  ${KARG}"
  warn "  Bazzite:  sudo rpm-ostree kargs --append-if-missing='${KARG}'"
  warn "  CachyOS/Arch (grub):  add to GRUB_CMDLINE_LINUX_DEFAULT in /etc/default/grub, then sudo grub-mkconfig -o /boot/grub/grub.cfg"
}

# --- commands ----------------------------------------------------------------

cmd_disable() {
  local ctrl; ctrl="$(find_fp_controller)" || { err "Could not find the fingerprint's xHCI controller."; exit 1; }
  info "Fingerprint controller: ${ctrl}"
  disable_pme "$ctrl"
  case "$(distro_id)" in
    steamos) add_karg_steamos ;;
    *) karg_note_other ;;
  esac
  echo; cmd_status
}

cmd_enable() {
  local ctrl; ctrl="$(find_fp_controller || true)"
  enable_pme "$ctrl"
  case "$(distro_id)" in
    steamos) remove_karg_steamos ;;
    *) warn "Remove the kernel arg '${KARG}' manually if you added it." ;;
  esac
  echo; cmd_status
}

case "${1:-status}" in
  status)  cmd_status ;;
  disable) cmd_disable ;;
  enable)  cmd_enable ;;
  *) err "Usage: $0 {status|disable|enable}"; exit 1 ;;
esac
