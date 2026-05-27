import type { PluginBackend, EmitPayload } from "@loadout/types";
import { runFull } from "@loadout/exec";
import { readFile, access } from "node:fs/promises";

interface NetworkInterface {
  name: string;
  ip: string;
  mac: string;
  state: string;
  type: string;
}

interface ConnectionInfo {
  ssid: string | null;
  signal: number | null;
  frequency: string | null;
  bitRate: string | null;
}

/**
 * Run a shell command via /bin/sh -c and return its stdout.
 * Returns empty string on failure. Audit F-021: a non-zero exit
 * (other than 127 "command not found", which is the steady-state
 * for the nmcli/iwconfig fallback chain) is logged so a misconfigured
 * sysprobe shows up in journalctl instead of failing silently.
 */
async function sh(cmd: string): Promise<string> {
  try {
    const { stdout, stderr, exitCode } = await runFull([
      "/bin/sh",
      "-c",
      cmd,
    ]);
    if (exitCode !== 0 && exitCode !== 127) {
      console.warn(
        `[network-info] sh exit=${exitCode} for "${cmd}": ${stderr.trim() || "(no stderr)"}`,
      );
    }
    return stdout;
  } catch (err) {
    // runFull only throws on spawn failure (binary missing entirely).
    // We still want to know about that — sh expects /bin/sh to exist.
    console.warn(`[network-info] sh spawn failed for "${cmd}":`, err);
    return "";
  }
}

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
    const interfaces: NetworkInterface[] = [];

    // Get list of interfaces and their states
    const ipOutput = await sh("ip -o addr show");
    const lines = ipOutput.split("\n").filter(Boolean);

    const seen = new Set<string>();

    for (const line of lines) {
      // Format: index: name    inet/inet6 addr/prefix ...
      const match = line.match(/^\d+:\s+(\S+)\s+(\S+)\s+(\S+)/);
      if (!match) continue;

      const [, name, family, addrWithPrefix] = match;
      // Only show IPv4
      if (family !== "inet") continue;
      if (name === "lo") continue;
      if (seen.has(name)) continue;
      seen.add(name);

      const ip = addrWithPrefix.split("/")[0];

      // Audit F-009: replace 3 sh spawns per interface with direct
      // /sys/class/net reads. MAC + operstate + wireless-test are all
      // a single readFile / access call — no shell, no parsing, no
      // grep+awk pipeline.
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
   * Tries nmcli first, falls back to iwconfig.
   */
  async getConnectionInfo(): Promise<ConnectionInfo> {
    const result: ConnectionInfo = {
      ssid: null,
      signal: null,
      frequency: null,
      bitRate: null,
    };

    // Try nmcli first (more reliable)
    const nmcliOutput = await sh(
      "nmcli -t -f active,ssid,signal,freq dev wifi 2>/dev/null"
    );
    if (nmcliOutput) {
      for (const line of nmcliOutput.split("\n")) {
        const parts = line.split(":");
        if (parts[0] === "yes") {
          result.ssid = parts[1] || null;
          result.signal = parts[2] ? parseInt(parts[2], 10) : null;
          result.frequency = parts[3] ? `${parts[3]} MHz` : null;
          break;
        }
      }
    }

    // Also try iwconfig for bit rate
    const iwOutput = await sh("iwconfig 2>/dev/null");
    if (iwOutput) {
      const ssidMatch = iwOutput.match(/ESSID:"([^"]+)"/);
      if (ssidMatch && !result.ssid) result.ssid = ssidMatch[1];

      const signalMatch = iwOutput.match(
        /Signal level[=:](-?\d+)\s*dBm/
      );
      if (signalMatch && result.signal === null) {
        // Convert dBm to percentage (rough approximation)
        const dBm = parseInt(signalMatch[1], 10);
        result.signal = Math.max(0, Math.min(100, 2 * (dBm + 100)));
      }

      const freqMatch = iwOutput.match(/Frequency[=:](\S+\s*\S*)/);
      if (freqMatch && !result.frequency) result.frequency = freqMatch[1];

      const rateMatch = iwOutput.match(/Bit Rate[=:](\S+\s*\S*)/);
      if (rateMatch) result.bitRate = rateMatch[1];
    }

    // Try /proc/net/wireless for signal if still missing
    if (result.signal === null) {
      const wirelessInfo = await sh("cat /proc/net/wireless 2>/dev/null");
      if (wirelessInfo) {
        const dataLines = wirelessInfo.split("\n").slice(2); // Skip headers
        for (const line of dataLines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 4) {
            const level = parseFloat(parts[3]);
            // /proc/net/wireless reports in dBm or relative
            if (level < 0) {
              result.signal = Math.max(
                0,
                Math.min(100, 2 * (level + 100))
              );
            } else {
              result.signal = Math.min(100, level);
            }
            break;
          }
        }
      }
    }

    return result;
  }

}
