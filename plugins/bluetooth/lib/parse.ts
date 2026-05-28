/**
 * Pure parsing helpers for bluetoothctl output.
 * No I/O, no side effects — safe to unit-test without mocking.
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
 * Parse the `Icon:` field from `bluetoothctl info <mac>` output to
 * determine the device type. Matches the upstream logic exactly.
 */
export function parseDeviceType(infoOutput: string): DeviceType {
  const iconMatch = infoOutput.match(/Icon:\s*(\S+)/);
  if (!iconMatch) return "unknown";
  const icon = iconMatch[1].toLowerCase();
  if (icon.includes("audio") || icon.includes("headset") || icon.includes("headphone")) {
    return "audio";
  }
  if (icon.includes("input-gaming") || icon.includes("joystick") || icon.includes("gamepad")) {
    return "input";
  }
  if (icon.includes("input-keyboard") || icon.includes("keyboard")) {
    return "keyboard";
  }
  return "unknown";
}

/**
 * Parse the MAC + name lines from `bluetoothctl devices` output.
 * Returns `{ mac, name }` for each valid `Device XX:XX:…:XX Some Name` line.
 */
export function parseDeviceList(output: string): Array<{ mac: string; name: string }> {
  const results: Array<{ mac: string; name: string }> = [];
  for (const line of output.split("\n")) {
    if (!line.startsWith("Device ")) continue;
    const parts = line.match(/^Device\s+([\dA-Fa-f:]{17})\s+(.+)$/);
    if (!parts) continue;
    results.push({ mac: parts[1], name: parts[2] });
  }
  return results;
}

/**
 * Parse a single device's `bluetoothctl info <mac>` output into
 * connection/pair status and device type.
 */
export function parseDeviceInfo(
  mac: string,
  name: string,
  infoOutput: string,
): BluetoothDevice {
  const connected = /Connected:\s*yes/i.test(infoOutput);
  const paired = /Paired:\s*yes/i.test(infoOutput);
  const type = parseDeviceType(infoOutput);
  return { mac, name, connected, paired, type };
}

/**
 * Parse `bluetoothctl show` output into an AdapterInfo record.
 */
export function parseAdapterInfo(output: string): AdapterInfo {
  return {
    powered: /Powered:\s*yes/i.test(output),
    discovering: /Discovering:\s*yes/i.test(output),
    name: output.match(/Name:\s*(.+)/)?.[1] ?? "Unknown",
    address: output.match(/Controller\s+([\dA-Fa-f:]{17})/)?.[1] ?? "Unknown",
  };
}
