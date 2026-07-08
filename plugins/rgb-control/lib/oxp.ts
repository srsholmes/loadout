/**
 * Pure-logic helpers for the OneXPlayer (OXP) HID V2 RGB protocol and
 * the cross-driver colour utilities the backend uses.
 *
 * Anything here is dependency-free (no `this`, no `fs`, no `Bun`,
 * no `run`) — easy to unit-test without mocks. Backend = I/O + RPC
 * plumbing; pure logic lives here.
 *
 * ── OXP HID V2 Protocol ──
 * OneXPlayer Apex RGB controller — VID 0x1A2C, PID 0xB001 — speaks a
 * V2 framing: 64-byte HID output reports of the form
 *     [cid, 0xFF, ...payload, 0x00 padding]
 *
 * Solid colour: cmd 0x07, payload `[0xFE, R,G,B × 20, 0x00]`.
 * Brightness:   cmd 0x07, payload `[0xFD, enabled, 0x05, level_code]`.
 * Effect:       cmd 0x07, payload `[effect_code]`.
 */

/** OneXPlayer Apex RGB controller — USB VID / PID strings for `/sys/bus/hid/devices`. */
export const OXP_VID = "1A2C";
export const OXP_PID = "B001";

/** OXP effect presets sent via command ID 0x07. */
export const OXP_EFFECTS: Record<string, number> = {
  aurora: 0x01,
  flowing: 0x03,
  neon: 0x05,
  dreamy: 0x07,
  sun: 0x08,
  cyberpunk: 0x09,
  sunset: 0x0B,
  colorful: 0x0C,
  monster_woke: 0x0D,
};

/** Mode list for the OXP driver — `static` and `off` plus every named effect. */
export const OXP_MODES = ["static", "off", ...Object.keys(OXP_EFFECTS)] as const;

/** Fallback mode list for drivers without their own enum (OpenRGB, sysfs, platform). */
export const ALL_MODES = ["static", "breathing", "rainbow", "off"] as const;

export interface Preset {
  name: string;
  r: number;
  g: number;
  b: number;
}

/** Built-in colour presets exposed by `getPresets()`. */
export const COLOR_PRESETS: Preset[] = [
  { name: "Red", r: 255, g: 0, b: 0 },
  { name: "Green", r: 0, g: 255, b: 0 },
  { name: "Blue", r: 0, g: 0, b: 255 },
  { name: "Purple", r: 128, g: 0, b: 255 },
  { name: "Cyan", r: 0, g: 255, b: 255 },
  { name: "Orange", r: 255, g: 100, b: 0 },
  { name: "White", r: 255, g: 255, b: 255 },
  { name: "Off", r: 0, g: 0, b: 0 },
];

/**
 * Build a 64-byte V2 HID command: `[cid, 0xFF, ...payload]` with the
 * tail zero-padded. Caller writes the returned buffer to the hidraw
 * node.
 */
export function oxpCmd(cid: number, payload: number[]): Buffer {
  const buf = Buffer.alloc(64);
  buf[0] = cid;
  buf[1] = 0xFF;
  for (let i = 0; i < payload.length; i++) buf[2 + i] = payload[i]!; // i < length
  return buf;
}

/**
 * Encode a brightness percentage (0–100) into the OXP three-level
 * code. The firmware only honours low (0x01), medium (0x03), and
 * high (0x04). Boundaries match the original mapping:
 * 0–33 → low, 34–66 → medium, 67–100 → high.
 */
export function oxpBrightnessLevel(percent: number): "low" | "medium" | "high" {
  if (percent <= 33) return "low";
  if (percent <= 66) return "medium";
  return "high";
}

/** Map the OXP brightness level to its firmware payload byte. */
export function oxpBrightnessCode(level: "low" | "medium" | "high"): number {
  return level === "low" ? 0x01 : level === "medium" ? 0x03 : 0x04;
}

/** Clamp `value` to the closed `[min, max]` interval. */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Format an 8-bit-per-channel colour as a lowercase 6-char hex string (no `#`). */
export function toHex(r: number, g: number, b: number): string {
  return (
    r.toString(16).padStart(2, "0") +
    g.toString(16).padStart(2, "0") +
    b.toString(16).padStart(2, "0")
  );
}
