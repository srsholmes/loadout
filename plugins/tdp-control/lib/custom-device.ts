/**
 * User-defined device override for the TDP plugin.
 *
 * Users with newer or unlisted handhelds can enter their device's TDP range
 * and power presets by hand instead of waiting for a plugin release that adds
 * them to `@loadout/devices`. Exactly ONE custom device is stored — this is a
 * single override, not a profiles feature. When present it becomes the default
 * device the TDP control uses (range + presets), taking precedence over
 * DMI auto-detection. Clearing it reverts to auto-detection.
 *
 * Persistence: the single `customDevice` key inside the plugin's shared
 * storage file (`~/.config/loadout/plugins/tdp-control.json`), written via
 * `mutatePluginStorage` so it round-trips alongside the per-game profile
 * engine's keys in the same file.
 */

import type { DeviceInfo } from "@loadout/devices";
import { readPluginStorage, mutatePluginStorage } from "@loadout/plugin-storage";

/**
 * A user-entered device: the shared device schema (`DeviceInfo`) minus the DMI
 * `match` substring — a custom device is chosen explicitly, never matched
 * against a product name.
 */
export type CustomDevice = Omit<DeviceInfo, "match">;

/** Top-level key under which the single custom device is persisted. */
const STORAGE_KEY = "customDevice";

/** Absolute watt bounds any custom value must fall within (sanity guard). */
const MIN_WATTS = 1;
const MAX_WATTS = 200;
const MAX_NAME_LENGTH = 48;

/** The three preset slots every device defines, in ascending-power order. */
const PROFILE_KEYS = ["Silent", "Balanced", "Performance"] as const;

export type ValidationResult =
  | { ok: true; device: CustomDevice }
  | { ok: false; error: string };

function isWholeNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && Number.isInteger(n);
}

/**
 * Validate an untrusted object into a `CustomDevice`, or return a
 * user-facing error string. Rules: non-empty name; whole-number watts in
 * [MIN_WATTS, MAX_WATTS]; `minTdp < maxTdp`; `minTdp <= batteryMaxTdp <=
 * maxTdp`; each preset within `[minTdp, maxTdp]`. Pure — reused by the
 * backend RPC and by `readCustomDevice` to reject corrupt stored data.
 */
export function validateCustomDevice(input: unknown): ValidationResult {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Invalid device" };
  }
  const o = input as Record<string, unknown>;

  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name) return { ok: false, error: "Device name is required" };
  if (name.length > MAX_NAME_LENGTH) {
    return {
      ok: false,
      error: `Device name must be ${MAX_NAME_LENGTH} characters or fewer`,
    };
  }

  const ranges: Array<[string, unknown]> = [
    ["Min TDP", o.minTdp],
    ["Max TDP", o.maxTdp],
    ["Battery max TDP", o.batteryMaxTdp],
  ];
  for (const [label, value] of ranges) {
    if (!isWholeNumber(value)) {
      return { ok: false, error: `${label} must be a whole number` };
    }
    if (value < MIN_WATTS || value > MAX_WATTS) {
      return {
        ok: false,
        error: `${label} must be between ${MIN_WATTS} and ${MAX_WATTS} W`,
      };
    }
  }
  const minTdp = o.minTdp as number;
  const maxTdp = o.maxTdp as number;
  const batteryMaxTdp = o.batteryMaxTdp as number;

  if (minTdp >= maxTdp) {
    return { ok: false, error: "Min TDP must be less than Max TDP" };
  }
  if (batteryMaxTdp < minTdp || batteryMaxTdp > maxTdp) {
    return {
      ok: false,
      error: "Battery max TDP must be between Min and Max TDP",
    };
  }

  if (!o.profiles || typeof o.profiles !== "object") {
    return { ok: false, error: "Power presets are required" };
  }
  const rawProfiles = o.profiles as Record<string, unknown>;
  const profiles = {} as CustomDevice["profiles"];
  for (const key of PROFILE_KEYS) {
    const value = rawProfiles[key];
    if (!isWholeNumber(value)) {
      return { ok: false, error: `${key} preset must be a whole number` };
    }
    if (value < minTdp || value > maxTdp) {
      return {
        ok: false,
        error: `${key} preset must be between Min (${minTdp}) and Max (${maxTdp}) W`,
      };
    }
    profiles[key] = value;
  }

  // Presets must be ascending: Silent <= Balanced <= Performance. The
  // platform_profile method maps watts to low/balanced/performance using the
  // midpoints between these, which assumes ascending order — non-monotonic
  // presets yield a nonsensical mapping.
  if (
    profiles.Silent > profiles.Balanced ||
    profiles.Balanced > profiles.Performance
  ) {
    return {
      ok: false,
      error:
        "Presets must be ascending: Silent ≤ Balanced ≤ Performance",
    };
  }

  return {
    ok: true,
    device: { name, minTdp, maxTdp, batteryMaxTdp, profiles },
  };
}

/**
 * Load the stored custom device, or `null` when none is saved (or the stored
 * value fails validation — corrupt data is treated as "no custom device").
 */
export async function readCustomDevice(
  pluginId: string,
): Promise<CustomDevice | null> {
  const stored = await readPluginStorage<Record<string, unknown>>(pluginId);
  const raw = stored[STORAGE_KEY];
  if (raw == null) return null;
  const result = validateCustomDevice(raw);
  return result.ok ? result.device : null;
}

/**
 * Persist the single custom device. Merges into the plugin's shared file so
 * the per-game profile engine's keys are preserved.
 */
export async function writeCustomDevice(
  pluginId: string,
  device: CustomDevice,
): Promise<void> {
  await mutatePluginStorage<Record<string, unknown>>(pluginId, (existing) => ({
    ...existing,
    [STORAGE_KEY]: device,
  }));
}

/** Remove the custom device, reverting the plugin to auto-detection. */
export async function clearCustomDevice(pluginId: string): Promise<void> {
  await mutatePluginStorage<Record<string, unknown>>(pluginId, (existing) => {
    const next = { ...existing };
    delete next[STORAGE_KEY];
    return next;
  });
}
