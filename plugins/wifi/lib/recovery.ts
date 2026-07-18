/**
 * WiFi radio recovery — bring a crashed WiFi driver/firmware back without
 * a reboot.
 *
 * Field incident this automates (OneXPlayer Apex, Intel AX210, iwlwifi):
 * the firmware crashed ("HW problem - can not stop rx aggregation",
 * "failed to remove key ... (-5)", endless firmware reload loop in dmesg),
 * leaving NetworkManager's wifi device stuck "unavailable" until reboot.
 * The validated live fix was a plain module reload:
 *
 *     modprobe -r iwlmvm iwlwifi   # opmode module first, else "in use"
 *     modprobe iwlwifi             # NM auto-reconnects the saved network
 *
 * Escalation when the reload isn't enough: PCI function reset, then PCI
 * remove + rescan — the software equivalent of a cold boot for just the
 * card. Both tiers only ever run when the radio is already dead, so the
 * worst case equals the status quo (a reboot was needed anyway).
 *
 * Hard-won gotchas encoded here:
 *  - The interface can come back RENAMED after a reload (wlan0 → wlan1),
 *    so nothing hardcodes the name — the wifi device is re-detected from
 *    `nmcli device status` at every step.
 *  - rfkill is checked first: a blocked radio is the user's deliberate
 *    off-switch (or airplane mode), not a crash — never fight it.
 *  - Stacked drivers unload top-down (iwlmvm before iwlwifi). For drivers
 *    not in the map, /proc/modules' "used by" column supplies the holders
 *    generically.
 *  - The driver + PCI address are captured while the radio is healthy and
 *    persisted by the backend, so recovery still works when the interface
 *    has vanished entirely (driver unloaded, nothing under /sys/class/net).
 *
 * All fs/subprocess access is injected (RecoveryDeps) so the orchestration
 * is unit-testable without root, sysfs, or a real radio.
 */

import type { RunResult } from "./powersave";

export type Run = (
  cmd: string[],
  opts?: { timeoutMs?: number; quiet?: boolean },
) => Promise<RunResult>;

export interface RecoveryDeps {
  /** Run a subprocess (wired to `@loadout/exec`'s `runFull` in prod).
   *  `quiet` skips the per-call audit log line for high-frequency polls. */
  run: Run;
  /** Read a file as UTF-8. Rejects on a missing file. */
  readFile: (path: string) => Promise<string>;
  /** Write a file (UTF-8) — used for the sysfs PCI reset/remove/rescan knobs. */
  writeFile: (path: string, content: string) => Promise<void>;
  /** Resolve a symlink's target. Rejects on a missing path. */
  readlink: (path: string) => Promise<string>;
  /** Entry basenames of a directory. Rejects on a missing directory. */
  listDir: (path: string) => Promise<string[]>;
  /** Injectable so tests advance a fake clock instead of really waiting. */
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log?: (message: string) => void;
}

// --- pure helpers ------------------------------------------------------------

export interface NmDeviceRow {
  device: string;
  type: string;
  state: string;
}

/** Parse `nmcli -t -f DEVICE,TYPE,STATE device status` (terse, `\:`-escaped). */
export function parseNmDeviceStatus(out: string): NmDeviceRow[] {
  const rows: NmDeviceRow[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [device, type, state] = line
      .split(/(?<!\\):/)
      .map((part) => part.replace(/\\:/g, ":"));
    if (!device || !type || !state) continue;
    rows.push({ device, type, state });
  }
  return rows;
}

/** First wifi-type device row, or null. Never assume it's called wlan0. */
export function findWifiDevice(rows: NmDeviceRow[]): { device: string; state: string } | null {
  const row = rows.find((r) => r.type === "wifi");
  return row ? { device: row.device, state: row.state } : null;
}

/**
 * Driver → module list. `unload` is ordered top-down (dependents first):
 * Intel's opmode module iwlmvm holds iwlwifi, so `modprobe -r iwlwifi`
 * alone fails with "Module iwlwifi is in use". Loading the base module
 * auto-pulls its dependents back. Unmapped drivers get the identity
 * mapping plus the generic /proc/modules holders fallback in recover().
 */
export const DRIVER_MODULES: Record<string, { unload: string[]; load: string }> = {
  iwlwifi: { unload: ["iwlmvm", "iwlwifi"], load: "iwlwifi" },
};

export function modulesForDriver(opts: { driver: string }): { unload: string[]; load: string } {
  return DRIVER_MODULES[opts.driver] ?? { unload: [opts.driver], load: opts.driver };
}

/**
 * Modules holding `module` per /proc/modules (4th column, "used by":
 * a comma-separated list, or "-" when nothing holds it).
 */
export function findModuleHolders(opts: { procModules: string; module: string }): string[] {
  for (const line of opts.procModules.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== opts.module) continue;
    const usedBy = fields[3];
    if (!usedBy || usedBy === "-") return [];
    return usedBy.split(",").filter((name) => name.length > 0);
  }
  return [];
}

// --- impure orchestration ----------------------------------------------------

const RFKILL_DIR = "/sys/class/rfkill";

/**
 * rfkill state OR'd across all wlan-type rfkill devices, read straight
 * from sysfs (no rfkill binary — SteamOS doesn't ship one by default).
 * A missing rfkill dir means nothing can be blocked.
 */
export async function readRfkill(opts: { deps: RecoveryDeps }): Promise<{
  soft: boolean;
  hard: boolean;
  blocked: boolean;
}> {
  const { deps } = opts;
  let soft = false;
  let hard = false;
  const entries = await deps.listDir(RFKILL_DIR).catch(() => [] as string[]);
  for (const entry of entries) {
    const base = `${RFKILL_DIR}/${entry}`;
    const type = await deps.readFile(`${base}/type`).catch(() => "");
    if (type.trim() !== "wlan") continue;
    const [softRaw, hardRaw] = await Promise.all([
      deps.readFile(`${base}/soft`).catch(() => "0"),
      deps.readFile(`${base}/hard`).catch(() => "0"),
    ]);
    if (softRaw.trim() === "1") soft = true;
    if (hardRaw.trim() === "1") hard = true;
  }
  return { soft, hard, blocked: soft || hard };
}

/** Whether NetworkManager's wifi radio switch is on (`nmcli radio wifi`). */
export async function nmRadioEnabled(opts: { deps: RecoveryDeps; quiet?: boolean }): Promise<boolean> {
  const r = await opts.deps.run(["nmcli", "radio", "wifi"], {
    timeoutMs: 10_000,
    quiet: opts.quiet,
  });
  return r.exitCode === 0 && r.stdout.trim() === "enabled";
}

/** Current wifi device + NM state, or null when none exists. */
export async function getWifiDevice(opts: { deps: RecoveryDeps; quiet?: boolean }): Promise<{
  device: string;
  state: string;
} | null> {
  const r = await opts.deps.run(["nmcli", "-t", "-f", "DEVICE,TYPE,STATE", "device", "status"], {
    timeoutMs: 10_000,
    quiet: opts.quiet,
  });
  if (r.exitCode !== 0) return null;
  return findWifiDevice(parseNmDeviceStatus(r.stdout));
}

export interface DriverInfo {
  driver: string;
  /** PCI address like "0000:62:00.0", or null (e.g. USB wifi). */
  pciAddress: string | null;
  /** Interface name at capture time — informational; may change on reload. */
  iface: string;
  updatedAt: number;
}

const PCI_ADDRESS = /^[0-9a-fA-F]{4}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}\.[0-9a-fA-F]$/;

/** Kernel module name shape — no leading dash (modprobe option smuggling),
 *  no path separators. */
const MODULE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** Driver + PCI address for a live interface (via /sys symlinks), or null. */
export async function detectDriverInfo(opts: {
  deps: RecoveryDeps;
  iface: string;
}): Promise<DriverInfo | null> {
  const { deps, iface } = opts;
  const driverLink = await deps
    .readlink(`/sys/class/net/${iface}/device/driver`)
    .catch(() => null);
  if (!driverLink) return null;
  const deviceLink = await deps.readlink(`/sys/class/net/${iface}/device`).catch(() => null);
  const deviceBase = deviceLink ? basename(deviceLink) : "";
  return {
    driver: basename(driverLink),
    pciAddress: PCI_ADDRESS.test(deviceBase) ? deviceBase : null,
    iface,
    updatedAt: deps.now(),
  };
}

/**
 * `modprobe -r` the module list; on an "in use" failure for a driver we
 * don't have in the map, look up the holders in /proc/modules and retry
 * once with them prepended (the generic form of the iwlmvm lesson).
 */
async function unloadModules(opts: {
  deps: RecoveryDeps;
  unload: string[];
}): Promise<{ ok: boolean; detail: string }> {
  const { deps, unload } = opts;
  const describe = (r: RunResult) => r.stderr.trim() || `modprobe -r exited ${r.exitCode}`;

  const first = await boundedRun({ deps, cmd: ["modprobe", "-r", ...unload], timeoutMs: 15_000 });
  if (first.exitCode === 0) return { ok: true, detail: "" };

  if (/in use/i.test(first.stderr)) {
    const procModules = await deps.readFile("/proc/modules").catch(() => "");
    const holders = unload
      .flatMap((module) => findModuleHolders({ procModules, module }))
      .filter((holder) => !unload.includes(holder));
    if (holders.length > 0) {
      deps.log?.(`modprobe -r blocked by holders [${holders.join(", ")}] — retrying with them.`);
      const retry = await boundedRun({
        deps,
        cmd: ["modprobe", "-r", ...holders, ...unload],
        timeoutMs: 15_000,
      });
      if (retry.exitCode === 0) return { ok: true, detail: "" };
      return { ok: false, detail: describe(retry) };
    }
  }
  return { ok: false, detail: describe(first) };
}

/**
 * Write "1" to a sysfs knob with a hard timeout. A PCI function reset or
 * bus-remove can block inside the kernel; without the bound, a hung write
 * would wedge recover() — and the backend's single-flight guard — forever.
 * The stuck write is abandoned (nothing can cancel it), recovery just
 * stops waiting on it.
 */
const SYSFS_WRITE_TIMEOUT_MS = 15_000;
function boundedSysfsWrite(opts: { deps: RecoveryDeps; path: string }): Promise<void> {
  const { deps, path } = opts;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`sysfs write timed out after ${SYSFS_WRITE_TIMEOUT_MS}ms: ${path}`)),
      SYSFS_WRITE_TIMEOUT_MS,
    );
  });
  return Promise.race([deps.writeFile(path, "1"), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<void>;
}

/**
 * deps.run with a hard outer deadline. The exec layer's own timeout kills
 * the subprocess — but a modprobe stuck in uninterruptible D-state on
 * wedged firmware (the exact scenario this feature targets) survives
 * SIGKILL, its exit never resolves, and awaiting it would wedge recover()
 * and the backend's single-flight guard forever. Abandon it instead and
 * report a timeout result.
 */
function boundedRun(opts: {
  deps: RecoveryDeps;
  cmd: string[];
  timeoutMs: number;
}): Promise<RunResult> {
  const { deps, cmd, timeoutMs } = opts;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Outer deadline sits above the exec timeout so the normal kill path
  // wins whenever the process is actually killable.
  const timeout = new Promise<RunResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          stdout: "",
          stderr: `timed out after ${timeoutMs}ms (process unkillable — abandoned)`,
          exitCode: -1,
        }),
      timeoutMs + 5_000,
    );
  });
  return Promise.race([deps.run(cmd, { timeoutMs }), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Poll until a wifi device exists in a usable NM state ("disconnected",
 * "connecting", "connected", …) — i.e. anything except missing,
 * "unavailable" (driver dead) or "unmanaged". Returns null on timeout.
 */
async function waitForWifiDevice(opts: {
  deps: RecoveryDeps;
  timeoutMs: number;
  pollIntervalMs: number;
}): Promise<{ device: string; state: string } | null> {
  const { deps, timeoutMs, pollIntervalMs } = opts;
  const start = deps.now();
  for (;;) {
    const dev = await getWifiDevice({ deps, quiet: true });
    if (dev && dev.state !== "unavailable" && dev.state !== "unmanaged") return dev;
    if (deps.now() - start >= timeoutMs) return null;
    await deps.sleep(pollIntervalMs);
  }
}

export type RecoveryStage =
  | "precheck"
  | "unload"
  | "load"
  | "wait"
  | "pci-reset"
  | "pci-rescan"
  | "done";

export type RecoveryTier = "modprobe" | "pci-reset" | "pci-rescan";

export interface RecoveryResult {
  ok: boolean;
  /** Where the run ended: "done" on success, else the failing stage. */
  stage: RecoveryStage;
  /** The escalation tier that succeeded (or the last one tried). */
  tier: RecoveryTier | null;
  driver: string | null;
  /** Post-recovery device name — may differ from before (wlan0 → wlan1). */
  iface: string | null;
  /** Human-readable outcome for the UI's last-result line / notification. */
  detail: string;
  durationMs: number;
}

/**
 * Run the full recovery ladder: module reload → PCI function reset →
 * PCI remove + rescan. Resolves (never rejects) with a structured result —
 * an unexpectedly-throwing dep becomes a failed result at the stage it
 * died in, so the backend's single-flight guard always clears.
 */
export async function recover(opts: {
  deps: RecoveryDeps;
  /** Persisted fallback for when the interface has vanished entirely. */
  lastKnown: DriverInfo | null;
  onStage?: (stage: RecoveryStage) => void;
  /** How long each tier waits for the radio to come back. */
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<RecoveryResult> {
  const { deps, onStage } = opts;
  const start = deps.now();
  const finish = (
    partial: Omit<RecoveryResult, "durationMs">,
  ): RecoveryResult => ({ ...partial, durationMs: deps.now() - start });

  let stage: RecoveryStage = "precheck";
  let driver: string | null = null;
  const enterStage = (next: RecoveryStage) => {
    stage = next;
    onStage?.(next);
  };
  try {
    return await runLadder({ ...opts, enterStage, finish, setDriver: (d) => (driver = d) });
  } catch (e) {
    return finish({
      ok: false,
      stage,
      tier: null,
      driver,
      iface: null,
      detail: `Recovery failed unexpectedly at ${stage}: ${e}`,
    });
  }
}

async function runLadder(opts: {
  deps: RecoveryDeps;
  lastKnown: DriverInfo | null;
  enterStage: (stage: RecoveryStage) => void;
  finish: (partial: Omit<RecoveryResult, "durationMs">) => RecoveryResult;
  setDriver: (driver: string) => void;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<RecoveryResult> {
  const { deps, lastKnown, enterStage, finish, setDriver } = opts;
  const waitTimeoutMs = opts.waitTimeoutMs ?? 20_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 1_000;

  enterStage("precheck");
  const rfkill = await readRfkill({ deps });
  if (rfkill.blocked) {
    return finish({
      ok: false,
      stage: "precheck",
      tier: null,
      driver: null,
      iface: null,
      detail: rfkill.hard
        ? "WiFi is hardware-blocked (rfkill) — recovery skipped. Check the airplane-mode switch or BIOS."
        : "WiFi is switched off (rfkill) — recovery skipped. Turn WiFi on first.",
    });
  }

  let info: DriverInfo | null = null;
  const present = await getWifiDevice({ deps });
  if (present) info = await detectDriverInfo({ deps, iface: present.device });
  if (!info) info = lastKnown;
  if (!info) {
    return finish({
      ok: false,
      stage: "precheck",
      tier: null,
      driver: null,
      iface: null,
      detail: "No WiFi driver known — open this plugin once while WiFi works, then retry.",
    });
  }

  // Re-validate on readback: `lastKnown` comes from user-editable JSON
  // storage, and this code runs as root. Capture-time validation isn't
  // enough — a corrupted/tampered file must not steer modprobe argv or
  // the sysfs write paths (defense-in-depth; same shapes as capture).
  if (!MODULE_NAME.test(info.driver)) {
    return finish({
      ok: false,
      stage: "precheck",
      tier: null,
      driver: null,
      iface: null,
      detail: "Stored WiFi driver name looks invalid — open this plugin once while WiFi works, then retry.",
    });
  }
  const pciAddress =
    info.pciAddress && PCI_ADDRESS.test(info.pciAddress) ? info.pciAddress : null;
  setDriver(info.driver);

  const modules = modulesForDriver({ driver: info.driver });
  const wait = () => waitForWifiDevice({ deps, timeoutMs: waitTimeoutMs, pollIntervalMs });
  const load = () => boundedRun({ deps, cmd: ["modprobe", modules.load], timeoutMs: 15_000 });
  deps.log?.(`recovering ${info.driver} (unload: ${modules.unload.join(" ")})`);

  // Tier 1 — module reload (the fix validated live on the Apex).
  enterStage("unload");
  const unloaded = await unloadModules({ deps, unload: modules.unload });
  if (!unloaded.ok) {
    return finish({
      ok: false,
      stage: "unload",
      tier: "modprobe",
      driver: info.driver,
      iface: null,
      detail: `Couldn't unload the driver: ${unloaded.detail}`,
    });
  }
  enterStage("load");
  const loaded = await load();
  if (loaded.exitCode !== 0) {
    return finish({
      ok: false,
      stage: "load",
      tier: "modprobe",
      driver: info.driver,
      iface: null,
      detail: `Couldn't reload ${modules.load}: ${loaded.stderr.trim() || `exit ${loaded.exitCode}`}`,
    });
  }
  enterStage("wait");
  let dev = await wait();
  if (dev) {
    return finish({
      ok: true,
      stage: "done",
      tier: "modprobe",
      driver: info.driver,
      iface: dev.device,
      detail: `Driver reloaded — radio back as ${dev.device}.`,
    });
  }

  if (!pciAddress) {
    return finish({
      ok: false,
      stage: "wait",
      tier: "modprobe",
      driver: info.driver,
      iface: null,
      detail:
        "Module reload didn't bring the radio back and no PCI address is known — a full power-off should recover it.",
    });
  }

  // Tier 2 — PCI function reset: re-initialises just the card. Worst case
  // is temporary (cleared by a cold boot), and the radio is already dead.
  enterStage("pci-reset");
  deps.log?.(`module reload wasn't enough — PCI function reset of ${pciAddress}`);
  await unloadModules({ deps, unload: modules.unload }); // best-effort
  await boundedSysfsWrite({ deps, path: `/sys/bus/pci/devices/${pciAddress}/reset` }).catch(
    (e) => deps.log?.(`pci reset write failed: ${e}`),
  );
  await load();
  dev = await wait();
  if (dev) {
    return finish({
      ok: true,
      stage: "done",
      tier: "pci-reset",
      driver: info.driver,
      iface: dev.device,
      detail: `PCI reset recovered the radio — back as ${dev.device}.`,
    });
  }

  // Tier 3 — remove the device from the bus and rescan: a full
  // re-enumeration, the closest software gets to a cold boot of the card.
  enterStage("pci-rescan");
  deps.log?.(`PCI reset wasn't enough — removing ${pciAddress} and rescanning the bus`);
  await unloadModules({ deps, unload: modules.unload }); // best-effort
  await boundedSysfsWrite({ deps, path: `/sys/bus/pci/devices/${pciAddress}/remove` }).catch(
    (e) => deps.log?.(`pci remove write failed: ${e}`),
  );
  await deps.sleep(2_000);
  await boundedSysfsWrite({ deps, path: "/sys/bus/pci/rescan" }).catch((e) =>
    deps.log?.(`pci rescan write failed: ${e}`),
  );
  await load();
  dev = await wait();
  if (dev) {
    return finish({
      ok: true,
      stage: "done",
      tier: "pci-rescan",
      driver: info.driver,
      iface: dev.device,
      detail: `PCI rescan recovered the radio — back as ${dev.device}.`,
    });
  }
  return finish({
    ok: false,
    stage: "pci-rescan",
    tier: "pci-rescan",
    driver: info.driver,
    iface: null,
    detail:
      "Recovery exhausted (module reload, PCI reset, rescan) — a full power-off (not just a restart) should bring the card back.",
  });
}

// --- watchdog state machine --------------------------------------------------
//
// A pure reducer the backend drives from its poll interval. Kept free of
// timers/IO so every rule (debounce, cooldown, suspension) is unit-testable.

export interface WatchdogConfig {
  /** Consecutive bad polls before firing (filters resume transients). */
  debounceCount: number;
  /** Minimum ms between recovery attempts. */
  cooldownMs: number;
  /** Consecutive failed recoveries before suspending (no crash-loop). */
  maxFailures: number;
}

export const DEFAULT_WATCHDOG: WatchdogConfig = {
  debounceCount: 2,
  cooldownMs: 60_000,
  maxFailures: 3,
};

export interface WatchdogState {
  consecutiveBad: number;
  consecutiveFailures: number;
  lastAttemptAt: number | null;
  /** Gave up after repeated failures; clears on a healthy poll or reload. */
  suspended: boolean;
}

export function initialWatchdogState(): WatchdogState {
  return { consecutiveBad: 0, consecutiveFailures: 0, lastAttemptAt: null, suspended: false };
}

export interface WatchdogSample {
  wifiPresent: boolean;
  /** NM state when present, else null. */
  state: string | null;
  rfkillBlocked: boolean;
  /** `nmcli radio wifi` switch. */
  radioEnabled: boolean;
  /** Storage has a lastKnownDriver (the vanished-interface case is bad). */
  hasKnownDriver: boolean;
}

export function evaluateWatchdog(opts: {
  state: WatchdogState;
  sample: WatchdogSample;
  now: number;
  config: WatchdogConfig;
}): { next: WatchdogState; fire: boolean; reason: string } {
  const { state, sample, now, config } = opts;

  if (sample.wifiPresent && sample.state !== "unavailable") {
    // Healthy — full reset, including clearing a suspension. "unmanaged"
    // lands here on purpose: it's NM configuration, not a crash, and a
    // driver reload wouldn't change it.
    return { next: initialWatchdogState(), fire: false, reason: "healthy" };
  }
  if (sample.rfkillBlocked || !sample.radioEnabled) {
    // Deliberately off — never fight the user's off switch.
    return {
      next: { ...state, consecutiveBad: 0 },
      fire: false,
      reason: sample.rfkillBlocked ? "rfkill-blocked" : "radio-disabled",
    };
  }
  const bad = sample.wifiPresent || sample.hasKnownDriver;
  if (!bad) {
    // No device and nothing we'd know how to reload — not actionable.
    return { next: { ...state, consecutiveBad: 0 }, fire: false, reason: "no-known-driver" };
  }

  const consecutiveBad = state.consecutiveBad + 1;
  if (state.suspended) {
    return { next: { ...state, consecutiveBad }, fire: false, reason: "suspended" };
  }
  if (consecutiveBad < config.debounceCount) {
    return { next: { ...state, consecutiveBad }, fire: false, reason: "debouncing" };
  }
  if (state.lastAttemptAt !== null && now - state.lastAttemptAt < config.cooldownMs) {
    return { next: { ...state, consecutiveBad }, fire: false, reason: "cooldown" };
  }
  return {
    next: { ...state, consecutiveBad: 0, lastAttemptAt: now },
    fire: true,
    reason: sample.wifiPresent ? "device-unavailable" : "device-missing",
  };
}

export function recordRecoveryOutcome(opts: {
  state: WatchdogState;
  ok: boolean;
  config: WatchdogConfig;
}): WatchdogState {
  const { state, ok, config } = opts;
  if (ok) return { ...state, consecutiveFailures: 0, suspended: false };
  const consecutiveFailures = state.consecutiveFailures + 1;
  return { ...state, consecutiveFailures, suspended: consecutiveFailures >= config.maxFailures };
}
