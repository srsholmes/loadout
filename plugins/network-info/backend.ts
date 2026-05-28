import type { PluginBackend, EmitPayload } from "@loadout/types";
import { runFull } from "@loadout/exec";
import { readFile, access } from "node:fs/promises";
import {
  parseIpAddrOutput,
  parseNmcliOutput,
  parseIwconfigOutput,
  parseProcNetWireless,
  type NetworkInterface,
  type ConnectionInfo,
} from "./lib/network";

/**
 * Read a /sys file and trim trailing newline. Returns "" on any
 * filesystem error (missing file, permission denied, race against
 * an interface going down mid-read).
 */
async function readSysfs(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return "";
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export default class NetworkInfoBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;

  async onLoad(): Promise<void> {
    console.log("[network-info] Plugin loaded");
  }

  async onUnload(): Promise<void> {
    console.log("[network-info] Plugin unloaded");
  }

  /** Gather network interface information. */
  async getNetworkInfo(): Promise<NetworkInterface[]> {
    const { stdout: ipOutput } = await runFull(["ip", "-o", "addr", "show"]).catch(() => ({ stdout: "" }));
    const parsed = parseIpAddrOutput(ipOutput);

    const interfaces: NetworkInterface[] = [];
    for (const { name, ip } of parsed) {
      const sysBase = `/sys/class/net/${name}`;
      const mac = (await readSysfs(`${sysBase}/address`)) || "N/A";
      const state = (await readSysfs(`${sysBase}/operstate`)) || "unknown";
      const isWireless = await pathExists(`${sysBase}/wireless`);
      const type = isWireless ? "WiFi" : "Ethernet";

      interfaces.push({ name, ip, mac, state, type });
    }

    return interfaces;
  }

  /**
   * Get WiFi connection details: SSID, signal strength, frequency, bit rate.
   * Tries nmcli first, falls back to iwconfig, then /proc/net/wireless.
   */
  async getConnectionInfo(): Promise<ConnectionInfo> {
    const result: ConnectionInfo = {
      ssid: null,
      signal: null,
      frequency: null,
      bitRate: null,
    };

    // Try nmcli first (more reliable)
    const { stdout: nmcliOutput } = await runFull(["nmcli", "-t", "-f", "active,ssid,signal,freq", "dev", "wifi"]).catch(() => ({ stdout: "" }));
    if (nmcliOutput) {
      const nmcli = parseNmcliOutput(nmcliOutput);
      if (nmcli) {
        if (nmcli.ssid !== undefined) result.ssid = nmcli.ssid;
        if (nmcli.signal !== undefined) result.signal = nmcli.signal;
        if (nmcli.frequency !== undefined) result.frequency = nmcli.frequency;
      }
    }

    // Also try iwconfig for bit rate (and fallback fields)
    const { stdout: iwOutput } = await runFull(["iwconfig"]).catch(() => ({ stdout: "" }));
    if (iwOutput) {
      const iw = parseIwconfigOutput(iwOutput);
      if (iw.ssid && !result.ssid) result.ssid = iw.ssid;
      if (iw.signal !== undefined && result.signal === null) result.signal = iw.signal;
      if (iw.frequency && !result.frequency) result.frequency = iw.frequency;
      if (iw.bitRate) result.bitRate = iw.bitRate;
    }

    // Try /proc/net/wireless for signal if still missing
    if (result.signal === null) {
      try {
        const wirelessContent = await readFile("/proc/net/wireless", "utf8");
        const sig = parseProcNetWireless(wirelessContent);
        if (sig !== null) result.signal = sig;
      } catch {
        // /proc/net/wireless may not exist (no wireless iface)
      }
    }

    return result;
  }
}
