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
 * Writes are atomic: the helper writes to `<path>.tmp` and renames, so a
 * crash mid-write can't leave a torn file. Reads return an empty object
 * when the file is missing or unparseable; the caller is expected to
 * treat "no stored data" and "stored data that isn't our shape" the same
 * way (seed defaults, then persist).
 *
 * Typing pattern:
 *
 *   interface MyState { templates: Template[]; perGame: Record<string, Pins> }
 *   const state = await readPluginStorage<MyState>("quick-links");
 *   // state.templates / state.perGame may be undefined on first run
 *   await writePluginStorage<MyState>("quick-links", { templates, perGame });
 */

// `fs/promises` (no node: prefix) matches the specifier plugin tests mock
// via `mock.module("fs/promises", …)`. Keep this here so the tests don't
// need to know about the internal module path.
import { readFile, mkdir, rename, writeFile } from "fs/promises";
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
  // Prefer Bun.write when available (plugin backends run in the loader's
  // Bun process); fall back to fs.writeFile so tests and non-Bun callers
  // still work.
  const B = (globalThis as unknown as { Bun?: { write?: (p: string, d: string) => Promise<unknown> } }).Bun;
  if (B?.write) {
    await B.write(tmp, json);
  } else {
    await writeFile(tmp, json, "utf8");
  }
  await rename(tmp, path);
}
