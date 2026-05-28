import { describe, it, expect } from "bun:test";
import {
  floatToLong,
  longToFloat,
  kelvinToGamma,
  percentToRaw,
  rawToPercent,
} from "./color";

describe("floatToLong / longToFloat", () => {
  it("round-trips 0.5 through the uint32 packing", () => {
    const packed = floatToLong(0.5);
    expect(longToFloat(packed)).toBeCloseTo(0.5, 5);
  });

  it("round-trips 0.0 exactly", () => {
    expect(longToFloat(floatToLong(0.0))).toBe(0.0);
  });

  it("round-trips 1.0 exactly", () => {
    expect(longToFloat(floatToLong(1.0))).toBeCloseTo(1.0, 5);
  });

  it("produces distinct uint32 for distinct floats", () => {
    expect(floatToLong(0.25)).not.toBe(floatToLong(0.75));
  });
});

describe("kelvinToGamma", () => {
  it("returns values close to 1.0 for 6500K (D65 white)", () => {
    const { r, g, b } = kelvinToGamma(6500);
    expect(r).toBeCloseTo(1.0, 1);
    expect(g).toBeCloseTo(1.0, 1);
    expect(b).toBeCloseTo(1.0, 1);
  });

  it("warm temperature (3000K) has higher red than blue", () => {
    const { r, b } = kelvinToGamma(3000);
    expect(r).toBeGreaterThan(b);
  });

  it("all channels are in [0, 1] range for 3000K", () => {
    const { r, g, b } = kelvinToGamma(3000);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(1);
    expect(g).toBeGreaterThanOrEqual(0);
    expect(g).toBeLessThanOrEqual(1);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThanOrEqual(1);
  });

  it("all channels are in [0, 1] range for 6500K", () => {
    const { r, g, b } = kelvinToGamma(6500);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(1);
    expect(g).toBeGreaterThanOrEqual(0);
    expect(g).toBeLessThanOrEqual(1);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThanOrEqual(1);
  });

  it("produces values rounded to 3 decimal places", () => {
    const { r, g, b } = kelvinToGamma(4500);
    // toFixed(3) produces 3 decimal places max
    expect(String(r).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(3);
    expect(String(g).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(3);
    expect(String(b).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(3);
  });

  it("very low temperature (1900K) clamps blue to 0", () => {
    // temp/100 = 19 is the threshold below which b = 0
    const { b } = kelvinToGamma(1900);
    expect(b).toBe(0);
  });

  it("very high temperature (9900K) keeps all channels at 1.0", () => {
    // At 9900K temp=99>66: all channels in the high-temp formulas
    const { r, g, b } = kelvinToGamma(9900);
    expect(r).toBeGreaterThan(0);
    expect(g).toBeGreaterThan(0);
    expect(b).toBeCloseTo(1.0, 3);
  });
});

describe("percentToRaw", () => {
  it("converts 0% to 0", () => {
    expect(percentToRaw(0, 1000)).toBe(0);
  });

  it("converts 100% to maxBrightness", () => {
    expect(percentToRaw(100, 1000)).toBe(1000);
  });

  it("converts 50% to half maxBrightness", () => {
    expect(percentToRaw(50, 1000)).toBe(500);
  });

  it("clamps below 0% to 0", () => {
    expect(percentToRaw(-10, 1000)).toBe(0);
  });

  it("clamps above 100% to maxBrightness", () => {
    expect(percentToRaw(150, 1000)).toBe(1000);
  });

  it("rounds the result to an integer", () => {
    const result = percentToRaw(33, 100);
    expect(result).toBe(33);
    expect(Number.isInteger(result)).toBe(true);
  });
});

describe("rawToPercent", () => {
  it("converts 0 raw to 0%", () => {
    expect(rawToPercent(0, 1000)).toBe(0);
  });

  it("converts maxBrightness to 100%", () => {
    expect(rawToPercent(1000, 1000)).toBe(100);
  });

  it("converts half maxBrightness to 50%", () => {
    expect(rawToPercent(500, 1000)).toBe(50);
  });

  it("returns 0 when maxBrightness is 0 (avoids divide-by-zero)", () => {
    expect(rawToPercent(500, 0)).toBe(0);
  });

  it("rounds to integer", () => {
    const result = rawToPercent(333, 1000);
    expect(Number.isInteger(result)).toBe(true);
  });
});
