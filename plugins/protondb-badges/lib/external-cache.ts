/**
 * Tiny TTL disk cache, scoped to this plugin only.
 *
 * Inlined from the old `@steam-loader/external-cache` package because
 * the cross-plugin reuse bar (2+ migrated consumers) isn't met yet —
 * we'd rather repeat ~40 LOC than extract speculatively.
 *
 * Layout: `$XDG_CACHE_HOME/loadout/protondb-badges/<sha1(key)>.json`
 * (falls back to `~/.cache/loadout/protondb-badges/`). Each file holds
 * `{ expiresAt, value }`. Reads return `undefined` on missing /
 * unparseable / expired — caller treats all three as cache miss.
 *
 * The dir is resolved lazily per call so tests can flip
 * `XDG_CACHE_HOME` between runs without rebuilding the cache instance.
 */
import { readFile, writeFile, mkdir, rm, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

function cacheRoot(pluginId: string): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".cache");
  return join(base, "loadout", pluginId);
}

function keyToFile(pluginId: string, key: string): string {
  const hash = createHash("sha1").update(key).digest("hex");
  return join(cacheRoot(pluginId), `${hash}.json`);
}

export interface ExternalCache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, opts: { ttlSec: number }): Promise<void>;
  clear(): Promise<void>;
}

export function createExternalCache(pluginId: string): ExternalCache {
  if (!pluginId) throw new Error("createExternalCache: pluginId is required");

  return {
    async get<T>(key: string): Promise<T | undefined> {
      try {
        const raw = await readFile(keyToFile(pluginId, key), "utf8");
        const parsed = JSON.parse(raw) as CacheEntry<T>;
        if (typeof parsed?.expiresAt !== "number") return undefined;
        if (parsed.expiresAt <= Date.now()) return undefined;
        return parsed.value;
      } catch {
        return undefined;
      }
    },

    async set<T>(key: string, value: T, opts: { ttlSec: number }): Promise<void> {
      const path = keyToFile(pluginId, key);
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      const entry: CacheEntry<T> = {
        expiresAt: Date.now() + opts.ttlSec * 1000,
        value,
      };
      await writeFile(tmp, JSON.stringify(entry), "utf8");
      await rename(tmp, path);
    },

    async clear(): Promise<void> {
      await rm(cacheRoot(pluginId), { recursive: true, force: true });
    },
  };
}
