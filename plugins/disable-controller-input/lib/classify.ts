/**
 * Pure classification helpers for the auto-disable feature.
 *
 * Mirrors how Handheld Daemon (HHD) decides whether a gamepad is the
 * handheld's *built-in* pad or an *external* controller: it looks at the
 * device's bus type and vendor/product id. We get the same facts from
 * InputPlumber's source-device DBus interfaces (IdBustype / IdVendor /
 * IdProduct / DeviceClass) rather than parsing /proc/bus/input/devices,
 * which keeps us inside the plugin's existing `busctl` permission and
 * avoids mistaking InputPlumber's own *virtual output targets* for
 * external controllers.
 */

/** Facts read off one InputPlumber source device. Raw busctl renderings;
 *  normalization happens here so the wrappers in backend.ts stay dumb. */
export interface SourceFacts {
  /** IdBustype — Linux input bus id. Rendering varies (name / decimal /
   *  hex), so always run through {@link normalizeBusType}. */
  idBustype: string | null;
  idVendor: string | null;
  idProduct: string | null;
  /** EventDevice.DeviceClass (e.g. "gamepad"). Null on source interfaces
   *  that don't expose it (UdevDevice / HIDRaw). */
  deviceClass: string | null;
}

export type BusType = "usb" | "bluetooth" | "internal" | "virtual" | "unknown";

// linux/input.h BUS_* ids.
const BUS_USB = 0x03;
const BUS_BLUETOOTH = 0x05;
const BUS_VIRTUAL = 0x06;
const BUS_I2C = 0x18;
const BUS_HOST = 0x19;
const BUS_ISA = 0x10;
const BUS_I8042 = 0x11;
const BUS_PARPORT = 0x20;

/**
 * Normalize InputPlumber's `IdBustype` rendering into a coarse class.
 * Accepts a symbolic name ("usb"), a decimal string ("3"), or hex
 * ("0003" / "0x03"). Internal buses (I2C / HOST / platform-ish) map to
 * "internal"; BUS_VIRTUAL maps to "virtual" so we never treat an emulated
 * target as a real external controller.
 */
export function normalizeBusType(raw: string | null): BusType {
  if (raw == null) return "unknown";
  const s = raw.trim().toLowerCase();
  if (!s) return "unknown";

  // Symbolic names.
  switch (s) {
    case "usb":
      return "usb";
    case "bluetooth":
    case "bt":
      return "bluetooth";
    case "virtual":
      return "virtual";
    case "i2c":
    case "host":
    case "platform":
    case "serio":
    case "isa":
    case "i8042":
      return "internal";
  }

  const n = parseBusNumber(s);
  if (n == null) return "unknown";
  switch (n) {
    case BUS_USB:
      return "usb";
    case BUS_BLUETOOTH:
      return "bluetooth";
    case BUS_VIRTUAL:
      return "virtual";
    case BUS_I2C:
    case BUS_HOST:
    case BUS_ISA:
    case BUS_I8042:
    case BUS_PARPORT:
      return "internal";
    default:
      return "unknown";
  }
}

/** Parse a numeric bus id. `0x`-prefixed or non-decimal tokens are hex;
 *  a 4-char zero-padded token like "0003" is hex too (busctl's common
 *  rendering); otherwise decimal. */
function parseBusNumber(s: string): number | null {
  let str = s;
  let hex = false;
  if (str.startsWith("0x")) {
    str = str.slice(2);
    hex = true;
  }
  if (!/^[0-9a-f]+$/.test(str)) return null;
  // Pure-digit tokens are decimal *unless* zero-padded to 4 (the kernel /
  // busctl hex form, e.g. "0003").
  if (!hex && /^[0-9]+$/.test(str) && !(str.length === 4 && str[0] === "0")) {
    const d = parseInt(str, 10);
    return Number.isNaN(d) ? null : d;
  }
  const h = parseInt(str, 16);
  return Number.isNaN(h) ? null : h;
}

/**
 * Normalize a raw VID or PID to a 4-char lowercase hex string, or null.
 * Tolerates a `0x` prefix and decimal renderings. A token containing a
 * hex letter, or already 4 chars long, is treated as hex; otherwise it's
 * parsed as decimal and re-rendered as hex.
 */
export function normalizeId(raw: string | null): string | null {
  if (raw == null) return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith("0x")) s = s.slice(2);
  if (!/^[0-9a-f]+$/.test(s)) return null;

  const looksHex = /[a-f]/.test(s) || s.length === 4;
  const value = looksHex ? parseInt(s, 16) : parseInt(s, 10);
  if (Number.isNaN(value)) return null;
  return value.toString(16).padStart(4, "0");
}

/** Build the "vid:pid" key used by the lookup tables. */
function vidPidKey(vid: string | null, pid: string | null): string | null {
  const v = normalizeId(vid);
  const p = normalizeId(pid);
  if (!v || !p) return null;
  return `${v}:${p}`;
}

/**
 * Known *built-in* handheld gamepads, keyed by "vid:pid". Some handhelds
 * (notably the Steam Deck) expose their internal pad on the USB bus, so
 * bus type alone can't tell them from an external USB controller — this
 * table covers those. Extend as more handhelds are validated.
 */
export const BUILTIN_VIDPID: ReadonlySet<string> = new Set([
  "28de:1205", // Steam Deck (Jupiter)
  "28de:1206", // Steam Deck (Galileo)
]);

/**
 * Virtual pads we must never count as "external" — chiefly Steam Input's
 * virtual Xbox 360 pad. InputPlumber's own emulated targets are already
 * excluded via the "virtual" bus type, but a virtual pad on the USB bus
 * needs an explicit entry.
 */
export const VIRTUAL_VIDPID: ReadonlySet<string> = new Set([
  "28de:11ff", // Steam Input virtual gamepad
]);

/**
 * Classify one InputPlumber composite device from its source-device facts
 * (and, optionally, its CompositeDevice.Capabilities strings).
 *
 *  - isGamepad: any source reports DeviceClass "gamepad", or a capability
 *    string looks gamepad-ish. CompositeDevice.Capabilities is the cheap
 *    primary signal; DeviceClass is the per-source confirmation.
 *  - isExternal: at least one source is on the USB or Bluetooth bus AND
 *    its vid:pid is neither a known built-in nor a known virtual pad.
 *    Internal / virtual / unknown buses never make a device external —
 *    we err toward leaving controllers working.
 */
export function classifyComposite(
  sources: SourceFacts[],
  capabilities: string[] = [],
): { isGamepad: boolean; isExternal: boolean } {
  const isGamepad =
    sources.some((s) => (s.deviceClass ?? "").toLowerCase() === "gamepad") ||
    capabilities.some((c) => /gamepad/i.test(c));

  const isExternal = sources.some((s) => {
    const bus = normalizeBusType(s.idBustype);
    if (bus !== "usb" && bus !== "bluetooth") return false;
    const key = vidPidKey(s.idVendor, s.idProduct);
    if (key && (BUILTIN_VIDPID.has(key) || VIRTUAL_VIDPID.has(key))) {
      return false;
    }
    return true;
  });

  return { isGamepad, isExternal };
}
