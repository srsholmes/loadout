import { describe, it, expect } from "bun:test";
import {
  deviceTypeFromIcon,
  parseBoolProp,
  parseStringProp,
  splitPropLines,
  macFromDevicePath,
  devicePathFromMac,
  pickAdapterPath,
  pickDevicePaths,
} from "./parse";

describe("deviceTypeFromIcon", () => {
  it("maps audio icons", () => {
    expect(deviceTypeFromIcon("audio-headset")).toBe("audio");
    expect(deviceTypeFromIcon("audio-headphones")).toBe("audio");
  });
  it("maps gaming input icons", () => {
    expect(deviceTypeFromIcon("input-gaming")).toBe("input");
  });
  it("maps keyboard icons", () => {
    expect(deviceTypeFromIcon("input-keyboard")).toBe("keyboard");
  });
  it("falls back to unknown", () => {
    expect(deviceTypeFromIcon("phone")).toBe("unknown");
    expect(deviceTypeFromIcon("")).toBe("unknown");
  });
});

describe("parseBoolProp", () => {
  it("parses true / false", () => {
    expect(parseBoolProp("b true")).toBe(true);
    expect(parseBoolProp("b false")).toBe(false);
    expect(parseBoolProp("  b true  ")).toBe(true);
  });
  it("returns null for non-bool lines", () => {
    expect(parseBoolProp('s "x"')).toBeNull();
    expect(parseBoolProp("")).toBeNull();
    expect(parseBoolProp("b maybe")).toBeNull();
  });
});

describe("parseStringProp", () => {
  it("parses a quoted string", () => {
    expect(parseStringProp('s "steamdeck"')).toBe("steamdeck");
    expect(parseStringProp('s "Xbox Wireless Controller"')).toBe(
      "Xbox Wireless Controller",
    );
  });
  it("unescapes quotes and backslashes", () => {
    expect(parseStringProp('s "a\\"b"')).toBe('a"b');
  });
  it("returns null for non-string lines", () => {
    expect(parseStringProp("b true")).toBeNull();
    expect(parseStringProp("")).toBeNull();
  });
});

describe("splitPropLines", () => {
  it("splits multi-property output in order, dropping blanks", () => {
    expect(splitPropLines('b true\nb false\ns "steamdeck"\n\n')).toEqual([
      "b true",
      "b false",
      's "steamdeck"',
    ]);
  });
});

describe("macFromDevicePath", () => {
  it("extracts and colon-formats the MAC", () => {
    expect(macFromDevicePath("/org/bluez/hci0/dev_AA_BB_CC_DD_EE_0B")).toBe(
      "AA:BB:CC:DD:EE:0B",
    );
  });
  it("upper-cases lowercase hex", () => {
    expect(macFromDevicePath("/org/bluez/hci0/dev_aa_bb_cc_dd_ee_ff")).toBe(
      "AA:BB:CC:DD:EE:FF",
    );
  });
  it("returns null for non-device paths", () => {
    expect(macFromDevicePath("/org/bluez/hci0")).toBeNull();
    expect(macFromDevicePath("/org/bluez")).toBeNull();
  });
});

describe("devicePathFromMac", () => {
  it("builds the object path under an adapter", () => {
    expect(devicePathFromMac("/org/bluez/hci0", "AA:BB:CC:DD:EE:0B")).toBe(
      "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_0B",
    );
  });
  it("upper-cases the MAC", () => {
    expect(devicePathFromMac("/org/bluez/hci0", "aa:bb:cc:dd:ee:ff")).toBe(
      "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF",
    );
  });
});

describe("pickAdapterPath", () => {
  const tree = [
    "/",
    "/org",
    "/org/bluez",
    "/org/bluez/hci0",
    "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_0B",
  ].join("\n");

  it("returns the first adapter path", () => {
    expect(pickAdapterPath(tree)).toBe("/org/bluez/hci0");
  });
  it("returns null when no adapter is present", () => {
    expect(pickAdapterPath("/\n/org\n/org/bluez")).toBeNull();
  });
});

describe("pickDevicePaths", () => {
  it("returns only device object paths", () => {
    const tree = [
      "/org/bluez/hci0",
      "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_0B",
      "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF",
    ].join("\n");
    expect(pickDevicePaths(tree)).toEqual([
      "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_0B",
      "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF",
    ]);
  });
  it("returns [] when there are no devices", () => {
    expect(pickDevicePaths("/org/bluez/hci0")).toEqual([]);
  });
});
