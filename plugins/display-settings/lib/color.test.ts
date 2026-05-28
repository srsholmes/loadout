import { describe, it, expect } from "bun:test";
import {
  floatToLong,
  longToFloat,
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
