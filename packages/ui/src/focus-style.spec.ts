import { describe, it, expect } from "bun:test";
import { applyFocusPulse, focusScaleClass } from "./focus-style";

describe("focusScaleClass", () => {
  it("returns scale class when focused", () => {
    expect(focusScaleClass(true)).toBe("scale-[1.02]");
  });
  it("returns empty when not focused", () => {
    expect(focusScaleClass(false)).toBe("");
  });
  it("honors custom scale amount", () => {
    expect(focusScaleClass(true, "1.05")).toBe("scale-[1.05]");
  });
});

describe("applyFocusPulse", () => {
  it("returns base when not focused", () => {
    expect(applyFocusPulse(false, { color: "red" })).toEqual({ color: "red" });
    expect(applyFocusPulse(false)).toBeUndefined();
  });
  it("merges pulse animation with base when focused", () => {
    expect(applyFocusPulse(true, { color: "red" })).toEqual({
      color: "red",
      animation: "focusPulse 2s ease-in-out infinite",
    });
  });
  it("returns animation alone when focused with no base", () => {
    expect(applyFocusPulse(true)).toEqual({
      animation: "focusPulse 2s ease-in-out infinite",
    });
  });
});
