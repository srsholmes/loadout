/**
 * Steam Deck native HID protocol — discovery + frame parser.
 *
 * The Deck's controller is exposed via the kernel hid-steam driver at three
 * /dev/hidraw nodes (keyboard, mouse, gamepad). Multiple processes can read
 * the same hidraw concurrently — it's not exclusive like EVIOCGRAB on evdev.
 * Steam Input reads from it, and we read in parallel without disrupting it.
 *
 * This module is pure: no fs writes, no spawns, no globals. It only reads
 * /sys to discover the right hidraw node and decodes frame buffers. The
 * runtime stream watcher lives in apps/loadout-overlay/src/bun/native.
 *
 * References:
 *   - InputPlumber drivers/steam_deck/driver.rs (GPL-3.0) — authoritative
 *     bit-position reference.
 *   - issue #86 in this repo — empirically verified bit map from a spike
 *     on a Jupiter Deck (Jun 2026).
 */

import { readFile, readdir } from "node:fs/promises";

// ── Identity ────────────────────────────────────────────────────────────────

const VENDOR_VALVE = 0x28de;
const PRODUCT_JUPITER = 0x1205;
const PRODUCT_GALILEO = 0x1206;

/** Bus type 0x0003 = USB. Internal Deck controller appears as USB to userspace
 *  even though it's an SoC bus internally — the kernel hid-steam driver
 *  presents it that way. External Steam Controllers also bus 0x0003. */
const BUS_USB = 0x0003;

/** Steam Deck HID gamepad report ID. The hidraw stream interleaves a few
 *  report types; only 0x01 carries button + axis state. */
export const REPORT_ID_INPUT = 0x01;

/** Every input report is 64 bytes. */
export const REPORT_LEN = 64;

// ── Button bit map (issue #86, verified on a Jupiter Deck) ─────────────────

/** Buttons we surface in the picker. Excludes axis-derived and gameplay-core
 *  buttons (A/B/X/Y/L1/R1/L2/R2/dpad/stick clicks). Bolded rows from the
 *  issue's bit-map table.
 *
 *  `byte` is the offset into the 64-byte report; `bit` is the bit position
 *  within that byte (0 = LSB). `name` is the opaque id we round-trip through
 *  the picker (`raw` in WakeButtonOption). */
export interface DeckButton {
  /** Stable opaque id. Used as WakeButtonOption.raw. */
  name: string;
  /** Human label. */
  label: string;
  /** Byte offset (0..63). */
  byte: number;
  /** Bit position within that byte (0..7). */
  bit: number;
}

export const DECK_BUTTONS: readonly DeckButton[] = [
  { name: "Steam", label: "Steam Button", byte: 9, bit: 5 },
  { name: "Qam", label: "Quick Access (…) Button", byte: 14, bit: 2 },
  { name: "View", label: "View (Select)", byte: 9, bit: 4 },
  { name: "Menu", label: "Menu (Start)", byte: 9, bit: 6 },
  { name: "L4", label: "Left Back Paddle (L4)", byte: 13, bit: 1 },
  { name: "L5", label: "Left Back Paddle (L5)", byte: 9, bit: 7 },
  { name: "R4", label: "Right Back Paddle (R4)", byte: 13, bit: 2 },
  { name: "R5", label: "Right Back Paddle (R5)", byte: 10, bit: 0 },
  { name: "A", label: "A Button", byte: 8, bit: 7 },
];

/** Lookup index for parsing — byte → list of (bit, name). Built once, reused
 *  by frame-decode hot path. */
export const DECK_BUTTONS_BY_BYTE: ReadonlyMap<number, ReadonlyArray<{ bit: number; name: string }>> =
  (() => {
    const m = new Map<number, { bit: number; name: string }[]>();
    for (const b of DECK_BUTTONS) {
      const list = m.get(b.byte) ?? [];
      list.push({ bit: b.bit, name: b.name });
      m.set(b.byte, list);
    }
    return m;
  })();

/** Find a button definition by name. Returns null for unknown — callers
 *  should treat that as "no binding". */
export function findButton(name: string | null): DeckButton | null {
  if (!name) return null;
  return DECK_BUTTONS.find((b) => b.name === name) ?? null;
}

// ── HID device discovery ───────────────────────────────────────────────────

/** Parsed contents of /sys/class/hidraw/<node>/device/uevent. */
export interface HidUEvent {
  /** Raw HID_ID string, e.g. "0003:000028DE:00001205". Null if absent. */
  hidId: string | null;
  /** Numeric bus type from HID_ID (e.g. 0x0003). null if unparsed. */
  bus: number | null;
  /** Numeric vendor id from HID_ID. */
  vendor: number | null;
  /** Numeric product id from HID_ID. */
  product: number | null;
  /** Raw HID_PHYS string, e.g. "usb-0000:04:00.4-3/input2". null if absent. */
  hidPhys: string | null;
  /** USB-style interface number from HID_PHYS' `inputN` tail. null if absent. */
  interfaceNum: number | null;
}

/** Pure: parse a HID uevent file's contents. Tests can hand-feed this without
 *  touching /sys. Tolerates extra lines / ordering. */
export function parseHidUEvent(content: string): HidUEvent {
  const out: HidUEvent = {
    hidId: null,
    bus: null,
    vendor: null,
    product: null,
    hidPhys: null,
    interfaceNum: null,
  };
  for (const line of content.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "HID_ID") {
      out.hidId = value;
      // Format: BUS:VENDOR:PRODUCT, all hex, vendor/product zero-padded to 8.
      const parts = value.split(":");
      if (parts.length === 3) {
        // parts.length was checked === 3, so all three are present; the
        // guard only satisfies the type checker.
        const [busStr, vendorStr, productStr] = parts;
        if (
          busStr !== undefined &&
          vendorStr !== undefined &&
          productStr !== undefined
        ) {
          out.bus = parseInt(busStr, 16);
          out.vendor = parseInt(vendorStr, 16);
          out.product = parseInt(productStr, 16);
        }
      }
    } else if (key === "HID_PHYS") {
      out.hidPhys = value;
      // Tail "/inputN" — the kernel encodes the USB interface number here.
      const m = value.match(/\/input(\d+)\s*$/);
      // group 1 is a required capture, so it is always present when m
      // matched; the guard only satisfies the type checker.
      if (m) {
        const iface = m[1];
        if (iface !== undefined) out.interfaceNum = parseInt(iface, 10);
      }
    }
  }
  return out;
}

/** Pure: is this uevent a Steam Deck gamepad interface (interface 2)? */
export function isDeckGamepadInterface(ue: HidUEvent): boolean {
  if (ue.bus !== BUS_USB) return false;
  if (ue.vendor !== VENDOR_VALVE) return false;
  if (ue.product !== PRODUCT_JUPITER && ue.product !== PRODUCT_GALILEO) return false;
  // Interface 2 is the gamepad interface. Interfaces 0/1 are keyboard/mouse —
  // they don't carry the 64-byte gamepad reports and would never see a press.
  return ue.interfaceNum === 2;
}

/** Walk /sys/class/hidraw and return the first hidraw node whose uevent
 *  classifies as a Deck gamepad interface. Returns the device path
 *  (e.g. "/dev/hidraw2") or null when none is found.
 *
 *  When `root` is set, walks `<root>/sys/class/hidraw` instead — handy for
 *  tests that hand-stage a fake /sys tree on disk. */
export async function findDeckHidrawPath(root = ""): Promise<string | null> {
  const sysDir = `${root}/sys/class/hidraw`;
  let entries: string[];
  try {
    entries = await readdir(sysDir);
  } catch {
    return null;
  }
  // Sort so picks are deterministic across kernel-arbitrary directory order.
  entries.sort();
  for (const name of entries) {
    if (!name.startsWith("hidraw")) continue;
    try {
      const ue = parseHidUEvent(
        await readFile(`${sysDir}/${name}/device/uevent`, "utf-8"),
      );
      if (isDeckGamepadInterface(ue)) return `/dev/${name}`;
    } catch {
      // Missing uevent / transient read failure — skip and keep looking.
    }
  }
  return null;
}

// ── Frame decoding ──────────────────────────────────────────────────────────

/** A single decoded button transition. `pressed` is true for 0→1 (press),
 *  false for 1→0 (release). The watcher only acts on presses but tests use
 *  releases to verify edge detection isn't biased. */
export interface DeckButtonTransition {
  name: string;
  pressed: boolean;
}

/** Decode a single 64-byte input report 0x01 into a Map<name, bool>. Other
 *  report ids and short buffers return null so the caller can skip them. */
export function decodeButtons(report: Buffer): Map<string, boolean> | null {
  if (report.length < REPORT_LEN) return null;
  if (report[0] !== REPORT_ID_INPUT) return null;
  const out = new Map<string, boolean>();
  for (const [byteIdx, defs] of DECK_BUTTONS_BY_BYTE) {
    const v = report[byteIdx] ?? 0;
    for (const { bit, name } of defs) {
      out.set(name, (v & (1 << bit)) !== 0);
    }
  }
  return out;
}

/** Diff two decoded frames for transitions. Used by the watcher to fire on
 *  presses without spamming on held-down state. */
export function diffTransitions(
  prev: Map<string, boolean> | null,
  cur: Map<string, boolean>,
): DeckButtonTransition[] {
  const out: DeckButtonTransition[] = [];
  for (const [name, curVal] of cur) {
    const prevVal = prev?.get(name) ?? false;
    if (prevVal !== curVal) out.push({ name, pressed: curVal });
  }
  return out;
}

/** Convenience: split a possibly-coalesced read into individual 64-byte
 *  reports. The Deck driver typically writes one report per read, but the
 *  kernel coalesces under pressure — the spike showed runs of 2-4 reports
 *  per chunk. Returns owning sub-buffers so the caller can stash them. */
export function splitReports(chunk: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off + REPORT_LEN <= chunk.length; off += REPORT_LEN) {
    out.push(chunk.subarray(off, off + REPORT_LEN));
  }
  return out;
}
