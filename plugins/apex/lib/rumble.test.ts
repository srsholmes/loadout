import { describe, it, expect } from "bun:test";
import {
  FALLBACK_RANGE,
  clampIntensity,
  intensityLabel,
  isValidIntensity,
  parseIntensityRange,
} from "./rumble";

describe("parseIntensityRange", () => {
  it("parses what the driver actually emits", () => {
    // hid-oxp writes the literal "0-5\n" from a sysfs show handler.
    expect(parseIntensityRange("0-5\n")).toEqual({ min: 0, max: 5 });
  });

  it("tolerates whitespace and a wider future range", () => {
    expect(parseIntensityRange("  0 - 5  ")).toEqual({ min: 0, max: 5 });
    expect(parseIntensityRange("1-10")).toEqual({ min: 1, max: 10 });
  });

  it("returns null rather than guessing at an unusable shape", () => {
    // The caller falls back explicitly; a guess here would be invisible.
    for (const bad of [null, "", "five", "5", "5-", "-5", "abc-def", "5-5", "9-2"]) {
      expect(parseIntensityRange(bad)).toBeNull();
    }
  });
});

describe("clampIntensity", () => {
  it("keeps a value inside the device's range", () => {
    expect(clampIntensity(3, FALLBACK_RANGE)).toBe(3);
    expect(clampIntensity(99, FALLBACK_RANGE)).toBe(5);
    expect(clampIntensity(-4, FALLBACK_RANGE)).toBe(0);
  });

  it("rounds, since the attribute is an integer", () => {
    expect(clampIntensity(2.4, FALLBACK_RANGE)).toBe(2);
    expect(clampIntensity(2.6, FALLBACK_RANGE)).toBe(3);
  });

  it("falls to the minimum on a non-finite input", () => {
    // Deliberately off rather than clamping Infinity up to max: nonsense
    // input should silence the motors, not drive them at full.
    expect(clampIntensity(NaN, FALLBACK_RANGE)).toBe(0);
    expect(clampIntensity(Infinity, FALLBACK_RANGE)).toBe(0);
    expect(clampIntensity(-Infinity, FALLBACK_RANGE)).toBe(0);
  });

  it("respects a range that doesn't start at zero", () => {
    expect(clampIntensity(0, { min: 1, max: 10 })).toBe(1);
  });
});

describe("isValidIntensity", () => {
  it("accepts every level the driver would take", () => {
    for (let i = FALLBACK_RANGE.min; i <= FALLBACK_RANGE.max; i++) {
      expect(isValidIntensity(i, FALLBACK_RANGE)).toBe(true);
    }
  });

  it("rejects anything that shouldn't reach a sysfs write", () => {
    // Storage is user-editable JSON, so these are all reachable.
    for (const bad of [undefined, null, "3", 3.5, -1, 6, NaN, {}, []]) {
      expect(isValidIntensity(bad, FALLBACK_RANGE)).toBe(false);
    }
  });
});

describe("intensityLabel", () => {
  it("names the ends of the range rather than numbering them", () => {
    expect(intensityLabel(0, FALLBACK_RANGE)).toBe("Off");
    expect(intensityLabel(5, FALLBACK_RANGE)).toBe("Full");
    expect(intensityLabel(3, FALLBACK_RANGE)).toBe("Level 3");
  });

  it("uses the device's own bounds, not 0 and 5", () => {
    expect(intensityLabel(1, { min: 1, max: 10 })).toBe("Off");
    expect(intensityLabel(10, { min: 1, max: 10 })).toBe("Full");
  });
});
