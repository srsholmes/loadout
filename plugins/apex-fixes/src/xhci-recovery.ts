/**
 * xHCI gamepad recovery.
 *
 * Combines:
 *   - `xhci_recovery.py` — boot-time probe: if the gamepad USB
 *     devices are missing, rebind the xHCI PCI controller at
 *     0000:65:00.4 so they re-enumerate.
 *   - `resume_fix.py` — installs a dbus-monitored systemd service
 *     that watches for `PrepareForSleep=false` (wake) events and
 *     rebinds the xHCI controller each time, which is the only
 *     reliable way to get the gamepad back after s2idle on this
 *     hardware.
 *
 * PCI address is hard-coded to 0000:65:00.4 — it's stable across
 * firmware revisions of the APEX. Internal gamepad is exposed via
 *   - 1a86:fe00 (HID MCU)
 *   - 045e:028e (virtual Xbox 360 pad)
 * Both must be present for "healthy" status.
 */

import { access } from "node:fs/promises";
import { sudoSpawn, sudoTee, sudoMkdirP, sudoRmF, sudoChmod } from "./privileged";

const PCI_DEVICE = "0000:65:00.4";
const PCI_DRIVER_PATH = `/sys/bus/pci/devices/${PCI_DEVICE}/driver`;
const UNBIND_PATH = "/sys/bus/pci/drivers/xhci_hcd/unbind";
const BIND_PATH = "/sys/bus/pci/drivers/xhci_hcd/bind";
const SCRIPT_PATH = "/usr/local/sbin/apex-resume-recover.sh";
const SERVICE_NAME = "apex-resume-recover.service";
const SERVICE_PATH = `/etc/systemd/system/${SERVICE_NAME}`;
const VENDOR_HID_ID = "1a86:fe00";
const XBOX_GAMEPAD_ID = "045e:028e";

// Recovery script — ported from resume_fix.py's _SCRIPT_CONTENT. Two-phase:
// immediate unbind+bind after a 1s settle, then a 2s fallback if the first
// bind didn't stick.
const SCRIPT_CONTENT = `#!/bin/bash
# OneXPlayer Apex — gamepad recovery after sleep
# Listens for resume events via dbus and rebinds the xHCI controller.

XHCI_PCI="${PCI_DEVICE}"
XHCI_DRIVER="/sys/bus/pci/devices/$XHCI_PCI/driver"

recover_gamepad() {
    logger -t apex-resume-recover "Resume detected — recovering gamepad"

    sleep 1
    if [ -e "$XHCI_DRIVER" ]; then
        echo "$XHCI_PCI" > "$XHCI_DRIVER/unbind" 2>/dev/null
        sleep 0.5
    fi
    echo "$XHCI_PCI" > /sys/bus/pci/drivers/xhci_hcd/bind 2>/dev/null

    sleep 2
    if [ ! -e "$XHCI_DRIVER" ]; then
        logger -t apex-resume-recover "Phase 1 failed, retrying bind"
        echo "$XHCI_PCI" > /sys/bus/pci/drivers/xhci_hcd/bind 2>/dev/null
    fi

    logger -t apex-resume-recover "Recovery complete"
}

dbus-monitor --system "type='signal',interface='org.freedesktop.login1.Manager',member='PrepareForSleep'" | \\
while read -r line; do
    if echo "$line" | grep -q "boolean false"; then
        recover_gamepad &
    fi
done
`;

const SERVICE_CONTENT = `[Unit]
Description=OneXPlayer Apex gamepad resume recovery
After=dbus.service
Wants=dbus.service

[Service]
Type=simple
ExecStart=${SCRIPT_PATH}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;

export interface XhciStatus {
  /** Persistent recovery service installed, enabled, and running. */
  applied: boolean;
  scriptExists: boolean;
  serviceEnabled: boolean;
  serviceActive: boolean;
  /** PCI device node exists in /sys/bus/pci/devices. */
  pciDeviceExists: boolean;
  /** Driver symlink present — means xhci_hcd is currently bound. */
  driverBound: boolean;
  /** Both internal gamepad USB IDs enumerate via lsusb. */
  gamepadPresent: boolean;
  summary: string;
}

export interface XhciApplyResult {
  success: boolean;
  steps: string[];
  error?: string;
}

export interface RebindResult {
  success: boolean;
  gamepadPresent: boolean;
  error?: string;
  attempts: number;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function usbDevicePresent(vidPid: string): Promise<boolean> {
  const { exitCode, stdout } = await sudoSpawn("lsusb", ["-d", vidPid], {
    timeoutMs: 5_000,
  });
  return exitCode === 0 && stdout.toLowerCase().includes(vidPid.toLowerCase());
}

async function systemctlIs(cmd: "is-active" | "is-enabled"): Promise<boolean> {
  const { exitCode, stdout } = await sudoSpawn("systemctl", [cmd, SERVICE_NAME], {
    timeoutMs: 10_000,
  });
  const want = cmd === "is-active" ? "active" : "enabled";
  return exitCode === 0 && stdout.trim() === want;
}

export async function getStatus(): Promise<XhciStatus> {
  const [scriptExists, pciDeviceExists, driverBound, serviceExists] =
    await Promise.all([
      fileExists(SCRIPT_PATH),
      fileExists(`/sys/bus/pci/devices/${PCI_DEVICE}`),
      fileExists(PCI_DRIVER_PATH),
      fileExists(SERVICE_PATH),
    ]);

  const [serviceActive, serviceEnabled] = serviceExists
    ? await Promise.all([systemctlIs("is-active"), systemctlIs("is-enabled")])
    : [false, false];

  const [hidPresent, padPresent] = await Promise.all([
    usbDevicePresent(VENDOR_HID_ID),
    usbDevicePresent(XBOX_GAMEPAD_ID),
  ]);
  const gamepadPresent = hidPresent && padPresent;

  const applied = serviceActive && serviceEnabled && scriptExists;

  let summary: string;
  if (applied) summary = "Recovery service active — gamepad will rebind on wake.";
  else if (!pciDeviceExists) summary = `PCI device ${PCI_DEVICE} missing.`;
  else if (!driverBound) summary = "xHCI controller is not bound to xhci_hcd.";
  else if (!gamepadPresent)
    summary = "Gamepad USB devices missing — rebind recommended.";
  else summary = "Healthy, but recovery service not installed.";

  return {
    applied,
    scriptExists,
    serviceEnabled,
    serviceActive,
    pciDeviceExists,
    driverBound,
    gamepadPresent,
    summary,
  };
}

// ---------------------------------------------------------------------------
// One-shot rebind
// ---------------------------------------------------------------------------

async function writeToSysfs(path: string, value: string): Promise<boolean> {
  const { exitCode } = await sudoSpawn("tee", [path], {
    stdin: value,
    timeoutMs: 5_000,
  });
  return exitCode === 0;
}

async function rebindOnce(): Promise<boolean> {
  if (await fileExists(PCI_DRIVER_PATH)) {
    await writeToSysfs(UNBIND_PATH, PCI_DEVICE);
    await new Promise((r) => setTimeout(r, 500));
  }
  const bindOk = await writeToSysfs(BIND_PATH, PCI_DEVICE);
  await new Promise((r) => setTimeout(r, 2_000));
  return bindOk;
}

/** User-facing "Recover gamepad" button handler. Tries up to 2 rebinds. */
export async function rebindNow(): Promise<RebindResult> {
  if (!(await fileExists(`/sys/bus/pci/devices/${PCI_DEVICE}`))) {
    return {
      success: false,
      gamepadPresent: false,
      error: `PCI device ${PCI_DEVICE} not present`,
      attempts: 0,
    };
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    await rebindOnce();
    const [hid, pad] = await Promise.all([
      usbDevicePresent(VENDOR_HID_ID),
      usbDevicePresent(XBOX_GAMEPAD_ID),
    ]);
    if (hid && pad) {
      return { success: true, gamepadPresent: true, attempts: attempt };
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 2_000));
  }

  return {
    success: false,
    gamepadPresent: false,
    error: "gamepad not detected after 2 rebind attempts",
    attempts: 2,
  };
}

/**
 * Boot-time check called from `onLoad`. If the gamepad USB devices
 * are missing, do one silent rebind pass. Logged but not surfaced to
 * the user unless it fails — this is a self-heal path, not a UI
 * action. Safe to call even when the persistent service is not
 * installed.
 */
export async function checkAndRecover(): Promise<RebindResult> {
  const [hid, pad] = await Promise.all([
    usbDevicePresent(VENDOR_HID_ID),
    usbDevicePresent(XBOX_GAMEPAD_ID),
  ]);
  if (hid && pad) {
    return { success: true, gamepadPresent: true, attempts: 0 };
  }
  return rebindNow();
}

// ---------------------------------------------------------------------------
// Persistent install (dbus-monitored recovery service)
// ---------------------------------------------------------------------------

export async function apply(): Promise<XhciApplyResult> {
  const steps: string[] = [];

  if ((await getStatus()).applied) {
    return { success: true, steps: ["already applied"] };
  }

  // 1. Recovery script
  try {
    await sudoMkdirP("/usr/local/sbin");
    await sudoTee(SCRIPT_PATH, SCRIPT_CONTENT);
    await sudoChmod(SCRIPT_PATH, "755");
    steps.push(`wrote ${SCRIPT_PATH}`);
  } catch (err) {
    return {
      success: false,
      steps,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 2. systemd unit
  try {
    await sudoTee(SERVICE_PATH, SERVICE_CONTENT);
    steps.push(`wrote ${SERVICE_PATH}`);
  } catch (err) {
    return {
      success: false,
      steps,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 3. daemon-reload + enable+start
  const reload = await sudoSpawn("systemctl", ["daemon-reload"]);
  if (reload.exitCode !== 0) {
    return {
      success: false,
      steps,
      error: `daemon-reload failed: ${reload.stderr.trim()}`,
    };
  }

  const en = await sudoSpawn("systemctl", ["enable", "--now", SERVICE_NAME]);
  if (en.exitCode !== 0) {
    return {
      success: false,
      steps,
      error: `enable --now ${SERVICE_NAME} failed: ${en.stderr.trim()}`,
    };
  }
  steps.push(`enabled ${SERVICE_NAME}`);

  return { success: true, steps };
}

export async function revert(): Promise<XhciApplyResult> {
  const steps: string[] = [];

  if (await fileExists(SERVICE_PATH)) {
    const dis = await sudoSpawn("systemctl", ["disable", "--now", SERVICE_NAME]);
    if (dis.exitCode === 0) steps.push(`disabled ${SERVICE_NAME}`);
    else steps.push(`disable failed (continuing): ${dis.stderr.trim()}`);
  }

  await sudoRmF(SERVICE_PATH);
  await sudoRmF(SCRIPT_PATH);
  steps.push("removed service + script");

  await sudoSpawn("systemctl", ["daemon-reload"]);

  return { success: true, steps };
}

export async function isApplied(): Promise<boolean> {
  return (await getStatus()).applied;
}
