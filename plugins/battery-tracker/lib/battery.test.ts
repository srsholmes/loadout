import { describe, it, expect } from "bun:test";
import {
  parseSysfsInt,
  microToUnit,
  round2,
  computeHealthPercent,
  computeTimeRemaining,
  formatTimeRemaining,
  assembleBatteryInfo,
  scoreBatteryCandidate,
} from "./battery";

describe("parseSysfsInt", () => {
  it("parses a normal integer string", () => {
    expect(parseSysfsInt("75")).toBe(75);
  });

  it("trims whitespace before parsing", () => {
    expect(parseSysfsInt("  42\n")).toBe(42);
  });

  it("returns 0 for non-numeric input", () => {
    expect(parseSysfsInt("garbage")).toBe(0);
    expect(parseSysfsInt("not-a-number")).toBe(0);
    expect(parseSysfsInt("")).toBe(0);
  });

  it("returns 0 for NaN", () => {
    expect(parseSysfsInt("abc")).toBe(0);
  });
});

describe("microToUnit", () => {
  it("converts microwatts to watts", () => {
    expect(microToUnit(15_000_000)).toBe(15);
  });

  it("converts microvolts to volts", () => {
    expect(microToUnit(7_800_000)).toBe(7.8);
  });

  it("converts microwatt-hours to watt-hours", () => {
    expect(microToUnit(40_000_000)).toBe(40);
  });

  it("handles zero", () => {
    expect(microToUnit(0)).toBe(0);
  });
});

describe("round2", () => {
  it("rounds to 2 decimal places", () => {
    expect(round2(7.8345)).toBe(7.83);
    expect(round2(12.005)).toBe(12.01);
    expect(round2(15)).toBe(15);
  });
});

describe("computeHealthPercent", () => {
  it("computes health as (energyFull / energyFullDesign) * 100, rounded", () => {
    expect(computeHealthPercent(40, 45)).toBe(89); // 88.89 → 89
    expect(computeHealthPercent(35, 50)).toBe(70);
    expect(computeHealthPercent(40, 40)).toBe(100);
  });

  it("returns 100 when design capacity is zero (safe default)", () => {
    expect(computeHealthPercent(0, 0)).toBe(100);
    expect(computeHealthPercent(40, 0)).toBe(100);
  });
});

describe("computeTimeRemaining", () => {
  it("returns Full sentinel for Full status", () => {
    const result = computeTimeRemaining("Full", 0, 40, 40);
    expect(result.minutes).toBeNull();
    expect(result.formatted).toBe("Full");
  });

  it("returns null / '--' when power is zero and status is Discharging", () => {
    const result = computeTimeRemaining("Discharging", 0, 30, 40);
    expect(result.minutes).toBeNull();
    expect(result.formatted).toBe("--");
  });

  it("computes discharge time: energyNow / powerWatts in minutes", () => {
    // 30 Wh / 15 W = 2 hours = 120 minutes
    const result = computeTimeRemaining("Discharging", 15, 30, 40);
    expect(result.minutes).toBe(120);
    expect(result.formatted).toBe("2h 0m");
  });

  it("computes charge time: energyDeficit / powerWatts in minutes", () => {
    // deficit = 40 - 20 = 20 Wh / 20 W = 1 hour = 60 minutes
    const result = computeTimeRemaining("Charging", 20, 20, 40);
    expect(result.minutes).toBe(60);
    expect(result.formatted).toBe("1h 0m");
  });

  it("returns 0 minutes when battery is already full but status is Charging", () => {
    // deficit = 0
    const result = computeTimeRemaining("Charging", 10, 40, 40);
    expect(result.minutes).toBe(0);
    expect(result.formatted).toBe("0m");
  });

  it("returns null for an unknown status with no power", () => {
    const result = computeTimeRemaining("Unknown", 0, 30, 40);
    expect(result.minutes).toBeNull();
    expect(result.formatted).toBe("--");
  });
});

describe("formatTimeRemaining", () => {
  it("returns Full for Full status regardless of minutes", () => {
    expect(formatTimeRemaining(null, "Full")).toBe("Full");
    expect(formatTimeRemaining(60, "Full")).toBe("Full");
  });

  it("returns '--' for null minutes", () => {
    expect(formatTimeRemaining(null, "Discharging")).toBe("--");
  });

  it("returns '0m' for zero minutes", () => {
    expect(formatTimeRemaining(0, "Discharging")).toBe("0m");
  });

  it("formats minutes-only durations", () => {
    expect(formatTimeRemaining(15, "Discharging")).toBe("15m");
    expect(formatTimeRemaining(45, "Charging")).toBe("45m");
  });

  it("formats hours + minutes durations", () => {
    expect(formatTimeRemaining(120, "Discharging")).toBe("2h 0m");
    expect(formatTimeRemaining(145, "Discharging")).toBe("2h 25m");
    expect(formatTimeRemaining(60, "Charging")).toBe("1h 0m");
  });
});

describe("assembleBatteryInfo", () => {
  it("assembles a full BatteryInfo from sysfs micro-unit values (discharging)", () => {
    const info = assembleBatteryInfo({
      percentage: 75,
      status: "Discharging",
      powerNowMicro: 15_000_000,       // 15 W
      voltageNowMicro: 7_800_000,      // 7.8 V
      energyNowMicro: 30_000_000,      // 30 Wh
      energyFullMicro: 40_000_000,     // 40 Wh
      energyFullDesignMicro: 45_000_000, // 45 Wh
    });

    expect(info.percentage).toBe(75);
    expect(info.status).toBe("Discharging");
    expect(info.powerWatts).toBe(15);
    expect(info.voltage).toBe(7.8);
    expect(info.energyNowWh).toBe(30);
    expect(info.energyFullWh).toBe(40);
    expect(info.energyFullDesignWh).toBe(45);
    expect(info.healthPercent).toBe(89); // 40/45 ≈ 88.89 → 89
    expect(info.timeRemainingMinutes).toBe(120); // 30/15 h * 60
    expect(info.timeRemainingFormatted).toBe("2h 0m");
  });

  it("assembles BatteryInfo for a charging battery", () => {
    const info = assembleBatteryInfo({
      percentage: 50,
      status: "Charging",
      powerNowMicro: 20_000_000,
      voltageNowMicro: 8_000_000,
      energyNowMicro: 20_000_000,
      energyFullMicro: 40_000_000,
      energyFullDesignMicro: 40_000_000,
    });

    expect(info.status).toBe("Charging");
    expect(info.timeRemainingMinutes).toBe(60); // (40-20)/20 * 60
    expect(info.timeRemainingFormatted).toBe("1h 0m");
    expect(info.healthPercent).toBe(100);
  });

  it("assembles BatteryInfo for Full status", () => {
    const info = assembleBatteryInfo({
      percentage: 100,
      status: "Full",
      powerNowMicro: 0,
      voltageNowMicro: 8_200_000,
      energyNowMicro: 40_000_000,
      energyFullMicro: 40_000_000,
      energyFullDesignMicro: 40_000_000,
    });

    expect(info.timeRemainingFormatted).toBe("Full");
    expect(info.timeRemainingMinutes).toBeNull();
  });

  it("handles all-zero sysfs values gracefully", () => {
    const info = assembleBatteryInfo({
      percentage: 0,
      status: "Unknown",
      powerNowMicro: 0,
      voltageNowMicro: 0,
      energyNowMicro: 0,
      energyFullMicro: 0,
      energyFullDesignMicro: 0,
    });

    expect(info.powerWatts).toBe(0);
    expect(info.healthPercent).toBe(100); // design = 0 → safe default
    expect(info.timeRemainingMinutes).toBeNull();
    expect(info.timeRemainingFormatted).toBe("--");
  });
});

describe("scoreBatteryCandidate", () => {
  it("gives a base score of 10 for a clean battery entry", () => {
    expect(
      scoreBatteryCandidate({ name: "BAT0", scope: "", hasDesignCapacity: false }),
    ).toBe(10);
  });

  it("adds 5 for having a design capacity", () => {
    expect(
      scoreBatteryCandidate({ name: "BAT0", scope: "", hasDesignCapacity: true }),
    ).toBe(15);
  });

  it("subtracts 100 for scope=Device (peripheral battery)", () => {
    expect(
      scoreBatteryCandidate({ name: "BAT0", scope: "Device", hasDesignCapacity: false }),
    ).toBe(-90);
  });

  it("subtracts 50 for hid- prefix", () => {
    expect(
      scoreBatteryCandidate({ name: "hid-ABCD-battery", scope: "", hasDesignCapacity: false }),
    ).toBe(-40);
  });

  it("combines penalties: hid- + Device scope", () => {
    expect(
      scoreBatteryCandidate({ name: "hid-ABCD-battery", scope: "Device", hasDesignCapacity: false }),
    ).toBe(-140);
  });

  it("system battery scores higher than a Device-scope HID battery", () => {
    const sys = scoreBatteryCandidate({ name: "BATT", scope: "", hasDesignCapacity: true });
    const hid = scoreBatteryCandidate({ name: "hid-ABCD-battery", scope: "Device", hasDesignCapacity: false });
    expect(sys).toBeGreaterThan(hid);
  });
});
