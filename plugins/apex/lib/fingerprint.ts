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
/**
 * How the GPIO kernel arg gets onto the command line here.
 *
 * The touch has TWO independent wake paths and both must close (see the file
 * header); path 1 is disarmed *only* by this karg, so a distro we can't stage
 * on is a distro where the block is genuinely incomplete. That is why this
 * returns a mode rather than a boolean — "we know the pin" and "we can put it
 * there" are different questions, and conflating them is what previously had
 * the UI reporting a half-applied block as fully on.
 *
 *   "steamos" — /etc/default/grub-steamos, behind steamos-readonly
 *   "ostree"  — rpm-ostree kargs (Bazzite and other rpm-ostree images)
 *   "manual"  — we know the pin but not this bootloader (CachyOS, Arch, …);
 *               print the arg and say the block is incomplete
 *   "unknown" — we couldn't identify the system at all
 *   "none"    — unmeasured board: we don't know the pin, so say nothing
 *
 * There is deliberately no GRUB mode. Editing /etc/default/grub was tried and
 * removed: the file is sourced, so a value that isn't double-quoted got a
 * second assignment appended and the user's real cryptdevice=/resume= args
 * were discarded — and none of it is verifiable before a reboot.
 */
export type KargMode = "steamos" | "ostree" | "manual" | "unknown" | "none";

export function kargMode(
  distro: string,
  pinKnown: boolean,
  /** `/run/ostree-booted` exists AND `rpm-ostree` is usable. Detected by
   *  mechanism rather than distro name (Silverblue and Kinoite both report
   *  `ID=fedora`), and the tool is required as well as the marker — the
   *  marker is present on bootc images where rpm-ostree may be absent, and
   *  claiming "automatic" there loops forever instead of falling back to a
   *  workable instruction. */
  ostreeBooted = false,
): KargMode {
  if (!pinKnown) return "none";
  // Distinct from "none": an unreadable /etc/os-release means we don't know
  // the SYSTEM, not that we don't know the BOARD. Collapsing them made the UI
  // tell a real Apex owner "we don't know this model's pin", which is false.
  if (!distro) return "unknown";
  if (ostreeBooted) return "ostree";
  if (distro === "steamos") return "steamos";
  return "manual";
}

/** Modes where we know the pin but cannot stage it — the user can. */
export function isKargManual(mode: KargMode): boolean {
  return mode === "manual" || mode === "unknown";
}

/** Modes where we put the karg there ourselves. */
export function isKargAutomatic(mode: KargMode): boolean {
  return mode === "steamos" || mode === "ostree";
}

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
  /** How (or whether) the karg gets staged on this machine. */
  kargMode: KargMode;
  /** We stage the karg ourselves here — so it counts toward `applied`. */
  kargAutomatic: boolean;
  /** We manage the bootloader here, but couldn't read what the next boot
   *  will carry — distinct from knowing it isn't staged. */
  kargStagedUnknown: boolean;
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
  /**
   * The karg is live on this boot but absent from the bootloader config,
   * while the block is still meant to be on — so the next grub regeneration
   * drops it. Re-applying re-stages it; a reboot would LOSE it.
   */
  kargUnpersisted: boolean;
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
  // Marker AND tool: /run/ostree-booted is present on bootc images where
  // rpm-ostree may not be, and "automatic" without the tool is a heal loop.
  const ostreeBooted =
    (await deps.pathExists("/run/ostree-booted")) && (await ostreeUsable(deps));
  const mode = kargMode(distro, kargApplicable, ostreeBooted);
  const kargAutomatic = isKargAutomatic(mode);
  // Only where we actually manage the bootloader. Forcing `pinKnown: true`
  // here spent an rpm-ostree DBus round-trip on every status refresh for a
  // value nothing reads: kargStaged isn't surfaced to the UI, and its one
  // internal consumer (rebootPending) is gated on kargAutomatic anyway.
  const stagedRead = controller === null ? undefined : await readKargStaged(deps, mode);
  const kargStaged = stagedRead === true;

  const path2Closed = controllerWakeDisabled && udevRuleInstalled;

  // `kargStaged !== kargActive` treated both directions as "reboot
  // required", which is wrong in one of them. Live-but-not-staged happens
  // when a SteamOS A/B update regenerates /etc/default/grub-steamos and
  // drops our line while the running kernel still carries it from the last
  // boot. Nothing is staged, the block is working, and rebooting is the one
  // action that would undo it — so reporting "reboot to finish applying"
  // was both false and actively harmful advice.
  //
  // The udev rule is our marker for "the block is meant to be on", which is
  // what separates that case from a revert still waiting on a reboot.
  // Only meaningful where we stage the karg ourselves. Where the user added
  // it by hand, "live but not staged" is simply how that looks — reporting it
  // as drift gave them an alert describing a bootloader file they may not
  // even have, and a remedy that could never run.
  // `stagedRead === false` and not merely `!kargStaged`: an unknown read must
  // never look like drift, or a transient rpm-ostree failure produces a false
  // alert and a heal that runs on every boot.
  const kargLiveOnly = kargAutomatic && kargActive && stagedRead === false;
  return {
    supported: controller !== null,
    controller,
    controllerWakeDisabled,
    udevRuleInstalled,
    kargActive,
    kargStaged,
    kargApplicable,
    kargMode: mode,
    kargAutomatic,
    // Both wake paths must close, so where we CAN stage the karg, the karg
    // has to be LIVE — staged-but-not-yet-live means path 1 is open right
    // now. Counting `kargStaged` here was a lie whenever staging succeeded
    // but could never take effect, and nothing bounded it to a pre-reboot
    // window. The toggle no longer keys on this at all; it reflects the
    // user's stored choice, so being strict here costs nothing.
    applied: path2Closed && (kargActive || !kargAutomatic),
    // Gated on kargAutomatic throughout. Without it, an unmeasured board with
    // a karg in its boot config from anywhere rendered "Reboot to finish
    // applying" — with a reboot button — directly beneath the text saying we
    // don't know this model's pin. Pressing it activated that foreign pin.
    // `stagedRead === true`, not `kargStaged`: an unknown read must not read
    // as "not staged" here, or a machine with the karg genuinely staged loses
    // its reboot prompt and the karg is never activated.
    rebootPending:
      kargAutomatic &&
      ((stagedRead === true && !kargActive) || (kargLiveOnly && !udevRuleInstalled)),
    /** We manage the bootloader here but couldn't read what it will carry. */
    kargStagedUnknown: kargAutomatic && stagedRead === undefined,
    kargUnpersisted: kargLiveOnly && udevRuleInstalled,
    distro,
  };
}

/**
 * Should the block be silently re-applied at startup?
 *
 * A SteamOS A/B update regenerates `/etc` and takes the udev rule and the
 * grub line with it, so the device quietly goes back to waking on a light
 * touch of the power button with nothing to tell the user.
 *
 * `wanted` must come from plugin storage under `$HOME`, NOT from any of the
 * status fields below. Every signal in {@link FingerprintStatus} is derived
 * from `/etc` or the live kernel — exactly what the update wipes — so after
 * one they cannot tell "the user never enabled it" from "the user enabled it
 * and the OS ate it". Healing off those would re-apply the block on machines
 * whose owner deliberately never turned it on.
 *
 * `kargUnpersisted` counts as needing a heal even though `applied` is true
 * in that state: the karg is live on this boot but missing from the
 * bootloader, so the protection silently expires at the next grub
 * regeneration. Re-applying re-stages it.
 */
export function shouldHeal(input: {
  /** The user's stored choice. `undefined` = never chose. */
  wanted: boolean | undefined;
  status: Pick<
    FingerprintStatus,
    "supported" | "applied" | "kargUnpersisted" | "kargStaged" | "kargActive" | "kargAutomatic"
  >;
}): boolean {
  if (input.wanted !== true) return false;
  // No reader on this machine — nothing to re-apply, and apply() would fail.
  if (!input.status.supported) return false;
  // Staged and waiting for a reboot is PENDING, not LOST. Healing here did
  // nothing and then announced "a system update removed the wake block" —
  // on every backend restart until the user rebooted.
  const { kargAutomatic, kargStaged, kargActive } = input.status;
  if (kargAutomatic && kargStaged && !kargActive) return false;
  return !input.status.applied || input.status.kargUnpersisted;
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
  // try/finally, not an exit-code branch alone: `update-grub` can THROW
  // (missing binary, denied command policy) rather than exit non-zero, and a
  // throw used to escape between the write and `steamos-readonly enable` —
  // leaving a modified grub source, no regeneration, and the rootfs writable.
  let staged = false;
  try {
    await deps.writeFile(`${GRUB_STEAMOS}.loadout.bak`, current);
    await deps.writeFile(GRUB_STEAMOS, addKargToGrubSteamos(current));
    const gen = await deps.run(["update-grub"], { timeoutMs: 120_000 });
    if (gen.exitCode !== 0) {
      throw new Error(`update-grub failed: ${gen.stderr.trim() || gen.exitCode}`);
    }
    staged = true;
  } catch (e) {
    // Roll back the source file so a bad generation can't strand boot config.
    await deps.writeFile(GRUB_STEAMOS, current).catch(() => {});
    await deps.run(["update-grub"], { timeoutMs: 120_000 }).catch(() => {});
    throw e;
  } finally {
    // Always re-seal the rootfs, on every path out of here.
    await deps.run(["steamos-readonly", "enable"], { timeoutMs: 30_000 }).catch(() => {});
  }
  steps.push("karg-staged");
  return staged;
}

/** Whether a bootloader config currently carries the karg. */
async function readsKarg(deps: FingerprintDeps, path: string): Promise<boolean> {
  return deps
    .readFile(path)
    .then((c) => c.includes(KARG))
    .catch(() => false);
}

// --- karg backends: rpm-ostree (Bazzite) ------------------------------------

/**
 * `rpm-ostree kargs` is idempotent both ways, so these are plain calls with
 * no read-modify-write and no backup file — the deployment itself is the
 * rollback.
 */
async function addKargOstree(deps: FingerprintDeps, steps: string[]): Promise<boolean> {
  // Report whether this changed anything, like the SteamOS backend does —
  // returning true unconditionally sent users to reboot for a no-op.
  if ((await ostreeKargStaged(deps)) === true) {
    steps.push("karg-already-staged");
    return false;
  }
  const r = await deps.run(["rpm-ostree", "kargs", `--append-if-missing=${KARG}`], {
    timeoutMs: 180_000,
  });
  if (r.exitCode !== 0) {
    throw new Error(`rpm-ostree kargs failed: ${r.stderr.trim() || r.exitCode}`);
  }
  steps.push("karg-staged");
  return true;
}

async function removeKargOstree(deps: FingerprintDeps, steps: string[]): Promise<boolean> {
  if ((await ostreeKargStaged(deps)) === false) {
    steps.push("karg-not-present");
    return false;
  }
  const r = await deps.run(["rpm-ostree", "kargs", `--delete-if-present=${KARG}`], {
    timeoutMs: 180_000,
  });
  if (r.exitCode !== 0) {
    throw new Error(`rpm-ostree kargs failed: ${r.stderr.trim() || r.exitCode}`);
  }
  steps.push("karg-unstaged");
  return true;
}

/**
 * What the next boot will use, per rpm-ostree itself.
 *
 * Never throws and never guesses: an exception (the command policy, a missing
 * binary) or a non-zero exit (a transaction in progress — Bazzite's
 * auto-update timer fires around boot, exactly when the heal runs) yields
 * `undefined`. Returning `false` there put an unread deployment into every
 * downstream decision, and an uncaught throw took the whole getStatus RPC
 * down with it — leaving the plugin page stuck loading.
 */
/** Whether `rpm-ostree` can actually be run here. */
async function ostreeUsable(deps: FingerprintDeps): Promise<boolean> {
  const r = await deps.run(["sh", "-c", "command -v rpm-ostree"], { timeoutMs: 5_000 }).catch(
    () => null,
  );
  return !!r && r.exitCode === 0 && r.stdout.trim() !== "";
}

async function ostreeKargStaged(deps: FingerprintDeps): Promise<boolean | undefined> {
  // Well under the overlay's 30s RPC cap: this runs inside getStatus, and a
  // read that outlasts the cap leaves the plugin page spinning forever.
  const r = await deps.run(["rpm-ostree", "kargs"], { timeoutMs: 8_000 }).catch(() => null);
  if (!r || r.exitCode !== 0) return undefined;
  return r.stdout.includes(KARG);
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

// --- karg dispatch -----------------------------------------------------------

/**
 * What the NEXT boot will carry, per whichever bootloader we manage here.
 * `undefined` means we could not find out — distinct from "not staged", which
 * would otherwise drive a false drift alert and a heal loop every time
 * rpm-ostree happened to be mid-transaction.
 */
async function readKargStaged(
  deps: FingerprintDeps,
  mode: KargMode,
): Promise<boolean | undefined> {
  switch (mode) {
    case "steamos":
      return readsKarg(deps, GRUB_STEAMOS);
    case "ostree":
      return ostreeKargStaged(deps);
    default:
      // Not ours to read; a hand-added karg shows up as kargActive instead.
      return false;
  }
}

async function stageKarg(deps: FingerprintDeps, mode: KargMode, steps: string[]): Promise<boolean> {
  switch (mode) {
    case "steamos":
      return addKargSteamos(deps, steps);
    case "ostree":
      return addKargOstree(deps, steps);
    default:
      return false;
  }
}

async function unstageKarg(
  deps: FingerprintDeps,
  mode: KargMode,
  steps: string[],
): Promise<boolean> {
  switch (mode) {
    case "steamos":
      return removeKargSteamos(deps, steps);
    case "ostree":
      return removeKargOstree(deps, steps);
    default:
      return false;
  }
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
  const mode = kargMode(distro, autoKarg, await deps.pathExists("/run/ostree-booted"));
  const canStage = isKargAutomatic(mode);
  const alreadyActive = (await deps.readCmdline()).includes(KARG);
  const alreadyStaged = canStage ? (await readKargStaged(deps, mode)) === true : false;

  // Only skip the bootloader edit when the karg is live AND already staged —
  // or when we would not be editing the bootloader anyway.
  //
  // Live-but-unstaged is the whole SteamOS-update case: the running kernel
  // still carries the karg while grub has lost it. Returning early there made
  // both remedies we offer for that state — "switch it off and on again" and
  // the startup self-heal — silently unable to put the line back, while
  // reporting success.
  if (alreadyActive && (alreadyStaged || !canStage)) {
    steps.push("karg-already-active");
    return { success: true, rebootRequired: false, steps };
  }
  if (canStage) {
    try {
      await stageKarg(deps, mode, steps);
      // Nothing to wait for when the running kernel already has it; this
      // call only re-persisted it for the next boot.
      return { success: true, rebootRequired: !alreadyActive, steps };
    } catch (e) {
      // Path 2 is still applied; surface the karg failure but don't pretend.
      return { success: false, rebootRequired: false, steps, error: `Path 1 (karg) failed: ${e}`, manualKarg: KARG };
    }
  }
  // A board whose GPIO pin we haven't confirmed. PME is blocked, which is
  // the whole fix we can offer here — and we deliberately do NOT hand over
  // KARG, because AMDI0030:00@58 is the Apex's wiring. Printing it as an
  // instruction is the same act as staging it, just with extra steps.
  if (mode === "none") {
    steps.push("karg-not-applicable");
    return { success: true, rebootRequired: false, steps };
  }

  // Known board, distro whose bootloader we don't edit: we know the right
  // pin, so offer it as text for the user to apply.
  // Nothing was staged, so a reboot changes nothing — saying otherwise sent
  // the user to reboot and discarded the one actionable thing we have.
  steps.push("karg-manual-required");
  return { success: true, rebootRequired: false, steps, manualKarg: KARG };
}

export async function revert(
  deps: FingerprintDeps,
  /** Symmetric with {@link apply}. Without it, revert handed the Apex's GPIO
   *  pin to unmeasured boards that apply() deliberately withholds it from. */
  { autoKarg = true }: { autoKarg?: boolean } = {},
): Promise<FingerprintResult> {
  const steps: string[] = [];
  const controller = await detectController(deps);
  await enablePme(deps, controller, steps);

  const distro = await deps.distroId();
  const mode = kargMode(distro, autoKarg, await deps.pathExists("/run/ostree-booted"));
  let rebootRequired = false;
  if (isKargAutomatic(mode)) {
    try {
      rebootRequired = await unstageKarg(deps, mode, steps);
    } catch (e) {
      return { success: false, rebootRequired: false, steps, error: `Karg removal failed: ${e}` };
    }
  } else if (isKargManual(mode) && (await deps.readCmdline()).includes(KARG)) {
    // Only where we know the pin: on an unmeasured board we never told them
    // to add it, so we don't tell them to remove it either.
    steps.push("karg-manual-removal-required");
    return { success: true, rebootRequired: true, steps, manualKarg: KARG };
  }
  return { success: true, rebootRequired, steps };
}
