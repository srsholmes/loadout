/**
 * Fingerprint wake block — stop the OneXPlayer Apex power-button fingerprint
 * reader (FocalTech, vendor 2808) from waking the device from sleep on a light
 * TOUCH. A power-button PRESS still wakes it (separate ACPI fixed event), and
 * the internal gamepad's controller is untouched.
 *
 * The touch reaches the SoC via TWO independent wake paths; both must close:
 *
 *   Path 1 — GPIO wake line (pinctrl_amd, ACPI dev AMDI0030:00, pin 58).
 *     Disarmed only by a kernel arg: gpiolib_acpi.ignore_wake=AMDI0030:00@58.
 *     Boot-time → needs a reboot to take effect / to undo.
 *
 *   Path 2 — PCIe PME raised by the fingerprint's own xHCI controller.
 *     The device's own power/wakeup does NOT stop it; the controller must be
 *     set power/wakeup=disabled. Runtime + a udev rule to persist. No reboot.
 *
 * Ported from scripts/apex-fingerprint-wake.sh. All hardware/OS access is
 * injected (`FingerprintDeps`) so the orchestration — including the SteamOS
 * grub edit — is unit-testable without root, real sysfs, or a real bootloader.
 */

import type { Run } from "./xhci";

/** ACPI GPIO controller + pin behind path 1 (stable Apex board values). */
export const GPIO_ACPI_DEV = "AMDI0030:00";
export const GPIO_PIN = "58";
export const KARG = `gpiolib_acpi.ignore_wake=${GPIO_ACPI_DEV}@${GPIO_PIN}`;

/**
 * FocalTech fingerprint reader USB ids.
 *
 * The reader is not one part across the family: the Apex ships `c652`, the
 * X2 Mini Pro ships `5952`. Both are FocalTech (vendor 2808) and both sit
 * behind an xHCI controller that PME-wakes the machine, so the fix is the
 * same — only the product id differs. A single hardcoded id silently made
 * this feature unavailable on every OneXPlayer whose reader wasn't the
 * Apex's, which is exactly the failure un-gating the plugin is meant to end.
 */
export const FP_VENDOR = "2808";
export const FP_PRODUCTS: readonly string[] = ["c652", "5952"];

export const UDEV_RULE_PATH = "/etc/udev/rules.d/90-loadout-fingerprint-no-wake.rules";
const GRUB_STEAMOS = "/etc/default/grub-steamos";

export interface FingerprintDeps {
  /** Run a subprocess (wired to `@loadout/exec` runFull in prod). */
  run: Run;
  pathExists: (path: string) => Promise<boolean>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
  /** Contents of /proc/cmdline (the live kernel args). */
  readCmdline: () => Promise<string>;
  /** /etc/os-release ID field, e.g. "steamos" / "bazzite" / "cachyos". */
  distroId: () => Promise<string>;
  log?: (message: string) => void;
}

export interface FingerprintStatus {
  /** The fingerprint reader is present on this machine. */
  supported: boolean;
  /** Resolved xHCI controller hosting the reader (path 2 target), or null. */
  controller: string | null;
  /** Controller wake currently disabled (path 2 closed at runtime). */
  controllerWakeDisabled: boolean;
  /** Persisting udev rule installed. */
  udevRuleInstalled: boolean;
  /** Karg present on the live kernel command line (path 1 active). */
  kargActive: boolean;
  /** Karg staged in the bootloader config but not yet booted. */
  kargStaged: boolean;
  /**
   * Whether the karg path is usable on this board at all. False when we
   * haven't confirmed the board's GPIO pin, in which case PME blocking is
   * the whole of the fix and `applied` must not wait on a karg that will
   * never be staged.
   */
  kargApplicable: boolean;
  /** Fully applied — as far as this board allows. */
  applied: boolean;
  /** A reboot is needed to finish applying/reverting (the karg changed). */
  rebootPending: boolean;
  distro: string;
}

export interface FingerprintResult {
  success: boolean;
  rebootRequired: boolean;
  steps: string[];
  /** Set when the karg couldn't be automated on this distro — manual hint. */
  manualKarg?: string;
  error?: string;
}

// --- detection ---------------------------------------------------------------

const USB_DEVICES = "/sys/bus/usb/devices";

/**
 * Resolve the xHCI PCI controller (e.g. "0000:67:00.0") that hosts the
 * fingerprint reader, by finding the USB device with the FocalTech VID/PID
 * and walking from its bus's root hub up to the PCI parent. Returns null if
 * the reader isn't present.
 */
export async function detectController(deps: FingerprintDeps): Promise<string | null> {
  // `lsusb` is only a cheap "is there a FocalTech device at all" gate —
  // vendor-only, so a new reader id doesn't need adding in two places. The
  // sysfs walk below is what filters to an actual reader.
  const present = await deps.run(["lsusb", "-d", `${FP_VENDOR}:`], { timeoutMs: 5_000 });
  if (present.exitCode !== 0) return null;

  // Find which usb bus the reader is on, then map that bus to its PCI host.
  // `readlink -f /sys/bus/usb/devices/usbN` → /sys/devices/pci…/0000:bb:dd.f/usbN
  const ls = await deps.run(["sh", "-c",
    `for d in ${USB_DEVICES}/*; do ` +
    `[ "$(cat "$d/idVendor" 2>/dev/null)" = "${FP_VENDOR}" ] || continue; ` +
    `case "$(cat "$d/idProduct" 2>/dev/null)" in ${FP_PRODUCTS.join("|")}) ;; *) continue ;; esac; ` +
    `busnum=$(cat "$d/busnum") && ` +
    `basename "$(dirname "$(readlink -f "${USB_DEVICES}/usb$busnum")")" && break; ` +
    `done`,
  ], { timeoutMs: 5_000 });
  const ctrl = ls.stdout.trim();
  return /^0000:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]$/.test(ctrl) ? ctrl : null;
}

// --- status ------------------------------------------------------------------

export async function getStatus(
  deps: FingerprintDeps,
  kargApplicable = false,
): Promise<FingerprintStatus> {
  const distro = await deps.distroId();
  const controller = await detectController(deps);
  const cmdline = await deps.readCmdline();
  const kargActive = cmdline.includes(KARG);

  let controllerWakeDisabled = false;
  if (controller) {
    const wake = await deps
      .readFile(`/sys/bus/pci/devices/${controller}/power/wakeup`)
      .catch(() => "");
    controllerWakeDisabled = wake.trim() === "disabled";
  }
  const udevRuleInstalled = await deps.pathExists(UDEV_RULE_PATH);
  const kargStaged = distro === "steamos"
    ? await deps.readFile(GRUB_STEAMOS).then((c) => c.includes(KARG)).catch(() => false)
    : false;

  const path2Closed = controllerWakeDisabled && udevRuleInstalled;
  return {
    supported: controller !== null,
    controller,
    controllerWakeDisabled,
    udevRuleInstalled,
    kargActive,
    kargStaged,
    kargApplicable,
    // On a board whose pin we haven't confirmed the karg is never staged, so
    // requiring kargActive left `applied` permanently false: the user flipped
    // the switch on, PME *was* blocked, and the control sprang back to off.
    // The natural response is to flip it again — which calls revert() and
    // undoes the one path that had worked.
    applied: path2Closed && (kargActive || !kargApplicable),
    // Reboot pending when the karg's staged state disagrees with the live one.
    rebootPending: kargStaged !== kargActive,
    distro,
  };
}

// --- path 2: controller PME (runtime + udev) ---------------------------------

const udevRuleBody = (controller: string) =>
  `# Block wake from the xHCI controller hosting the FocalTech fingerprint\n` +
  `# reader. A touch makes this controller raise a PCIe PME that wakes the\n` +
  `# device from sleep; the device's own power/wakeup does not stop it. The\n` +
  `# gamepad is on a different controller and is unaffected; a power-button\n` +
  `# press (ACPI fixed event) still wakes. Managed by the loadout apex plugin.\n` +
  `ACTION=="add", SUBSYSTEM=="pci", KERNEL=="${controller}", ATTR{power/wakeup}="disabled"\n`;

async function disablePme(deps: FingerprintDeps, controller: string, steps: string[]): Promise<void> {
  await deps.run(["tee", `/sys/bus/pci/devices/${controller}/power/wakeup`], {
    stdin: "disabled",
    timeoutMs: 5_000,
  });
  steps.push("controller-wake-disabled");
  await deps.writeFile(UDEV_RULE_PATH, udevRuleBody(controller));
  await deps.run(["udevadm", "control", "--reload-rules"], { timeoutMs: 10_000 });
  steps.push("udev-rule-installed");
  deps.log?.(`path 2: ${controller} power/wakeup=disabled + udev rule`);
}

async function enablePme(deps: FingerprintDeps, controller: string | null, steps: string[]): Promise<void> {
  if (controller) {
    await deps.run(["tee", `/sys/bus/pci/devices/${controller}/power/wakeup`], {
      stdin: "enabled",
      timeoutMs: 5_000,
    });
    steps.push("controller-wake-enabled");
  }
  if (await deps.pathExists(UDEV_RULE_PATH)) {
    await deps.removeFile(UDEV_RULE_PATH);
    await deps.run(["udevadm", "control", "--reload-rules"], { timeoutMs: 10_000 });
    steps.push("udev-rule-removed");
  }
}

// --- path 1: GPIO karg (distro-aware) ----------------------------------------

/** Insert the karg as its own continued line inside GRUB_CMDLINE_LINUX="…". */
export function addKargToGrubSteamos(content: string): string {
  if (content.includes(KARG)) return content;
  // Append before the closing quote of the GRUB_CMDLINE_LINUX="…" block.
  return content.replace(
    /(GRUB_CMDLINE_LINUX="[\s\S]*?)"(\s*)$/m,
    (_m, body, tail) => `${body}${KARG} \\\n"${tail}`,
  );
}

/** Drop the continued line carrying the karg. */
export function removeKargFromGrubSteamos(content: string): string {
  return content
    .split("\n")
    .filter((line) => !line.includes(KARG))
    .join("\n");
}

async function addKargSteamos(deps: FingerprintDeps, steps: string[]): Promise<boolean> {
  const current = await deps.readFile(GRUB_STEAMOS).catch(() => "");
  if (current.includes(KARG)) {
    steps.push("karg-already-staged");
    return false;
  }
  await deps.run(["steamos-readonly", "disable"], { timeoutMs: 30_000 });
  await deps.writeFile(`${GRUB_STEAMOS}.loadout.bak`, current);
  await deps.writeFile(GRUB_STEAMOS, addKargToGrubSteamos(current));
  const gen = await deps.run(["update-grub"], { timeoutMs: 120_000 });
  await deps.run(["steamos-readonly", "enable"], { timeoutMs: 30_000 });
  if (gen.exitCode !== 0) {
    // Roll back the source file so a bad generation can't strand boot config.
    await deps.run(["steamos-readonly", "disable"], { timeoutMs: 30_000 });
    await deps.writeFile(GRUB_STEAMOS, current);
    await deps.run(["update-grub"], { timeoutMs: 120_000 });
    await deps.run(["steamos-readonly", "enable"], { timeoutMs: 30_000 });
    throw new Error(`update-grub failed: ${gen.stderr.trim() || gen.exitCode}`);
  }
  steps.push("karg-staged");
  return true;
}

async function removeKargSteamos(deps: FingerprintDeps, steps: string[]): Promise<boolean> {
  const current = await deps.readFile(GRUB_STEAMOS).catch(() => "");
  if (!current.includes(KARG)) {
    steps.push("karg-not-present");
    return false;
  }
  await deps.run(["steamos-readonly", "disable"], { timeoutMs: 30_000 });
  await deps.writeFile(`${GRUB_STEAMOS}.loadout.bak`, current);
  await deps.writeFile(GRUB_STEAMOS, removeKargFromGrubSteamos(current));
  await deps.run(["update-grub"], { timeoutMs: 120_000 });
  await deps.run(["steamos-readonly", "enable"], { timeoutMs: 30_000 });
  steps.push("karg-unstaged");
  return true;
}

// --- apply / revert ----------------------------------------------------------

export async function apply(
  deps: FingerprintDeps,
  /**
   * Whether to edit the bootloader automatically. False on a OneXPlayer we
   * haven't measured: KARG names a specific GPIO pin (`AMDI0030:00@58`),
   * which is board wiring, not a family constant. Staging the wrong pin
   * into grub is a worse outcome than not closing the second wake path, so
   * those devices get the manual hint and the derived PME path only.
   */
  { autoKarg = true }: { autoKarg?: boolean } = {},
): Promise<FingerprintResult> {
  const steps: string[] = [];
  const controller = await detectController(deps);
  if (!controller) {
    return { success: false, rebootRequired: false, steps, error: "Fingerprint reader not found." };
  }

  try {
    await disablePme(deps, controller, steps); // path 2 — instant
  } catch (e) {
    return { success: false, rebootRequired: false, steps, error: `Path 2 failed: ${e}` };
  }

  // Path 1 — karg. SteamOS automated; other distros get a manual hint so we
  // never edit a bootloader we haven't validated.
  const distro = await deps.distroId();
  const alreadyActive = (await deps.readCmdline()).includes(KARG);
  if (alreadyActive) {
    steps.push("karg-already-active");
    return { success: true, rebootRequired: false, steps };
  }
  if (distro === "steamos" && autoKarg) {
    try {
      await addKargSteamos(deps, steps);
      return { success: true, rebootRequired: true, steps };
    } catch (e) {
      // Path 2 is still applied; surface the karg failure but don't pretend.
      return { success: false, rebootRequired: false, steps, error: `Path 1 (karg) failed: ${e}`, manualKarg: KARG };
    }
  }
  // A board whose GPIO pin we haven't confirmed. PME is blocked, which is
  // the whole fix we can offer here — and we deliberately do NOT hand over
  // KARG, because AMDI0030:00@58 is the Apex's wiring. Printing it as an
  // instruction is the same act as staging it, just with extra steps.
  if (!autoKarg) {
    steps.push("karg-not-applicable");
    return { success: true, rebootRequired: false, steps };
  }

  // Known board, distro whose bootloader we don't edit: we know the right
  // pin, so offer it as text for the user to apply.
  steps.push("karg-manual-required");
  return { success: true, rebootRequired: true, steps, manualKarg: KARG };
}

export async function revert(deps: FingerprintDeps): Promise<FingerprintResult> {
  const steps: string[] = [];
  const controller = await detectController(deps);
  await enablePme(deps, controller, steps);

  const distro = await deps.distroId();
  let rebootRequired = false;
  if (distro === "steamos") {
    try {
      rebootRequired = await removeKargSteamos(deps, steps);
    } catch (e) {
      return { success: false, rebootRequired: false, steps, error: `Karg removal failed: ${e}` };
    }
  } else if ((await deps.readCmdline()).includes(KARG)) {
    steps.push("karg-manual-removal-required");
    return { success: true, rebootRequired: true, steps, manualKarg: KARG };
  }
  return { success: true, rebootRequired, steps };
}
