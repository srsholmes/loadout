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
  decodeNavState,
  diffTransitions,
  splitReports,
  findButton,
  DECK_BUTTONS,
  REPORT_LEN,
  REPORT_ID_INPUT,
  REPORT_TYPE_DECK_STATE,
  isDeckStateReport,
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
/** A realistic Deck state frame. The header matters: a real frame is
 *  `01 00 09 40` — version 0x0001, ucType 0x09 (ID_CONTROLLER_DECK_STATE),
 *  payload length 0x40. Fixtures used to emit `01 00 00 00`, which no real
 *  controller sends, so they could not catch the decoder accepting the wrong
 *  report type. Pass `2: <other>` to forge a different ucType. */
function makeReport(overrides: Record<number, number> = {}): Buffer {
  const buf = Buffer.alloc(REPORT_LEN);
  buf[0] = REPORT_ID_INPUT;
  buf[1] = 0x00;
  buf[2] = REPORT_TYPE_DECK_STATE;
  buf[3] = 0x40;
  for (const [k, v] of Object.entries(overrides)) {
    buf[parseInt(k, 10)] = v;
  }
  return buf;
}

describe("decodeButtons", () => {
  it("returns null for a non-state report type", () => {
    // Forge ucType (byte 2), NOT byte 0. Byte 0 is the protocol version and
    // is 0x01 on every Valve in-report, so a fixture that changed it was
    // testing a case the hardware never produces — which is how the decoder
    // shipped accepting every report type.
    const buf = makeReport({ 2: 0x0b });
    expect(buf[0]).toBe(REPORT_ID_INPUT); // still a valid-looking header
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

describe("decodeNavState", () => {
  it("returns null for non-state report types and short buffers", () => {
    // A sensor/feature report carries a real header and real-looking payload
    // bytes; only ucType tells it apart. Decoding one as gamepad state is
    // what produced phantom presses / stick snaps on a real Deck.
    const sensors = makeReport({ 2: 0x0b, 8: 0xff, 9: 0xff, 48: 0xff, 49: 0x7f });
    expect(decodeNavState(sensors)).toBeNull();
    expect(decodeNavState(Buffer.alloc(32))).toBeNull();
  });

  it("decodes a neutral frame to all-false / centered", () => {
    const s = decodeNavState(makeReport())!;
    for (const k of [
      "a", "b", "x", "y", "l1", "r1",
      "dpadUp", "dpadDown", "dpadLeft", "dpadRight",
      "view", "menu", "steam", "qam",
    ] as const) {
      expect(s[k]).toBe(false);
    }
    expect(s.lx).toBe(0);
    expect(s.ly).toBe(0);
    expect(s.rx).toBe(0);
    expect(s.ry).toBe(0);
  });

  it("decodes each face/shoulder button bit of byte 8 individually", () => {
    expect(decodeNavState(makeReport({ 8: 1 << 2 }))!.r1).toBe(true);
    expect(decodeNavState(makeReport({ 8: 1 << 3 }))!.l1).toBe(true);
    expect(decodeNavState(makeReport({ 8: 1 << 4 }))!.y).toBe(true);
    expect(decodeNavState(makeReport({ 8: 1 << 5 }))!.b).toBe(true);
    expect(decodeNavState(makeReport({ 8: 1 << 6 }))!.x).toBe(true);
    expect(decodeNavState(makeReport({ 8: 1 << 7 }))!.a).toBe(true);
  });

  it("decodes each d-pad / system button bit of byte 9 individually", () => {
    expect(decodeNavState(makeReport({ 9: 1 << 0 }))!.dpadUp).toBe(true);
    expect(decodeNavState(makeReport({ 9: 1 << 1 }))!.dpadRight).toBe(true);
    expect(decodeNavState(makeReport({ 9: 1 << 2 }))!.dpadLeft).toBe(true);
    expect(decodeNavState(makeReport({ 9: 1 << 3 }))!.dpadDown).toBe(true);
    expect(decodeNavState(makeReport({ 9: 1 << 4 }))!.view).toBe(true);
    expect(decodeNavState(makeReport({ 9: 1 << 5 }))!.steam).toBe(true);
    expect(decodeNavState(makeReport({ 9: 1 << 6 }))!.menu).toBe(true);
  });

  it("decodes the Quick Access button (byte 14 bit 2)", () => {
    expect(decodeNavState(makeReport({ 14: 1 << 2 }))!.qam).toBe(true);
  });

  it("agrees with decodeButtons on every overlapping bit", () => {
    // Cross-validation: the wake table and the nav decoder must never drift.
    const frame = makeReport({ 8: 0x80, 9: 0x70, 14: 0x04 }); // A, View+Steam+Menu, Qam
    const wake = decodeButtons(frame)!;
    const nav = decodeNavState(frame)!;
    expect(nav.a).toBe(wake.get("A")!);
    expect(nav.view).toBe(wake.get("View")!);
    expect(nav.steam).toBe(wake.get("Steam")!);
    expect(nav.menu).toBe(wake.get("Menu")!);
    expect(nav.qam).toBe(wake.get("Qam")!);
  });

  it("normalizes sticks and flips Y to the evdev down-positive convention", () => {
    const frame = makeReport();
    frame.writeInt16LE(32767, 48);  // LX full right
    frame.writeInt16LE(32767, 50);  // LY full up (HID convention)
    frame.writeInt16LE(-32768, 52); // RX full left
    frame.writeInt16LE(-32768, 54); // RY full down (HID convention)
    const s = decodeNavState(frame)!;
    expect(s.lx).toBeCloseTo(1, 3);
    expect(s.ly).toBeCloseTo(-1, 3); // up → negative after flip
    expect(s.rx).toBeCloseTo(-1, 2);
    expect(s.ry).toBeCloseTo(1, 2);  // down → positive after flip
    // int16 min overshoots -1 slightly before clamping; verify the clamp.
    expect(s.rx).toBeGreaterThanOrEqual(-1);
    expect(s.ry).toBeLessThanOrEqual(1);
  });

  it("leaves centered sticks at exactly 0", () => {
    const frame = makeReport({ 8: 0xff });
    expect(decodeNavState(frame)!.lx).toBe(0);
  });
});

describe("isDeckStateReport", () => {
  it("accepts a real state frame header (01 00 09 40)", () => {
    expect(isDeckStateReport(makeReport())).toBe(true);
  });

  it("rejects every other ucType while byte 0 still reads 0x01", () => {
    // The regression guard: byte 0 alone cannot discriminate, so each of
    // these would have been decoded as gamepad state before the fix.
    for (const ucType of [0x01, 0x02, 0x0b, 0x0f, 0xff]) {
      if (ucType === REPORT_TYPE_DECK_STATE) continue;
      const forged = makeReport({ 2: ucType });
      expect(forged[0]).toBe(REPORT_ID_INPUT);
      expect(isDeckStateReport(forged)).toBe(false);
    }
  });

  it("rejects a wrong protocol version", () => {
    expect(isDeckStateReport(makeReport({ 0: 0x02 }))).toBe(false);
    expect(isDeckStateReport(makeReport({ 1: 0x01 }))).toBe(false);
  });

  it("rejects a short buffer", () => {
    expect(isDeckStateReport(Buffer.alloc(REPORT_LEN - 1))).toBe(false);
  });
});
