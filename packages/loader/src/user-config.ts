/**
 * User config persistence at `~/.config/loadout/config.json`.
 *
 * Lives outside the app install dir so reinstalls/updates don't wipe
 * favorites, theme, scale, etc. The file is a flat key → JSON-value
 * map owned by the overlay frontend; the loader is just a dumb
 * read/merge/write persistence layer.
 *
 * Concurrency: the overlay fires PATCH requests from many call sites
 * (favorites toggle, drag/resize, theme change, last route, …) and
 * react-grid-layout in particular emits a burst of onLayoutChange
 * events during a single gesture. Two PATCHes racing read→merge→write
 * used to produce torn bytes on disk (interleaved writeFile calls),
 * which parsed back as "Unterminated string" and silently wiped the
 * config on the next read. All file I/O now goes through a single
 * promise-chain mutex and writes go through a tempfile+rename so the
 * file on disk is never partially written.
 *
 * XDG Base Directory: we honor $XDG_CONFIG_HOME if set, falling back to
 * ~/.config/. Same convention the rest of the system uses.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { log } from "./logger";

export type UserConfig = Record<string, unknown>;

function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "loadout");
}

export function userConfigPath(): string {
  return join(configDir(), "config.json");
}

// Serialize every read/write so a PATCH's read→merge→write is atomic
// w.r.t. other PATCHes. Bun is single-threaded but the async gap
// between readFile and writeFile is enough for concurrent handlers to
// interleave. Chain each op onto the tail of the queue.
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function atomicWriteFile(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, path);
}

async function readRaw(): Promise<UserConfig> {
  const path = userConfigPath();
  try {
    const contents = await readFile(path, "utf8");
    const parsed = JSON.parse(contents);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as UserConfig;
    }
    log.warn(`[user-config] ${path} is not an object — ignoring`);
    return {};
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return {};
    // Parse error or other read failure — preserve the broken file for
    // forensics instead of silently wiping it on the next PATCH.
    log.warn(`[user-config] Failed to read ${path}: ${e.message}`);
    try {
      const backup = `${path}.corrupted.${Date.now()}`;
      await rename(path, backup);
      log.warn(`[user-config] Backed up corrupted config to ${backup}`);
    } catch {}
    return {};
  }
}

async function writeRaw(config: UserConfig): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  await atomicWriteFile(userConfigPath(), JSON.stringify(config, null, 2) + "\n");
}

/** Read the config file. Returns {} if it doesn't exist or is malformed. */
export function readUserConfig(): Promise<UserConfig> {
  return enqueue(readRaw);
}

/** Overwrite the config file with the given object (pretty-printed). */
export function writeUserConfig(config: UserConfig): Promise<void> {
  return enqueue(() => writeRaw(config));
}

/** Merge partial updates into the on-disk config. Returns the new full config. */
export function patchUserConfig(patch: UserConfig): Promise<UserConfig> {
  return enqueue(async () => {
    const current = await readRaw();
    const next = { ...current, ...patch };
    await writeRaw(next);
    return next;
  });
}
