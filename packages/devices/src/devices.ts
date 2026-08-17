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
    // Win Mini 2025 — 30 W-class silicon, a notch above the older Mini.
    match: "G1617-02",
    name: "GPD Win Mini (2025)",
    minTdp: 5,
    maxTdp: 30,
    batteryMaxTdp: 25,
    profiles: { Silent: 8, Balanced: 15, Performance: 30 },
  },
  {
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

/**
 * Share of a firmware-declared max allowed on battery for a device we have no
 * table row for. Matches the ~80% relationship the hand-tuned rows above use
 * between `maxTdp` and `batteryMaxTdp`. `BATTERY_SAFE_MAX_WATTS` still caps
 * the result.
 */
const FALLBACK_BATTERY_FRACTION = 0.8;

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
  /**
   * True when no row in the device table matched and this is a vendor-keyed
   * guess. Callers that have a better source of truth for the envelope — a
   * firmware-declared range, say — use this to tell "we know this device"
   * from "we're guessing from the CPU vendor".
   */
  isFallback: boolean;
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
        isFallback: false,
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
    isFallback: true,
  };
}

/**
 * Fold a firmware-declared TDP envelope into a device match.
 *
 * Handhelds whose vendor driver implements the kernel's `firmware-attributes`
 * interface publish the exact envelope their firmware will accept
 * (`min_value`/`max_value` on the PL1 rail). That beats this table: it is
 * per-unit accurate, and it is the only source of truth for a device that
 * shipped after the table was last touched.
 *
 * What it does NOT beat is the hand-tuned judgment in a matched row. A device
 * we know about keeps its battery ceiling and its presets — those encode
 * thermals and runtime, not just what the silicon tolerates — clamped into
 * the firmware's interval so we never ask for a wattage the rail will reject.
 * A fallback match has no such judgment to preserve, so its presets are
 * derived from the range instead. Pure.
 */
export function applyFirmwareRange(
  device: DeviceMatch,
  range: { min: number; max: number },
): DeviceMatch {
  const { min, max } = range;
  const clamp = (w: number) => Math.min(Math.max(w, min), max);
  const span = max - min;
  // Both battery-ceiling paths run through clamp() so neither can land under
  // the floor. A narrow firmware range makes this reachable: 15–17 W gives
  // round(17 * 0.8) = 14 on the fallback path, and a known row whose
  // batteryMaxTdp predates a firmware that raised min would slip under it
  // too — either way the UI would offer a battery ceiling the rail rejects.

  return {
    ...device,
    minTdp: min,
    maxTdp: max,
    batteryMaxTdp: device.isFallback
      ? clamp(Math.round(max * FALLBACK_BATTERY_FRACTION))
      : clamp(device.batteryMaxTdp),
    profiles: device.isFallback
      ? {
          Silent: Math.round(min + span * 0.2),
          Balanced: Math.round(min + span * 0.5),
          Performance: max,
        }
      : Object.fromEntries(
          Object.entries(device.profiles).map(([name, watts]) => [
            name,
            clamp(watts),
          ]),
        ),
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

/**
 * Hard ceiling on TDP while running on battery, in watts — applies to EVERY
 * device regardless of its `batteryMaxTdp` or any user override.
 *
 * Sustained high-wattage draw on a handheld's cells is the failure mode this
 * guards: it drives cell temperature and discharge current well past what
 * these packs are specified for, degrading capacity and, at the extreme,
 * risking damage. No device's battery ceiling should exceed this, so it is
 * enforced as a floor-of-last-resort rather than left to per-device data or
 * to whatever a user types into the custom-device form.
 *
 * Applies ONLY on battery. Plugged in, the device's own `maxTdp` governs and
 * this value is irrelevant.
 */
export const BATTERY_SAFE_MAX_WATTS = 55;

/**
 * The TDP ceiling that applies right now, given power state. Pure.
 *
 * `acOnline === false` means "known to be on battery" — an unknown/null AC
 * state deliberately does NOT restrict, because misreporting AC as absent
 * would throttle a plugged-in device for no reason.
 */
export function effectiveMaxWatts({
  acOnline,
  maxTdp,
  batteryMaxTdp,
}: {
  acOnline: boolean | null;
  maxTdp: number;
  batteryMaxTdp: number;
}): number {
  if (acOnline !== false) return maxTdp;
  return Math.min(batteryMaxTdp, BATTERY_SAFE_MAX_WATTS);
}

/**
 * True when running on battery reduces the TDP ceiling at all — whether the
 * cause is the device's own `batteryMaxTdp` or the global
 * BATTERY_SAFE_MAX_WATTS. Drives the informational notice: a slider that
 * stops short of the number the user set is confusing regardless of WHICH
 * limit produced it, so the notice doesn't distinguish them.
 *
 * False when the on-battery ceiling equals the plugged one (e.g. Steam Deck
 * at 15 W) — there is nothing to explain, and claiming the max "might be
 * lower" would simply be wrong.
 */
export function isBatteryLimited({
  acOnline,
  maxTdp,
  batteryMaxTdp,
}: {
  acOnline: boolean | null;
  maxTdp: number;
  batteryMaxTdp: number;
}): boolean {
  return (
    effectiveMaxWatts({ acOnline, maxTdp, batteryMaxTdp }) < maxTdp
  );
}
