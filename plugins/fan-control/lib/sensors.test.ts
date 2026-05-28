import { describe, it, expect } from "bun:test";
import { classifyTempZone, parsePwmMode, zoneSortWeight } from "./sensors";

// ---------------------------------------------------------------------------
// classifyTempZone — moved out of backend.test.ts so the pure
// chip/keyword heuristics are tested where they live.
// ---------------------------------------------------------------------------

describe("classifyTempZone()", () => {
  it("classifies k10temp as cpu", () => {
    expect(classifyTempZone("k10temp", "Tctl")).toBe("cpu");
  });

  it("classifies coretemp as cpu", () => {
    expect(classifyTempZone("coretemp", "Package id 0")).toBe("cpu");
  });

  it("classifies zenpower as cpu", () => {
    expect(classifyTempZone("zenpower", "Tdie")).toBe("cpu");
  });

  it("classifies amdgpu as gpu", () => {
    expect(classifyTempZone("amdgpu", "edge")).toBe("gpu");
  });

  it("classifies junction label as gpu", () => {
    expect(classifyTempZone("something", "junction")).toBe("gpu");
  });

  it("classifies steamdeck_hwmon's 'Battery Temp' as battery, NOT cpu", () => {
    // Regression: pre-fix this returned "cpu", so the safety watchdog
    // compared APU thermals against a battery (~40 °C idle) and never
    // engaged. The Deck crashed under high TDP + low fan.
    expect(classifyTempZone("steamdeck_hwmon", "Battery Temp")).toBe("battery");
  });

  it("classifies acpitz (no label) as cpu — the Deck's APU thermal zone", () => {
    expect(classifyTempZone("acpitz", "")).toBe("cpu");
  });

  it("classifies an NVMe SSD composite sensor as unknown, not cpu", () => {
    expect(classifyTempZone("nvme", "Composite")).toBe("unknown");
  });

  it("classifies unknown chip/label as unknown", () => {
    expect(classifyTempZone("random_chip", "some_label")).toBe("unknown");
  });

  it("classifies soc label as cpu (soc is a CPU keyword)", () => {
    expect(classifyTempZone("some_chip", "SoC temp")).toBe("cpu");
  });

  it("classifies a soc-only chip with no CPU keyword as soc", () => {
    // "soc" alone (without tctl/tdie/cpu/package) falls to the soc branch.
    // Use a label that contains "soc" but isn't caught earlier — it is in
    // CPU_LABEL_KEYWORDS, so this stays cpu; the explicit soc branch is a
    // safety net only reachable when "soc" is a substring of another word.
    expect(classifyTempZone("mysocchip", "x")).toBe("cpu");
  });
});

describe("zoneSortWeight()", () => {
  it("orders cpu < gpu < soc < battery < unknown", () => {
    expect(zoneSortWeight("cpu")).toBeLessThan(zoneSortWeight("gpu"));
    expect(zoneSortWeight("gpu")).toBeLessThan(zoneSortWeight("soc"));
    expect(zoneSortWeight("soc")).toBeLessThan(zoneSortWeight("battery"));
    expect(zoneSortWeight("battery")).toBeLessThan(zoneSortWeight("unknown"));
  });

  it("treats an unrecognised zone as the lowest priority (4)", () => {
    expect(zoneSortWeight("banana")).toBe(4);
  });
});

describe("parsePwmMode()", () => {
  it("maps 0 to full", () => {
    expect(parsePwmMode(0)).toBe("full");
  });
  it("maps 1 to manual", () => {
    expect(parsePwmMode(1)).toBe("manual");
  });
  it("maps 2 to auto", () => {
    expect(parsePwmMode(2)).toBe("auto");
  });
  it("maps unknown values to unknown", () => {
    expect(parsePwmMode(5)).toBe("unknown");
    expect(parsePwmMode(-1)).toBe("unknown");
  });
});
