import { describe, it, expect } from "bun:test";
import {
  detectActivePreset,
  alphaToPercent,
  percentToAlpha,
} from "./preset-match";
import { PRESETS } from "./config";

describe("detectActivePreset", () => {
  it("matches the 'minimal' preset by its exact key set", () => {
    expect(detectActivePreset({ fps: "1", fps_only: "1" }, PRESETS)).toBe(
      "minimal",
    );
  });

  it("matches the 'standard' preset", () => {
    expect(
      detectActivePreset(
        { fps: "1", gpu_stats: "1", cpu_stats: "1", ram: "1", vram: "1" },
        PRESETS,
      ),
    ).toBe("standard");
  });

  it("returns null when nothing matches", () => {
    expect(detectActivePreset({ fps: "1", gpu_stats: "1" }, PRESETS)).toBeNull();
  });

  it("ignores position / fps_limit / background_alpha when matching", () => {
    expect(
      detectActivePreset(
        {
          fps: "1",
          fps_only: "1",
          position: "top-left",
          fps_limit: "60",
          background_alpha: "0.5",
        },
        PRESETS,
      ),
    ).toBe("minimal");
  });

  it("does NOT match if metric values differ", () => {
    expect(
      detectActivePreset({ fps: "0", fps_only: "1" }, PRESETS),
    ).toBeNull();
  });

  it("returns null for empty config", () => {
    expect(detectActivePreset({}, PRESETS)).toBeNull();
  });
});

describe("alphaToPercent", () => {
  it("converts 0.0 → 0", () => expect(alphaToPercent("0")).toBe(0));
  it("converts 0.5 → 50", () => expect(alphaToPercent("0.5")).toBe(50));
  it("converts 1.0 → 100", () => expect(alphaToPercent("1")).toBe(100));
  it("rounds to nearest percent", () =>
    expect(alphaToPercent("0.736")).toBe(74));
  it("defaults to 50 for undefined input", () =>
    expect(alphaToPercent(undefined)).toBe(50));
  it("defaults to 50 for non-numeric input", () =>
    expect(alphaToPercent("not-a-number")).toBe(50));
  it("clamps values above 1.0 to 100", () =>
    expect(alphaToPercent("2.5")).toBe(100));
  it("clamps negative values to 0", () =>
    expect(alphaToPercent("-0.3")).toBe(0));
});

describe("percentToAlpha", () => {
  it("converts 0 → '0.00'", () => expect(percentToAlpha(0)).toBe("0.00"));
  it("converts 50 → '0.50'", () => expect(percentToAlpha(50)).toBe("0.50"));
  it("converts 100 → '1.00'", () => expect(percentToAlpha(100)).toBe("1.00"));
  it("formats with 2 decimal places", () =>
    expect(percentToAlpha(33)).toBe("0.33"));
  it("clamps above 100 to '1.00'", () =>
    expect(percentToAlpha(150)).toBe("1.00"));
  it("clamps below 0 to '0.00'", () =>
    expect(percentToAlpha(-10)).toBe("0.00"));
});
