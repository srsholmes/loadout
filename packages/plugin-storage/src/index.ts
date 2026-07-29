/**
 * Per-plugin JSON storage under the user's Loadout config directory.
 *
 *   $XDG_CONFIG_HOME/loadout/plugins/<plugin-id>.json
 *   (typically ~/.config/loadout/plugins/<plugin-id>.json)
 *
 * Plugin backends use this instead of inventing their own directory layout
 * so user data lives in one well-known place that's visible to the user,
 * backup-friendly, and survives overlay reinstalls (same dir as the
 * overlay's `config.json`). Each plugin owns ONE JSON file keyed by its
 * plugin ID. The overlay shell never touches these files — they're plugin
 * state, not user preferences.
 *
 * Writes are atomic: tmp file + rename. POSIX rename is atomic when src
 * and dst share a filesystem, so a crash mid-write never leaves a torn
 * file — the previous successful write is still the one readers see. The
 * tmp filename includes a randomUUID() so concurrent writes (or a retried
 * write while a stale tmp is still on disk) can't clobber each other.
 *
 * Reads return `{}` (typed as `Partial<T>`) when the file is missing or
 * unparseable. Callers are expected to treat "no stored data" and "stored
 * data that isn't our shape" the same way — destructure with defaults:
 *
 *   const { sessions = [], pendingActive = null } =
 *     await readPluginStorage<PlaytimeData>("playtime");
 */

import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

/** Base directory for Loadout config (XDG-aware). */
export function loadoutConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "loadout");
}

/** Absolute path of a plugin's JSON storage file. Exposed for tests and
 *  tooling that wants to know where state lives without invoking the
 *  read/write helpers. */
export function pluginStoragePath(pluginId: string): string {
  return join(loadoutConfigDir(), "plugins", `${pluginId}.json`);
}

/** Read + parse the plugin's JSON file. Returns `{}` on any I/O or
 *  parse failure — callers treat missing keys as "needs seeding". */
export async function readPluginStorage<T extends object>(
  pluginId: string,
): Promise<Partial<T>> {
  try {
    const raw = await readFile(pluginStoragePath(pluginId), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Partial<T>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Overwrite the plugin's JSON file atomically. Creates the `plugins/`
 *  subdirectory on first write. Throws on I/O failure — callers should
 *  catch and warn.
 *
 *  Uses fs.writeFile (not Bun.write) so consumers can spy on this with
 *  `spyOn(fsPromises, "writeFile")` for testing. The Bun.write fast-path
 *  the old @steam-loader package had wasn't measurably faster for the
 *  small JSON writes plugins actually do here, and it broke the spy. */
export async function writePluginStorage<T extends object>(
  pluginId: string,
  data: T,
): Promise<void> {
  const path = pluginStoragePath(pluginId);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  await rename(tmp, path);
}

// Per-plugin write lock. Several call sites do independent read-modify-write
// on the SAME plugin file (e.g. a custom-curve save and a per-game-profile
// save both merging into fan-control.json). Without serialization their
// reads can interleave and one write clobbers the other's top-level keys —
// a lost update. One chained promise per pluginId makes those cycles
// strictly sequential.
const storageLocks = new Map<string, Promise<unknown>>();

/**
 * Serialized read-modify-write of a plugin's JSON. `mutate` receives the
 * current contents and returns the next contents; for a given `pluginId`
 * the read+write is queued behind any in-flight mutation, so concurrent
 * callers each observe the previous one's result instead of overwriting it.
 * Use this instead of a bare read→spread→write whenever more than one code
 * path persists into the same file. Throws on I/O failure (after the lock
 * advances) — callers should catch and warn.
 */
export async function mutatePluginStorage<T extends object>(
  pluginId: string,
  mutate: (current: Partial<T>) => T,
): Promise<void> {
  const prior = storageLocks.get(pluginId) ?? Promise.resolve();
  // A failed prior mutation must not poison the chain for later writers.
  const run = prior
    .catch(() => {})
    .then(async () => {
      const current = await readPluginStorage<T>(pluginId);
      await writePluginStorage(pluginId, mutate(current));
    });
  storageLocks.set(pluginId, run);
  return run;
}
