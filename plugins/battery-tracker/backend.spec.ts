import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import type { EmitPayload } from "@loadout/types";
import type { BunFile } from "bun";

// Mock node:fs/promises
const mockReaddir = mock(() => Promise.resolve([] as string[]));
mock.module("node:fs/promises", () => ({
  readdir: mockReaddir,
}));

import BatteryTrackerBackend from "./backend";

// ---------------------------------------------------------------------------
// Test-only types. The backend's BatteryInfo + history shape aren't exported,
// so we mirror just the fields tests assert on. This replaces `info as any`
// with a named alias and lets each `(backend as any)` callsite share one
// loose surface for the private fields/methods we poke at.
// ---------------------------------------------------------------------------

type BatteryInfoLike = {
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
};

type BatteryBackendInternals = {
  updateInterval?: ReturnType<typeof setInterval>;
  historyInterval?: ReturnType<typeof setInterval>;
  batteryPath: string | null;
  recordHistory(): Promise<void>;
  findBatteryPath(): Promise<string | null>;
};
const internals = (b: BatteryTrackerBackend): BatteryBackendInternals =>
  b as unknown as BatteryBackendInternals;

/** Convenience: narrow `getBatteryInfo()`'s union to its non-error branch. */
const asBattery = (x: { error?: string } | BatteryInfoLike): BatteryInfoLike =>
  x as BatteryInfoLike;

describe("BatteryTrackerBackend", () => {
  let backend: BatteryTrackerBackend;
  let emittedEvents: EmitPayload[];
  let originalBunFile: typeof Bun.file;

  beforeEach(() => {
    backend = new BatteryTrackerBackend();
    emittedEvents = [];
    backend.emit = (payload: EmitPayload) => {
      emittedEvents.push(payload);
    };
    mockReaddir.mockClear();
    originalBunFile = Bun.file;

    // Clear intervals that onLoad might set
    clearInterval(internals(backend).updateInterval);
    clearInterval(internals(backend).historyInterval);
  });

  afterEach(() => {
    Bun.file = originalBunFile;
    clearInterval(internals(backend).updateInterval);
    clearInterval(internals(backend).historyInterval);
  });

  /**
   * Helper: sets up Bun.file to simulate sysfs files for a battery.
   * @param sysfsFiles  Map of absolute path -> content string
   */
  function mockSysfs(sysfsFiles: Map<string, string>) {
    type BunFileLike = Pick<BunFile, "exists" | "text" | "size">;
    Bun.file = ((path: string) =>
      ({
        exists: () => Promise.resolve(sysfsFiles.has(path)),
        text: () =>
          sysfsFiles.has(path)
            ? Promise.resolve(sysfsFiles.get(path)!)
            : Promise.reject(new Error("ENOENT")),
        size: 0,
      }) as BunFileLike as BunFile) as typeof Bun.file;
  }

  // ---------------------------------------------------------------------------
  // getBatteryInfo — no battery
  // ---------------------------------------------------------------------------

  describe("getBatteryInfo()", () => {
    it("returns error when no battery is detected", async () => {
      // batteryPath is null by default (no onLoad called)
      const result = await backend.getBatteryInfo();
      expect(result).toEqual({ error: "No battery detected" });
    });
  });

  // ---------------------------------------------------------------------------
  // readBattery — sysfs parsing
  // ---------------------------------------------------------------------------

  describe("readBattery() via getBatteryInfo()", () => {
    function setupBattery(sysfs: Record<string, string>) {
      const base = "/sys/class/power_supply/BAT0";
      internals(backend).batteryPath = base;

      const sysfsMap = new Map<string, string>();
      for (const [key, val] of Object.entries(sysfs)) {
        sysfsMap.set(`${base}/${key}`, val);
      }
      mockSysfs(sysfsMap);
    }

    it("parses a normal discharging battery state", async () => {
      setupBattery({
        capacity: "75",
        status: "Discharging",
        power_now: "15000000",       // 15 W in microwatts
        voltage_now: "7800000",      // 7.8 V in microvolts
        energy_now: "30000000",      // 30 Wh in microwatt-hours
        energy_full: "40000000",     // 40 Wh
        energy_full_design: "45000000", // 45 Wh
      });

      const info = await backend.getBatteryInfo();
      expect(info).not.toHaveProperty("error");

      const battery = asBattery(info);
      expect(battery.percentage).toBe(75);
      expect(battery.status).toBe("Discharging");
      expect(battery.powerWatts).toBe(15);
      expect(battery.voltage).toBe(7.8);
      expect(battery.energyNowWh).toBe(30);
      expect(battery.energyFullWh).toBe(40);
      expect(battery.energyFullDesignWh).toBe(45);

      // Health: 40/45 = 88.89% -> rounded to 89
      expect(battery.healthPercent).toBe(89);

      // Time remaining: 30 Wh / 15 W = 2 hours = 120 minutes
      expect(battery.timeRemainingMinutes).toBe(120);
      expect(battery.timeRemainingFormatted).toBe("2h 0m");
    });

    it("parses a charging battery state", async () => {
      setupBattery({
        capacity: "50",
        status: "Charging",
        power_now: "20000000",        // 20 W
        voltage_now: "8000000",       // 8 V
        energy_now: "20000000",       // 20 Wh
        energy_full: "40000000",      // 40 Wh
        energy_full_design: "40000000",
      });

      const info = await backend.getBatteryInfo();
      const battery = asBattery(info);
      expect(battery.status).toBe("Charging");

      // Time to full: (40-20) Wh / 20 W = 1 hour = 60 minutes
      expect(battery.timeRemainingMinutes).toBe(60);
      expect(battery.timeRemainingFormatted).toBe("1h 0m");
    });

    it("handles Full status", async () => {
      setupBattery({
        capacity: "100",
        status: "Full",
        power_now: "0",
        voltage_now: "8200000",
        energy_now: "40000000",
        energy_full: "40000000",
        energy_full_design: "40000000",
      });

      const info = await backend.getBatteryInfo();
      const battery = asBattery(info);
      expect(battery.status).toBe("Full");
      expect(battery.timeRemainingFormatted).toBe("Full");
    });

    it("handles missing sysfs files gracefully (returns 0)", async () => {
      const base = "/sys/class/power_supply/BAT0";
      internals(backend).batteryPath = base;

      // Only status and capacity exist; the rest will fail with ENOENT
      const sysfsMap = new Map<string, string>();
      sysfsMap.set(`${base}/capacity`, "42");
      sysfsMap.set(`${base}/status`, "Discharging");
      mockSysfs(sysfsMap);

      const info = await backend.getBatteryInfo();
      const battery = asBattery(info);
      expect(battery.percentage).toBe(42);
      expect(battery.status).toBe("Discharging");
      // Missing power/energy files should default to 0
      expect(battery.powerWatts).toBe(0);
      expect(battery.energyNowWh).toBe(0);
      // With 0 power, time remaining should be null
      expect(battery.timeRemainingMinutes).toBeNull();
      expect(battery.timeRemainingFormatted).toBe("--");
    });

    it("handles non-numeric sysfs values", async () => {
      setupBattery({
        capacity: "not-a-number",
        status: "Unknown",
        power_now: "garbage",
        voltage_now: "",
        energy_now: "abc",
        energy_full: "def",
        energy_full_design: "0",
      });

      const info = await backend.getBatteryInfo();
      const battery = asBattery(info);
      // readSysfsNumber returns 0 for NaN
      expect(battery.percentage).toBe(0);
      expect(battery.powerWatts).toBe(0);
      // healthPercent: energyFullDesignWh = 0 so formula returns 100
      expect(battery.healthPercent).toBe(100);
    });

    it("calculates health percentage correctly", async () => {
      setupBattery({
        capacity: "80",
        status: "Discharging",
        power_now: "10000000",
        voltage_now: "7500000",
        energy_now: "25000000",
        energy_full: "35000000",     // 35 Wh
        energy_full_design: "50000000", // 50 Wh
      });

      const info = await backend.getBatteryInfo();
      const battery = asBattery(info);
      // Health: 35/50 = 70%
      expect(battery.healthPercent).toBe(70);
    });

    it("formats short time remaining without hours", async () => {
      setupBattery({
        capacity: "10",
        status: "Discharging",
        power_now: "20000000",       // 20 W
        voltage_now: "7500000",
        energy_now: "5000000",       // 5 Wh
        energy_full: "40000000",
        energy_full_design: "40000000",
      });

      const info = await backend.getBatteryInfo();
      const battery = asBattery(info);
      // Time remaining: 5 Wh / 20 W = 0.25 hours = 15 minutes
      expect(battery.timeRemainingMinutes).toBe(15);
      expect(battery.timeRemainingFormatted).toBe("15m");
    });
  });

  // ---------------------------------------------------------------------------
  // getHistory — buffer management
  // ---------------------------------------------------------------------------

  describe("getHistory()", () => {
    it("returns empty history initially", async () => {
      const history = await backend.getHistory();
      expect(history).toEqual([]);
    });

    it("accumulates history entries via recordHistory()", async () => {
      const base = "/sys/class/power_supply/BAT0";
      internals(backend).batteryPath = base;

      const sysfsMap = new Map<string, string>();
      sysfsMap.set(`${base}/capacity`, "80");
      sysfsMap.set(`${base}/status`, "Discharging");
      sysfsMap.set(`${base}/power_now`, "10000000");
      sysfsMap.set(`${base}/voltage_now`, "7500000");
      sysfsMap.set(`${base}/energy_now`, "30000000");
      sysfsMap.set(`${base}/energy_full`, "40000000");
      sysfsMap.set(`${base}/energy_full_design`, "40000000");
      mockSysfs(sysfsMap);

      await internals(backend).recordHistory();
      await internals(backend).recordHistory();

      const history = await backend.getHistory();
      expect(history).toHaveLength(2);
      expect(history[0].percentage).toBe(80);
      expect(history[0].status).toBe("Discharging");
      expect(history[0].powerWatts).toBe(10);
      expect(history[0].timestamp).toBeGreaterThan(0);
    });

    it("caps history at HISTORY_MAX (60) entries", async () => {
      const base = "/sys/class/power_supply/BAT0";
      internals(backend).batteryPath = base;

      const sysfsMap = new Map<string, string>();
      sysfsMap.set(`${base}/capacity`, "50");
      sysfsMap.set(`${base}/status`, "Discharging");
      sysfsMap.set(`${base}/power_now`, "10000000");
      sysfsMap.set(`${base}/voltage_now`, "7500000");
      sysfsMap.set(`${base}/energy_now`, "20000000");
      sysfsMap.set(`${base}/energy_full`, "40000000");
      sysfsMap.set(`${base}/energy_full_design`, "40000000");
      mockSysfs(sysfsMap);

      // Record 65 entries
      for (let i = 0; i < 65; i++) {
        await internals(backend).recordHistory();
      }

      const history = await backend.getHistory();
      expect(history).toHaveLength(60);
    });

    it("does nothing when batteryPath is null", async () => {
      internals(backend).batteryPath = null;
      await internals(backend).recordHistory();
      const history = await backend.getHistory();
      expect(history).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // findBatteryPath
  // ---------------------------------------------------------------------------

  describe("findBatteryPath()", () => {
    it("returns null when power_supply directory is empty", async () => {
      mockReaddir.mockImplementation(() => Promise.resolve([]));
      mockSysfs(new Map());

      const result = await internals(backend).findBatteryPath();
      expect(result).toBeNull();
    });

    it("returns null when no Battery type entries exist", async () => {
      mockReaddir.mockImplementation(() => Promise.resolve(["AC0"]));
      const sysfsMap = new Map<string, string>();
      sysfsMap.set("/sys/class/power_supply/AC0/type", "Mains");
      mockSysfs(sysfsMap);

      const result = await internals(backend).findBatteryPath();
      expect(result).toBeNull();
    });

    it("finds the first battery with a capacity file", async () => {
      mockReaddir.mockImplementation(() =>
        Promise.resolve(["AC0", "BAT0", "BAT1"]),
      );
      const sysfsMap = new Map<string, string>();
      sysfsMap.set("/sys/class/power_supply/AC0/type", "Mains");
      sysfsMap.set("/sys/class/power_supply/BAT0/type", "Battery");
      sysfsMap.set("/sys/class/power_supply/BAT0/capacity", "85");
      sysfsMap.set("/sys/class/power_supply/BAT1/type", "Battery");
      sysfsMap.set("/sys/class/power_supply/BAT1/capacity", "90");
      mockSysfs(sysfsMap);

      const result = await internals(backend).findBatteryPath();
      expect(result).toBe("/sys/class/power_supply/BAT0");
    });

    it("returns null when readdir throws", async () => {
      mockReaddir.mockImplementation(() =>
        Promise.reject(new Error("ENOENT")),
      );
      const result = await internals(backend).findBatteryPath();
      expect(result).toBeNull();
    });

    it("prefers the system battery over a HID peripheral", async () => {
      // readdir returns hid- first (realistic — inode order, not
      // alphabetical — and on the OXP APEX the Magic Keyboard's
      // scope=Device HID battery actually sorted first, which made
      // the overlay statusbar report the keyboard's "Charging" state
      // instead of the device's real discharge.
      mockReaddir.mockImplementation(() =>
        Promise.resolve(["hid-ABCD-battery", "BATT", "ACAD"]),
      );
      const sysfsMap = new Map<string, string>();
      sysfsMap.set("/sys/class/power_supply/hid-ABCD-battery/type", "Battery");
      sysfsMap.set("/sys/class/power_supply/hid-ABCD-battery/capacity", "100");
      sysfsMap.set("/sys/class/power_supply/hid-ABCD-battery/scope", "Device");
      sysfsMap.set("/sys/class/power_supply/BATT/type", "Battery");
      sysfsMap.set("/sys/class/power_supply/BATT/capacity", "91");
      sysfsMap.set("/sys/class/power_supply/BATT/energy_full_design", "50000000");
      sysfsMap.set("/sys/class/power_supply/ACAD/type", "Mains");
      mockSysfs(sysfsMap);

      const result = await internals(backend).findBatteryPath();
      expect(result).toBe("/sys/class/power_supply/BATT");
    });

    it("falls back to a Device-scope battery when that's the only option", async () => {
      // If a user somehow only has a HID battery, don't refuse to
      // work — just pick it with the low score.
      mockReaddir.mockImplementation(() =>
        Promise.resolve(["hid-ABCD-battery"]),
      );
      const sysfsMap = new Map<string, string>();
      sysfsMap.set("/sys/class/power_supply/hid-ABCD-battery/type", "Battery");
      sysfsMap.set("/sys/class/power_supply/hid-ABCD-battery/capacity", "80");
      sysfsMap.set("/sys/class/power_supply/hid-ABCD-battery/scope", "Device");
      mockSysfs(sysfsMap);

      const result = await internals(backend).findBatteryPath();
      expect(result).toBe("/sys/class/power_supply/hid-ABCD-battery");
    });
  });
});
