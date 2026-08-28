/**
 * Global rumble intensity for OneXPlayer-family handhelds.
 *
 * The kernel's `hid-oxp` driver exposes `rumble_intensity` (RW u8) and
 * `rumble_intensity_range` (RO, "0-5") on the gamepad's HID device. That is
 * the whole interface: one global attenuator on the MCU, no force feedback,
 * no per-motor split.
 *
 * ## Why this lives in the OneXPlayer plugin
 *
 * `rumble_intensity` is a `hid-oxp` attribute, and no other handheld exposes
 * an equivalent the kernel can hand us. Surveying Handheld Daemon's device
 * tree: MSI Claw and ROG Ally only pass force-feedback *events* through (a
 * buzz, not a level); Ayaneo, Legion Go and Orange Pi have nothing. GPD Win
 * does have a real global setting — off/medium/high — but it is written into
 * a config blob over the `wincontrols` vendor HID protocol from userspace,
 * with no sysfs at all, so it shares no mechanism with this.
 *
 * A standalone plugin would therefore have been a permanently dead entry on
 * every non-OneXPlayer device, since the shell gives each loaded plugin a
 * sidebar row whether or not its hardware is present.
 *
 * ## Detection is by attribute, not by device
 *
 * We glob `/sys/bus/hid/devices/*&#47;rumble_intensity` rather than matching a
 * VID/PID table — the attribute exists on every gen-2 device the driver
 * binds (X1 mini series, G1 A/i, AOKZOE A1X, Apex, X2 Mini Pro), so a table
 * would be a list to maintain and a way to exclude hardware that works.
 *
 * ## The stored value is the source of truth
 *
 * `rumble_intensity_show` returns a driver-side cache initialised to 5 in
 * `oxp_cfg_probe` — it never queries the MCU. So a read after boot says 5
 * whatever the firmware is doing, and the value we persisted is the better
 * record of what the user chose. We re-apply on load because that cache
 * resets on every module load. No wake listener is needed: the driver
 * re-applies its cache after resume itself.
 */

import type { RetryScanner } from "@loadout/types";
import { createRetryScanner } from "@loadout/types";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FALLBACK_RANGE,
  clampIntensity,
  isValidIntensity,
  parseIntensityRange,
  type IntensityRange,
} from "./rumble";

const HID_DEVICES = "/sys/bus/hid/devices";
const INTENSITY_ATTR = "rumble_intensity";
const RANGE_ATTR = "rumble_intensity_range";

export interface RumbleInfo {
  /** A device exposing the attribute was found. */
  available: boolean;
  /** The HID device directory, for diagnostics. */
  devicePath: string | null;
  min: number;
  max: number;
  /** The level in effect: what we persisted if we have it, else the driver's. */
  intensity: number | null;
  /** Where `intensity` came from — the driver's cache is unreliable after a
   *  module reload, so the UI can say which it is. */
  source: "stored" | "driver" | null;
}

export interface RumbleDeps {
  /** Read the persisted level (undefined when never set). */
  readStored: () => Promise<number | undefined>;
  /** Persist the level. */
  writeStored: (value: number) => Promise<void>;
  log?: (msg: string) => void;
  /** Retry cadence while no device is found. Injectable so tests can assert
   *  the scan actually stops rather than waiting out the real 30s. */
  intervalMs?: number;
  /** Called when detection or the level changes, so the UI can refresh. */
  onChange?: (info: RumbleInfo) => void;
  /**
   * Sysfs access, injected like {@link ./xhci}'s `run`/`pathExists`. Without
   * this the scan reads the host's real /sys, so the plugin's own tests
   * behaved differently on a machine that happens to have OneXPlayer
   * hardware attached — which is exactly the machine they get run on.
   */
  fs?: {
    readdir: (path: string) => Promise<string[]>;
    readFile: (path: string) => Promise<string>;
    writeFile: (path: string, data: string) => Promise<void>;
  };
}

const REAL_FS: NonNullable<RumbleDeps["fs"]> = {
  readdir: (p) => readdir(p),
  readFile: (p) => readFile(p, "utf8"),
  writeFile: (p, d) => writeFile(p, d),
};

export class RumbleControl {
  private devicePath: string | null = null;
  private range: IntensityRange = FALLBACK_RANGE;
  private scanner?: RetryScanner;

  private fs: NonNullable<RumbleDeps["fs"]>;

  constructor(private deps: RumbleDeps) {
    this.fs = deps.fs ?? REAL_FS;
  }

  async start(): Promise<void> {
    // The driver binds on USB enumeration and can lose the race with plugin
    // load — and a user who has just un-blacklisted it only gets the module
    // at the next boot. Retrying costs one readdir every 30s until found.
    this.scanner = createRetryScanner({
      label: "apex:rumble",
      scan: () => this.scan(),
      intervalMs: this.deps.intervalMs ?? 30_000,
      onFound: async () => {
        await this.restore();
        this.deps.onChange?.(await this.getInfo());
      },
    });
    await this.scanner.start();
  }

  stop(): void {
    this.scanner?.stop();
  }

  /** Find the first HID device carrying the attribute. */
  private async scan(): Promise<boolean> {
    // Clear first: without this a rescan after the device disappeared kept
    // reporting the old path as available.
    this.devicePath = null;
    let entries: string[];
    try {
      entries = await this.fs.readdir(HID_DEVICES);
    } catch {
      // No HID bus at all (container, unusual kernel) — not an error worth
      // logging every 30s.
      return false;
    }

    for (const entry of entries) {
      const dir = join(HID_DEVICES, entry);
      if ((await this.readAttr(join(dir, INTENSITY_ATTR))) === null) continue;

      this.devicePath = dir;
      this.range =
        parseIntensityRange(await this.readAttr(join(dir, RANGE_ATTR))) ?? FALLBACK_RANGE;
      this.deps.log?.(`rumble control at ${dir} (range ${this.range.min}-${this.range.max})`);
      return true;
    }
    return false;
  }

  private async readAttr(path: string): Promise<string | null> {
    try {
      return await this.fs.readFile(path);
    } catch {
      return null;
    }
  }

  /**
   * Re-apply the stored level. Writes nothing when the user has never chosen
   * one — leaving the firmware's default alone is the right default, and a
   * user managing this elsewhere is never clobbered.
   */
  private async restore(): Promise<void> {
    if (!this.devicePath) return;
    const stored = await this.deps.readStored();
    if (!isValidIntensity(stored, this.range)) return;

    const result = await this.write(stored);
    this.deps.log?.(
      result.success
        ? `restored rumble intensity ${stored}`
        : `could not restore rumble intensity: ${result.error}`,
    );
  }

  private async write(value: number): Promise<{ success: boolean; error?: string }> {
    if (!this.devicePath) return { success: false, error: "No device with rumble control." };
    try {
      // The backend runs as root, and the kernel serialises the underlying
      // HID report under its own mutex — no write-gap pacing needed here,
      // unlike the raw hidraw path in rgb-control.
      await this.fs.writeFile(join(this.devicePath, INTENSITY_ATTR), String(value));
      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  /** Current state for the UI. */
  async getInfo(): Promise<RumbleInfo> {
    if (!this.devicePath) {
      return {
        available: false,
        devicePath: null,
        min: this.range.min,
        max: this.range.max,
        intensity: null,
        source: null,
      };
    }

    const stored = await this.deps.readStored();
    if (isValidIntensity(stored, this.range)) {
      return {
        available: true,
        devicePath: this.devicePath,
        min: this.range.min,
        max: this.range.max,
        intensity: stored,
        source: "stored",
      };
    }

    // Nothing stored: report what the driver says, flagged as such. Its cache
    // is initialised to the maximum on probe, so this is "what it would do",
    // not necessarily what the MCU is doing.
    // `Number("")` is 0, which is finite — so a short or empty read used to
    // surface as a confident "Off" for a level we do not actually know.
    const raw = await this.readAttr(join(this.devicePath, INTENSITY_ATTR));
    const trimmed = raw?.trim() ?? "";
    const parsed = trimmed === "" ? NaN : Number(trimmed);
    return {
      available: true,
      devicePath: this.devicePath,
      min: this.range.min,
      max: this.range.max,
      intensity: Number.isFinite(parsed) ? clampIntensity(parsed, this.range) : null,
      source: Number.isFinite(parsed) ? "driver" : null,
    };
  }

  /** Set the global rumble level and remember it. */
  async setIntensity(
    value: number,
  ): Promise<{ success: boolean; error?: string; info?: RumbleInfo }> {
    if (!this.devicePath) return { success: false, error: "No device with rumble control." };
    const level = clampIntensity(value, this.range);

    const result = await this.write(level);
    if (!result.success) return result;

    try {
      await this.deps.writeStored(level);
    } catch (e) {
      // The hardware took it; failing the call over a storage error would
      // misreport what the user can plainly feel.
      this.deps.log?.(`could not persist rumble intensity: ${e}`);
    }

    const info = await this.getInfo();
    this.deps.onChange?.(info);
    return { success: true, info };
  }

  /** Re-run detection — for the UI's retry button after un-blacklisting. */
  async rescan(): Promise<RumbleInfo> {
    // Through the scanner, not scan() directly: calling scan() left the
    // scanner's `found` flag false, so its 30s interval kept polling after a
    // successful manual rescan and eventually re-fired onFound — an extra
    // sysfs write and an extra change event out of nowhere.
    if (this.scanner) await this.scanner.rescan();
    else await this.scan();
    const info = await this.getInfo();
    this.deps.onChange?.(info);
    return info;
  }
}
