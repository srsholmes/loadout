import type { PluginBackend, EmitPayload } from "@loadout/types";
import { readFile, readdir } from "node:fs/promises";
import {
  assembleBatteryInfo,
  scoreBatteryCandidate,
  parseSysfsInt,
  type BatteryInfo,
  type HistoryEntry,
} from "./lib/battery";

const POWER_SUPPLY_PATH = "/sys/class/power_supply";
const HISTORY_MAX = 60; // 60 entries (one per minute = 60 minutes)
const UPDATE_INTERVAL_MS = 10_000; // 10 seconds
// History records every 6th update tick (60s). Audit D-018: deriving
// history cadence from the update tick eliminates the second
// setInterval — fewer timers, no risk of the two drifting under
// scheduler pressure.
const HISTORY_EVERY_N_TICKS = 6;

/**
 * Battery Tracker plugin backend.
 *
 * Reads battery data from sysfs, emits updates every 10 seconds,
 * and keeps a 60-entry history buffer for charge/discharge graphing.
 */
export default class BatteryTrackerBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;

  private updateInterval?: ReturnType<typeof setInterval>;
  private history: HistoryEntry[] = [];
  private batteryPath: string | null = null;
  private tickCount = 0;

  async onLoad(): Promise<void> {
    console.log("[battery-tracker] Plugin loaded");
    this.batteryPath = await this._findBatteryPath();

    if (!this.batteryPath) {
      console.warn("[battery-tracker] No battery found in /sys/class/power_supply/");
      return;
    }

    console.log(`[battery-tracker] Using battery at ${this.batteryPath}`);

    // Take an initial history reading
    await this._recordHistory();

    // Emit battery updates every 10 seconds. Every 6th tick (60s) we
    // also record history — one timer instead of two avoids drift.
    this.updateInterval = setInterval(async () => {
      try {
        const info = await this._readBattery();
        this.emit?.({ event: "batteryUpdate", data: info });
      } catch (e) {
        console.error("[battery-tracker] Update error:", e);
      }
      this.tickCount++;
      if (this.tickCount % HISTORY_EVERY_N_TICKS === 0) {
        await this._recordHistory();
      }
    }, UPDATE_INTERVAL_MS);
  }

  async onUnload(): Promise<void> {
    clearInterval(this.updateInterval);
    console.log("[battery-tracker] Plugin unloaded");
  }

  /**
   * Find the SYSTEM battery device in /sys/class/power_supply/.
   *
   * The naive "first type=Battery" approach picks up peripheral
   * batteries — Bluetooth keyboards, Xbox controllers, anything
   * HID-class that reports a battery — because `readdir()` returns
   * inode order, not the alphabetical order you'd expect, and
   * `hid-XXX-battery` sometimes sorts before `BATT`. Those peripherals
   * then masquerade as the device battery and their stale "Charging"
   * status leaks into the overlay.
   *
   * Two signals reliably distinguish a peripheral from the system
   * battery:
   *  - `scope=Device` is set on HID/USB peripherals (the system
   *    battery either has `scope=System` or no scope file at all,
   *    which the kernel treats as System by default).
   *  - HID sysfs entries are conventionally named `hid-*-battery`.
   *
   * We score every Battery candidate and pick the highest. A tie on
   * score falls through to readdir order, which is fine once the
   * peripherals have been scored down.
   */
  private async _findBatteryPath(): Promise<string | null> {
    try {
      const entries = await readdir(POWER_SUPPLY_PATH);
      const candidates: { path: string; score: number; name: string }[] = [];

      for (const entry of entries) {
        const base = `${POWER_SUPPLY_PATH}/${entry}`;
        try {
          const type = await this._readSysfs(`${base}/type`);
          if (type !== "Battery") continue;
          // Must have a capacity file to be usable.
          await this._readSysfs(`${base}/capacity`);

          const scope = await this._readSysfs(`${base}/scope`).catch(() => "");
          const hasDesignCapacity =
            (await this._readSysfs(`${base}/energy_full_design`).catch(() => "")) !== "" ||
            (await this._readSysfs(`${base}/charge_full_design`).catch(() => "")) !== "";

          const score = scoreBatteryCandidate({ name: entry, scope, hasDesignCapacity });
          candidates.push({ path: base, score, name: entry });
        } catch {
          /* not readable / not a battery — skip */
        }
      }

      if (candidates.length === 0) return null;
      candidates.sort((a, b) => b.score - a.score);
      // Non-empty: the length === 0 case returned above.
      const picked = candidates[0]!;
      if (candidates.length > 1) {
        console.log(
          `[battery-tracker] battery candidates: ${candidates
            .map((c) => `${c.name}(${c.score})`)
            .join(", ")} — picked ${picked.name}`,
        );
      }
      return picked.path;
    } catch (e) {
      console.error("[battery-tracker] Failed to read power_supply directory:", e);
    }
    return null;
  }

  /** Read a sysfs file and return its trimmed content */
  private async _readSysfs(path: string): Promise<string> {
    const text = await readFile(path, "utf8");
    return text.trim();
  }

  /** Read a sysfs file as a number, return 0 if missing */
  private async _readSysfsNumber(path: string): Promise<number> {
    try {
      return parseSysfsInt(await this._readSysfs(path));
    } catch {
      return 0;
    }
  }

  /** Read all battery info from sysfs */
  private async _readBattery(): Promise<BatteryInfo> {
    const base = this.batteryPath!;

    const [percentage, statusRaw, powerNowMicro, voltageNowMicro, energyNowMicro, energyFullMicro, energyFullDesignMicro] =
      await Promise.all([
        this._readSysfsNumber(`${base}/capacity`),
        this._readSysfs(`${base}/status`).catch(() => "Unknown"),
        this._readSysfsNumber(`${base}/power_now`),
        this._readSysfsNumber(`${base}/voltage_now`),
        this._readSysfsNumber(`${base}/energy_now`),
        this._readSysfsNumber(`${base}/energy_full`),
        this._readSysfsNumber(`${base}/energy_full_design`),
      ]);

    return assembleBatteryInfo({
      percentage,
      status: statusRaw,
      powerNowMicro,
      voltageNowMicro,
      energyNowMicro,
      energyFullMicro,
      energyFullDesignMicro,
    });
  }

  /** Record a history entry */
  private async _recordHistory(): Promise<void> {
    if (!this.batteryPath) return;
    try {
      const info = await this._readBattery();
      this.history.push({
        timestamp: Date.now(),
        percentage: info.percentage,
        powerWatts: info.powerWatts,
        status: info.status,
      });
      // Keep only the last HISTORY_MAX entries
      if (this.history.length > HISTORY_MAX) {
        this.history = this.history.slice(-HISTORY_MAX);
      }
    } catch (e) {
      console.error("[battery-tracker] History recording error:", e);
    }
  }

  /** RPC: Get current battery info */
  async getBatteryInfo(): Promise<BatteryInfo | { error: string }> {
    if (!this.batteryPath) {
      return { error: "No battery detected" };
    }
    return this._readBattery();
  }

  /** RPC: Get charge history buffer */
  async getHistory(): Promise<HistoryEntry[]> {
    return this.history;
  }
}
