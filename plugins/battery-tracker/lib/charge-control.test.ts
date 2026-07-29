import { describe, it, expect } from "bun:test";
import {
  behaviourSupportsAlways,
  behaviourSupportsAwake,
  bypassModeToSysfs,
  isValidChargeLimit,
  parseActiveEnumValue,
  parseEnumOptions,
  sysfsToBypassMode,
  thresholdToLimitPercent,
} from "./charge-control";

describe("isValidChargeLimit", () => {
  it("accepts integers in [50, 100]", () => {
    expect(isValidChargeLimit(50)).toBe(true);
    expect(isValidChargeLimit(80)).toBe(true);
    expect(isValidChargeLimit(100)).toBe(true);
  });

  it("rejects out-of-range and non-integer values", () => {
    expect(isValidChargeLimit(49)).toBe(false);
    expect(isValidChargeLimit(101)).toBe(false);
    expect(isValidChargeLimit(0)).toBe(false);
    expect(isValidChargeLimit(-5)).toBe(false);
    expect(isValidChargeLimit(72.5)).toBe(false);
    expect(isValidChargeLimit(NaN)).toBe(false);
  });
});

describe("parseActiveEnumValue", () => {
  it("extracts the bracketed value from an option list", () => {
    expect(parseActiveEnumValue("[auto] inhibit-charge inhibit-charge-awake")).toBe("auto");
    expect(parseActiveEnumValue("auto [inhibit-charge] inhibit-charge-awake")).toBe(
      "inhibit-charge",
    );
    expect(parseActiveEnumValue("auto inhibit-charge [inhibit-charge-awake]")).toBe(
      "inhibit-charge-awake",
    );
  });

  it("returns plain single-value attrs trimmed", () => {
    expect(parseActiveEnumValue("Standard\n")).toBe("Standard");
    expect(parseActiveEnumValue("  Bypass ")).toBe("Bypass");
  });
});

describe("parseEnumOptions", () => {
  it("splits the option list and strips the active bracket", () => {
    expect(parseEnumOptions("[auto] inhibit-charge inhibit-charge-awake")).toEqual([
      "auto",
      "inhibit-charge",
      "inhibit-charge-awake",
    ]);
    expect(parseEnumOptions("auto [force-discharge]")).toEqual(["auto", "force-discharge"]);
  });
});

describe("behaviourSupportsAlways", () => {
  it("detects the plain inhibit-charge value by exact token, not substring", () => {
    expect(behaviourSupportsAlways("[auto] inhibit-charge inhibit-charge-awake")).toBe(true);
    expect(behaviourSupportsAlways("[auto] inhibit-charge")).toBe(true);
    // Only the awake variant present — plain inhibit-charge is NOT offered.
    expect(behaviourSupportsAlways("[auto] inhibit-charge-awake")).toBe(false);
    // force-discharge is not a bypass value.
    expect(behaviourSupportsAlways("[auto] force-discharge")).toBe(false);
  });
});

describe("behaviourSupportsAwake", () => {
  it("detects the handheld-kernel awake extension", () => {
    expect(behaviourSupportsAwake("[auto] inhibit-charge inhibit-charge-awake")).toBe(true);
    expect(behaviourSupportsAwake("[auto] inhibit-charge")).toBe(false);
    expect(behaviourSupportsAwake("[auto] inhibit-charge force-discharge")).toBe(false);
  });
});

describe("bypassModeToSysfs", () => {
  it("maps modes for charge_behaviour", () => {
    expect(bypassModeToSysfs("charge_behaviour", "disabled")).toBe("auto");
    expect(bypassModeToSysfs("charge_behaviour", "awake")).toBe("inhibit-charge-awake");
    expect(bypassModeToSysfs("charge_behaviour", "always")).toBe("inhibit-charge");
  });

  it("maps modes for legacy charge_type", () => {
    expect(bypassModeToSysfs("charge_type", "disabled")).toBe("Standard");
    expect(bypassModeToSysfs("charge_type", "awake")).toBe("BypassS0");
    expect(bypassModeToSysfs("charge_type", "always")).toBe("Bypass");
  });
});

describe("sysfsToBypassMode", () => {
  it("round-trips charge_behaviour values", () => {
    expect(sysfsToBypassMode("charge_behaviour", "auto")).toBe("disabled");
    expect(sysfsToBypassMode("charge_behaviour", "inhibit-charge")).toBe("always");
    expect(sysfsToBypassMode("charge_behaviour", "inhibit-charge-awake")).toBe("awake");
  });

  it("round-trips charge_type values", () => {
    expect(sysfsToBypassMode("charge_type", "Standard")).toBe("disabled");
    expect(sysfsToBypassMode("charge_type", "Bypass")).toBe("always");
    expect(sysfsToBypassMode("charge_type", "BypassS0")).toBe("awake");
  });

  it("reads unknown values as disabled", () => {
    // Only claim bypass is engaged when positively identified —
    // force-discharge / Fast / Trickle are unrelated states.
    expect(sysfsToBypassMode("charge_behaviour", "force-discharge")).toBe("disabled");
    expect(sysfsToBypassMode("charge_type", "Fast")).toBe("disabled");
  });
});

describe("thresholdToLimitPercent", () => {
  it("passes through a real limit", () => {
    expect(thresholdToLimitPercent(80)).toBe(80);
    expect(thresholdToLimitPercent(62)).toBe(62);
  });

  it("normalizes no-limit sentinels to null", () => {
    expect(thresholdToLimitPercent(null)).toBeNull();
    expect(thresholdToLimitPercent(100)).toBeNull();
    expect(thresholdToLimitPercent(0)).toBeNull();
    expect(thresholdToLimitPercent(-1)).toBeNull();
  });
});
