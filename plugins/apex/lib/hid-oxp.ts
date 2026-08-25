/**
 * The old `hid-oxp` driver blacklist — **removal only**.
 *
 * ## Do not add an enable path to this file
 *
 * Loadout once recommended blacklisting the OneXPlayer HID driver, because it
 * looked implicated in the xHCI USB controller dying on resume. That was never
 * a fix: it disabled the driver instead of addressing the wake bug, and the
 * real mitigation ships in ./xhci.ts — unbind/rebind the controller so the bus
 * re-enumerates, exposed as **Recover gamepad** and as
 * `scripts/fix-controller-resume.sh`.
 *
 * The cost has since grown. `hid-oxp` is where OneXPlayer's device controls
 * live — rumble intensity, gamepad mode, button remapping — so a machine
 * carrying this drop-in silently loses all of them, with nothing on screen to
 * explain why. A future plugin reading those attributes will find no hardware
 * on exactly the machines that took our advice.
 *
 * So this module reads the state and takes the blacklist *off*. There is
 * deliberately no way to put it back on, and the UI offers none. If the wake
 * bug resurfaces, fix it in ./xhci.ts.
 *
 * All IO is injected (`HidOxpDeps`) so the logic is unit-testable without root
 * or a real /etc + /proc.
 */

/** modprobe.d drop-in that disables the driver. */
export const HID_OXP_CONF = "/etc/modprobe.d/hid-oxp.conf";
/** The directive we look for. Never written — see the note above. */
export const BLACKLIST_LINE = "blacklist hid-oxp";
/** Module name as it appears in /proc/modules (underscored). */
const MODULE_NAME = "hid_oxp";
const PROC_MODULES = "/proc/modules";

export interface HidOxpDeps {
  /** Read a file, or resolve null when it doesn't exist. */
  readFile: (path: string) => Promise<string | null>;
  /** Remove a file; must be a no-op when it's already absent. */
  removeFile: (path: string) => Promise<void>;
  /** Optional progress sink. */
  log?: (message: string) => void;
}

export interface HidOxpStatus {
  /** The modprobe.d drop-in is present and carries the blacklist line. */
  blacklisted: boolean;
  /** `hid_oxp` is currently loaded (still resident until the next boot). */
  moduleLoaded: boolean;
  /**
   * The blacklist is in place but the module is still resident, so it hasn't
   * taken effect yet.
   *
   * Deliberately not extended to cover "removed but not yet loaded": on a
   * machine where hid_oxp simply isn't loaded — a gen-1 device, or a kernel
   * without the driver — that would flag a reboot nobody needs. The UI says
   * "reboot to restore the driver" after a successful removal instead, where
   * the context is unambiguous.
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
 * Remove the drop-in and report the fresh status. Idempotent: removing when
 * it's already absent is a no-op, so this is safe to call unconditionally.
 */
export async function removeHidOxpBlacklist(
  deps: HidOxpDeps,
): Promise<HidOxpStatus> {
  await deps.removeFile(HID_OXP_CONF);
  deps.log?.(`removed ${HID_OXP_CONF}`);
  return getHidOxpStatus(deps);
}
