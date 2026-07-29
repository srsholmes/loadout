/**
 * Persistence for the user's manually-set TDP.
 *
 * The TDP the user picks (slider or power preset) is applied to hardware but,
 * on AMD/Intel/WMI handhelds, the hardware limit resets to a firmware default
 * on every reboot. Without persistence the user's choice is lost across a
 * shutdown. We store the last user-requested wattage so `onLoad` can re-apply
 * it, restoring the device to how the user left it.
 *
 * Persistence: the single `manualTdp` key inside the plugin's shared storage
 * file (`~/.config/loadout/plugins/tdp-control.json`), written via
 * `mutatePluginStorage` so it round-trips alongside the per-game profile
 * engine's keys and the custom-device override in the same file.
 */

import { readPluginStorage, mutatePluginStorage } from "@loadout/plugin-storage";

/** Top-level key under which the user's manual TDP is persisted. */
const STORAGE_KEY = "manualTdp";

/** Absolute watt bounds a stored value must fall within (sanity guard). */
const MIN_WATTS = 1;
const MAX_WATTS = 200;

/**
 * Load the stored manual TDP, or `null` when none is saved (or the stored
 * value is missing/corrupt/out of range — treated as "nothing to restore").
 */
export async function readSavedTdp(pluginId: string): Promise<number | null> {
  const stored = await readPluginStorage<Record<string, unknown>>(pluginId);
  const raw = stored[STORAGE_KEY];
  if (
    typeof raw !== "number" ||
    !Number.isFinite(raw) ||
    raw < MIN_WATTS ||
    raw > MAX_WATTS
  ) {
    return null;
  }
  return Math.round(raw);
}

/**
 * Persist the user's manual TDP. Merges into the plugin's shared file so the
 * per-game profile engine's keys and the custom-device override are preserved.
 */
export async function writeSavedTdp(
  pluginId: string,
  watts: number,
): Promise<void> {
  await mutatePluginStorage<Record<string, unknown>>(pluginId, (existing) => ({
    ...existing,
    [STORAGE_KEY]: Math.round(watts),
  }));
}
