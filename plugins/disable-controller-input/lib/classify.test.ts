import { describe, it, expect } from "bun:test";
import {
  normalizeBusType,
  normalizeId,
  classifyComposite,
  type SourceFacts,
} from "./classify";

describe("normalizeBusType", () => {
  it("recognizes USB across name / decimal / hex renderings", () => {
    expect(normalizeBusType("usb")).toBe("usb");
    expect(normalizeBusType("USB")).toBe("usb");
    expect(normalizeBusType("3")).toBe("usb");
    expect(normalizeBusType("0003")).toBe("usb");
    expect(normalizeBusType("0x03")).toBe("usb");
  });

  it("recognizes Bluetooth", () => {
    expect(normalizeBusType("bluetooth")).toBe("bluetooth");
    expect(normalizeBusType("5")).toBe("bluetooth");
    expect(normalizeBusType("0005")).toBe("bluetooth");
    expect(normalizeBusType("0x05")).toBe("bluetooth");
  });

  it("maps internal buses (I2C / HOST)", () => {
    expect(normalizeBusType("i2c")).toBe("internal");
    expect(normalizeBusType("0x18")).toBe("internal"); // BUS_I2C
    expect(normalizeBusType("24")).toBe("internal"); // 0x18 decimal
    expect(normalizeBusType("0x19")).toBe("internal"); // BUS_HOST
    expect(normalizeBusType("host")).toBe("internal");
  });

  it("maps the virtual bus", () => {
    expect(normalizeBusType("virtual")).toBe("virtual");
    expect(normalizeBusType("6")).toBe("virtual");
    expect(normalizeBusType("0x06")).toBe("virtual");
  });

  it("returns unknown for empty / null / unrecognized", () => {
    expect(normalizeBusType(null)).toBe("unknown");
    expect(normalizeBusType("")).toBe("unknown");
    expect(normalizeBusType("99")).toBe("unknown");
    expect(normalizeBusType("nonsense")).toBe("unknown");
  });
});

describe("normalizeId", () => {
  it("passes through a 4-char hex id", () => {
    expect(normalizeId("28de")).toBe("28de");
  });

  it("strips a 0x prefix", () => {
    expect(normalizeId("0x28de")).toBe("28de");
  });

  it("zero-pads a short hex id", () => {
    expect(normalizeId("45e")).toBe("045e");
  });

  it("parses a non-4-char decimal rendering", () => {
    // 0x28de == 10462 decimal. A 5-digit token can't be a 4-hex id, so
    // it's unambiguously decimal. (4-char numeric tokens are treated as
    // hex — matching busctl's usual "045e"-style rendering.)
    expect(normalizeId("10462")).toBe("28de");
  });

  it("returns null for unparseable input", () => {
    expect(normalizeId(null)).toBeNull();
    expect(normalizeId("")).toBeNull();
    expect(normalizeId("zzzz")).toBeNull();
  });
});

const src = (
  idBustype: string | null,
  idVendor: string | null,
  idProduct: string | null,
  deviceClass: string | null = null,
): SourceFacts => ({ idBustype, idVendor, idProduct, deviceClass });

describe("classifyComposite", () => {
  it("treats an internal-bus Steam Deck pad as a non-external gamepad", () => {
    const r = classifyComposite(
      [src("0x18", "28de", "1205", "gamepad")],
      ["Gamepad:Button:South"],
    );
    expect(r.isGamepad).toBe(true);
    expect(r.isExternal).toBe(false);
  });

  it("treats a USB Steam Deck pad as built-in via the VID/PID table", () => {
    // Steam Deck exposes its internal pad on USB — bus type alone would
    // call it external, the known-built-in table corrects that.
    const r = classifyComposite([src("usb", "28de", "1205", "gamepad")]);
    expect(r.isExternal).toBe(false);
  });

  it("flags a USB Xbox controller as external", () => {
    const r = classifyComposite(
      [src("usb", "045e", "028e", "gamepad")],
      ["Gamepad:Button:South"],
    );
    expect(r.isGamepad).toBe(true);
    expect(r.isExternal).toBe(true);
  });

  it("flags a Bluetooth controller as external", () => {
    const r = classifyComposite([src("bluetooth", "054c", "0ce6", "gamepad")]);
    expect(r.isExternal).toBe(true);
  });

  it("never treats the Steam virtual pad as external", () => {
    const r = classifyComposite([src("usb", "28de", "11ff", "gamepad")]);
    expect(r.isExternal).toBe(false);
  });

  it("never treats a virtual-bus target as external", () => {
    const r = classifyComposite([src("virtual", "045e", "028e", "gamepad")]);
    expect(r.isExternal).toBe(false);
  });

  it("uses CompositeDevice capabilities as the gamepad signal when DeviceClass is absent", () => {
    const r = classifyComposite([src("usb", "045e", "028e", null)], [
      "Gamepad:Button:South",
      "Gamepad:Axis:LeftStick",
    ]);
    expect(r.isGamepad).toBe(true);
    expect(r.isExternal).toBe(true);
  });

  it("classifies a non-gamepad (keyboard) as not a gamepad", () => {
    const r = classifyComposite([src("usb", "046d", "c52b", "keyboard")], [
      "Keyboard:KeyEsc",
    ]);
    expect(r.isGamepad).toBe(false);
  });

  it("treats a multi-source device with one external USB source as external", () => {
    const r = classifyComposite([
      src("0x18", "28de", "1205", "gamepad"),
      src("usb", "045e", "028e", "gamepad"),
    ]);
    expect(r.isExternal).toBe(true);
  });

  it("never marks an unknown-bus device external (conservative)", () => {
    const r = classifyComposite([src("99", "1234", "5678", "gamepad")]);
    expect(r.isExternal).toBe(false);
  });
});
