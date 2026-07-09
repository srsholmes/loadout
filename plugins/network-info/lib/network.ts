/**
 * Pure network parsing helpers.
 * No I/O — all functions take raw strings and return typed values.
 * Covered by lib/network.test.ts.
 */

export interface NetworkInterface {
  name: string;
  ip: string;
  mac: string;
  state: string;
  type: string;
}

export interface ConnectionInfo {
  ssid: string | null;
  signal: number | null;
  frequency: string | null;
  bitRate: string | null;
}

/**
 * Parse the output of `ip -o addr show` into a list of IPv4 interfaces.
 * Skips loopback and IPv6 entries; deduplicates by name (keeps first).
 * Does NOT populate mac/state/type — those come from /sys.
 */
export function parseIpAddrOutput(output: string): Array<{ name: string; ip: string }> {
  const lines = output.split("\n").filter(Boolean);
  const seen = new Set<string>();
  const result: Array<{ name: string; ip: string }> = [];

  for (const line of lines) {
    // Format: index: name    inet/inet6 addr/prefix ...
    const match = line.match(/^\d+:\s+(\S+)\s+(\S+)\s+(\S+)/);
    if (!match) continue;

    const [, name, family, addrWithPrefix] = match;
    if (!name || !family || !addrWithPrefix) continue;
    if (family !== "inet") continue;
    if (name === "lo") continue;
    if (seen.has(name)) continue;
    seen.add(name);

    const ip = addrWithPrefix.split("/")[0] ?? addrWithPrefix;
    result.push({ name, ip });
  }

  return result;
}

/**
 * Parse `nmcli -t -f active,ssid,signal,freq dev wifi` output.
 * Returns partial ConnectionInfo for the active entry, or null if none found.
 */
export function parseNmcliOutput(output: string): Partial<ConnectionInfo> | null {
  for (const line of output.split("\n")) {
    const parts = line.split(":");
    if (parts[0] !== "yes") continue;
    return {
      ssid: parts[1] || null,
      signal: parts[2] ? parseInt(parts[2], 10) : null,
      frequency: parts[3] ? `${parts[3]} MHz` : null,
    };
  }
  return null;
}

/**
 * Parse `iwconfig` output.
 * Returns partial ConnectionInfo with whatever fields are present.
 */
export function parseIwconfigOutput(output: string): Partial<ConnectionInfo> {
  const result: Partial<ConnectionInfo> = {};

  const ssidMatch = output.match(/ESSID:"([^"]+)"/);
  if (ssidMatch) result.ssid = ssidMatch[1];

  const signalMatch = output.match(/Signal level[=:](-?\d+)\s*dBm/);
  if (signalMatch?.[1]) {
    const dBm = parseInt(signalMatch[1], 10);
    // Convert dBm to percentage (rough approximation)
    result.signal = Math.max(0, Math.min(100, 2 * (dBm + 100)));
  }

  const freqMatch = output.match(/Frequency[=:](\S+\s*\S*)/);
  if (freqMatch) result.frequency = freqMatch[1];

  const rateMatch = output.match(/Bit Rate[=:](\S+\s*\S*)/);
  if (rateMatch) result.bitRate = rateMatch[1];

  return result;
}

/**
 * Parse `/proc/net/wireless` content for signal level.
 * Returns a 0–100 signal percentage, or null if the file is empty / unparseable.
 */
export function parseProcNetWireless(content: string): number | null {
  const dataLines = content.split("\n").slice(2); // Skip 2 header lines
  for (const line of dataLines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const rawLevel = parts[3]; // present: parts.length >= 4
    if (rawLevel === undefined) continue;
    const level = parseFloat(rawLevel);
    if (isNaN(level)) continue;
    if (level < 0) {
      return Math.max(0, Math.min(100, 2 * (level + 100)));
    }
    return Math.min(100, level);
  }
  return null;
}

// --- UI formatting helpers (used by app.tsx) ---

export const fmtSpeed = (bps: number | null): string =>
  bps === null ? "--" : (bps / 1_000_000).toFixed(1);

export const fmtLatency = (ms: number | null): string =>
  ms === null ? "--" : ms.toFixed(1);

export const fmtTime = (d: Date | null): string =>
  d === null
    ? "--"
    : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

export function signalLabel(signal: number | null): string {
  if (signal == null) return "Unknown";
  if (signal >= 80) return "Excellent";
  if (signal >= 60) return "Good";
  if (signal >= 40) return "Fair";
  if (signal >= 20) return "Weak";
  return "Very Weak";
}

/** Cloudflare PoP → friendly city name map. */
export const CF_DATACENTERS: Record<string, string> = {
  ATL: "Atlanta, GA", BOS: "Boston, MA", ORD: "Chicago, IL", DFW: "Dallas, TX",
  DEN: "Denver, CO", IAH: "Houston, TX", LAX: "Los Angeles, CA", MIA: "Miami, FL",
  EWR: "Newark, NJ", PHX: "Phoenix, AZ", SJC: "San Jose, CA", SEA: "Seattle, WA",
  IAD: "Ashburn, VA", YYZ: "Toronto, CA", YVR: "Vancouver, CA",
  AMS: "Amsterdam, NL", TXL: "Berlin, DE", CDG: "Paris, FR", FRA: "Frankfurt, DE",
  LHR: "London, GB", MAD: "Madrid, ES", MXP: "Milan, IT", ARN: "Stockholm, SE",
  ZRH: "Zurich, CH", DUB: "Dublin, IE", HEL: "Helsinki, FI",
  NRT: "Tokyo, JP", SIN: "Singapore", HKG: "Hong Kong", SYD: "Sydney, AU",
  ICN: "Seoul, KR", BOM: "Mumbai, IN", GRU: "São Paulo, BR",
};
