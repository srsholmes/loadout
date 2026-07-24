import type { PluginBackend, EmitPayload } from "@loadout/types";
import { readFile, readdir } from "node:fs/promises";
import { runFull } from "@loadout/exec";
import { readPluginStorage, mutatePluginStorage } from "@loadout/plugin-storage";
import {
  assembleBatteryInfo,
  scoreBatteryCandidate,
  parseSysfsInt,
  type BatteryInfo,
  type HistoryEntry,
} from "./lib/battery";
import {
  BYPASS_MODES,
  CHARGE_LIMIT_MIN,
  CHARGE_LIMIT_MAX,
  behaviourSupportsAlways,
  behaviourSupportsAwake,
  bypassModeToSysfs,
  isValidChargeLimit,
  parseActiveEnumValue,
  sysfsToBypassMode,
  thresholdToLimitPercent,
  type BypassMechanism,
  type BypassMode,
  type ChargeControlInfo,
} from "./lib/charge-control";

const POWER_SUPPLY_PATH = "/sys/class/power_supply";
const SYS_VENDOR_PATH = "/sys/devices/virtual/dmi/id/sys_vendor";
const PLUGIN_ID = "battery-tracker";

/** Persisted user intent, reapplied at every service start (firmware may
 *  forget the threshold across reboots). */
interface ChargeControlStorage {
  chargeLimitPercent?: number | null;
  bypassMode?: BypassMode;
}
const HISTORY_MAX = 60; // 60 entries (one per minute = 60 minutes)
const UPDATE_INTERVAL_MS = 10_000; // 10 seconds
// History records every 6th update tick (60s). Audit D-018: deriving
// history cadence from the update tick eliminates the second
// setInterval — fewer timers, no risk of the two drifting under
// scheduler pressure.
const HISTORY_EVERY_N_TICKS = 6;

/**
 * Battery plugin backend.
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
  private chargeLimitPath: string | null = null;
  private bypassPath: string | null = null;
  private bypassMechanism: BypassMechanism | null = null;
  private supportsBypassAwake = false;

  async onLoad(): Promise<void> {
    console.log("[battery-tracker] Plugin loaded");
    this.batteryPath = await this._findBatteryPath();

    if (!this.batteryPath) {
      console.warn("[battery-tracker] No battery found in /sys/class/power_supply/");
      return;
    }

    console.log(`[battery-tracker] Using battery at ${this.batteryPath}`);

    await this._detectChargeControl();
    await this._restoreChargeControl();

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
      // Non-empty: the length === 0 case returned above; guard degrades identically.
      const picked = candidates[0];
      if (!picked) return null;
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
    // Every caller guards batteryPath before invoking; throwing on a null
    // path mirrors the sysfs read rejection the callers already catch.
    const base = this.batteryPath;
    if (!base) throw new Error("[battery-tracker] _readBattery called with no battery path");

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

  // -------------------------------------------------------------------------
  // Charge control (charge limit + bypass charging)
  //
  // Probe the generic power_supply attrs on whatever battery we discovered
  // (BAT0, BAT1, BATT, …) and let the kernel's vendor driver talk to the
  // EC. This keeps the code device-agnostic — no DMI matching except the
  // legacy OneXPlayer charge_type gate.
  // -------------------------------------------------------------------------

  /** Probe which charge-control attrs this battery exposes. */
  private async _detectChargeControl(): Promise<void> {
    const base = this.batteryPath;
    if (!base) return;

    const limitPath = `${base}/charge_control_end_threshold`;
    if (await this._sysfsReadable(limitPath)) {
      this.chargeLimitPath = limitPath;
    }

    const behaviourPath = `${base}/charge_behaviour`;
    const behaviourRaw = await this._readSysfs(behaviourPath).catch(() => null);
    if (behaviourRaw !== null) {
      // charge_behaviour is the modern interface, but it's only a *bypass*
      // control if it actually offers an inhibit-charge variant. A driver
      // that lists only e.g. `[auto] force-discharge` is not one — treating
      // it as such would show a control whose writes always fail. The attr
      // enumerates every value it supports, so probe the option list.
      const supportsAwake = behaviourSupportsAwake(behaviourRaw);
      if (behaviourSupportsAlways(behaviourRaw) || supportsAwake) {
        this.bypassPath = behaviourPath;
        this.bypassMechanism = "charge_behaviour";
        this.supportsBypassAwake = supportsAwake;
      }
    } else {
      // Legacy pre-oxpec kernels expose bypass through charge_type, but
      // other vendors use charge_type for unrelated concepts (Fast/Trickle),
      // so only trust it on OneXPlayer/AOKZOE hardware.
      const chargeTypePath = `${base}/charge_type`;
      if (await this._sysfsReadable(chargeTypePath)) {
        const vendor = await this._readSysfs(SYS_VENDOR_PATH).catch(() => "");
        if (vendor.includes("ONE-NETBOOK")) {
          this.bypassPath = chargeTypePath;
          this.bypassMechanism = "charge_type";
          this.supportsBypassAwake = true;
        }
      }
    }

    console.log(
      `[battery-tracker] charge control: limit=${this.chargeLimitPath !== null}, ` +
        `bypass=${this.bypassMechanism ?? "none"}, awake=${this.supportsBypassAwake}`,
    );
  }

  /**
   * Reapply the saved charge limit / bypass mode at service start —
   * firmware forgets the threshold across reboots on some devices.
   * Deliberately writes nothing when the saved setting is disabled, so a
   * user who manages charging with another tool is never clobbered.
   */
  private async _restoreChargeControl(): Promise<void> {
    const stored = await readPluginStorage<ChargeControlStorage>(PLUGIN_ID);

    const limit = stored.chargeLimitPercent;
    if (this.chargeLimitPath && typeof limit === "number" && isValidChargeLimit(limit)) {
      try {
        await this._writeSysfs(this.chargeLimitPath, String(limit));
        console.log(`[battery-tracker] restored charge limit ${limit}%`);
      } catch (e) {
        console.error("[battery-tracker] failed to restore charge limit:", e);
      }
    }

    const mode = stored.bypassMode;
    if (
      this.bypassPath &&
      this.bypassMechanism &&
      (mode === "always" || (mode === "awake" && this.supportsBypassAwake))
    ) {
      try {
        await this._writeSysfs(this.bypassPath, bypassModeToSysfs(this.bypassMechanism, mode));
        console.log(`[battery-tracker] restored bypass mode ${mode}`);
      } catch (e) {
        console.error("[battery-tracker] failed to restore bypass mode:", e);
      }
    }
  }

  /** Whether a sysfs file exists and is readable. */
  private async _sysfsReadable(path: string): Promise<boolean> {
    try {
      await readFile(path, "utf8");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Write a sysfs node. The backend runs as root (system service), so a
   * direct write succeeds; `tee` is a fallback for the rare node that
   * rejects a plain write() but accepts a fresh open via tee.
   */
  private async _writeSysfs(path: string, value: string): Promise<void> {
    try {
      await Bun.write(path, value);
      return;
    } catch {
      // fall through to tee
    }
    const { stderr, exitCode } = await runFull(["tee", path], { stdin: value });
    if (exitCode !== 0) {
      throw new Error(`Failed to write ${path}: ${stderr}`);
    }
  }

  /** RPC: capability + current state of charge limit and bypass charging. */
  async getChargeControl(): Promise<ChargeControlInfo> {
    let chargeLimitPercent: number | null = null;
    if (this.chargeLimitPath) {
      const raw = await this._readSysfs(this.chargeLimitPath).catch(() => null);
      chargeLimitPercent = thresholdToLimitPercent(raw === null ? null : parseSysfsInt(raw));
    }

    let bypassMode: BypassMode = "disabled";
    if (this.bypassPath && this.bypassMechanism) {
      const raw = await this._readSysfs(this.bypassPath).catch(() => null);
      if (raw !== null) {
        bypassMode = sysfsToBypassMode(this.bypassMechanism, parseActiveEnumValue(raw));
      }
    }

    return {
      supportsChargeLimit: this.chargeLimitPath !== null,
      chargeLimitPercent,
      supportsBypass: this.bypassPath !== null,
      supportsBypassAwake: this.supportsBypassAwake,
      bypassMode,
    };
  }

  /**
   * RPC: set (or clear, with null) the battery charge limit.
   * Persisted and reapplied at every service start.
   */
  async setChargeLimit(percent: number | null): Promise<{ success: boolean; error?: string }> {
    if (!this.chargeLimitPath) {
      return { success: false, error: "Charge limit is not supported on this device" };
    }
    if (percent !== null && !isValidChargeLimit(percent)) {
      return {
        success: false,
        error: `Charge limit must be a whole number between ${CHARGE_LIMIT_MIN} and ${CHARGE_LIMIT_MAX}`,
      };
    }
    try {
      // Clearing the limit means "charge to 100%".
      await this._writeSysfs(this.chargeLimitPath, String(percent ?? 100));
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
    await mutatePluginStorage<ChargeControlStorage>(PLUGIN_ID, (data) => ({
      ...data,
      chargeLimitPercent: percent,
    }));
    return { success: true };
  }

  /**
   * RPC: set the bypass-charging mode. "always" inhibits charging whenever
   * on AC; "awake" resumes normal charging while asleep or off (only on
   * hardware that supports it); "disabled" restores normal charging.
   */
  async setBypassMode(mode: BypassMode): Promise<{ success: boolean; error?: string }> {
    if (!this.bypassPath || !this.bypassMechanism) {
      return { success: false, error: "Bypass charging is not supported on this device" };
    }
    if (!BYPASS_MODES.includes(mode)) {
      return { success: false, error: `Unknown bypass mode: ${String(mode)}` };
    }
    if (mode === "awake" && !this.supportsBypassAwake) {
      return { success: false, error: "Bypass-while-awake is not supported on this device" };
    }
    try {
      await this._writeSysfs(this.bypassPath, bypassModeToSysfs(this.bypassMechanism, mode));
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
    await mutatePluginStorage<ChargeControlStorage>(PLUGIN_ID, (data) => ({
      ...data,
      bypassMode: mode,
    }));
    return { success: true };
  }
}
