/**
 * Device database + pure matching helpers, shared across plugins via
 * `@loadout/devices`.
 *
 * The (large, static) handheld table and the watt-matching logic live here so
 * any plugin can resolve a device's TDP range / presets. No I/O lives in this
 * module — callers read DMI/CPU info (see `./dmi`) and pass it to `matchDevice`
 * / `matchProfileName`.
 */

export type CpuVendor = "AMD" | "Intel" | "Unknown";

export interface DeviceInfo {
  /** Match substring against DMI product_name */
  match: string;
  /** Friendly display name */
  name: string;
  minTdp: number;
  /** Max TDP when plugged into AC. */
  maxTdp: number;
  /**
   * Max TDP when running on battery. A notch below `maxTdp` for high-power
   * devices to protect runtime/thermals; equal to `maxTdp` when there's no
   * meaningful gap (e.g. Steam Deck). Invariant: `batteryMaxTdp <= maxTdp`.
   */
  batteryMaxTdp: number;
  /** Per-profile watt defaults */
  profiles: { Silent: number; Balanced: number; Performance: number };
}

const KNOWN_DEVICES: DeviceInfo[] = [
  // Steam Deck
  {
    match: "Galileo",
    name: "Steam Deck OLED",
    minTdp: 3,
    maxTdp: 15,
    batteryMaxTdp: 15,
    profiles: { Silent: 5, Balanced: 10, Performance: 15 },
  },
  {
    match: "Jupiter",
    name: "Steam Deck LCD",
    minTdp: 3,
    maxTdp: 15,
    batteryMaxTdp: 15,
    profiles: { Silent: 5, Balanced: 10, Performance: 15 },
  },
  // ASUS ROG Ally
  {
    match: "ROG Ally X RC72",
    name: "ROG Ally X",
    minTdp: 5,
    maxTdp: 30,
    batteryMaxTdp: 25,
    profiles: { Silent: 10, Balanced: 17, Performance: 30 },
  },
  {
    match: "ROG Ally RC71",
    name: "ROG Ally",
    minTdp: 5,
    maxTdp: 25,
    batteryMaxTdp: 20,
    profiles: { Silent: 10, Balanced: 15, Performance: 25 },
  },
  // Lenovo Legion Go
  {
    match: "83L3",
    name: "Legion Go S (Z2 Go)",
    minTdp: 5,
    maxTdp: 25,
    batteryMaxTdp: 20,
    profiles: { Silent: 8, Balanced: 15, Performance: 25 },
  },
  {
    match: "83N6",
    name: "Legion Go S (Z1 Extreme)",
    minTdp: 5,
    maxTdp: 30,
    batteryMaxTdp: 25,
    profiles: { Silent: 8, Balanced: 15, Performance: 30 },
  },
  {
    match: "83E1",
    name: "Legion Go",
    minTdp: 5,
    maxTdp: 30,
    batteryMaxTdp: 25,
    profiles: { Silent: 8, Balanced: 15, Performance: 30 },
  },
  // OneXPlayer
  {
    match: "ONEXPLAYER APEX",
    name: "OneXPlayer APEX",
    minTdp: 5,
    maxTdp: 80,
    batteryMaxTdp: 55,
    profiles: { Silent: 15, Balanced: 30, Performance: 50 },
  },
  {
    match: "ONEXPLAYER Mini Pro",
    name: "OneXPlayer Mini Pro",
    minTdp: 5,
    maxTdp: 30,
    batteryMaxTdp: 25,
    profiles: { Silent: 8, Balanced: 15, Performance: 30 },
  },
  {
    match: "ONEXPLAYER",
    name: "OneXPlayer",
    minTdp: 5,
    maxTdp: 35,
    batteryMaxTdp: 28,
    profiles: { Silent: 10, Balanced: 18, Performance: 35 },
  },
  // GPD
  {
    match: "G1619-04",
    name: "GPD Win Max 2",
    minTdp: 5,
    maxTdp: 28,
    batteryMaxTdp: 24,
    profiles: { Silent: 8, Balanced: 15, Performance: 28 },
  },
  {
    match: "G1618-04",
    name: "GPD Win 4",
    minTdp: 5,
    maxTdp: 28,
    batteryMaxTdp: 24,
    profiles: { Silent: 8, Balanced: 15, Performance: 28 },
  },
  {
    match: "GPD",
    name: "GPD Device",
    minTdp: 5,
    maxTdp: 28,
    batteryMaxTdp: 24,
    profiles: { Silent: 8, Balanced: 15, Performance: 28 },
  },
  // AYANEO
  {
    match: "AYANEO",
    name: "AYANEO",
    minTdp: 5,
    maxTdp: 33,
    batteryMaxTdp: 28,
    profiles: { Silent: 8, Balanced: 15, Performance: 33 },
  },
  // AOKZOE
  {
    match: "AOKZOE",
    name: "AOKZOE",
    minTdp: 5,
    maxTdp: 33,
    batteryMaxTdp: 28,
    profiles: { Silent: 8, Balanced: 18, Performance: 33 },
  },
  // Minisforum
  {
    match: "V3",
    name: "Minisforum V3",
    minTdp: 5,
    maxTdp: 30,
    batteryMaxTdp: 25,
    profiles: { Silent: 10, Balanced: 18, Performance: 30 },
  },
  {
    match: "Minisforum",
    name: "Minisforum",
    minTdp: 5,
    maxTdp: 35,
    batteryMaxTdp: 28,
    profiles: { Silent: 10, Balanced: 18, Performance: 35 },
  },
  // MSI Claw
  {
    match: "Claw 8 AI",
    name: "MSI Claw 8 AI+",
    minTdp: 5,
    maxTdp: 40,
    batteryMaxTdp: 33,
    profiles: { Silent: 10, Balanced: 20, Performance: 40 },
  },
  {
    match: "Claw",
    name: "MSI Claw",
    minTdp: 5,
    maxTdp: 30,
    batteryMaxTdp: 25,
    profiles: { Silent: 8, Balanced: 17, Performance: 30 },
  },
];

/** Default ranges when device is unknown. */
const DEFAULT_AMD: Omit<DeviceInfo, "match"> = {
  name: "Generic AMD",
  minTdp: 5,
  maxTdp: 35,
  batteryMaxTdp: 28,
  profiles: { Silent: 10, Balanced: 18, Performance: 35 },
};

const DEFAULT_INTEL: Omit<DeviceInfo, "match"> = {
  name: "Generic Intel",
  minTdp: 3,
  maxTdp: 40,
  batteryMaxTdp: 30,
  profiles: { Silent: 8, Balanced: 15, Performance: 30 },
};

const DEFAULT_UNKNOWN: Omit<DeviceInfo, "match"> = {
  name: "Unknown",
  minTdp: 5,
  maxTdp: 35,
  batteryMaxTdp: 28,
  profiles: { Silent: 10, Balanced: 18, Performance: 35 },
};

/** Approximate TDP for platform_profile values (used only as fallback estimate). */
export const PLATFORM_PROFILE_TDP_MAP: Record<string, number> = {
  "low-power": 15,
  balanced: 25,
  performance: 35,
};

/** Resolved device profile (a known-device match or a vendor fallback). */
export interface DeviceMatch {
  name: string;
  minTdp: number;
  /** Max TDP when plugged into AC. */
  maxTdp: number;
  /** Max TDP when on battery (<= maxTdp). */
  batteryMaxTdp: number;
  profiles: Record<string, number>;
}

/**
 * Resolve a device's TDP range + preset profiles from its DMI product name,
 * falling back to a generic profile keyed by CPU vendor. First substring
 * match in KNOWN_DEVICES wins (table is ordered specific-first). Pure.
 */
export function matchDevice(
  dmiProductName: string,
  cpuVendor: CpuVendor,
): DeviceMatch {
  for (const device of KNOWN_DEVICES) {
    if (dmiProductName.includes(device.match)) {
      return {
        name: device.name,
        minTdp: device.minTdp,
        maxTdp: device.maxTdp,
        batteryMaxTdp: device.batteryMaxTdp,
        profiles: { ...device.profiles },
      };
    }
  }
  const fallback =
    cpuVendor === "AMD"
      ? DEFAULT_AMD
      : cpuVendor === "Intel"
        ? DEFAULT_INTEL
        : DEFAULT_UNKNOWN;
  return {
    name: fallback.name,
    minTdp: fallback.minTdp,
    maxTdp: fallback.maxTdp,
    batteryMaxTdp: fallback.batteryMaxTdp,
    profiles: { ...fallback.profiles },
  };
}

/**
 * Name the preset matching a wattage (within ±1 W), or "Custom" if none
 * matches. Returns null for a null reading. Pure.
 */
export function matchProfileName(
  tdp: number | null,
  profiles: Record<string, number>,
): string | null {
  if (tdp === null) return null;
  for (const [name, watts] of Object.entries(profiles)) {
    if (Math.abs(tdp - watts) <= 1) return name;
  }
  return "Custom";
}
