/**
 * Per-plugin JSON storage under the user's Loadout config directory.
 *
 *   $XDG_CONFIG_HOME/loadout/plugins/<plugin-id>.json
 *   (typically ~/.config/loadout/plugins/<plugin-id>.json)
 *
 * Inlined into this plugin per the migration spec — the old repo shipped
 * this as a shared `@steam-loader/plugin-storage` package, but Loadout
 * keeps plugin code inside the plugin capsule unless 2+ migrated plugins
 * genuinely share it. Each plugin owns ONE JSON file keyed by its plugin
 * ID.
 *
 * Writes are atomic: the helper writes to `<path>.tmp` and renames, so a
 * crash mid-write can't leave a torn file. Reads return an empty object
 * when the file is missing or unparseable; the caller is expected to
 * treat "no stored data" and "stored data that isn't our shape" the same
 * way (seed defaults, then persist).
 */

import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join, dirname } from "path";
import { homedir } from "os";

function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "loadout");
}

/** Absolute path of a plugin's JSON storage file. Exposed for tests and
 *  tooling that wants to know where state lives without invoking the
 *  read/write helpers. */
export function pluginStoragePath(pluginId: string): string {
  return join(configDir(), "plugins", `${pluginId}.json`);
}

/** Read + parse the plugin's JSON file. Returns `{}` on any I/O or
 *  parse failure — callers treat missing keys as "needs seeding". */
export async function readPluginStorage<T extends object>(
  pluginId: string,
): Promise<Partial<T>> {
  try {
    const raw = await readFile(pluginStoragePath(pluginId), "utf8");
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
 *  subdirectory on first write. */
export async function writePluginStorage<T extends object>(
  pluginId: string,
  data: T,
): Promise<void> {
  const path = pluginStoragePath(pluginId);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const json = JSON.stringify(data, null, 2) + "\n";
  await writeFile(tmp, json, "utf8");
  await rename(tmp, path);
}
