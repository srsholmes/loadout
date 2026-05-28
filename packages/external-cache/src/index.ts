/**
 * Per-plugin disk cache for external API responses.
 *
 *   $XDG_CACHE_HOME/steam-loader/<plugin-id>/<sha1(key)>.json
 *   (typically ~/.cache/steam-loader/<plugin-id>/<sha1(key)>.json)
 *
 * Plugins that fetch data from external sources (ProtonDB,
 * HowLongToBeat, SteamGridDB, …) wrap their fetch sites in
 * `cache.getOrFetch(key, fetcher, { ttlSec })`. The cache is
 * per-plugin so uninstalling a plugin (rm -rf its data dir) takes
 * the cache with it.
 *
 * **Why not tanstack-query**: TQ is a React-side request-state
 * manager that lives in the browser tab; it has no notion of
 * disk persistence and disappears on every tab reload. Our plugins
 * fetch from a Bun backend process and stash data so the next
 * session doesn't pay another network round-trip. JSON-on-disk
 * keyed by URL is what we actually need.
 *
 * **Why XDG_CACHE_HOME and not XDG_CONFIG_HOME**: this is
 * regenerable data, not user state. `~/.cache/` is exactly the
 * dir XDG carves out for "things the app can re-fetch on demand"
 * — fits the freedesktop spec, plays nicely with cleanup tools
 * like `bleachbit`, and lets `plugin-storage` (config) and
 * `external-cache` (cache) coexist on disk without one shadowing
 * the other.
 *
 * **Per-entry TTL**: each cache file carries its own `expiresAt`
 * timestamp. Read paths skip expired entries (treated as cache
 * miss) and `clearExpired()` sweeps them off disk. The ttlSec
 * argument to `getOrFetch` is per-call — different endpoints in
 * the same plugin can use different freshness windows.
 *
 * Writes are atomic: `<file>.tmp` is renamed onto the final path,
 * so a crash mid-write can't leave a torn file. Reads return
 * `undefined` (cache miss) when the file is missing, unparseable,
 * or expired — the caller treats all three the same way and
 * re-fetches.
 *
 * Typing pattern:
 *
 *   const cache = createExternalCache("protondb-badges");
 *   const report = await cache.getOrFetch<ProtonDBReport>(
 *     `report:${appId}`,
 *     () => fetch(url).then((r) => r.json()),
 *     { ttlSec: 60 * 60 },
 *   );
 *
 * Cache keys are arbitrary strings. They're SHA-1-hashed before
 * hitting disk so URLs, query strings, and unicode names all map
 * to the same fixed-width filename shape.
 */

// `fs/promises` (no node: prefix) matches the specifier plugin-storage
// uses so tests can mock both packages with one `mock.module(...)`.
import { readFile, mkdir, rename, rm, readdir, unlink } from "fs/promises";
import { createHash } from "crypto";
import { join, dirname } from "path";
import { homedir } from "os";

/** Public cache surface — what plugins import. */
export interface ExternalCache {
  /** Plugin id this cache is scoped to. */
  readonly pluginId: string;
  /** Absolute path of the plugin's cache directory. Resolved lazily
   *  per call from `XDG_CACHE_HOME`, so a test that flips the env
   *  var between runs sees the change without rebuilding the cache
   *  instance — same convention `plugin-storage` follows for
   *  `XDG_CONFIG_HOME`. */
  readonly dir: string;
  /**
   * Cache-aside fetch. If a fresh entry exists for `key`, return it.
   * Otherwise call `fetcher`, write the result with the given TTL,
   * and return it. `null` and `undefined` results from `fetcher` are
   * also cached — call sites that want negative-result caching get
   * it for free; ones that don't should branch in the fetcher.
   *
   * Failures inside `fetcher` propagate up; we don't write a partial
   * entry. This matches the in-memory caches the plugins already use.
   */
  getOrFetch<T>(
    key: string,
    fetcher: () => Promise<T>,
    opts: { ttlSec: number },
  ): Promise<T>;
  /** Read a cached value if present and unexpired; otherwise undefined. */
  get<T>(key: string): Promise<T | undefined>;
  /** Write a value with the given TTL. Overwrites any existing entry. */
  set<T>(key: string, value: T, opts: { ttlSec: number }): Promise<void>;
  /** Delete one entry. No-op if it doesn't exist. */
  delete(key: string): Promise<void>;
  /** Nuke the whole cache directory for this plugin. */
  clear(): Promise<void>;
  /** Sweep expired entries off disk. Returns the number removed. */
  clearExpired(): Promise<number>;
}

/** Wire shape of a cached entry — `expiresAt` is a Unix-ms timestamp. */
interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

/**
 * Resolve the cache root directory:
 *   $XDG_CACHE_HOME/steam-loader/  (when set)
 *   ~/.cache/steam-loader/         (fallback)
 *
 * Mirrors plugin-storage's `configDir` but rooted at the cache
 * variant of the XDG base-dir spec.
 */
export function cacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".cache");
  return join(base, "steam-loader");
}

/** Absolute path of a plugin's cache subdirectory. Exposed for tests
 *  + the loader's "clear all caches" RPC, which iterates plugins and
 *  prefers calling each plugin's own `clearExternalCache` RPC, but
 *  falls back to deleting this dir directly if the plugin doesn't
 *  expose one (defence in depth). */
export function pluginCacheDir(pluginId: string): string {
  return join(cacheDir(), pluginId);
}

/** Hash a cache key into a flat `<sha1>.json` filename. SHA-1 is fine
 *  here — collision resistance against an attacker isn't a concern,
 *  and we want a fixed-width filename regardless of how long / weird
 *  the source key is (URLs with query strings are typical). */
function keyToFilename(key: string): string {
  return createHash("sha1").update(key).digest("hex") + ".json";
}

/** Create a cache instance scoped to one plugin. Cheap — no disk
 *  I/O happens until the first read/write.
 *
 *  The cache dir is resolved per-call from `pluginCacheDir(pluginId)`
 *  rather than captured at construction time. That's load-bearing
 *  for the loader's hot-reload path and for spec setups that swap
 *  `XDG_CACHE_HOME` between tests — capturing once would freeze the
 *  cache to the env var's value at first construction. */
export function createExternalCache(pluginId: string): ExternalCache {
  if (!pluginId || typeof pluginId !== "string") {
    throw new Error("createExternalCache: pluginId is required");
  }

  function currentDir(): string {
    return pluginCacheDir(pluginId);
  }

  async function readEntry<T>(key: string): Promise<CacheEntry<T> | undefined> {
    const path = join(currentDir(), keyToFilename(key));
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        typeof (parsed as { expiresAt?: unknown }).expiresAt === "number"
      ) {
        return parsed as CacheEntry<T>;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  async function writeEntry<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    const path = join(currentDir(), keyToFilename(key));
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    const json = JSON.stringify(entry);
    // Bun.write when available (loader runs under Bun); fall back to
    // fs.writeFile so tests / non-Bun callers still work — same
    // pattern plugin-storage uses.
    const B = (globalThis as unknown as {
      Bun?: { write?: (p: string, d: string) => Promise<unknown> };
    }).Bun;
    if (B?.write) {
      await B.write(tmp, json);
    } else {
      const { writeFile } = await import("fs/promises");
      await writeFile(tmp, json, "utf8");
    }
    await rename(tmp, path);
  }

  return {
    pluginId,
    get dir(): string {
      return currentDir();
    },

    async get<T>(key: string): Promise<T | undefined> {
      const entry = await readEntry<T>(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= Date.now()) return undefined;
      return entry.value;
    },

    async set<T>(
      key: string,
      value: T,
      opts: { ttlSec: number },
    ): Promise<void> {
      await writeEntry<T>(key, {
        expiresAt: Date.now() + opts.ttlSec * 1000,
        value,
      });
    },

    async getOrFetch<T>(
      key: string,
      fetcher: () => Promise<T>,
      opts: { ttlSec: number },
    ): Promise<T> {
      const cached = await readEntry<T>(key);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.value;
      }
      const value = await fetcher();
      await writeEntry<T>(key, {
        expiresAt: Date.now() + opts.ttlSec * 1000,
        value,
      });
      return value;
    },

    async delete(key: string): Promise<void> {
      const path = join(currentDir(), keyToFilename(key));
      try {
        await unlink(path);
      } catch {
        /* not present — fine */
      }
    },

    async clear(): Promise<void> {
      // `rm -rf` on the per-plugin cache dir — `force: true` so a
      // missing dir isn't an error (clearing a never-warmed cache
      // should be a no-op, not a throw).
      await rm(currentDir(), { recursive: true, force: true });
    },

    async clearExpired(): Promise<number> {
      const dir = currentDir();
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return 0;
      }
      const now = Date.now();
      let removed = 0;
      for (const name of entries) {
        if (!name.endsWith(".json")) continue;
        const path = join(dir, name);
        let parsed: unknown;
        try {
          const raw = await readFile(path, "utf8");
          parsed = JSON.parse(raw);
        } catch {
          // Unreadable / corrupt — drop it; clearExpired is a janitor.
          try {
            await unlink(path);
            removed++;
          } catch {
            /* ignore */
          }
          continue;
        }
        const expiresAt = (parsed as { expiresAt?: unknown })?.expiresAt;
        if (typeof expiresAt !== "number" || expiresAt <= now) {
          try {
            await unlink(path);
            removed++;
          } catch {
            /* ignore */
          }
        }
      }
      return removed;
    },
  };
}

/**
 * Loader-side helper: nuke the cache directory for a plugin without
 * needing the plugin instance. Used as a defence-in-depth fallback
 * by the loader's "Clear all data caches" RPC for plugins that
 * don't expose a `clearExternalCache` method themselves. Also handy
 * when uninstalling a plugin entirely.
 */
export async function clearPluginCacheDir(pluginId: string): Promise<void> {
  await rm(pluginCacheDir(pluginId), { recursive: true, force: true });
}
