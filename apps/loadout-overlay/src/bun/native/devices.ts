// Port of src-tauri/src/device_monitor.rs.
//
// Enumerates /proc/bus/input/devices and classifies each entry as
// controller / keyboard / QAM by inspecting the kernel's reported key
// capability bitmask (the `B: KEY=` line of /proc/bus/input/devices).
// This is more robust than name heuristics — a device without "gamepad"
// or "xbox" in its name still classifies as a controller if it reports
// BTN_A/B/X/Y/SELECT/MODE, and a device named "Keyboard" that doesn't
// have Ctrl/3/4 keys won't masquerade as one.
//
// A single device can be multiple things at once (Steam Deck's QAM
// button is exposed on the same virtual keyboard that also has Ctrl),
// so `flags` is a bitmask, not a single enum.

import { readFile } from "node:fs/promises";

// ---- linux/input-event-codes.h ---------------------------------------------

// Gamepad buttons
const BTN_A = 0x130;
const BTN_B = 0x131;
const BTN_X = 0x133;
const BTN_Y = 0x134;
const BTN_SELECT = 0x13a;
const BTN_MODE = 0x13c;

// Keyboard keys
const KEY_LEFTCTRL = 29;
const KEY_3 = 4;
const KEY_4 = 5;
const KEY_F16 = 0xba;

/** Minimum set of buttons a device must report to be treated as a controller. */
const CONTROLLER_REQUIRED_BUTTONS = [
  BTN_SELECT,
  BTN_MODE,
  BTN_A,
  BTN_B,
  BTN_X,
  BTN_Y,
] as const;

/** Minimum set of keys to qualify as a "shortcut-capable" keyboard. Excludes
 *  the PC AT laptop keyboard — it has Ctrl/3/4 but we don't want its shortcut
 *  modifiers firing in the overlay. */
const KEYBOARD_REQUIRED_KEYS = [KEY_LEFTCTRL, KEY_3, KEY_4] as const;

/** Vendor/product for Steam Input's VIRTUAL Xbox 360 pad — we must never
 *  grab this (it's how Steam's own UI gets input) and never treat it as a
 *  physical controller for interception. */
const STEAM_VENDOR = 0x28de;
const STEAM_PRODUCT = 0x11ff;

// ---- Types -----------------------------------------------------------------

/** Deprecated — single-class view kept for callers that haven't moved to
 *  {@link DeviceFlags}. Derived from flags on parse. */
export type DeviceClass = "controller" | "keyboard" | "qam" | "unknown";

/** Capability-bit classification (matches device_monitor.rs::DeviceClass). */
export interface DeviceFlags {
  isController: boolean;
  isKeyboard: boolean;
  isQam: boolean;
}

export interface InputDevice {
  eventPath: string; // "/dev/input/event7"
  name: string;
  vendor: string; // lowercase hex, no prefix — e.g. "28de"
  product: string;
  /** Primary classification for legacy callers; prefer {@link flags}. */
  class: DeviceClass;
  flags: DeviceFlags;
  /** Stable hash across reconnects — djb2 over name+vendor+product so the
   *  NavController can key per-controller state (key repeat, modifier) by a
   *  value that survives unplug/replug without growing a Map key per
   *  reboot. */
  hash: number;
  /** Parsed EV_KEY capability bitmask. Empty if the B: KEY= line is absent
   *  (non-input devices). */
  keyCaps: Uint8Array;
  /** True for Steam Input's virtual Xbox 360 pad. Interception MUST skip
   *  it — grabbing it would mean our overlay's own CEF Gamepad API and
   *  Steam's BPM nav both lose input. */
  isSteamVirtual: boolean;
}

// ---- Enumeration -----------------------------------------------------------

export async function enumerateDevices(): Promise<InputDevice[]> {
  const raw = await readFile("/proc/bus/input/devices", "utf8");
  return parseDevices(raw);
}

/** Exposed for tests — pure function over the raw /proc content. */
export function parseDevices(raw: string): InputDevice[] {
  const blocks = raw.split(/\n\n+/).filter((b) => b.trim().length > 0);
  const devices: InputDevice[] = [];
  for (const block of blocks) {
    const name = matchLine(block, /^N:\s+Name="([^"]*)"$/m) ?? "";
    const vendor = (matchLine(block, /Vendor=([0-9a-f]+)/i) ?? "").toLowerCase();
    const product =
      (matchLine(block, /Product=([0-9a-f]+)/i) ?? "").toLowerCase();
    const handlers = matchLine(block, /^H:\s+Handlers=(.*)$/m) ?? "";
    const eventName = handlers.split(/\s+/).find((h) => h.startsWith("event"));
    if (!eventName) continue;
    const keyLine = matchLine(block, /^B:\s+KEY=(.*)$/m) ?? "";
    const keyCaps = parseKeyBitmask(keyLine);
    const flags = classifyByCaps(name, keyCaps);
    const isSteamVirtual =
      parseInt(vendor, 16) === STEAM_VENDOR &&
      parseInt(product, 16) === STEAM_PRODUCT;
    devices.push({
      eventPath: `/dev/input/${eventName}`,
      name,
      vendor,
      product,
      class: flagsToLegacyClass(flags, name),
      flags,
      hash: djb2(`${name}|${vendor}|${product}`),
      keyCaps,
      isSteamVirtual,
    });
  }
  return devices;
}

function matchLine(block: string, re: RegExp): string | undefined {
  const m = block.match(re);
  return m?.[1];
}

// ---- Capability parsing ----------------------------------------------------

/**
 * Parse the `B: KEY=...` line into a little-endian bitmask indexed by
 * linux/input-event-codes.h key codes.
 *
 * The kernel formats this as space-separated 64-bit words in **big-endian
 * hex**, written most-significant-word first. To get a byte array indexable
 * by `code >> 3`, we serialize each word as BE bytes then reverse the whole
 * array. (Same algorithm as device_monitor.rs's `B:`-case parser.)
 */
export function parseKeyBitmask(keyLine: string): Uint8Array {
  if (!keyLine.trim()) return new Uint8Array(0);
  const words = keyLine.trim().split(/\s+/);
  const bytes: number[] = [];
  for (const word of words) {
    // Pad to a full 64-bit width so partial leading words don't shift
    // the bitmap. Then serialize as BE bytes — the kernel writes MSW
    // first within each word too, so we keep the natural order and
    // reverse the whole array at the end.
    const padded = word.padStart(16, "0");
    for (let i = 0; i < padded.length; i += 2) {
      bytes.push(parseInt(padded.slice(i, i + 2), 16));
    }
  }
  bytes.reverse();
  return new Uint8Array(bytes);
}

export function hasCapability(caps: Uint8Array, code: number): boolean {
  const byteIdx = code >> 3;
  const bitIdx = code & 0x07;
  if (byteIdx >= caps.length) return false;
  // Guarded above: byteIdx < caps.length, so this index is in-bounds; ?? 0
  // is behaviour-identical for the bitwise test and drops the non-null `!`.
  return ((caps[byteIdx] ?? 0) & (1 << bitIdx)) !== 0;
}

/**
 * Capability-based classification. Matches device_monitor.rs::classify_device
 * exactly:
 *   - Controller: reports all of BTN_SELECT, BTN_MODE, BTN_A/B/X/Y.
 *   - Keyboard: reports Ctrl/3/4 *and* isn't "AT Translated Set 2 keyboard"
 *     (built-in laptop keyboard — shortcut modifiers on it open the overlay
 *     during normal typing, which is not what we want).
 *   - QAM: reports KEY_F16 (emitted by InputPlumber / Handheld Daemon virtual
 *     keyboards when the QAM button is pressed).
 */
export function classifyByCaps(name: string, caps: Uint8Array): DeviceFlags {
  const isController = CONTROLLER_REQUIRED_BUTTONS.every((c) =>
    hasCapability(caps, c),
  );
  const isKeyboard =
    !name.startsWith("AT Translated") &&
    KEYBOARD_REQUIRED_KEYS.every((c) => hasCapability(caps, c));
  const isQam = hasCapability(caps, KEY_F16);
  return { isController, isKeyboard, isQam };
}

function flagsToLegacyClass(flags: DeviceFlags, name: string): DeviceClass {
  // "controller" wins over keyboard wins over qam — same priority the
  // name-based classifier used to pick, keeps the behaviour of legacy
  // callers (`class === "controller"` filters) intact.
  if (flags.isController) return "controller";
  if (flags.isKeyboard) return "keyboard";
  if (flags.isQam) return "qam";
  // Fallback to the old name heuristic so the legacy `class` field still
  // returns something meaningful for devices that don't advertise any
  // interesting caps (e.g. "Handheld QAM Button" that lies about its
  // capabilities).
  return classifyByName(name);
}

/**
 * Pure name-heuristic classification, kept for the legacy single-class
 * view and for tests that predate the capability-based classifier.
 * Prefer classifyByCaps for real decisions.
 */
export function classify(name: string): DeviceClass {
  return classifyByName(name);
}

function classifyByName(name: string): DeviceClass {
  const n = name.toLowerCase();
  if (
    n.includes("xbox") ||
    n.includes("controller") ||
    n.includes("gamepad") ||
    n.includes("steam")
  ) {
    return "controller";
  }
  if (n.includes("keyboard")) return "keyboard";
  if (n.includes("qam")) return "qam";
  return "unknown";
}

// ---- djb2 -----------------------------------------------------------------

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    // h * 33 + c, kept as a 32-bit unsigned int so it hashes identically
    // regardless of engine. Shifts are 32-bit signed in JS — Math.imul is
    // the portable way to get wrap-around arithmetic.
    h = (Math.imul(h, 33) + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}
