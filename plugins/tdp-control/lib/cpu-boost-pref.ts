/**
 * Persistence for the user's CPU boost preference.
 *
 * Why this exists: with boost left on, amd-pstate grants full boost clocks
 * under any sustained load — regardless of governor/EPP — and a many-core
 * Zen chip at ~5 GHz consumes whatever the TDP limit allows. Power draw then
 * tracks the *limit* instead of the *workload* (the "draw always equals the
 * TDP I set" field reports; verified live on Strix Halo: flipping boost off
 * dropped package draw from a pinned 43 W to the ~30 W the game needed).
 * SimpleDeckyTDP avoids this by re-asserting a CPU profile, boost included,
 * with every TDP apply; the backend now does the same.
 *
 * The stored value is the user's desired boost state, re-applied alongside
 * every TDP write and at startup (the sysfs knob resets to boost-on at every
 * boot). When nothing is stored the policy default is OFF; the plugin's
 * CPU Boost toggle is the opt-out for users who want boost clocks.
 *
 * Persistence: the single `cpuBoost` key inside the plugin's shared storage
 * file (`~/.config/loadout/plugins/tdp-control.json`), written via
 * `mutatePluginStorage` so it round-trips alongside the per-game profile
 * engine's keys, the custom-device override, and the saved manual TDP.
 */

import { readPluginStorage, mutatePluginStorage } from "@loadout/plugin-storage";

/** Top-level key under which the boost preference is persisted. */
const STORAGE_KEY = "cpuBoost";

/**
 * Load the stored boost preference, or `null` when the user never set one
 * (or the stored value is corrupt) — the caller falls back to the policy
 * default (boost off).
 */
export async function readCpuBoostPref(
  pluginId: string,
): Promise<boolean | null> {
  const stored = await readPluginStorage<Record<string, unknown>>(pluginId);
  const raw = stored[STORAGE_KEY];
  return typeof raw === "boolean" ? raw : null;
}

/**
 * Persist the user's boost preference. Merges into the plugin's shared file
 * so the co-tenant keys (per-game profiles, custom device, manual TDP) are
 * preserved.
 */
export async function writeCpuBoostPref(options: {
  pluginId: string;
  enabled: boolean;
}): Promise<void> {
  const { pluginId, enabled } = options;
  await mutatePluginStorage<Record<string, unknown>>(pluginId, (existing) => ({
    ...existing,
    [STORAGE_KEY]: enabled,
  }));
}
