import { describe, it, expect } from "bun:test";
import { sanitiseGlobalMode } from "./global-mode";
import { FAN_CURVES } from "./fan-curves";

describe("sanitiseGlobalMode", () => {
  it("accepts every preset the curve table defines", () => {
    // Derived, not hand-listed: PRESET_NAMES used to be a copy of these
    // keys, so adding a fourth preset silently made it non-restorable —
    // rejected here before applyPreset ever saw it.
    for (const name of Object.keys(FAN_CURVES)) {
      expect(sanitiseGlobalMode({ kind: "preset", name })).toEqual({
        kind: "preset",
        name: name as never,
      });
    }
  });

  it("round-trips each mode the backend persists", () => {
    expect(sanitiseGlobalMode({ kind: "preset", name: "silent" })).toEqual({
      kind: "preset",
      name: "silent",
    });
    expect(sanitiseGlobalMode({ kind: "custom" })).toEqual({ kind: "custom" });
    expect(sanitiseGlobalMode({ kind: "auto" })).toEqual({ kind: "auto" });
    expect(sanitiseGlobalMode({ kind: "manual", percent: 42 })).toEqual({
      kind: "manual",
      percent: 42,
    });
  });

  it("rejects an unknown preset name rather than restoring a bogus curve", () => {
    expect(sanitiseGlobalMode({ kind: "preset", name: "turbo" })).toBeNull();
    expect(sanitiseGlobalMode({ kind: "preset" })).toBeNull();
    expect(sanitiseGlobalMode({ kind: "preset", name: 3 })).toBeNull();
  });

  it("keeps manual intent when the percent is missing or unusable", () => {
    // The auto-vs-manual choice still stands even with no duty to write —
    // the backend re-asserts the mode and skips the speed.
    expect(sanitiseGlobalMode({ kind: "manual" })).toEqual({
      kind: "manual",
      percent: null,
    });
    expect(sanitiseGlobalMode({ kind: "manual", percent: "80" })).toEqual({
      kind: "manual",
      percent: null,
    });
    expect(sanitiseGlobalMode({ kind: "manual", percent: NaN })).toEqual({
      kind: "manual",
      percent: null,
    });
  });

  it("clamps and rounds an out-of-range percent", () => {
    // Storage is user-editable JSON, so a hand-typed 900 must not reach the
    // PWM write path.
    expect(sanitiseGlobalMode({ kind: "manual", percent: 900 })).toEqual({
      kind: "manual",
      percent: 100,
    });
    expect(sanitiseGlobalMode({ kind: "manual", percent: -20 })).toEqual({
      kind: "manual",
      percent: 0,
    });
    expect(sanitiseGlobalMode({ kind: "manual", percent: 55.6 })).toEqual({
      kind: "manual",
      percent: 56,
    });
  });

  it("returns null for absent or malformed values", () => {
    expect(sanitiseGlobalMode(undefined)).toBeNull();
    expect(sanitiseGlobalMode(null)).toBeNull();
    expect(sanitiseGlobalMode("silent")).toBeNull();
    expect(sanitiseGlobalMode(42)).toBeNull();
    expect(sanitiseGlobalMode([])).toBeNull();
    expect(sanitiseGlobalMode({})).toBeNull();
    expect(sanitiseGlobalMode({ kind: "nonsense" })).toBeNull();
  });
});
