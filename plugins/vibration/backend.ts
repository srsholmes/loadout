/**
 * Vibration — global rumble intensity for OneXPlayer-family handhelds.
 *
 * The kernel's `hid-oxp` driver exposes `rumble_intensity` (RW u8) and
 * `rumble_intensity_range` (RO, "0-5") on the gamepad's HID device. That is
 * the whole interface: one global attenuator on the MCU, no force feedback,
 * no per-motor split.
 *
 * ## Detection is by attribute, not by device
 *
 * We glob `/sys/bus/hid/devices/*&#47;rumble_intensity` rather than matching DMI
 * or VID/PID. The attribute exists on every gen-2 device the driver binds —
 * X1 mini series, G1 A/i, AOKZOE A1X, Apex — so a device table would be a
 * list to maintain and a way to exclude hardware that works. If the file is
 * there, the control works.
 *
 * ## The stored value is the source of truth
 *
 * `rumble_intensity_show` returns a driver-side cache initialised to 5 in
 * `oxp_cfg_probe` — it never queries the MCU. So a read after boot says 5
 * whatever the firmware is doing, and the value we persisted is the better
 * record of what the user chose. Same posture as battery-tracker's charge
 * limit, for the same reason.
 *
 * We do re-apply on load, because that driver-side cache resets on every
 * module load. No wake listener is needed: the driver re-applies its cache
 * after resume itself (it watches for the MCU's post-wake status event and
 * requeues its init work).
 */

import type { PluginBackend, EmitPayload, PluginLogger, RetryScanner } from "@loadout/types";
import { createRetryScanner } from "@loadout/types";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readPluginStorage, mutatePluginStorage } from "@loadout/plugin-storage";
import {
  FALLBACK_RANGE,
  clampIntensity,
  isValidIntensity,
  parseIntensityRange,
  type IntensityRange,
} from "./lib/rumble";

const PLUGIN_ID = "vibration";
const HID_DEVICES = "/sys/bus/hid/devices";
const INTENSITY_ATTR = "rumble_intensity";
const RANGE_ATTR = "rumble_intensity_range";

interface VibrationStorage {
  /** The level the user chose. Re-applied on load; absent means never set. */
  intensity?: number;
}

export interface VibrationInfo {
  /** A device exposing the attribute was found. */
  available: boolean;
  /** The HID device directory, for diagnostics. */
  devicePath: string | null;
  /** Bounds the driver accepts. */
  min: number;
  max: number;
  /** The level in effect: what we persisted if we have it, else what the
   *  driver reports. */
  intensity: number | null;
  /** Where `intensity` came from — the driver's cache is unreliable after a
   *  module reload, so the UI can say which it is. */
  source: "stored" | "driver" | null;
}

export default class VibrationBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;
  log?: PluginLogger;

  private devicePath: string | null = null;
  private range: IntensityRange = FALLBACK_RANGE;
  private scanner?: RetryScanner;

  async onLoad(): Promise<void> {
    // The driver binds on USB enumeration and can lose the race with plugin
    // load — and a user who has just un-blacklisted it only gets the module
    // at the next boot. Retrying costs one readdir every 30s until found.
    this.scanner = createRetryScanner({
      label: PLUGIN_ID,
      scan: () => this.scan(),
      intervalMs: 30_000,
      onFound: async () => {
        await this.restore();
        this.emit?.({ event: "hardwareChanged", data: await this.getInfo() });
      },
    });
    await this.scanner.start();
  }

  async onUnload(): Promise<void> {
    this.scanner?.stop();
  }

  /** Find the first HID device carrying the attribute. */
  private async scan(): Promise<boolean> {
    let entries: string[];
    try {
      entries = await readdir(HID_DEVICES);
    } catch {
      // No HID bus at all (container, unusual kernel) — not an error worth
      // logging every 30s.
      return false;
    }

    for (const entry of entries) {
      const dir = join(HID_DEVICES, entry);
      const raw = await this.readAttr(join(dir, INTENSITY_ATTR));
      if (raw === null) continue;

      this.devicePath = dir;
      this.range =
        parseIntensityRange(await this.readAttr(join(dir, RANGE_ATTR))) ?? FALLBACK_RANGE;
      this.log?.info(
        `[${PLUGIN_ID}] rumble control at ${dir} (range ${this.range.min}-${this.range.max})`,
      );
      return true;
    }
    return false;
  }

  private async readAttr(path: string): Promise<string | null> {
    try {
      return await readFile(path, "utf8");
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
    const stored = await readPluginStorage<VibrationStorage>(PLUGIN_ID);
    if (!isValidIntensity(stored.intensity, this.range)) return;

    const result = await this.write(stored.intensity);
    if (result.success) {
      this.log?.info(`[${PLUGIN_ID}] restored intensity ${stored.intensity}`);
    } else {
      this.log?.warn(`[${PLUGIN_ID}] could not restore intensity: ${result.error}`);
    }
  }

  private async write(value: number): Promise<{ success: boolean; error?: string }> {
    if (!this.devicePath) {
      return { success: false, error: "No device with rumble control." };
    }
    try {
      // The backend runs as root, and the kernel serialises the underlying
      // HID report under its own mutex — no write-gap pacing needed here,
      // unlike the raw hidraw path in rgb-control.
      await writeFile(join(this.devicePath, INTENSITY_ATTR), String(value));
      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  /** Current state for the UI. */
  async getInfo(): Promise<VibrationInfo> {
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

    const stored = await readPluginStorage<VibrationStorage>(PLUGIN_ID);
    if (isValidIntensity(stored.intensity, this.range)) {
      return {
        available: true,
        devicePath: this.devicePath,
        min: this.range.min,
        max: this.range.max,
        intensity: stored.intensity,
        source: "stored",
      };
    }

    // Nothing stored: report what the driver says, flagged as such. Its cache
    // is initialised to the maximum on probe, so this is "what it would do",
    // not necessarily what the MCU is doing.
    const raw = await this.readAttr(join(this.devicePath, INTENSITY_ATTR));
    const parsed = raw === null ? NaN : Number(raw.trim());
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
  ): Promise<{ success: boolean; error?: string; info?: VibrationInfo }> {
    if (!this.devicePath) {
      return { success: false, error: "No device with rumble control." };
    }
    const level = clampIntensity(value, this.range);

    const result = await this.write(level);
    if (!result.success) return result;

    try {
      await mutatePluginStorage<VibrationStorage>(PLUGIN_ID, (existing) => ({
        ...existing,
        intensity: level,
      }));
    } catch (e) {
      // The hardware took it; failing the call over a storage error would
      // misreport what the user can plainly feel.
      this.log?.warn(`[${PLUGIN_ID}] could not persist intensity: ${e}`);
    }

    const info = await this.getInfo();
    this.emit?.({ event: "hardwareChanged", data: info });
    return { success: true, info };
  }

  /** Re-run detection — for the UI's retry button after un-blacklisting. */
  async rescan(): Promise<VibrationInfo> {
    await this.scan();
    const info = await this.getInfo();
    this.emit?.({ event: "hardwareChanged", data: info });
    return info;
  }
}
