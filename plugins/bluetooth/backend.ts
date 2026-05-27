import type { PluginBackend, EmitPayload } from "@loadout/types";
import { run, spawn } from "@loadout/exec";

interface BluetoothDevice {
  mac: string;
  name: string;
  connected: boolean;
  paired: boolean;
  type: "audio" | "input" | "keyboard" | "unknown";
}

interface AdapterInfo {
  powered: boolean;
  discovering: boolean;
  name: string;
  address: string;
}

/**
 * Parse the Icon field from `bluetoothctl info` to determine device type.
 */
function parseDeviceType(infoOutput: string): BluetoothDevice["type"] {
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
 * Bluetooth manager plugin backend.
 *
 * Uses bluetoothctl CLI to manage Bluetooth devices.
 * Polls device connection status every 3 seconds and emits
 * deviceChanged events when state changes.
 */
export default class BluetoothBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;

  private pollInterval?: Timer;
  private lastDeviceState = new Map<string, boolean>();
  private scanProcess?: ReturnType<typeof spawn>;
  // Audit F-008: re-entrancy guard. `getDevices()` shells out N+1 times
  // (one `bluetoothctl devices` + one `info <mac>` per paired device).
  // On a system with 8 paired devices that's ~250-400ms; if the tick
  // overlaps itself the second invocation's emits interleave with the
  // first's state map writes and we can flap deviceChanged events.
  private polling = false;

  async onLoad(): Promise<void> {
    console.log("[bluetooth] Plugin loaded");

    // Start polling device status every 3 seconds
    this.pollInterval = setInterval(async () => {
      if (this.polling) return;
      this.polling = true;
      try {
        const devices = await this.getDevices();
        const seen = new Set<string>();
        for (const device of devices) {
          seen.add(device.mac);
          const prevConnected = this.lastDeviceState.get(device.mac);
          if (prevConnected !== undefined && prevConnected !== device.connected) {
            this.emit?.({
              event: "deviceChanged",
              data: device,
            });
          }
          this.lastDeviceState.set(device.mac, device.connected);
        }
        // Audit F-008: prune entries for devices that no longer appear
        // in the paired list (user removed them via bluetoothctl or a
        // sibling UI). Otherwise lastDeviceState grows monotonically.
        for (const mac of this.lastDeviceState.keys()) {
          if (!seen.has(mac)) this.lastDeviceState.delete(mac);
        }
      } catch {
        // Silently ignore poll errors (e.g. adapter off)
      } finally {
        this.polling = false;
      }
    }, 3000);
  }

  async onUnload(): Promise<void> {
    clearInterval(this.pollInterval);
    this.scanProcess?.kill();
    this.scanProcess = undefined;
    console.log("[bluetooth] Plugin unloaded");
  }

  /** List all paired devices with their connection status. */
  async getDevices(): Promise<BluetoothDevice[]> {
    const { stdout: output } = await run(["bluetoothctl", "devices"]);
    if (!output) return [];

    const lines = output.split("\n").filter((l) => l.startsWith("Device "));
    const devices: BluetoothDevice[] = [];

    for (const line of lines) {
      // Format: "Device XX:XX:XX:XX:XX:XX Device Name"
      const parts = line.match(/^Device\s+([\dA-Fa-f:]{17})\s+(.+)$/);
      if (!parts) continue;

      const mac = parts[1];
      const name = parts[2];

      try {
        const { stdout: info } = await run(["bluetoothctl", "info", mac]);
        const connected = /Connected:\s*yes/i.test(info);
        const paired = /Paired:\s*yes/i.test(info);
        const type = parseDeviceType(info);

        devices.push({ mac, name, connected, paired, type });
      } catch {
        devices.push({ mac, name, connected: false, paired: false, type: "unknown" });
      }
    }

    return devices;
  }

  /** Connect to a device by MAC address. */
  async connectDevice(mac: string): Promise<string> {
    const { stdout } = await run(["bluetoothctl", "connect", mac]);
    // Update cache immediately
    this.lastDeviceState.set(mac, true);
    return stdout;
  }

  /** Disconnect a device by MAC address. */
  async disconnectDevice(mac: string): Promise<string> {
    const { stdout } = await run(["bluetoothctl", "disconnect", mac]);
    // Update cache immediately
    this.lastDeviceState.set(mac, false);
    return stdout;
  }

  /** Get adapter status (powered, discovering, name, address). */
  async getAdapterInfo(): Promise<AdapterInfo> {
    const { stdout: output } = await run(["bluetoothctl", "show"]);
    return {
      powered: /Powered:\s*yes/i.test(output),
      discovering: /Discovering:\s*yes/i.test(output),
      name: output.match(/Name:\s*(.+)/)?.[1] ?? "Unknown",
      address: output.match(/Controller\s+([\dA-Fa-f:]{17})/)?.[1] ?? "Unknown",
    };
  }

  /** Toggle Bluetooth adapter power on or off. */
  async togglePower(on: boolean): Promise<string> {
    const { stdout } = await run(["bluetoothctl", "power", on ? "on" : "off"]);
    return stdout;
  }

  /** Start scanning for new devices. Non-blocking (scan on is a long-running command). */
  async startScan(): Promise<string> {
    // Kill any existing scan process first
    this.scanProcess?.kill();
    this.scanProcess = spawn(["bluetoothctl", "scan", "on"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return "Scanning started";
  }

  /** Stop scanning for devices. */
  async stopScan(): Promise<string> {
    this.scanProcess?.kill();
    this.scanProcess = undefined;
    // Also tell bluetoothctl to stop discovery
    const { stdout } = await run(["bluetoothctl", "scan", "off"]);
    return stdout;
  }
}
