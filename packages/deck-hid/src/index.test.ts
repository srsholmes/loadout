/**
 * Pure unit tests for the Deck hidraw parser. No /sys or hidraw reads —
 * uevent content + frame buffers are hand-built. Verifies:
 *   - HID_ID / HID_PHYS parsing across formatting variation
 *   - Deck identification (Jupiter + Galileo, USB bus, interface 2 only)
 *   - Frame decode (only report 0x01, only at full length)
 *   - Transition diff (press vs release, no spam on held)
 *   - Coalesced-chunk splitting
 */

import { describe, it, expect } from "bun:test";
import {
  parseHidUEvent,
  isDeckGamepadInterface,
  decodeButtons,
  diffTransitions,
  splitReports,
  findButton,
  DECK_BUTTONS,
  REPORT_LEN,
  REPORT_ID_INPUT,
} from "./index";

const JUPITER_GAMEPAD_UEVENT = `\
DRIVER=hid-steam
HID_ID=0003:000028DE:00001205
HID_NAME=Valve Software Steam Deck Controller
HID_PHYS=usb-0000:04:00.4-3/input2
HID_UNIQ=
MODALIAS=hid:b0003g0001v000028DEp00001205
`;

const JUPITER_KEYBOARD_UEVENT = `\
DRIVER=hid-steam
HID_ID=0003:000028DE:00001205
HID_PHYS=usb-0000:04:00.4-3/input0
`;

const GALILEO_GAMEPAD_UEVENT = `\
DRIVER=hid-steam
HID_ID=0003:000028DE:00001206
HID_PHYS=usb-0000:04:00.4-3/input2
`;

const FOREIGN_PAD_UEVENT = `\
DRIVER=hid-generic
HID_ID=0003:0000054C:000005C4
HID_PHYS=usb-0000:01:00.0-1/input0
`;

describe("parseHidUEvent", () => {
  it("extracts bus / vendor / product / interface from a Deck gamepad uevent", () => {
    const ue = parseHidUEvent(JUPITER_GAMEPAD_UEVENT);
    expect(ue.bus).toBe(0x0003);
    expect(ue.vendor).toBe(0x28de);
    expect(ue.product).toBe(0x1205);
    expect(ue.interfaceNum).toBe(2);
  });

  it("tolerates trailing whitespace and blank lines", () => {
    const ue = parseHidUEvent("\nHID_ID=0003:000028DE:00001206  \n\nHID_PHYS=foo/input2 \n");
    expect(ue.product).toBe(0x1206);
    expect(ue.interfaceNum).toBe(2);
  });

  it("returns nulls when keys are absent", () => {
    const ue = parseHidUEvent("DRIVER=hid-generic\nNAME=something\n");
    expect(ue.hidId).toBeNull();
    expect(ue.bus).toBeNull();
    expect(ue.vendor).toBeNull();
    expect(ue.product).toBeNull();
    expect(ue.interfaceNum).toBeNull();
  });
});

describe("isDeckGamepadInterface", () => {
  it("accepts a Jupiter gamepad (interface 2)", () => {
    expect(isDeckGamepadInterface(parseHidUEvent(JUPITER_GAMEPAD_UEVENT))).toBe(true);
  });
  it("accepts a Galileo gamepad (interface 2)", () => {
    expect(isDeckGamepadInterface(parseHidUEvent(GALILEO_GAMEPAD_UEVENT))).toBe(true);
  });
  it("rejects the keyboard interface of the same controller", () => {
    expect(isDeckGamepadInterface(parseHidUEvent(JUPITER_KEYBOARD_UEVENT))).toBe(false);
  });
  it("rejects a foreign controller (Sony DS4) with the same bus", () => {
    expect(isDeckGamepadInterface(parseHidUEvent(FOREIGN_PAD_UEVENT))).toBe(false);
  });
});

describe("findButton", () => {
  it("finds Steam by name", () => {
    const b = findButton("Steam");
    expect(b).not.toBeNull();
    expect(b!.byte).toBe(9);
    expect(b!.bit).toBe(5);
  });
  it("returns null for unknown names", () => {
    expect(findButton("notabutton")).toBeNull();
    expect(findButton(null)).toBeNull();
  });
  it("covers every issue #86 bolded button", () => {
    // Smoke check: the picker list has these 9 names. If we drop one by
    // accident the picker silently loses an option — fail loudly.
    const names = DECK_BUTTONS.map((b) => b.name).sort();
    expect(names).toEqual(["A", "L4", "L5", "Menu", "Qam", "R4", "R5", "Steam", "View"]);
  });
});

// ── Frame fixtures ──────────────────────────────────────────────────────────

/** Build a 64-byte report 0x01 with the given byte overrides. All other bytes
 *  are zero, so the only buttons "set" are the ones the test explicitly
 *  overrides. */
function makeReport(overrides: Record<number, number> = {}): Buffer {
  const buf = Buffer.alloc(REPORT_LEN);
  buf[0] = REPORT_ID_INPUT;
  for (const [k, v] of Object.entries(overrides)) {
    buf[parseInt(k, 10)] = v;
  }
  return buf;
}

describe("decodeButtons", () => {
  it("returns null for a non-input report id", () => {
    const buf = Buffer.alloc(REPORT_LEN);
    buf[0] = 0x09; // some other report id
    expect(decodeButtons(buf)).toBeNull();
  });

  it("returns null for a short buffer", () => {
    expect(decodeButtons(Buffer.alloc(32))).toBeNull();
  });

  it("flags the Steam button when bit 5 of byte 9 is set", () => {
    const out = decodeButtons(makeReport({ 9: 0x20 }))!;
    expect(out.get("Steam")).toBe(true);
    expect(out.get("View")).toBe(false);
    expect(out.get("Menu")).toBe(false);
    expect(out.get("L5")).toBe(false);
  });

  it("decodes multiple buttons in the same byte independently", () => {
    // byte 9: View (bit 4) + Steam (bit 5) + Menu (bit 6) = 0x10|0x20|0x40 = 0x70
    const out = decodeButtons(makeReport({ 9: 0x70 }))!;
    expect(out.get("View")).toBe(true);
    expect(out.get("Steam")).toBe(true);
    expect(out.get("Menu")).toBe(true);
    expect(out.get("L5")).toBe(false);
  });

  it("decodes QAM at byte 14 bit 2", () => {
    expect(decodeButtons(makeReport({ 14: 0x04 }))!.get("Qam")).toBe(true);
  });

  it("decodes L4/R4 at byte 13", () => {
    const out = decodeButtons(makeReport({ 13: 0x06 }))!;
    expect(out.get("L4")).toBe(true);
    expect(out.get("R4")).toBe(true);
  });
});

describe("diffTransitions", () => {
  const idle = decodeButtons(makeReport())!;
  const steamPressed = decodeButtons(makeReport({ 9: 0x20 }))!;

  it("emits a press when a bit goes 0→1", () => {
    const tr = diffTransitions(idle, steamPressed);
    expect(tr).toEqual([{ name: "Steam", pressed: true }]);
  });

  it("emits a release when a bit goes 1→0", () => {
    const tr = diffTransitions(steamPressed, idle);
    expect(tr).toEqual([{ name: "Steam", pressed: false }]);
  });

  it("emits nothing while the button stays held", () => {
    expect(diffTransitions(steamPressed, steamPressed)).toEqual([]);
  });

  it("treats a null prev as all-zero (first frame)", () => {
    const tr = diffTransitions(null, steamPressed);
    expect(tr).toContainEqual({ name: "Steam", pressed: true });
    // Idle buttons don't emit because curVal===prevVal===false.
    expect(tr.filter((t) => t.pressed)).toHaveLength(1);
  });
});

describe("splitReports", () => {
  it("returns one report per 64 bytes", () => {
    const chunk = Buffer.concat([
      makeReport({ 9: 0x20 }),
      makeReport({ 14: 0x04 }),
    ]);
    const parts = splitReports(chunk);
    expect(parts).toHaveLength(2);
    expect(parts[0]![9]).toBe(0x20);
    expect(parts[1]![14]).toBe(0x04);
  });

  it("drops the trailing partial report on a short chunk", () => {
    const chunk = Buffer.concat([makeReport(), Buffer.alloc(13)]);
    expect(splitReports(chunk)).toHaveLength(1);
  });

  it("yields an empty array for a chunk shorter than one report", () => {
    expect(splitReports(Buffer.alloc(32))).toEqual([]);
  });
});
