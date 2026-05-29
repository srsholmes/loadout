import { describe, it, expect } from "bun:test";
import {
  OXP_VID,
  OXP_PID,
  OXP_EFFECTS,
  OXP_MODES,
  ALL_MODES,
  COLOR_PRESETS,
  oxpCmd,
  oxpBrightnessLevel,
  oxpBrightnessCode,
  clamp,
  toHex,
} from "./oxp";

describe("OXP protocol constants", () => {
  it("targets the OneXPlayer Apex VID:PID", () => {
    expect(OXP_VID).toBe("1A2C");
    expect(OXP_PID).toBe("B001");
  });

  it("includes the documented effect codes", () => {
    // Spot-check the effect codes used by setMode() against the
    // firmware reference (HHD parity). If any of these drift the
    // hardware will silently render the wrong effect.
    expect(OXP_EFFECTS.aurora).toBe(0x01);
    expect(OXP_EFFECTS.cyberpunk).toBe(0x09);
    expect(OXP_EFFECTS.monster_woke).toBe(0x0D);
  });

  it("OXP_MODES is static + off + every effect, no duplicates", () => {
    expect(OXP_MODES[0]).toBe("static");
    expect(OXP_MODES[1]).toBe("off");
    for (const effect of Object.keys(OXP_EFFECTS)) {
      expect(OXP_MODES).toContain(effect);
    }
    expect(new Set(OXP_MODES).size).toBe(OXP_MODES.length);
  });

  it("ALL_MODES covers the cross-driver fallback set", () => {
    expect([...ALL_MODES]).toEqual(["static", "breathing", "rainbow", "off"]);
  });

  it("COLOR_PRESETS includes Red/Green/Blue/Off as documented", () => {
    const red = COLOR_PRESETS.find((p) => p.name === "Red");
    expect(red).toEqual({ name: "Red", r: 255, g: 0, b: 0 });
    const off = COLOR_PRESETS.find((p) => p.name === "Off");
    expect(off).toEqual({ name: "Off", r: 0, g: 0, b: 0 });
  });
});

describe("oxpCmd", () => {
  it("produces a 64-byte buffer with cid, 0xFF prefix, then payload", () => {
    const buf = oxpCmd(0x07, [0xFE, 0x11, 0x22, 0x33]);
    expect(buf.length).toBe(64);
    expect(buf[0]).toBe(0x07);
    expect(buf[1]).toBe(0xFF);
    expect(buf[2]).toBe(0xFE);
    expect(buf[3]).toBe(0x11);
    expect(buf[4]).toBe(0x22);
    expect(buf[5]).toBe(0x33);
  });

  it("zero-pads the tail when payload is short", () => {
    const buf = oxpCmd(0x07, [0xFD, 1, 5, 4]);
    // Tail beyond the payload must be zero (Buffer.alloc fills with 0).
    for (let i = 6; i < 64; i++) {
      expect(buf[i]).toBe(0);
    }
  });

  it("accepts an empty payload (just the framing prefix)", () => {
    const buf = oxpCmd(0x01, []);
    expect(buf.length).toBe(64);
    expect(buf[0]).toBe(0x01);
    expect(buf[1]).toBe(0xFF);
    expect(buf[2]).toBe(0);
  });

  it("matches the solid-colour framing the backend builds", () => {
    // The solid-colour payload is `[0xFE, R, G, B × 20, 0x00]` —
    // verify the marker + first triplet land where we expect them.
    const payload: number[] = [0xFE];
    for (let i = 0; i < 20; i++) payload.push(255, 0, 0);
    payload.push(0x00);
    const buf = oxpCmd(0x07, payload);
    expect(buf[2]).toBe(0xFE);
    expect(buf[3]).toBe(255);
    expect(buf[4]).toBe(0);
    expect(buf[5]).toBe(0);
  });
});

describe("oxpBrightnessLevel + oxpBrightnessCode", () => {
  it("maps 0–33 to low (0x01)", () => {
    expect(oxpBrightnessLevel(0)).toBe("low");
    expect(oxpBrightnessLevel(20)).toBe("low");
    expect(oxpBrightnessLevel(33)).toBe("low");
    expect(oxpBrightnessCode("low")).toBe(0x01);
  });

  it("maps 34–66 to medium (0x03)", () => {
    expect(oxpBrightnessLevel(34)).toBe("medium");
    expect(oxpBrightnessLevel(50)).toBe("medium");
    expect(oxpBrightnessLevel(66)).toBe("medium");
    expect(oxpBrightnessCode("medium")).toBe(0x03);
  });

  it("maps 67–100 to high (0x04)", () => {
    expect(oxpBrightnessLevel(67)).toBe("high");
    expect(oxpBrightnessLevel(100)).toBe("high");
    expect(oxpBrightnessCode("high")).toBe(0x04);
  });
});

describe("clamp", () => {
  it("returns the value unchanged inside the range", () => {
    expect(clamp(50, 0, 100)).toBe(50);
    expect(clamp(0, 0, 100)).toBe(0);
    expect(clamp(100, 0, 100)).toBe(100);
  });

  it("clips below min to min", () => {
    expect(clamp(-10, 0, 100)).toBe(0);
    expect(clamp(-1, 0, 255)).toBe(0);
  });

  it("clips above max to max", () => {
    expect(clamp(300, 0, 255)).toBe(255);
    expect(clamp(150, 0, 100)).toBe(100);
  });
});

describe("toHex", () => {
  it("formats a colour as six lowercase hex chars", () => {
    expect(toHex(0, 0, 0)).toBe("000000");
    expect(toHex(255, 255, 255)).toBe("ffffff");
    expect(toHex(255, 0, 0)).toBe("ff0000");
    expect(toHex(0, 255, 0)).toBe("00ff00");
    expect(toHex(0, 0, 255)).toBe("0000ff");
  });

  it("zero-pads single-digit channels", () => {
    expect(toHex(1, 2, 3)).toBe("010203");
    expect(toHex(15, 15, 15)).toBe("0f0f0f");
  });
});
