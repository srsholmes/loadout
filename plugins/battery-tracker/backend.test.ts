import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import type { EmitPayload } from "@loadout/types";
import * as fsPromises from "node:fs/promises";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// NOTE: We use spyOn (not mock.module) for node:fs/promises because
// mock.module leaks state across files in a single bun test process.
// See docs/test-mock-contamination.md and PLAYBOOK.md for details.
// ---------------------------------------------------------------------------

import BatteryTrackerBackend from "./backend";

// ---------------------------------------------------------------------------
// Test-only types. The backend's BatteryInfo + history shape aren't exported
// from backend.ts — they come from lib/battery.ts. Mirror just the fields
// tests assert on so each cast is named rather than `as any`.
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
  updateInterval?: ReturnType<typeof setInterval> | undefined;
  batteryPath: string | null;
  _recordHistory(): Promise<void>;
  _findBatteryPath(): Promise<string | null>;
};
const internals = (b: BatteryTrackerBackend): BatteryBackendInternals =>
  b as unknown as BatteryBackendInternals;

/** Narrow getBatteryInfo()'s union return to the non-error branch. */
const asBattery = (x: { error?: string } | BatteryInfoLike): BatteryInfoLike =>
  x as BatteryInfoLike;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Updates the readFile spy to simulate a set of sysfs files.
 * Must be called after beforeEach sets up the initial spy.
 *
 * The backend uses `readFile(path, "utf8")` (not Bun.file) so we spy
 * on node:fs/promises directly.
 */
function mockSysfs(sysfsFiles: Map<string, string>) {
  // Re-use the existing spy by updating its implementation (avoid creating
  // a second spy on the same property — that breaks mockRestore chaining).
  (fsPromises.readFile as ReturnType<typeof spyOn>).mockImplementation(
    (path: unknown, _opts?: unknown): Promise<string> => {
      const p = path as string;
      if (sysfsFiles.has(p)) return Promise.resolve(sysfsFiles.get(p)!);
      return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    },
  );
}

function makeSysfsMap(base: string, sysfs: Record<string, string>): Map<string, string> {
  const m = new Map<string, string>();
  for (const [key, val] of Object.entries(sysfs)) {
    m.set(`${base}/${key}`, val);
  }
  return m;
}

describe("BatteryTrackerBackend", () => {
  let backend: BatteryTrackerBackend;
  let emittedEvents: EmitPayload[];
  let readdirSpy: ReturnType<typeof spyOn>;
  let readFileSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    backend = new BatteryTrackerBackend();
    emittedEvents = [];
    backend.emit = (payload: EmitPayload) => emittedEvents.push(payload);

    // Default: empty power_supply directory
    readdirSpy = spyOn(fsPromises, "readdir").mockImplementation(() =>
      Promise.resolve([] as unknown as string[]),
    );
    readFileSpy = spyOn(fsPromises, "readFile").mockImplementation(
      (_path: unknown, _opts?: unknown): Promise<string> =>
        Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    );
    // readFileSpy starts as ENOENT-by-default; individual tests call
    // mockSysfs() to configure the paths they need.
  });

  afterEach(() => {
    clearInterval(internals(backend).updateInterval);
    readdirSpy.mockRestore();
    readFileSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // getBatteryInfo — no battery
  // -------------------------------------------------------------------------

  describe("getBatteryInfo()", () => {
    it("returns error when no battery is detected", async () => {
      // batteryPath is null by default (no onLoad called)
      const result = await backend.getBatteryInfo();
      expect(result).toEqual({ error: "No battery detected" });
    });
  });

  // -------------------------------------------------------------------------
  // readBattery — sysfs parsing (via getBatteryInfo)
  // -------------------------------------------------------------------------

  describe("_readBattery() via getBatteryInfo()", () => {
    function setupBattery(sysfs: Record<string, string>) {
      const base = "/sys/class/power_supply/BAT0";
      internals(backend).batteryPath = base;
      mockSysfs(makeSysfsMap(base, sysfs));
    }

    it("parses a normal discharging battery state", async () => {
      setupBattery({
        capacity: "75",
        status: "Discharging",
        power_now: "15000000",          // 15 W in microwatts
        voltage_now: "7800000",         // 7.8 V in microvolts
        energy_now: "30000000",         // 30 Wh in microwatt-hours
        energy_full: "40000000",        // 40 Wh
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
      // Health: 40/45 = 88.89% → rounded to 89
      expect(battery.healthPercent).toBe(89);
      // Time remaining: 30 Wh / 15 W = 2 hours = 120 minutes
      expect(battery.timeRemainingMinutes).toBe(120);
      expect(battery.timeRemainingFormatted).toBe("2h 0m");
    });

    it("parses a charging battery state", async () => {
      setupBattery({
        capacity: "50",
        status: "Charging",
        power_now: "20000000",  // 20 W
        voltage_now: "8000000", // 8 V
        energy_now: "20000000", // 20 Wh
        energy_full: "40000000", // 40 Wh
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
      // Missing power/energy files default to 0
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
        energy_full: "35000000",          // 35 Wh
        energy_full_design: "50000000",   // 50 Wh
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
        power_now: "20000000", // 20 W
        voltage_now: "7500000",
        energy_now: "5000000",   // 5 Wh
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

  // -------------------------------------------------------------------------
  // getHistory — buffer management
  // -------------------------------------------------------------------------

  describe("getHistory()", () => {
    it("returns empty history initially", async () => {
      const history = await backend.getHistory();
      expect(history).toEqual([]);
    });

    it("accumulates history entries via _recordHistory()", async () => {
      const base = "/sys/class/power_supply/BAT0";
      internals(backend).batteryPath = base;
      mockSysfs(
        makeSysfsMap(base, {
          capacity: "80",
          status: "Discharging",
          power_now: "10000000",
          voltage_now: "7500000",
          energy_now: "30000000",
          energy_full: "40000000",
          energy_full_design: "40000000",
        }),
      );

      await internals(backend)._recordHistory();
      await internals(backend)._recordHistory();

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
      mockSysfs(
        makeSysfsMap(base, {
          capacity: "50",
          status: "Discharging",
          power_now: "10000000",
          voltage_now: "7500000",
          energy_now: "20000000",
          energy_full: "40000000",
          energy_full_design: "40000000",
        }),
      );

      for (let i = 0; i < 65; i++) {
        await internals(backend)._recordHistory();
      }

      const history = await backend.getHistory();
      expect(history).toHaveLength(60);
    });

    it("does nothing when batteryPath is null", async () => {
      internals(backend).batteryPath = null;
      await internals(backend)._recordHistory();
      const history = await backend.getHistory();
      expect(history).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // _findBatteryPath
  // -------------------------------------------------------------------------

  describe("_findBatteryPath()", () => {
    it("returns null when power_supply directory is empty", async () => {
      readdirSpy.mockImplementation(() => Promise.resolve([]));
      mockSysfs(new Map());

      const result = await internals(backend)._findBatteryPath();
      expect(result).toBeNull();
    });

    it("returns null when no Battery type entries exist", async () => {
      readdirSpy.mockImplementation(() => Promise.resolve(["AC0"]));
      mockSysfs(
        new Map([
          ["/sys/class/power_supply/AC0/type", "Mains"],
        ]),
      );

      const result = await internals(backend)._findBatteryPath();
      expect(result).toBeNull();
    });

    it("finds the first battery with a capacity file", async () => {
      readdirSpy.mockImplementation(() => Promise.resolve(["AC0", "BAT0", "BAT1"]));
      mockSysfs(
        new Map([
          ["/sys/class/power_supply/AC0/type", "Mains"],
          ["/sys/class/power_supply/BAT0/type", "Battery"],
          ["/sys/class/power_supply/BAT0/capacity", "85"],
          ["/sys/class/power_supply/BAT1/type", "Battery"],
          ["/sys/class/power_supply/BAT1/capacity", "90"],
        ]),
      );

      const result = await internals(backend)._findBatteryPath();
      expect(result).toBe("/sys/class/power_supply/BAT0");
    });

    it("returns null when readdir throws", async () => {
      readdirSpy.mockImplementation(() => Promise.reject(new Error("ENOENT")));
      const result = await internals(backend)._findBatteryPath();
      expect(result).toBeNull();
    });

    it("prefers the system battery over a HID peripheral", async () => {
      // hid- first to simulate inode order on the OXP APEX where the Magic
      // Keyboard's HID battery sorted before BATT.
      readdirSpy.mockImplementation(() =>
        Promise.resolve(["hid-ABCD-battery", "BATT", "ACAD"]),
      );
      mockSysfs(
        new Map([
          ["/sys/class/power_supply/hid-ABCD-battery/type", "Battery"],
          ["/sys/class/power_supply/hid-ABCD-battery/capacity", "100"],
          ["/sys/class/power_supply/hid-ABCD-battery/scope", "Device"],
          ["/sys/class/power_supply/BATT/type", "Battery"],
          ["/sys/class/power_supply/BATT/capacity", "91"],
          ["/sys/class/power_supply/BATT/energy_full_design", "50000000"],
          ["/sys/class/power_supply/ACAD/type", "Mains"],
        ]),
      );

      const result = await internals(backend)._findBatteryPath();
      expect(result).toBe("/sys/class/power_supply/BATT");
    });

    it("falls back to a Device-scope battery when that's the only option", async () => {
      // If a user only has a HID battery, don't refuse to work.
      readdirSpy.mockImplementation(() => Promise.resolve(["hid-ABCD-battery"]));
      mockSysfs(
        new Map([
          ["/sys/class/power_supply/hid-ABCD-battery/type", "Battery"],
          ["/sys/class/power_supply/hid-ABCD-battery/capacity", "80"],
          ["/sys/class/power_supply/hid-ABCD-battery/scope", "Device"],
        ]),
      );

      const result = await internals(backend)._findBatteryPath();
      expect(result).toBe("/sys/class/power_supply/hid-ABCD-battery");
    });
  });

  // -------------------------------------------------------------------------
  // Charge control (charge limit + bypass charging)
  //
  // These go through onLoad() so detection, restore, and the RPCs are
  // exercised together. Bun.write is spied (sysfs writes would need root);
  // plugin storage is redirected to a temp dir via XDG_CONFIG_HOME so
  // persistence uses the real read/write path.
  // -------------------------------------------------------------------------

  describe("charge control", () => {
    const base = "/sys/class/power_supply/BATT";
    let bunWriteSpy: ReturnType<typeof spyOn>;
    let tmpDir: string;
    let prevXdg: string | undefined;

    beforeEach(() => {
      bunWriteSpy = spyOn(Bun, "write").mockImplementation(
        () => Promise.resolve(1) as ReturnType<typeof Bun.write>,
      );
      tmpDir = mkdtempSync(join(tmpdir(), "battery-charge-test-"));
      prevXdg = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = tmpDir;
    });

    afterEach(() => {
      bunWriteSpy.mockRestore();
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
      rmSync(tmpDir, { recursive: true, force: true });
    });

    /** Mock a system battery at BATT plus any extra sysfs entries. */
    function setupBattery(
      extra: Record<string, string>,
      absolute: Record<string, string> = {},
    ) {
      readdirSpy.mockImplementation(() => Promise.resolve(["BATT"] as unknown as string[]));
      const map = makeSysfsMap(base, {
        type: "Battery",
        capacity: "62",
        status: "Full",
        ...extra,
      });
      for (const [path, value] of Object.entries(absolute)) {
        map.set(path, value);
      }
      mockSysfs(map);
    }

    const storagePath = () => join(tmpDir, "loadout", "plugins", "battery-tracker.json");
    const readStorage = () => JSON.parse(readFileSync(storagePath(), "utf8"));

    it("detects charge limit and charge_behaviour support", async () => {
      setupBattery({
        charge_control_end_threshold: "62",
        charge_behaviour: "[auto] inhibit-charge inhibit-charge-awake",
      });
      await backend.onLoad();

      const info = await backend.getChargeControl();
      expect(info.supportsChargeLimit).toBe(true);
      expect(info.chargeLimitPercent).toBe(62);
      expect(info.supportsBypass).toBe(true);
      expect(info.supportsBypassAwake).toBe(true);
      expect(info.bypassMode).toBe("disabled");
    });

    it("reports an active bypass mode from charge_behaviour", async () => {
      setupBattery({
        charge_behaviour: "auto [inhibit-charge] inhibit-charge-awake",
      });
      await backend.onLoad();

      const info = await backend.getChargeControl();
      expect(info.bypassMode).toBe("always");
    });

    it("reports no support when the attrs are absent", async () => {
      setupBattery({});
      await backend.onLoad();

      const info = await backend.getChargeControl();
      expect(info.supportsChargeLimit).toBe(false);
      expect(info.supportsBypass).toBe(false);
      expect(info.chargeLimitPercent).toBeNull();
      expect(info.bypassMode).toBe("disabled");
    });

    it("does not claim bypass when charge_behaviour offers no inhibit variant", async () => {
      // A driver that only supports force-discharge is not a bypass control;
      // advertising it would show a control whose writes always fail.
      setupBattery({ charge_behaviour: "[auto] force-discharge" });
      await backend.onLoad();

      const info = await backend.getChargeControl();
      expect(info.supportsBypass).toBe(false);
      expect(info.supportsBypassAwake).toBe(false);
    });

    it("treats a threshold of 100 as no limit", async () => {
      setupBattery({ charge_control_end_threshold: "100" });
      await backend.onLoad();

      const info = await backend.getChargeControl();
      expect(info.supportsChargeLimit).toBe(true);
      expect(info.chargeLimitPercent).toBeNull();
    });

    it("accepts legacy charge_type bypass on OneXPlayer hardware only", async () => {
      setupBattery(
        { charge_type: "Standard" },
        { "/sys/devices/virtual/dmi/id/sys_vendor": "ONE-NETBOOK Technology Co., Ltd." },
      );
      await backend.onLoad();
      const info = await backend.getChargeControl();
      expect(info.supportsBypass).toBe(true);
      expect(info.supportsBypassAwake).toBe(true);
    });

    it("refuses charge_type bypass on non-OneXPlayer hardware", async () => {
      // Other vendors use charge_type for Fast/Trickle, not bypass.
      setupBattery(
        { charge_type: "Fast" },
        { "/sys/devices/virtual/dmi/id/sys_vendor": "ASUSTeK COMPUTER INC." },
      );
      await backend.onLoad();
      const info = await backend.getChargeControl();
      expect(info.supportsBypass).toBe(false);
    });

    it("setChargeLimit writes sysfs and persists the value", async () => {
      setupBattery({ charge_control_end_threshold: "100" });
      await backend.onLoad();

      const result = await backend.setChargeLimit(80);
      expect(result.success).toBe(true);
      expect(bunWriteSpy).toHaveBeenCalledWith(`${base}/charge_control_end_threshold`, "80");
      expect(readStorage().chargeLimitPercent).toBe(80);
    });

    it("setChargeLimit(null) clears the limit by writing 100", async () => {
      setupBattery({ charge_control_end_threshold: "80" });
      await backend.onLoad();

      const result = await backend.setChargeLimit(null);
      expect(result.success).toBe(true);
      expect(bunWriteSpy).toHaveBeenCalledWith(`${base}/charge_control_end_threshold`, "100");
      expect(readStorage().chargeLimitPercent).toBeNull();
    });

    it("setChargeLimit rejects out-of-range and non-integer values", async () => {
      setupBattery({ charge_control_end_threshold: "100" });
      await backend.onLoad();

      expect((await backend.setChargeLimit(45)).success).toBe(false);
      expect((await backend.setChargeLimit(110)).success).toBe(false);
      expect((await backend.setChargeLimit(72.5)).success).toBe(false);
      expect(bunWriteSpy).not.toHaveBeenCalled();
    });

    it("setChargeLimit fails cleanly when unsupported", async () => {
      setupBattery({});
      await backend.onLoad();

      const result = await backend.setChargeLimit(80);
      expect(result.success).toBe(false);
      expect(result.error).toContain("not supported");
    });

    it("setBypassMode maps modes to charge_behaviour values and persists", async () => {
      setupBattery({
        charge_behaviour: "[auto] inhibit-charge inhibit-charge-awake",
      });
      await backend.onLoad();

      const result = await backend.setBypassMode("awake");
      expect(result.success).toBe(true);
      expect(bunWriteSpy).toHaveBeenCalledWith(`${base}/charge_behaviour`, "inhibit-charge-awake");
      expect(readStorage().bypassMode).toBe("awake");
    });

    it("setBypassMode rejects the awake mode when the kernel lacks it", async () => {
      setupBattery({ charge_behaviour: "[auto] inhibit-charge" });
      await backend.onLoad();

      const result = await backend.setBypassMode("awake");
      expect(result.success).toBe(false);
      expect((await backend.setBypassMode("always")).success).toBe(true);
    });

    it("restores saved settings at load", async () => {
      setupBattery(
        {
          charge_control_end_threshold: "100",
          charge_behaviour: "[auto] inhibit-charge inhibit-charge-awake",
        },
        {
          [join(tmpDir, "loadout", "plugins", "battery-tracker.json")]: JSON.stringify({
            chargeLimitPercent: 85,
            bypassMode: "always",
          }),
        },
      );
      await backend.onLoad();

      expect(bunWriteSpy).toHaveBeenCalledWith(`${base}/charge_control_end_threshold`, "85");
      expect(bunWriteSpy).toHaveBeenCalledWith(`${base}/charge_behaviour`, "inhibit-charge");
    });

    it("writes nothing at load when saved settings are disabled", async () => {
      // Don't-clobber rule: a user managing charging with another tool
      // must not have their setting overwritten at our startup.
      setupBattery(
        {
          charge_control_end_threshold: "77",
          charge_behaviour: "[inhibit-charge] auto",
        },
        {
          [join(tmpDir, "loadout", "plugins", "battery-tracker.json")]: JSON.stringify({
            chargeLimitPercent: null,
            bypassMode: "disabled",
          }),
        },
      );
      await backend.onLoad();

      expect(bunWriteSpy).not.toHaveBeenCalled();
    });
  });
});
