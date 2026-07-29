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
 * [MIN_WATTS, MAX_WATTS]; `minTdp < maxTdp`; each preset within
 * `[minTdp, maxTdp]`. `batteryMaxTdp` is OPTIONAL and defaults to `maxTdp`
 * when omitted — when given it must satisfy `minTdp <= batteryMaxTdp <=
 * maxTdp`. Whatever it ends up as, BATTERY_SAFE_MAX_WATTS still caps the
 * applied wattage on battery. Pure — reused by the backend RPC and by
 * `readCustomDevice` to reject corrupt stored data.
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
  ];
  // Battery max is OPTIONAL. Requiring it is what produced issue #230: the
  // form pre-seeded this field from the AUTO-DETECTED device, so raising Max
  // TDP to 80 while leaving a detected 28-30 here silently capped the slider
  // at that lower figure whenever the handheld was on battery — with nothing
  // in the UI saying why. Omitted now means "same as Max TDP", and the global
  // BATTERY_SAFE_MAX_WATTS ceiling protects the battery regardless.
  if (o.batteryMaxTdp != null && o.batteryMaxTdp !== "") {
    ranges.push(["Battery max TDP", o.batteryMaxTdp]);
  }
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
  const batteryMaxTdp =
    o.batteryMaxTdp == null || o.batteryMaxTdp === ""
      ? maxTdp
      : (o.batteryMaxTdp as number);

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

/** Marks the issue-#230 battery-max migration as already considered. */
const MIGRATED_KEY = "batteryMaxMigrated";

/**
 * One-time repair of a custom device carrying the issue-#230 seed.
 *
 * `batteryMaxTdp` was required from the first release and the form pre-filled
 * it from the AUTO-DETECTED device, so every custom device saved before this
 * change has an explicit value — and anyone who raised Max TDP without
 * noticing that field is still capped by it. Making the field optional only
 * helps new saves, so existing users need a nudge.
 *
 * Runs AT MOST ONCE, ever, guarded by a persisted flag, and rewrites storage
 * rather than patching in memory. Both properties matter: the seeded values
 * ARE the fallback defaults (28 W generic-AMD, 30 W generic-Intel), which are
 * also the roundest numbers a user might deliberately type. A per-load
 * in-memory heuristic would therefore (a) misfire on a deliberate 28, and
 * (b) be impossible to escape — re-entering 28 would just be re-migrated on
 * the next load. Persisting the flag means a value the user sets afterwards
 * is theirs and is never touched again.
 *
 * @returns the previous value if it was migrated away, else null.
 */
export async function migrateSeededBatteryMax({
  pluginId,
  detectedBatteryMaxTdp,
}: {
  pluginId: string;
  /** batteryMaxTdp of the DMI-detected device — the value the old form seeded. */
  detectedBatteryMaxTdp: number;
}): Promise<number | null> {
  let migratedFrom: number | null = null;
  await mutatePluginStorage<Record<string, unknown>>(pluginId, (existing) => {
    if (existing[MIGRATED_KEY]) return existing;
    const next = { ...existing, [MIGRATED_KEY]: true };
    const raw = existing[STORAGE_KEY] as Record<string, unknown> | undefined;
    if (!raw) return next; // nothing to migrate, but never consider it again
    const stored = validateCustomDevice(raw);
    if (!stored.ok) return next;
    const d = stored.device;
    // Fingerprint of the bug: below the user's own max AND exactly the value
    // the old form would have seeded from detection.
    if (d.batteryMaxTdp >= d.maxTdp) return next;
    if (d.batteryMaxTdp !== detectedBatteryMaxTdp) return next;
    migratedFrom = d.batteryMaxTdp;
    const { batteryMaxTdp: _dropped, ...rest } = d;
    return { ...next, [STORAGE_KEY]: rest };
  });
  return migratedFrom;
}
