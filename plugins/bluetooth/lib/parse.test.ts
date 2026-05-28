import { describe, it, expect } from "bun:test";
import {
  parseDeviceType,
  parseDeviceList,
  parseDeviceInfo,
  parseAdapterInfo,
} from "./parse";

// ---------------------------------------------------------------------------
// parseDeviceType
// ---------------------------------------------------------------------------

describe("parseDeviceType()", () => {
  it("classifies audio-headset as audio", () => {
    expect(parseDeviceType("Icon: audio-headset")).toBe("audio");
  });

  it("classifies audio-headphone as audio", () => {
    expect(parseDeviceType("Icon: audio-headphone")).toBe("audio");
  });

  it("classifies headset (bare) as audio", () => {
    expect(parseDeviceType("Icon: headset")).toBe("audio");
  });

  it("classifies input-gaming as input", () => {
    expect(parseDeviceType("Icon: input-gaming")).toBe("input");
  });

  it("classifies joystick as input", () => {
    expect(parseDeviceType("Icon: joystick")).toBe("input");
  });

  it("classifies gamepad as input", () => {
    expect(parseDeviceType("Icon: gamepad")).toBe("input");
  });

  it("classifies input-keyboard as keyboard", () => {
    expect(parseDeviceType("Icon: input-keyboard")).toBe("keyboard");
  });

  it("classifies keyboard (bare) as keyboard", () => {
    expect(parseDeviceType("Icon: keyboard")).toBe("keyboard");
  });

  it("classifies phone as unknown", () => {
    expect(parseDeviceType("Icon: phone")).toBe("unknown");
  });

  it("returns unknown when no Icon field present", () => {
    expect(parseDeviceType("Paired: yes\nConnected: no\n")).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// parseDeviceList
// ---------------------------------------------------------------------------

describe("parseDeviceList()", () => {
  it("returns empty array for empty output", () => {
    expect(parseDeviceList("")).toEqual([]);
  });

  it("parses a single Device line", () => {
    const result = parseDeviceList("Device AA:BB:CC:DD:EE:FF Sony WH-1000XM5\n");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ mac: "AA:BB:CC:DD:EE:FF", name: "Sony WH-1000XM5" });
  });

  it("parses multiple Device lines", () => {
    const output = [
      "Device AA:BB:CC:DD:EE:01 Xbox Controller",
      "Device AA:BB:CC:DD:EE:02 Keychron K2",
    ].join("\n");
    const result = parseDeviceList(output);
    expect(result).toHaveLength(2);
    expect(result[0].mac).toBe("AA:BB:CC:DD:EE:01");
    expect(result[1].mac).toBe("AA:BB:CC:DD:EE:02");
  });

  it("skips non-Device lines", () => {
    const output = [
      "Device AA:BB:CC:DD:EE:FF Headphones",
      "some garbage line",
      "",
      "not a device line at all",
    ].join("\n");
    const result = parseDeviceList(output);
    expect(result).toHaveLength(1);
    expect(result[0].mac).toBe("AA:BB:CC:DD:EE:FF");
  });

  it("skips malformed Device lines (short MAC)", () => {
    const result = parseDeviceList("Device AA:BB:CC Short\n");
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parseDeviceInfo
// ---------------------------------------------------------------------------

describe("parseDeviceInfo()", () => {
  it("detects connected=true, paired=true, type=audio", () => {
    const info = [
      "Icon: audio-headset",
      "Paired: yes",
      "Connected: yes",
    ].join("\n");
    const device = parseDeviceInfo("AA:BB:CC:DD:EE:FF", "Sony WH-1000XM5", info);
    expect(device).toEqual({
      mac: "AA:BB:CC:DD:EE:FF",
      name: "Sony WH-1000XM5",
      connected: true,
      paired: true,
      type: "audio",
    });
  });

  it("detects connected=false, paired=false, type=unknown for empty info", () => {
    const device = parseDeviceInfo("11:22:33:44:55:66", "Gadget", "");
    expect(device.connected).toBe(false);
    expect(device.paired).toBe(false);
    expect(device.type).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// parseAdapterInfo
// ---------------------------------------------------------------------------

describe("parseAdapterInfo()", () => {
  it("parses powered=true, discovering=true", () => {
    const output = [
      "Controller AA:BB:CC:DD:EE:FF BlueZ 5.66 [default]",
      "\tName: deck-bluetooth",
      "\tPowered: yes",
      "\tDiscovering: yes",
    ].join("\n");
    const info = parseAdapterInfo(output);
    expect(info.powered).toBe(true);
    expect(info.discovering).toBe(true);
    expect(info.name).toBe("deck-bluetooth");
    expect(info.address).toBe("AA:BB:CC:DD:EE:FF");
  });

  it("returns defaults for empty output", () => {
    const info = parseAdapterInfo("");
    expect(info.powered).toBe(false);
    expect(info.discovering).toBe(false);
    expect(info.name).toBe("Unknown");
    expect(info.address).toBe("Unknown");
  });

  it("detects powered=false, discovering=false", () => {
    const output = [
      "Controller 00:11:22:33:44:55 BlueZ",
      "\tName: my-adapter",
      "\tPowered: no",
      "\tDiscovering: no",
    ].join("\n");
    const info = parseAdapterInfo(output);
    expect(info.powered).toBe(false);
    expect(info.discovering).toBe(false);
  });
});
