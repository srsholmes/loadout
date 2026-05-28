import type { PluginBackend, EmitPayload } from "@loadout/types";
import { run, spawn } from "@loadout/exec";
import {
  type BluetoothDevice,
  type AdapterInfo,
  parseDeviceList,
  parseDeviceInfo,
  parseAdapterInfo,
  assertBluetoothctlOk,
} from "./lib/parse";

/**
 * Bluetooth manager plugin backend.
 *
 * Uses bluetoothctl CLI to manage Bluetooth devices.
 * Polls device connection status every 3 seconds and emits
 * deviceChanged events when state changes.
 *
 * Backend runs as root (system service) — no sudo needed.
 * Declare all binaries in plugin.permissions.commands.
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
    // Best-effort: tell bluez to drop the discovery session in case our
    // SIGKILL of bluetoothctl didn't propagate. Ignore errors — adapter
    // may be off, busy, or already not discovering.
    try {
      await run(["bluetoothctl", "scan", "off"]);
    } catch {}
    console.log("[bluetooth] Plugin unloaded");
  }

  /** List all paired devices with their connection status. */
  async getDevices(): Promise<BluetoothDevice[]> {
    const { stdout: output } = await run(["bluetoothctl", "devices"]);
    const entries = parseDeviceList(output);
    const devices: BluetoothDevice[] = [];

    for (const { mac, name } of entries) {
      try {
        const { stdout: info } = await run(["bluetoothctl", "info", mac]);
        devices.push(parseDeviceInfo(mac, name, info));
      } catch {
        // Transient bluetoothctl error (DBus hiccup, adapter blip). Use
        // the previously-cached connection state so the poll loop's
        // emit comparison is a no-op — without this, we'd flap a fake
        // `deviceChanged` event the moment info recovers on a later
        // tick. Type defaults to "unknown" until info comes back.
        const prevConnected = this.lastDeviceState.get(mac) ?? false;
        devices.push({
          mac,
          name,
          connected: prevConnected,
          paired: false,
          type: "unknown",
        });
      }
    }

    return devices;
  }

  /** Connect to a device by MAC address. */
  async connectDevice(mac: string): Promise<string> {
    const { stdout } = await run(["bluetoothctl", "connect", mac]);
    // bluetoothctl exits 0 even when bluez reports a failure — parse the
    // output before optimistically caching, otherwise a doomed connect
    // makes the cache disagree with reality until the next poll tick.
    assertBluetoothctlOk(stdout, "connect");
    this.lastDeviceState.set(mac, true);
    return stdout;
  }

  /** Disconnect a device by MAC address. */
  async disconnectDevice(mac: string): Promise<string> {
    const { stdout } = await run(["bluetoothctl", "disconnect", mac]);
    assertBluetoothctlOk(stdout, "disconnect");
    this.lastDeviceState.set(mac, false);
    return stdout;
  }

  /** Get adapter status (powered, discovering, name, address). */
  async getAdapterInfo(): Promise<AdapterInfo> {
    const { stdout: output } = await run(["bluetoothctl", "show"]);
    return parseAdapterInfo(output);
  }

  /** Toggle Bluetooth adapter power on or off. */
  async togglePower(on: boolean): Promise<string> {
    const { stdout } = await run(["bluetoothctl", "power", on ? "on" : "off"]);
    assertBluetoothctlOk(stdout, on ? "power on" : "power off");
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
