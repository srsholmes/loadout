import { describe, it, expect } from "bun:test";
import {
  FAN_CURVES,
  clampPercent,
  interpolateCurve,
  percentToPwm,
  pwmToPercent,
} from "./fan-curves";

// ---------------------------------------------------------------------------
// interpolateCurve — moved out of backend.test.ts so the pure curve maths
// is tested where it lives.
// ---------------------------------------------------------------------------

describe("interpolateCurve()", () => {
  const curve = [
    { tempC: 30, percent: 10 },
    { tempC: 50, percent: 50 },
    { tempC: 70, percent: 100 },
  ];

  it("returns first point percent below the curve range", () => {
    expect(interpolateCurve(curve, 20)).toBe(10);
  });

  it("returns last point percent above the curve range", () => {
    expect(interpolateCurve(curve, 90)).toBe(100);
  });

  it("returns exact percent at a curve point", () => {
    expect(interpolateCurve(curve, 50)).toBe(50);
  });

  it("interpolates between two curve points (40C → 30%)", () => {
    expect(interpolateCurve(curve, 40)).toBe(30);
  });

  it("interpolates in the upper range (60C → 75%)", () => {
    expect(interpolateCurve(curve, 60)).toBe(75);
  });

  it("holds the boundary points exactly", () => {
    expect(interpolateCurve(curve, 30)).toBe(10);
    expect(interpolateCurve(curve, 70)).toBe(100);
  });
});

describe("FAN_CURVES presets", () => {
  it("exposes silent / balanced / performance, each sorted ascending and ending at 100%", () => {
    for (const name of ["silent", "balanced", "performance"] as const) {
      const curve = FAN_CURVES[name];
      expect(curve.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < curve.length; i++) {
        expect(curve[i].tempC).toBeGreaterThan(curve[i - 1].tempC);
      }
      expect(curve[curve.length - 1].percent).toBe(100);
    }
  });
});

describe("clampPercent()", () => {
  it("clamps below 0 to 0", () => {
    expect(clampPercent(-20)).toBe(0);
  });
  it("clamps above 100 to 100", () => {
    expect(clampPercent(250)).toBe(100);
  });
  it("rounds fractional values", () => {
    expect(clampPercent(35.7)).toBe(36);
  });
  it("passes a normal value through", () => {
    expect(clampPercent(50)).toBe(50);
  });
});

describe("percentToPwm() / pwmToPercent()", () => {
  it("maps 0% → PWM 0 and 100% → PWM 255", () => {
    expect(percentToPwm(0)).toBe(0);
    expect(percentToPwm(100)).toBe(255);
  });

  it("maps 60% → PWM 153 (the 60% safety floor value)", () => {
    expect(percentToPwm(60)).toBe(153);
  });

  it("clamps out-of-range percent before converting", () => {
    expect(percentToPwm(150)).toBe(255);
    expect(percentToPwm(-10)).toBe(0);
  });

  it("maps PWM 255 → 100% and PWM 128 → 50%", () => {
    expect(pwmToPercent(255)).toBe(100);
    expect(pwmToPercent(128)).toBe(50);
  });
});

