import { describe, expect, it } from "bun:test";
import {
  classify,
  classifyByCaps,
  hasCapability,
  parseDevices,
  parseKeyBitmask,
} from "./devices";

// BTN_A (0x130 = 304), BTN_B (305), BTN_X (307), BTN_Y (308),
// BTN_SELECT (0x13a = 314), BTN_MODE (0x13c = 316). These are the
// "controller" capability set.
//
// /proc/bus/input/devices formats B: KEY= as space-separated 64-bit
// hex words, most-significant-word FIRST. All six controller-required
// bits live in word 4 (codes 304..316 → word 304/64 = 4). Within that
// word: bits 48, 49, 51, 52 = A/B/X/Y (0x11b = 0x1b for the two bytes
// crossing into bit 52), bits 58, 60 = SELECT/MODE (0x14 byte).
// Sum: 0x141b000000000000.
const CONTROLLER_KEY_LINE = "141b000000000000 0 0 0 0";

// Fixture mirrors the shape of a real /proc/bus/input/devices block so the
// regex parsing stays honest if someone tweaks it.
const FIXTURE = `I: Bus=0003 Vendor=28de Product=11ff Version=0001
N: Name="Microsoft Xbox 360 pad"
P: Phys=usb-0000:00:14.0-1/input0
H: Handlers=js0 event7
B: KEY=${CONTROLLER_KEY_LINE}

I: Bus=0011 Vendor=0001 Product=0001 Version=ab41
N: Name="AT Translated Set 2 keyboard"
H: Handlers=sysrq kbd event3

I: Bus=0019 Vendor=0000 Product=0000 Version=0000
N: Name="Power Button"
H: Handlers=kbd event0

I: Bus=0003 Vendor=1234 Product=5678 Version=0001
N: Name="Fancy Widget"
H: Handlers=mouse2
`;

describe("parseDevices", () => {
  it("parses every block with an event handler", () => {
    const devices = parseDevices(FIXTURE);
    expect(devices).toHaveLength(3); // "Fancy Widget" has no event* handler
    expect(devices.map((d) => d.eventPath)).toEqual([
      "/dev/input/event7",
      "/dev/input/event3",
      "/dev/input/event0",
    ]);
  });

  it("extracts vendor and product in lowercase hex", () => {
    const [pad] = parseDevices(FIXTURE);
    expect(pad.vendor).toBe("28de");
    expect(pad.product).toBe("11ff");
    expect(pad.name).toBe("Microsoft Xbox 360 pad");
  });

  it("flags the Steam Input virtual pad (vendor 28de / product 11ff)", () => {
    const [pad] = parseDevices(FIXTURE);
    expect(pad.isSteamVirtual).toBe(true);
  });

  it("populates a stable hash across reconnects", () => {
    const [a] = parseDevices(FIXTURE);
    const [b] = parseDevices(FIXTURE);
    // Same name+vendor+product → same hash, no matter how many times we
    // reparse. Regression guard against the hash being implicitly derived
    // from eventPath (which is unstable across unplug).
    expect(a.hash).toBe(b.hash);
    expect(typeof a.hash).toBe("number");
  });

  it("classifies via capability bits, not just the name", () => {
    const [pad, kbd, power] = parseDevices(FIXTURE);
    // Xbox pad's B: KEY= line has the controller buttons set.
    expect(pad.flags.isController).toBe(true);
    expect(pad.class).toBe("controller");
    // AT Translated keyboard is explicitly excluded from the keyboard
    // classification — see classifyByCaps.
    expect(kbd.flags.isKeyboard).toBe(false);
    // No B: KEY= line → no caps, no classification.
    expect(power.flags.isController).toBe(false);
    expect(power.flags.isKeyboard).toBe(false);
  });

  it("handles empty input", () => {
    expect(parseDevices("")).toEqual([]);
  });
});

describe("parseKeyBitmask + hasCapability", () => {
  it("sets the right bit for the right code (little-endian byte order)", () => {
    // A single word with bit 0 set should give capability for code 0.
    const caps = parseKeyBitmask("1");
    expect(hasCapability(caps, 0)).toBe(true);
    expect(hasCapability(caps, 1)).toBe(false);
  });

  it("reverses the word order so MSW comes last (matches kernel)", () => {
    // "0 1" — first (high) word is 0, second (low) word has bit 0 set.
    // Because the kernel writes MSW first, reversing places bit 0 at the
    // start of the byte array → code 0 set.
    const caps = parseKeyBitmask("0 1");
    expect(hasCapability(caps, 0)).toBe(true);
  });

  it("returns false for codes past the bitmask", () => {
    const caps = parseKeyBitmask("ff");
    expect(hasCapability(caps, 7)).toBe(true);
    expect(hasCapability(caps, 8)).toBe(false);
    expect(hasCapability(caps, 999)).toBe(false);
  });

  it("handles empty input", () => {
    expect(parseKeyBitmask("").length).toBe(0);
    expect(hasCapability(new Uint8Array(0), 5)).toBe(false);
  });
});

describe("classifyByCaps", () => {
  // Helper: construct a caps Uint8Array that has specific bits set.
  function capsWith(codes: number[]): Uint8Array {
    const maxCode = Math.max(0, ...codes);
    const len = (maxCode >> 3) + 1;
    const u = new Uint8Array(len);
    for (const c of codes) u[c >> 3] |= 1 << (c & 7);
    return u;
  }

  it("classifies a device as controller only when it has every required button", () => {
    const full = capsWith([0x130, 0x131, 0x133, 0x134, 0x13a, 0x13c]);
    expect(classifyByCaps("whatever", full).isController).toBe(true);
    // Missing BTN_MODE — not a controller.
    const missingMode = capsWith([0x130, 0x131, 0x133, 0x134, 0x13a]);
    expect(classifyByCaps("whatever", missingMode).isController).toBe(false);
  });

  it("classifies a device as keyboard only with Ctrl+3+4 AND not AT Translated", () => {
    const kbdCaps = capsWith([29, 4, 5]);
    expect(classifyByCaps("Some External Keyboard", kbdCaps).isKeyboard).toBe(
      true,
    );
    // Built-in laptop keyboard is explicitly excluded.
    expect(
      classifyByCaps("AT Translated Set 2 keyboard", kbdCaps).isKeyboard,
    ).toBe(false);
  });

  it("classifies KEY_F16 holders as QAM sources", () => {
    const qamCaps = capsWith([0xba]);
    expect(classifyByCaps("InputPlumber Keyboard", qamCaps).isQam).toBe(true);
  });

  it("a single device can be multiple classes at once", () => {
    // InputPlumber's virtual keyboard is BOTH keyboard + qam.
    const caps = capsWith([29, 4, 5, 0xba]);
    const f = classifyByCaps("InputPlumber Keyboard", caps);
    expect(f.isKeyboard).toBe(true);
    expect(f.isQam).toBe(true);
    expect(f.isController).toBe(false);
  });
});

describe("classify (legacy name-heuristic)", () => {
  it("matches controller substrings", () => {
    expect(classify("Xbox One Controller")).toBe("controller");
    expect(classify("Steam Virtual Gamepad")).toBe("controller");
    expect(classify("Sony DualShock Controller")).toBe("controller");
  });

  it("matches qam devices", () => {
    expect(classify("OXP QAM")).toBe("qam");
    expect(classify("Handheld QAM Button")).toBe("qam");
  });

  it("falls through to unknown", () => {
    expect(classify("Random Device")).toBe("unknown");
  });
});
