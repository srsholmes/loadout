/**
 * Pure parsing helpers for the Bluetooth plugin.
 *
 * The plugin talks to BlueZ over the system D-Bus via `busctl`, NOT the
 * `bluetoothctl` CLI. One-shot `bluetoothctl <cmd>` exits before its
 * async D-Bus client finishes enumerating the default controller, so on
 * modern BlueZ (5.6x) it prints nothing when run non-interactively —
 * every read came back empty and the adapter always looked powered-off
 * (so the UI's power toggle "reverted" on the next poll). `busctl
 * get-property` / `set-property` are synchronous and deterministic.
 *
 * These helpers parse busctl's textual output. No I/O, no side effects —
 * safe to unit-test without mocking.
 */

export type DeviceType = "audio" | "input" | "keyboard" | "unknown";

export interface BluetoothDevice {
  mac: string;
  name: string;
  connected: boolean;
  paired: boolean;
  type: DeviceType;
}

export interface AdapterInfo {
  powered: boolean;
  discovering: boolean;
  name: string;
  address: string;
}

/**
 * Map a BlueZ `Icon` property (e.g. "audio-headset", "input-gaming") to
 * our coarse device category. Mirrors the old bluetoothctl `Icon:` logic.
 */
export function deviceTypeFromIcon(icon: string): DeviceType {
  const i = icon.toLowerCase();
  if (i.includes("audio") || i.includes("headset") || i.includes("headphone")) {
    return "audio";
  }
  if (i.includes("input-gaming") || i.includes("joystick") || i.includes("gamepad")) {
    return "input";
  }
  if (i.includes("input-keyboard") || i.includes("keyboard")) {
    return "keyboard";
  }
  return "unknown";
}

/** Parse a single `b true` / `b false` busctl property line. Returns null
 *  if the line isn't a boolean variant. */
export function parseBoolProp(line: string): boolean | null {
  const m = line.trim().match(/^b\s+(true|false)$/);
  if (!m) return null;
  return m[1] === "true";
}

/** Parse a single `s "value"` busctl property line. Returns null if the
 *  line isn't a quoted string. Unescapes `\"` and `\\`. */
export function parseStringProp(line: string): string | null {
  const m = line.trim().match(/^s\s+"((?:\\.|[^"\\])*)"$/);
  if (!m) return null;
  // Group 1 always captures when the match succeeds; `?? ""` is a no-op there.
  return (m[1] ?? "").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/** Split multi-property `busctl get-property` output into per-line value
 *  strings, in request order. Blank lines dropped. */
export function splitPropLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** `/org/bluez/hci0/dev_AA_BB_CC_DD_EE_0B` → `AA:BB:CC:DD:EE:0B`.
 *  Returns null for a path that isn't a BlueZ device object. */
export function macFromDevicePath(path: string): string | null {
  const m = path.match(/\/dev_([0-9A-Fa-f]{2}(?:_[0-9A-Fa-f]{2}){5})$/);
  if (!m) return null;
  // Group 1 always captures when the match succeeds; `?? ""` is a no-op there.
  return (m[1] ?? "").replace(/_/g, ":").toUpperCase();
}

/** `AA:BB:CC:DD:EE:0B` → `/org/bluez/hci0/dev_AA_BB_CC_DD_EE_0B` under
 *  the given adapter path. */
export function devicePathFromMac(adapterPath: string, mac: string): string {
  return `${adapterPath}/dev_${mac.replace(/:/g, "_").toUpperCase()}`;
}

const ADAPTER_PATH_RE = /^\/org\/bluez\/hci\d+$/;
const DEVICE_PATH_RE = /^\/org\/bluez\/hci\d+\/dev_[0-9A-Fa-f_]+$/;

/** First adapter object path (`/org/bluez/hciN`) in `busctl tree --list`
 *  output, or null if BlueZ exposes no controller. */
export function pickAdapterPath(treeStdout: string): string | null {
  for (const line of treeStdout.split("\n")) {
    const t = line.trim();
    if (ADAPTER_PATH_RE.test(t)) return t;
  }
  return null;
}

/** All device object paths in `busctl tree --list` output. */
export function pickDevicePaths(treeStdout: string): string[] {
  const paths: string[] = [];
  for (const line of treeStdout.split("\n")) {
    const t = line.trim();
    if (DEVICE_PATH_RE.test(t)) paths.push(t);
  }
  return paths;
}
