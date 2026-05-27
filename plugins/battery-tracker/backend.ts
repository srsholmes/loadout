import type { PluginBackend, EmitPayload } from "@loadout/types";
import { readdir } from "node:fs/promises";

interface BatteryInfo {
  percentage: number;
  status: string;
  powerWatts: number;
  voltage: number;
  energyNowWh: number;
  energyFullWh: number;
  energyFullDesignWh: number;
  healthPercent: number;
  timeRemainingMinutes: number | null;
  timeRemainingFormatted: string;
}

interface HistoryEntry {
  timestamp: number;
  percentage: number;
  powerWatts: number;
  status: string;
}

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

  private updateInterval?: Timer;
  private history: HistoryEntry[] = [];
  private batteryPath: string | null = null;
  private tickCount = 0;

  async onLoad(): Promise<void> {
    console.log("[battery-tracker] Plugin loaded");
    this.batteryPath = await this.findBatteryPath();

    if (!this.batteryPath) {
      console.warn("[battery-tracker] No battery found in /sys/class/power_supply/");
      return;
    }

    console.log(`[battery-tracker] Using battery at ${this.batteryPath}`);

    // Take an initial history reading
    await this.recordHistory();

    // Emit battery updates every 10 seconds. Every 6th tick (60s) we
    // also record history — one timer instead of two avoids drift.
    this.updateInterval = setInterval(async () => {
      try {
        const info = await this.readBattery();
        this.emit?.({ event: "batteryUpdate", data: info });
      } catch (e) {
        console.error("[battery-tracker] Update error:", e);
      }
      this.tickCount++;
      if (this.tickCount % HISTORY_EVERY_N_TICKS === 0) {
        await this.recordHistory();
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
  private async findBatteryPath(): Promise<string | null> {
    try {
      const entries = await readdir(POWER_SUPPLY_PATH);
      const candidates: { path: string; score: number; name: string }[] = [];

      for (const entry of entries) {
        const base = `${POWER_SUPPLY_PATH}/${entry}`;
        try {
          const type = await this.readSysfs(`${base}/type`);
          if (type !== "Battery") continue;
          // Must have a capacity file to be usable.
          await this.readSysfs(`${base}/capacity`);

          let score = 10;
          // Device-scoped entries are peripherals — heavy penalty.
          const scope = await this.readSysfs(`${base}/scope`).catch(() => "");
          if (scope === "Device") score -= 100;
          // HID prefix is the kernel's convention for peripheral
          // batteries when scope isn't exposed — still a strong signal.
          if (entry.startsWith("hid-")) score -= 50;
          // A system battery almost always exposes energy_full_design
          // (or charge_full_design); peripherals usually don't.
          const hasDesign =
            (await this.readSysfs(`${base}/energy_full_design`).catch(() => "")) !== "" ||
            (await this.readSysfs(`${base}/charge_full_design`).catch(() => "")) !== "";
          if (hasDesign) score += 5;

          candidates.push({ path: base, score, name: entry });
        } catch {
          /* not readable / not a battery — skip */
        }
      }

      if (candidates.length === 0) return null;
      candidates.sort((a, b) => b.score - a.score);
      const picked = candidates[0];
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
  private async readSysfs(path: string): Promise<string> {
    const file = Bun.file(path);
    const text = await file.text();
    return text.trim();
  }

  /** Read a sysfs file as a number, return 0 if missing */
  private async readSysfsNumber(path: string): Promise<number> {
    try {
      const val = await this.readSysfs(path);
      const num = parseInt(val, 10);
      return isNaN(num) ? 0 : num;
    } catch {
      return 0;
    }
  }

  /** Read all battery info from sysfs */
  private async readBattery(): Promise<BatteryInfo> {
    const base = this.batteryPath!;

    const [percentage, statusRaw, powerNowMicro, voltageNowMicro, energyNowMicro, energyFullMicro, energyFullDesignMicro] =
      await Promise.all([
        this.readSysfsNumber(`${base}/capacity`),
        this.readSysfs(`${base}/status`).catch(() => "Unknown"),
        this.readSysfsNumber(`${base}/power_now`),
        this.readSysfsNumber(`${base}/voltage_now`),
        this.readSysfsNumber(`${base}/energy_now`),
        this.readSysfsNumber(`${base}/energy_full`),
        this.readSysfsNumber(`${base}/energy_full_design`),
      ]);

    // Convert from microwatts/microvolts/microwatt-hours to standard units
    const powerWatts = powerNowMicro / 1_000_000;
    const voltage = voltageNowMicro / 1_000_000;
    const energyNowWh = energyNowMicro / 1_000_000;
    const energyFullWh = energyFullMicro / 1_000_000;
    const energyFullDesignWh = energyFullDesignMicro / 1_000_000;

    // Battery health: current full capacity vs original design capacity
    const healthPercent = energyFullDesignWh > 0
      ? Math.round((energyFullWh / energyFullDesignWh) * 100)
      : 100;

    // Estimate time remaining
    let timeRemainingMinutes: number | null = null;
    let timeRemainingFormatted = "--";

    const status = statusRaw;

    if (powerWatts > 0) {
      if (status === "Discharging") {
        // Time until empty: energy remaining / power draw
        const hoursRemaining = energyNowWh / powerWatts;
        timeRemainingMinutes = Math.round(hoursRemaining * 60);
      } else if (status === "Charging") {
        // Time until full: energy deficit / charge rate
        const energyDeficit = energyFullWh - energyNowWh;
        if (energyDeficit > 0) {
          const hoursRemaining = energyDeficit / powerWatts;
          timeRemainingMinutes = Math.round(hoursRemaining * 60);
        } else {
          timeRemainingMinutes = 0;
        }
      }
    }

    if (timeRemainingMinutes !== null) {
      if (timeRemainingMinutes <= 0) {
        timeRemainingFormatted = status === "Full" ? "Full" : "0m";
      } else {
        const hours = Math.floor(timeRemainingMinutes / 60);
        const mins = timeRemainingMinutes % 60;
        timeRemainingFormatted = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
      }
    }

    if (status === "Full") {
      timeRemainingFormatted = "Full";
    }

    return {
      percentage,
      status,
      powerWatts: Math.round(powerWatts * 100) / 100,
      voltage: Math.round(voltage * 100) / 100,
      energyNowWh: Math.round(energyNowWh * 100) / 100,
      energyFullWh: Math.round(energyFullWh * 100) / 100,
      energyFullDesignWh: Math.round(energyFullDesignWh * 100) / 100,
      healthPercent,
      timeRemainingMinutes,
      timeRemainingFormatted,
    };
  }

  /** Record a history entry */
  private async recordHistory(): Promise<void> {
    if (!this.batteryPath) return;
    try {
      const info = await this.readBattery();
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
    return this.readBattery();
  }

  /** RPC: Get charge history buffer */
  async getHistory(): Promise<HistoryEntry[]> {
    return this.history;
  }
}
