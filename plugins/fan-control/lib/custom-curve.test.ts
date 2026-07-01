import { describe, it, expect } from "bun:test";
import {
  CURVE_MAX_POINTS,
  CURVE_MIN_POINTS,
  CURVE_TEMP_MAX,
  CURVE_TEMP_MIN,
  DEFAULT_CUSTOM_CURVE,
  clampTemp,
  sanitiseCurve,
} from "./custom-curve";
import { interpolateCurve } from "./fan-curves";

describe("clampTemp()", () => {
  it("clamps below the editable floor", () => {
    expect(clampTemp(-5)).toBe(CURVE_TEMP_MIN);
  });
  it("clamps above the editable ceiling", () => {
    expect(clampTemp(200)).toBe(CURVE_TEMP_MAX);
  });
  it("rounds fractional temps", () => {
    expect(clampTemp(55.6)).toBe(56);
  });
});

describe("DEFAULT_CUSTOM_CURVE", () => {
  it("is itself a valid curve (ascending, in range)", () => {
    expect(DEFAULT_CUSTOM_CURVE.length).toBeGreaterThanOrEqual(CURVE_MIN_POINTS);
    for (let i = 1; i < DEFAULT_CUSTOM_CURVE.length; i++) {
      expect(DEFAULT_CUSTOM_CURVE[i].tempC).toBeGreaterThan(
        DEFAULT_CUSTOM_CURVE[i - 1].tempC,
      );
    }
    expect(sanitiseCurve(DEFAULT_CUSTOM_CURVE)).toEqual([...DEFAULT_CUSTOM_CURVE]);
  });
});

describe("sanitiseCurve()", () => {
  it("passes a well-formed curve through unchanged", () => {
    const curve = [
      { tempC: 30, percent: 10 },
      { tempC: 60, percent: 60 },
      { tempC: 90, percent: 100 },
    ];
    expect(sanitiseCurve(curve)).toEqual(curve);
  });

  it("sorts points ascending by temperature", () => {
    const curve = [
      { tempC: 90, percent: 100 },
      { tempC: 30, percent: 10 },
      { tempC: 60, percent: 60 },
    ];
    expect(sanitiseCurve(curve)).toEqual([
      { tempC: 30, percent: 10 },
      { tempC: 60, percent: 60 },
      { tempC: 90, percent: 100 },
    ]);
  });

  it("drops duplicate-temperature points so interpolation can't divide by zero", () => {
    const result = sanitiseCurve([
      { tempC: 50, percent: 20 },
      { tempC: 50, percent: 80 },
      { tempC: 70, percent: 90 },
    ]);
    const temps = result.map((p) => p.tempC);
    expect(new Set(temps).size).toBe(temps.length);
    // The interpolation must not produce NaN anywhere across the range.
    for (let t = CURVE_TEMP_MIN; t <= CURVE_TEMP_MAX; t++) {
      expect(Number.isNaN(interpolateCurve(result, t))).toBe(false);
    }
  });

  it("clamps out-of-range temps and percents", () => {
    const result = sanitiseCurve([
      { tempC: -10, percent: 150 },
      { tempC: 999, percent: -50 },
    ]);
    expect(result).toEqual([
      { tempC: CURVE_TEMP_MIN, percent: 100 },
      { tempC: CURVE_TEMP_MAX, percent: 0 },
    ]);
  });

  it("rounds fractional values", () => {
    expect(sanitiseCurve([
      { tempC: 40.4, percent: 33.6 },
      { tempC: 70.5, percent: 90.2 },
    ])).toEqual([
      { tempC: 40, percent: 34 },
      { tempC: 71, percent: 90 },
    ]);
  });

  it("skips non-numeric / malformed entries", () => {
    const result = sanitiseCurve([
      { tempC: 40, percent: 20 },
      { tempC: "hot", percent: 50 },
      null,
      42,
      { percent: 80 },
      { tempC: 80, percent: 100 },
    ]);
    expect(result).toEqual([
      { tempC: 40, percent: 20 },
      { tempC: 80, percent: 100 },
    ]);
  });

  it("trims to at most CURVE_MAX_POINTS", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      tempC: 20 + i * 4,
      percent: i * 5,
    }));
    expect(sanitiseCurve(many).length).toBe(CURVE_MAX_POINTS);
  });

  it("falls back to the default curve when fewer than the minimum survive", () => {
    expect(sanitiseCurve([{ tempC: 50, percent: 40 }])).toEqual([
      ...DEFAULT_CUSTOM_CURVE,
    ]);
    expect(sanitiseCurve([])).toEqual([...DEFAULT_CUSTOM_CURVE]);
  });

  it("falls back to the default curve on non-array input", () => {
    expect(sanitiseCurve(null)).toEqual([...DEFAULT_CUSTOM_CURVE]);
    expect(sanitiseCurve("nope")).toEqual([...DEFAULT_CUSTOM_CURVE]);
    expect(sanitiseCurve(undefined)).toEqual([...DEFAULT_CUSTOM_CURVE]);
  });
});
