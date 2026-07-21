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
  // ASUS ROG (Xbox) Ally + Flow
  {
    match: "RC73X",
    name: "ROG Xbox Ally X",
    minTdp: 4,
    maxTdp: 35,
    batteryMaxTdp: 35,
    profiles: { Silent: 13, Balanced: 17, Performance: 35 },
  },
  {
    // Z2 A silicon — a 20 W-class part. The generic-AMD fallback's 35 W
    // ceiling would badly overshoot it.
    match: "RC73Y",
    name: "ROG Xbox Ally",
    minTdp: 4,
    maxTdp: 20,
    batteryMaxTdp: 20,
    profiles: { Silent: 6, Balanced: 15, Performance: 20 },
  },
  {
    // Strix Halo tablet. 65 W sustained on AC (54 W on battery); the
    // firmware allows an OC mode beyond this that we don't expose.
    match: "GZ302",
    name: "ROG Flow Z13",
    minTdp: 5,
    maxTdp: 65,
    batteryMaxTdp: 54,
    profiles: { Silent: 40, Balanced: 45, Performance: 65 },
  },
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
    // Ryzen AI Max+ 395 (Strix Halo) tablet. 45 W air-cooled default,
    // 120 W with the external Frost Bay liquid cooler; 90 W is a realistic
    // AC ceiling between the two. Same APU family as the APEX above.
    match: "ONEXPLAYER SUPER X",
    name: "OneXPlayer Super X",
    minTdp: 5,
    maxTdp: 90,
    batteryMaxTdp: 65,
    profiles: { Silent: 15, Balanced: 45, Performance: 75 },
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
    // OneXFly F1 Pro / F1 EVA-02 (Ryzen AI 9 HX 370) — a 30 W-class
    // part; the generic OneXPlayer 35 W ceiling overshoots it.
    match: "ONEXPLAYER F1",
    name: "OneXPlayer OneXFly F1",
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
    // Ryzen AI Max+ 395 (Strix Halo) — a 4–85 W STAPM envelope, nothing
    // like the 28 W-class GPDs the vendor fallback below assumes. The
    // 55 W battery cap is a judgment call (small internal battery),
    // mirroring the same-silicon APEX above.
    match: "G1618-05",
    name: "GPD Win 5",
    minTdp: 4,
    maxTdp: 85,
    batteryMaxTdp: 55,
    profiles: { Silent: 15, Balanced: 25, Performance: 60 },
  },
  {
    // Covers G1617-01 (Win Mini) and G1617-02 (Win Mini 2025).
    match: "G1617",
    name: "GPD Win Mini",
    minTdp: 5,
    maxTdp: 28,
    batteryMaxTdp: 24,
    profiles: { Silent: 8, Balanced: 15, Performance: 28 },
  },
  {
    // Covers G1619-04 (2023) and G1619-05 (2024) — same 28 W envelope.
    match: "G1619",
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
  // OrangePi
  {
    match: "NEO-01",
    name: "OrangePi Neo",
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
