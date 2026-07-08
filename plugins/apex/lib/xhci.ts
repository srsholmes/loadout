/**
 * xHCI gamepad recovery — the TS port of `scripts/fix-controller-resume.sh`.
 *
 * On the OneXPlayer Apex the xHCI USB host controller (0000:65:00.4) can
 * die on resume from s2idle:
 *
 *   xhci_hcd 0000:65:00.4: xHCI host controller not responding, assume dead
 *   xhci_hcd 0000:65:00.4: HC died; cleaning up
 *   usb 1-1: USB disconnect ...
 *
 * That drops the internal gamepad (1a86:fe00 HID MCU + 045e:028e Xbox 360
 * pad) clean off the USB bus — the device node is gone, so restarting
 * InputPlumber can't recover it. The only reliable fix is to unbind and
 * rebind the xHCI PCI controller so the whole bus re-enumerates.
 *
 * All hardware access is injected (`XhciDeps`) so the orchestration is
 * unit-testable without root, real sysfs, or a real controller.
 */

/** Known xHCI controller for the Apex internal gamepad. Stable across
 *  firmware revisions; overridable when the caller knows better. */
export const DEFAULT_XHCI_PCI = "0000:65:00.4";

/** Internal gamepad USB IDs — both must enumerate for "healthy". */
export const GAMEPAD_IDS = ["1a86:fe00", "045e:028e"] as const;

const DRIVER_DIR = "/sys/bus/pci/drivers/xhci_hcd";
const PCI_DEVICES = "/sys/bus/pci/devices";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type Run = (
  cmd: string[],
  opts?: { stdin?: string; timeoutMs?: number },
) => Promise<RunResult>;

export interface XhciDeps {
  /** Run a subprocess (wired to `@loadout/exec`'s `runFull` in prod). */
  run: Run;
  /** Test whether a path exists (wired to `fs.access` in prod). */
  pathExists: (path: string) => Promise<boolean>;
  /** Resolvable delay (wired to `setTimeout` in prod; instant in tests). */
  sleep: (ms: number) => Promise<void>;
  /**
   * Re-grab the recovered pad through InputPlumber. In prod this delegates
   * to the input-plumber plugin's `restartInputPlumber` (daemon restart +
   * wake-profile *reload*), so the QAM→F16 wake mapping survives — a raw
   * `systemctl restart inputplumber` drops the loaded profile and kills the
   * overlay shortcut. Best-effort: recover() never gates success on this.
   */
  restartInputPlumber: () => Promise<{ ok: boolean; error?: string }>;
  /** Optional progress sink. */
  log?: (message: string) => void;
}

export interface XhciStatus {
  /** PCI device node exists under /sys/bus/pci/devices. */
  pciDeviceExists: boolean;
  /** Driver symlink present — xhci_hcd is currently bound. */
  driverBound: boolean;
  /** Both internal gamepad USB IDs enumerate via lsusb. */
  gamepadPresent: boolean;
  /** The controller we'd act on (detected-dead, else default). */
  controller: string;
  /** True if the kernel log shows this controller recently died. */
  deadInLog: boolean;
  summary: string;
}

export interface RecoverResult {
  success: boolean;
  controller: string;
  steps: string[];
  gamepadPresent: boolean;
  /** True when recover() found the gamepad already enumerating and did
   *  nothing — no rebind was needed. */
  alreadyHealthy?: boolean;
  error?: string;
}

/**
 * Parse a `dmesg` dump for the most recent xHCI controller the kernel
 * declared dead. Returns the PCI address (e.g. `0000:65:00.4`) or null.
 */
export function parseDeadController(dmesg: string): string | null {
  const re = /xhci_hcd (0000:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]):.*(?:HC died|assume dead)/gi;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = re.exec(dmesg)) !== null) last = match[1]!; // group 1 present per pattern
  return last;
}

function pciDevicePath(pci: string): string {
  return `${PCI_DEVICES}/${pci}`;
}

function driverLinkPath(pci: string): string {
  return `${PCI_DEVICES}/${pci}/driver`;
}

/** True when every internal-gamepad USB ID enumerates via lsusb. */
export async function gamepadPresent(run: Run): Promise<boolean> {
  for (const id of GAMEPAD_IDS) {
    const r = await run(["lsusb", "-d", id], { timeoutMs: 5_000 });
    if (r.exitCode !== 0 || !r.stdout.toLowerCase().includes(id.toLowerCase())) {
      return false;
    }
  }
  return true;
}

/** Decide which controller to act on: caller override → dead-in-log →
 *  the known Apex default. */
export async function pickController(
  deps: XhciDeps,
  override?: string,
): Promise<{ controller: string; deadInLog: boolean }> {
  if (override) return { controller: override, deadInLog: false };
  const r = await deps.run(["dmesg"], { timeoutMs: 5_000 });
  const dead = r.exitCode === 0 ? parseDeadController(r.stdout) : null;
  if (dead) {
    deps.log?.(`Detected dead xHCI controller from kernel log: ${dead}`);
    return { controller: dead, deadInLog: true };
  }
  deps.log?.(`No dead controller in dmesg; using default ${DEFAULT_XHCI_PCI}`);
  return { controller: DEFAULT_XHCI_PCI, deadInLog: false };
}

export async function getStatus(deps: XhciDeps, override?: string): Promise<XhciStatus> {
  const { controller, deadInLog } = await pickController(deps, override);
  const [pciDeviceExists, driverBound, padPresent] = await Promise.all([
    deps.pathExists(pciDevicePath(controller)),
    deps.pathExists(driverLinkPath(controller)),
    gamepadPresent(deps.run),
  ]);

  let summary: string;
  if (!pciDeviceExists) summary = `PCI device ${controller} not present.`;
  else if (padPresent) summary = "Controller healthy — nothing to do.";
  else if (deadInLog) summary = "Controller died on resume — rebind to recover the gamepad.";
  else summary = "Gamepad not enumerating — a rebind may recover it.";

  return {
    pciDeviceExists,
    driverBound,
    gamepadPresent: padPresent,
    controller,
    deadInLog,
    summary,
  };
}

/** Write a value to a sysfs path via `tee` (backend runs as root). */
async function writeSysfs(run: Run, path: string, value: string): Promise<boolean> {
  const r = await run(["tee", path], { stdin: value, timeoutMs: 5_000 });
  return r.exitCode === 0;
}

/**
 * Unbind (if bound) then bind the controller, with one retry if the
 * bind doesn't take. Mirrors the shell script's two-phase rebind.
 */
async function rebind(deps: XhciDeps, pci: string, steps: string[]): Promise<void> {
  if (await deps.pathExists(driverLinkPath(pci))) {
    steps.push("unbind");
    deps.log?.("unbind");
    await writeSysfs(deps.run, `${DRIVER_DIR}/unbind`, pci);
    await deps.sleep(1_000);
  }

  steps.push("bind");
  deps.log?.("bind");
  await writeSysfs(deps.run, `${DRIVER_DIR}/bind`, pci);
  await deps.sleep(2_000);

  if (!(await deps.pathExists(driverLinkPath(pci)))) {
    steps.push("bind-retry");
    deps.log?.("bind didn't stick — retrying");
    await writeSysfs(deps.run, `${DRIVER_DIR}/bind`, pci);
    await deps.sleep(2_000);
  }
}

/**
 * Full recovery: rebind the controller, poll for the gamepad to
 * re-enumerate, then restart InputPlumber so it re-grabs the freshly
 * hotplugged source. Without that restart InputPlumber keeps its grab on
 * the old (now-gone) node and doesn't reliably pick up the new one,
 * leaving a *duplicate* pad — the raw controller plus InputPlumber's
 * virtual one — which Steam reads as a second, dead controller.
 *
 * The `alreadyHealthy` short-circuit is the loop guard: if the gamepad is
 * already enumerating there is nothing to recover, so a re-pressed button
 * (or any re-invocation) no-ops — no rebind, no InputPlumber restart —
 * instead of needlessly resetting a working controller. That same guard is
 * what makes the InputPlumber restart safe from the old re-press feedback
 * loop: any synthetic press the restart provokes just re-enters recover(),
 * finds the pad present, and returns before touching anything. Pass
 * `force` to rebind regardless.
 */
export async function recover(
  deps: XhciDeps,
  opts: { override?: string; force?: boolean } = {},
): Promise<RecoverResult> {
  const steps: string[] = [];
  const { controller } = await pickController(deps, opts.override);

  // Loop guard — nothing to do if the gamepad is already on the bus.
  if (!opts.force && (await gamepadPresent(deps.run))) {
    return {
      success: true,
      controller,
      steps,
      gamepadPresent: true,
      alreadyHealthy: true,
    };
  }

  if (!(await deps.pathExists(pciDevicePath(controller)))) {
    return {
      success: false,
      controller,
      steps,
      gamepadPresent: false,
      error: `PCI device ${controller} does not exist on this system.`,
    };
  }

  deps.log?.(`Rebinding xHCI controller ${controller} ...`);
  await rebind(deps, controller, steps);

  // Give the bus a few seconds to enumerate downstream devices.
  let present = false;
  for (let i = 0; i < 5; i++) {
    present = await gamepadPresent(deps.run);
    if (present) break;
    await deps.sleep(1_000);
  }

  if (!present) {
    return {
      success: false,
      controller,
      steps,
      gamepadPresent: false,
      error: `Gamepad USB IDs still missing after rebind (${GAMEPAD_IDS.join(", ")}). It may need a physical reconnect, or this is a different failure than the xHCI resume death.`,
    };
  }

  // Re-grab via InputPlumber. The rebind hotplugged the pad on a fresh USB
  // node; InputPlumber still holds its old grab and won't reliably re-grab
  // the new one, so it must be restarted or Steam ends up seeing a stale
  // duplicate. We delegate to the input-plumber plugin (see
  // `deps.restartInputPlumber`) instead of a raw `systemctl restart` so the
  // restart also *reloads* the wake profile — otherwise the QAM→F16 overlay
  // shortcut silently dies. Best-effort: a failure here doesn't fail the
  // recovery (the USB pad is already back), so we don't gate the result on it.
  steps.push("inputplumber-restart");
  deps.log?.("restarting InputPlumber to re-grab the recovered pad");
  const ip = await deps.restartInputPlumber();
  if (!ip.ok) {
    deps.log?.(`InputPlumber restart reported a problem: ${ip.error ?? "unknown"} (pad is back regardless)`);
  }

  return { success: true, controller, steps, gamepadPresent: true };
}
