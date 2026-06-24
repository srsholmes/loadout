/**
 * hid-oxp driver blacklist — the OneXPlayer-specific HID kernel driver.
 *
 * On the Apex, the `hid-oxp` driver appears to be implicated in the xHCI
 * USB controller dying on resume from sleep. Blacklisting it (so the kernel
 * doesn't bind it to the gamepad's HID MCU) makes the controller survive
 * wake far more reliably in field testing — a cleaner, root-cause-adjacent
 * mitigation than rebinding the dead controller after the fact (see
 * ./xhci.ts for that recovery path).
 *
 * The blacklist is just a one-line drop-in under /etc/modprobe.d. It only
 * takes effect on the next boot: an already-loaded module stays loaded
 * until reboot, so `getHidOxpStatus` reports `rebootRequired` when the
 * blacklist is in place but the module is still resident.
 *
 * All IO is injected (`HidOxpDeps`) so the logic is unit-testable without
 * root or a real /etc + /proc.
 */

/** modprobe.d drop-in that disables the driver. */
export const HID_OXP_CONF = "/etc/modprobe.d/hid-oxp.conf";
/** The exact directive we write / look for. */
export const BLACKLIST_LINE = "blacklist hid-oxp";
/** Module name as it appears in /proc/modules (underscored). */
const MODULE_NAME = "hid_oxp";
const PROC_MODULES = "/proc/modules";

export interface HidOxpDeps {
  /** Read a file, or resolve null when it doesn't exist. */
  readFile: (path: string) => Promise<string | null>;
  /** Write (create/overwrite) a file. */
  writeFile: (path: string, content: string) => Promise<void>;
  /** Remove a file; must be a no-op when it's already absent. */
  removeFile: (path: string) => Promise<void>;
  /** Optional progress sink. */
  log?: (message: string) => void;
}

export interface HidOxpStatus {
  /** The modprobe.d drop-in is present and contains the blacklist line. */
  blacklisted: boolean;
  /** `hid_oxp` is currently loaded (still resident until the next boot). */
  moduleLoaded: boolean;
  /**
   * The desired state is set but a reboot is needed to reach it: blacklisted
   * yet still loaded. (Un-blacklisting also only frees the module at the next
   * boot, but that's the harmless direction, so we don't flag it.)
   */
  rebootRequired: boolean;
}

/** True when /proc/modules lists `hid_oxp` (first column of any line). */
function moduleIsLoaded(procModules: string): boolean {
  return procModules
    .split("\n")
    .some((line) => line.split(/\s+/)[0] === MODULE_NAME);
}

/** True when the conf file exists and carries the blacklist directive. */
function confBlacklists(conf: string | null): boolean {
  if (!conf) return false;
  return conf.split("\n").some((line) => line.trim() === BLACKLIST_LINE);
}

export async function getHidOxpStatus(deps: HidOxpDeps): Promise<HidOxpStatus> {
  const [conf, procModules] = await Promise.all([
    deps.readFile(HID_OXP_CONF),
    deps.readFile(PROC_MODULES),
  ]);
  const blacklisted = confBlacklists(conf);
  const moduleLoaded = moduleIsLoaded(procModules ?? "");
  return { blacklisted, moduleLoaded, rebootRequired: blacklisted && moduleLoaded };
}

/**
 * Enable or disable the blacklist by writing / removing the drop-in, then
 * return the fresh status. Idempotent: enabling when already blacklisted
 * just rewrites the same line; disabling when absent is a no-op.
 */
export async function setHidOxpBlacklist(
  deps: HidOxpDeps,
  enabled: boolean,
): Promise<HidOxpStatus> {
  if (enabled) {
    await deps.writeFile(HID_OXP_CONF, `${BLACKLIST_LINE}\n`);
    deps.log?.(`wrote ${HID_OXP_CONF} (blacklist hid-oxp)`);
  } else {
    await deps.removeFile(HID_OXP_CONF);
    deps.log?.(`removed ${HID_OXP_CONF}`);
  }
  return getHidOxpStatus(deps);
}
