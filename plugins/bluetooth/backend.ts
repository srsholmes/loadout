import type { PluginBackend, EmitPayload } from "@loadout/types";
import { runFull, spawn } from "@loadout/exec";
import {
  type BluetoothDevice,
  type AdapterInfo,
  type DeviceType,
  deviceTypeFromIcon,
  parseBoolProp,
  parseStringProp,
  splitPropLines,
  macFromDevicePath,
  devicePathFromMac,
  pickAdapterPath,
  pickDevicePaths,
} from "./lib/parse";

/**
 * Bluetooth manager plugin backend.
 *
 * Talks to BlueZ over the system D-Bus via `busctl` rather than the
 * `bluetoothctl` CLI: one-shot `bluetoothctl <cmd>` exits before its
 * async client enumerates the default controller and prints NOTHING on
 * modern BlueZ when run non-interactively, so every read returned empty
 * and the adapter always looked powered-off — the UI's power toggle
 * appeared to "turn off again" on the next poll. `busctl` get/set-property
 * are synchronous and deterministic. The one exception is scanning: an
 * active discovery session is tied to the D-Bus connection that started
 * it, so we hold it open with a long-lived `bluetoothctl scan on` process
 * (a one-shot `busctl ... StartDiscovery` would stop the instant its
 * connection closed).
 *
 * Backend runs as root (system service) — no sudo needed; root satisfies
 * polkit for the BlueZ set-property / Connect calls. Declare all binaries
 * in plugin.permissions.commands.
 */

const BLUEZ = "org.bluez";
const ADAPTER_IFACE = "org.bluez.Adapter1";
const DEVICE_IFACE = "org.bluez.Device1";

// Reads run on the 3s poll loop — a wedged system bus must fail fast, not
// stall the loop. Connect/Disconnect legitimately take longer (pairing,
// link setup), so they get a roomier ceiling.
const BUSCTL_TIMEOUT_MS = 5000;
const CONNECT_TIMEOUT_MS = 30000;

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

export default class BluetoothBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;

  private pollInterval?: Timer;
  private lastDeviceState = new Map<string, boolean>();
  // Last adapter snapshot the poll loop saw, so it only emits
  // `adapterChanged` on an actual power/discovering transition.
  private lastAdapter: AdapterInfo | null = null;
  private scanProcess?: ReturnType<typeof spawn>;
  // Audit F-008: re-entrancy guard so a slow poll can't pile up behind
  // itself and interleave its emits with the next tick's state writes.
  private polling = false;
  // Cached BlueZ adapter object path (e.g. /org/bluez/hci0). Resolved
  // lazily and cleared whenever a read fails, so a controller that comes
  // / goes (USB BT dongle, bluetoothd restart) is re-discovered.
  private adapterPath: string | null = null;

  async onLoad(): Promise<void> {
    console.log("[bluetooth] Plugin loaded");

    // Poll device + adapter status every 3 seconds.
    this.pollInterval = setInterval(() => {
      this._poll().catch(() => {});
    }, 3000);
  }

  async onUnload(): Promise<void> {
    clearInterval(this.pollInterval);
    // Killing the scan process drops its D-Bus connection, which tells
    // BlueZ to end the discovery session — no explicit StopDiscovery
    // needed (and a one-shot busctl call couldn't stop a session it
    // doesn't own anyway).
    this.scanProcess?.kill();
    this.scanProcess = undefined;
    console.log("[bluetooth] Plugin unloaded");
  }

  // ---------------------------------------------------------------------------
  // busctl plumbing
  // ---------------------------------------------------------------------------

  /** Run a busctl call against the system bus. `quiet` keeps routine
   *  polled reads out of the command audit log. */
  private async busctl(
    args: string[],
    opts: { timeoutMs?: number; quiet?: boolean } = {},
  ): Promise<ExecResult> {
    try {
      const { stdout, stderr, exitCode } = await runFull(
        ["busctl", "--system", "--no-pager", ...args],
        { timeoutMs: opts.timeoutMs ?? BUSCTL_TIMEOUT_MS, quiet: opts.quiet },
      );
      return { ok: exitCode === 0, stdout, stderr, code: exitCode };
    } catch (e) {
      return {
        ok: false,
        stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
        code: -1,
      };
    }
  }

  /** Resolve (and cache) the BlueZ adapter object path. Returns null if
   *  BlueZ exposes no controller (none plugged / bluetoothd down). */
  private async ensureAdapterPath(quiet = false): Promise<string | null> {
    if (this.adapterPath) return this.adapterPath;
    const r = await this.busctl(["tree", "--list", BLUEZ], { quiet });
    if (!r.ok) return null;
    this.adapterPath = pickAdapterPath(r.stdout);
    return this.adapterPath;
  }

  // ---------------------------------------------------------------------------
  // Reads (polled — quiet so they don't flood the audit log)
  // ---------------------------------------------------------------------------

  /** Get adapter status (powered, discovering, name, address). */
  async getAdapterInfo(): Promise<AdapterInfo> {
    const unknown: AdapterInfo = {
      powered: false,
      discovering: false,
      name: "Unknown",
      address: "Unknown",
    };
    const path = await this.ensureAdapterPath(true);
    if (!path) {
      this.adapterPath = null;
      return unknown;
    }
    // All four properties in a single call (busctl prints one typed line
    // per property, in request order).
    const r = await this.busctl(
      [
        "get-property",
        BLUEZ,
        path,
        ADAPTER_IFACE,
        "Powered",
        "Discovering",
        "Name",
        "Address",
      ],
      { quiet: true },
    );
    if (!r.ok) {
      this.adapterPath = null; // force a fresh resolve on the next tick
      return unknown;
    }
    const lines = splitPropLines(r.stdout);
    return {
      powered: parseBoolProp(lines[0] ?? "") ?? false,
      discovering: parseBoolProp(lines[1] ?? "") ?? false,
      name: parseStringProp(lines[2] ?? "") ?? "Unknown",
      address: parseStringProp(lines[3] ?? "") ?? "Unknown",
    };
  }

  /** List all known devices with their connection status. */
  async getDevices(): Promise<BluetoothDevice[]> {
    const path = await this.ensureAdapterPath(true);
    if (!path) return [];

    const tree = await this.busctl(["tree", "--list", BLUEZ], { quiet: true });
    if (!tree.ok) {
      this.adapterPath = null;
      return [];
    }

    const devices: BluetoothDevice[] = [];
    for (const dp of pickDevicePaths(tree.stdout)) {
      const mac = macFromDevicePath(dp);
      if (!mac) continue;
      devices.push(await this._readDevice(dp, mac));
    }
    return devices;
  }

  /** Read one device's state. Connected + Paired are mandatory BlueZ
   *  properties (one call); Name and Icon are optional, so they're read
   *  with tolerant follow-up calls. On a transient bus error we fall back
   *  to the cached connection state so the poll loop's compare is a no-op
   *  and we don't flap a phantom `deviceChanged`. */
  private async _readDevice(
    dp: string,
    mac: string,
  ): Promise<BluetoothDevice> {
    const core = await this.busctl(
      ["get-property", BLUEZ, dp, DEVICE_IFACE, "Connected", "Paired"],
      { quiet: true },
    );
    if (!core.ok) {
      const prevConnected = this.lastDeviceState.get(mac) ?? false;
      return { mac, name: mac, connected: prevConnected, paired: false, type: "unknown" };
    }
    const cl = splitPropLines(core.stdout);
    const connected = parseBoolProp(cl[0] ?? "") ?? false;
    const paired = parseBoolProp(cl[1] ?? "") ?? false;

    const name = (await this._readStringProp(dp, "Name")) ?? mac;
    const icon = await this._readStringProp(dp, "Icon");
    const type: DeviceType = icon ? deviceTypeFromIcon(icon) : "unknown";

    return { mac, name, connected, paired, type };
  }

  /** Read one optional string property; null if absent or on error. */
  private async _readStringProp(
    dp: string,
    prop: string,
  ): Promise<string | null> {
    const r = await this.busctl(
      ["get-property", BLUEZ, dp, DEVICE_IFACE, prop],
      { quiet: true },
    );
    if (!r.ok) return null;
    return parseStringProp(splitPropLines(r.stdout)[0] ?? "");
  }

  // ---------------------------------------------------------------------------
  // Writes (real user actions — audited)
  // ---------------------------------------------------------------------------

  /** Toggle Bluetooth adapter power on or off. */
  async togglePower(on: boolean): Promise<string> {
    if (on) {
      // SteamOS (anything fronting the adapter with rfkill) soft-blocks
      // Bluetooth when it's "off" system-wide; BlueZ then rejects
      // Powered=true with org.bluez.Error.Blocked and the user is stuck.
      // Clear the soft block first. Best-effort — ignore rfkill errors
      // (binary missing, nothing blocked) and let set-property below
      // report the real outcome.
      try {
        await runFull(["rfkill", "unblock", "bluetooth"], {
          timeoutMs: BUSCTL_TIMEOUT_MS,
        });
      } catch {
        // fall through
      }
    }
    const path = await this.ensureAdapterPath();
    if (!path) throw new Error("No Bluetooth adapter found");
    const r = await this.busctl([
      "set-property",
      BLUEZ,
      path,
      ADAPTER_IFACE,
      "Powered",
      "b",
      on ? "true" : "false",
    ]);
    if (!r.ok) {
      throw new Error(
        `power ${on ? "on" : "off"} failed: ${r.stderr.trim() || `exit ${r.code}`}`,
      );
    }
    return `Powered ${on ? "on" : "off"}`;
  }

  /** Connect to a device by MAC address. */
  async connectDevice(mac: string): Promise<string> {
    const path = await this.ensureAdapterPath();
    if (!path) throw new Error("No Bluetooth adapter found");
    const r = await this.busctl(
      ["call", BLUEZ, devicePathFromMac(path, mac), DEVICE_IFACE, "Connect"],
      { timeoutMs: CONNECT_TIMEOUT_MS },
    );
    // Unlike bluetoothctl, busctl exits non-zero on a BlueZ-side failure,
    // so the exit code is authoritative — no stdout grepping needed.
    if (!r.ok) {
      throw new Error(`connect failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    }
    this.lastDeviceState.set(mac, true);
    return "Connection successful";
  }

  /** Disconnect a device by MAC address. */
  async disconnectDevice(mac: string): Promise<string> {
    const path = await this.ensureAdapterPath();
    if (!path) throw new Error("No Bluetooth adapter found");
    const r = await this.busctl(
      ["call", BLUEZ, devicePathFromMac(path, mac), DEVICE_IFACE, "Disconnect"],
      { timeoutMs: CONNECT_TIMEOUT_MS },
    );
    if (!r.ok) {
      throw new Error(
        `disconnect failed: ${r.stderr.trim() || `exit ${r.code}`}`,
      );
    }
    this.lastDeviceState.set(mac, false);
    return "Disconnected";
  }

  /** Start scanning for new devices. A long-lived bluetoothctl process
   *  holds the discovery session open (see class doc). Non-blocking. */
  async startScan(): Promise<string> {
    this.scanProcess?.kill();
    this.scanProcess = spawn(["bluetoothctl", "scan", "on"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return "Scanning started";
  }

  /** Stop scanning for devices. */
  async stopScan(): Promise<string> {
    // Dropping the scan process's connection ends the BlueZ discovery
    // session it owns.
    this.scanProcess?.kill();
    this.scanProcess = undefined;
    return "Scanning stopped";
  }

  // ---------------------------------------------------------------------------
  // Poll loop
  // ---------------------------------------------------------------------------

  /**
   * One poll tick: refresh device connection states and adapter
   * power/discovering, emitting `deviceChanged` / `adapterChanged` only on
   * an actual transition. Extracted from the interval so it can be
   * unit-tested directly. Guarded against overlapping runs.
   */
  private async _poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const devices = await this.getDevices();
      const seen = new Set<string>();
      for (const device of devices) {
        seen.add(device.mac);
        const prevConnected = this.lastDeviceState.get(device.mac);
        if (prevConnected !== undefined && prevConnected !== device.connected) {
          this.emit?.({ event: "deviceChanged", data: device });
        }
        this.lastDeviceState.set(device.mac, device.connected);
      }
      // Prune entries for devices that no longer appear so the cache
      // doesn't grow monotonically.
      for (const mac of this.lastDeviceState.keys()) {
        if (!seen.has(mac)) this.lastDeviceState.delete(mac);
      }

      const adapter = await this.getAdapterInfo();
      if (
        this.lastAdapter === null ||
        this.lastAdapter.powered !== adapter.powered ||
        this.lastAdapter.discovering !== adapter.discovering
      ) {
        if (this.lastAdapter !== null) {
          this.emit?.({ event: "adapterChanged", data: adapter });
        }
        this.lastAdapter = adapter;
      }
    } catch {
      // Silently ignore poll errors (e.g. adapter off / bus hiccup).
    } finally {
      this.polling = false;
    }
  }
}
