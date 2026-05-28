/**
 * Minimal plugin-storage helper — inlined from the removed
 * `@steam-loader/plugin-storage` package.
 *
 * Reads and writes JSON at `~/.config/loadout/plugins/<filename>.json`.
 * Uses an atomic tmp+rename pattern so a crash mid-write never corrupts
 * the file.
 *
 * NOTE: This is an extraction candidate — battery-tracker (and any other
 * plugin that persists data) will likely inline identical logic. Flag to
 * the coordinator when a second plugin copies this file.
 */

import { writeFile, readFile, mkdir, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const PLUGIN_DATA_DIR = join(homedir(), ".config", "loadout", "plugins");

/** Return the canonical path for a plugin's JSON store. */
export function pluginDataPath(filename: string): string {
  return join(PLUGIN_DATA_DIR, filename.endsWith(".json") ? filename : `${filename}.json`);
}

/** Ensure the plugin data directory exists. */
export async function ensurePluginDataDir(): Promise<void> {
  await mkdir(PLUGIN_DATA_DIR, { recursive: true });
}

/**
 * Read the plugin's JSON store. Returns `defaultValue` if the file
 * does not exist or cannot be parsed.
 */
export async function readPluginData<T>(path: string, defaultValue: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return defaultValue;
  }
}

/**
 * Write `data` to `path` atomically (tmp file + rename).
 * Throws on I/O failure — callers should catch and warn.
 */
export async function writePluginData<T>(path: string, data: T): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  // Node's rename is atomic on POSIX when src and dst share a filesystem.
  await rename(tmp, path);
}
