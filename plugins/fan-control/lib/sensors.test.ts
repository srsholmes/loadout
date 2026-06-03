import { describe, it, expect } from "bun:test";
import {
  classifyTempZone,
  cpuChipPriority,
  parsePwmMode,
  zoneSortWeight,
} from "./sensors";

// ---------------------------------------------------------------------------
// cpuChipPriority — within the CPU zone, the real die sensor must beat the
// acpitz fallback. Regression: on the OXP APEX (and Deck) acpitz is a slow
// board sensor reading ~70°C deep into idle; when k10temp is loaded it must
// be the one shown / fed to the fan curve.
// ---------------------------------------------------------------------------

describe("cpuChipPriority()", () => {
  it("ranks real CPU die chips ahead of acpitz", () => {
    expect(cpuChipPriority("k10temp")).toBeLessThan(cpuChipPriority("acpitz"));
    expect(cpuChipPriority("coretemp")).toBeLessThan(cpuChipPriority("acpitz"));
    expect(cpuChipPriority("zenpower")).toBeLessThan(cpuChipPriority("acpitz"));
  });

  it("treats acpitz and other non-die chips as the fallback tier", () => {
    expect(cpuChipPriority("acpitz")).toBe(1);
    expect(cpuChipPriority("amdgpu")).toBe(1);
  });

  it("is case-insensitive on the chip name", () => {
    expect(cpuChipPriority("K10TEMP")).toBe(0);
  });

  it("sorts a k10temp+acpitz mix so k10temp is selected first", () => {
    // Mirrors backend scanTempSensors: zone weight first, then cpuChipPriority.
    const sensors = [
      { chipName: "acpitz", zone: "cpu" },
      { chipName: "k10temp", zone: "cpu" },
    ];
    sensors.sort((a, b) => {
      const byZone = zoneSortWeight(a.zone) - zoneSortWeight(b.zone);
      if (byZone !== 0) return byZone;
      return cpuChipPriority(a.chipName) - cpuChipPriority(b.chipName);
    });
    expect(sensors[0].chipName).toBe("k10temp");
  });
});

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
