import { describe, it, expect } from "bun:test";
import { parseOpenRgbList } from "./openrgb-parse";

describe("parseOpenRgbList", () => {
  it("returns an empty array for empty input", () => {
    expect(parseOpenRgbList("")).toEqual([]);
  });

  it("returns an empty array when no device headers match", () => {
    expect(parseOpenRgbList("No devices found\n")).toEqual([]);
  });

  it("treats a device with no Zone lines as a single zone", () => {
    const input = "0: My RGB Mouse\n";
    const zones = parseOpenRgbList(input);
    expect(zones).toHaveLength(1);
    expect(zones[0]).toMatchObject({
      id: "openrgb:0:0",
      name: "My RGB Mouse",
      color: { r: 0, g: 0, b: 0 },
      brightness: 100,
      mode: "static",
    });
    expect(zones[0].supportedModes).toContain("static");
  });

  it("emits one zone per Zone line for a multi-zone device", () => {
    const input =
      "1: Keyboard\n" +
      "  Zone 0: Underglow\n" +
      "  Zone 1: Logo\n";
    const zones = parseOpenRgbList(input);
    expect(zones).toHaveLength(2);
    expect(zones[0].id).toBe("openrgb:1:0");
    expect(zones[0].name).toBe("Keyboard - Underglow");
    expect(zones[1].id).toBe("openrgb:1:1");
    expect(zones[1].name).toBe("Keyboard - Logo");
  });

  it("handles multiple devices in one listing", () => {
    const input =
      "0: Mouse\n" +
      "1: Keyboard\n" +
      "  Zone 0: Main\n" +
      "2: MotherboardLED\n" +
      "  Zone 0: Backplate\n" +
      "  Zone 1: IO Shield\n";
    const zones = parseOpenRgbList(input);
    expect(zones.map((z) => z.id)).toEqual([
      "openrgb:0:0",
      "openrgb:1:0",
      "openrgb:2:0",
      "openrgb:2:1",
    ]);
    expect(zones[0].name).toBe("Mouse"); // no-Zone device path
    expect(zones[1].name).toBe("Keyboard - Main");
    expect(zones[2].name).toBe("MotherboardLED - Backplate");
    expect(zones[3].name).toBe("MotherboardLED - IO Shield");
  });

  it("trims trailing whitespace in device and zone names", () => {
    const input = "0:   Padded Device   \n  Zone 0:   Padded Zone   \n";
    const zones = parseOpenRgbList(input);
    expect(zones[0].name).toBe("Padded Device - Padded Zone");
  });

  it("each parsed zone owns its own copy of supportedModes", () => {
    const input = "0: A\n1: B\n";
    const zones = parseOpenRgbList(input);
    zones[0].supportedModes.push("mutated");
    expect(zones[1].supportedModes).not.toContain("mutated");
  });
});
