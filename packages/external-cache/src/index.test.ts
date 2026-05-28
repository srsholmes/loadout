// Backend specs for @loadout/external-cache. Real disk I/O against
// a per-test temp dir set via XDG_CACHE_HOME — same pattern
// plugin-storage uses (see ./packages/plugin-storage/src/index.spec.ts)
// to avoid the `mock.module("fs/promises", …)` cross-file leakage that
// bit several other backend specs.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
} from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";

import {
  cacheDir,
  pluginCacheDir,
  createExternalCache,
  clearPluginCacheDir,
} from "./index";

let tempDir: string;
let prevXdg: string | undefined;

beforeEach(() => {
  prevXdg = process.env.XDG_CACHE_HOME;
  tempDir = mkdtempSync(join(tmpdir(), "external-cache-spec-"));
  process.env.XDG_CACHE_HOME = tempDir;
});

afterEach(() => {
  if (prevXdg === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = prevXdg;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe("cacheDir / pluginCacheDir", () => {
  it("honors XDG_CACHE_HOME when set", () => {
    expect(cacheDir()).toBe(join(tempDir, "steam-loader"));
    expect(pluginCacheDir("my-plugin")).toBe(
      join(tempDir, "steam-loader", "my-plugin"),
    );
  });

  it("falls back to ~/.cache when XDG_CACHE_HOME is unset or empty", () => {
    delete process.env.XDG_CACHE_HOME;
    expect(cacheDir()).toBe(join(homedir(), ".cache", "steam-loader"));

    process.env.XDG_CACHE_HOME = "";
    expect(cacheDir()).toBe(join(homedir(), ".cache", "steam-loader"));
  });
});

describe("createExternalCache", () => {
  it("rejects an empty pluginId", () => {
    expect(() => createExternalCache("")).toThrow();
  });

  it("returns undefined for a missing key", async () => {
    const cache = createExternalCache("p1");
    expect(await cache.get("never-set")).toBeUndefined();
  });
});

describe("getOrFetch", () => {
  it("calls the fetcher on cache miss and caches the result", async () => {
    const cache = createExternalCache("p1");
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return { hello: "world" };
    };

    const first = await cache.getOrFetch("k", fetcher, { ttlSec: 60 });
    expect(first).toEqual({ hello: "world" });
    expect(calls).toBe(1);

    // Second call within TTL — fetcher should NOT run again.
    const second = await cache.getOrFetch("k", fetcher, { ttlSec: 60 });
    expect(second).toEqual({ hello: "world" });
    expect(calls).toBe(1);
  });

  it("caches null results too (negative-result caching)", async () => {
    const cache = createExternalCache("p1");
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return null;
    };
    const first = await cache.getOrFetch<null>("k", fetcher, { ttlSec: 60 });
    expect(first).toBeNull();
    const second = await cache.getOrFetch<null>("k", fetcher, { ttlSec: 60 });
    expect(second).toBeNull();
    expect(calls).toBe(1);
  });

  it("re-fetches after the entry expires", async () => {
    const cache = createExternalCache("p1");
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return calls;
    };

    // ttlSec: 0 means the entry is expired the moment after we write
    // it (Date.now() === expiresAt is treated as expired).
    const first = await cache.getOrFetch<number>("k", fetcher, { ttlSec: 0 });
    expect(first).toBe(1);

    // Sleep one millisecond so Date.now advances past expiresAt.
    await new Promise((r) => setTimeout(r, 5));

    const second = await cache.getOrFetch<number>("k", fetcher, { ttlSec: 0 });
    expect(second).toBe(2);
    expect(calls).toBe(2);
  });

  it("propagates fetcher errors and does not write a cache entry", async () => {
    const cache = createExternalCache("p1");
    const fetcher = async () => {
      throw new Error("upstream is down");
    };

    await expect(
      cache.getOrFetch("k", fetcher, { ttlSec: 60 }),
    ).rejects.toThrow("upstream is down");

    // After the failure, the cache should still be empty — i.e. the
    // next call hits the fetcher again instead of returning a cached
    // failure.
    let okCalls = 0;
    const okFetcher = async () => {
      okCalls++;
      return "ok";
    };
    const v = await cache.getOrFetch("k", okFetcher, { ttlSec: 60 });
    expect(v).toBe("ok");
    expect(okCalls).toBe(1);
  });
});

describe("set / get / delete", () => {
  it("round-trips via set + get", async () => {
    const cache = createExternalCache("p1");
    await cache.set("k", { count: 7 }, { ttlSec: 60 });
    expect(await cache.get<{ count: number }>("k")).toEqual({ count: 7 });
  });

  it("get returns undefined once the entry has expired", async () => {
    const cache = createExternalCache("p1");
    await cache.set("k", { count: 7 }, { ttlSec: 0 });
    await new Promise((r) => setTimeout(r, 5));
    expect(await cache.get("k")).toBeUndefined();
  });

  it("delete removes a single entry without touching others", async () => {
    const cache = createExternalCache("p1");
    await cache.set("a", 1, { ttlSec: 60 });
    await cache.set("b", 2, { ttlSec: 60 });
    await cache.delete("a");
    expect(await cache.get("a")).toBeUndefined();
    expect(await cache.get<number>("b")).toBe(2);
  });

  it("delete is a no-op when the entry doesn't exist", async () => {
    const cache = createExternalCache("p1");
    // Should not throw.
    await cache.delete("never-existed");
  });
});

describe("clear", () => {
  it("removes the entire plugin cache directory", async () => {
    const cache = createExternalCache("p1");
    await cache.set("a", 1, { ttlSec: 60 });
    await cache.set("b", 2, { ttlSec: 60 });
    expect(existsSync(cache.dir)).toBe(true);

    await cache.clear();
    expect(existsSync(cache.dir)).toBe(false);

    // Subsequent reads behave like a fresh cache.
    expect(await cache.get("a")).toBeUndefined();
  });

  it("is a no-op on a never-warmed cache", async () => {
    const cache = createExternalCache("never-warmed");
    expect(existsSync(cache.dir)).toBe(false);
    // Should not throw.
    await cache.clear();
  });

  it("isolates plugins from each other", async () => {
    const a = createExternalCache("plugin-a");
    const b = createExternalCache("plugin-b");
    await a.set("k", "from-a", { ttlSec: 60 });
    await b.set("k", "from-b", { ttlSec: 60 });

    await a.clear();

    expect(await a.get("k")).toBeUndefined();
    expect(await b.get<string>("k")).toBe("from-b");
  });
});

describe("clearExpired", () => {
  it("removes only entries whose TTL has lapsed", async () => {
    const cache = createExternalCache("p1");
    await cache.set("fresh", "still here", { ttlSec: 60 });
    await cache.set("stale", "should die", { ttlSec: 0 });
    await new Promise((r) => setTimeout(r, 5));

    const removed = await cache.clearExpired();
    expect(removed).toBe(1);

    expect(await cache.get<string>("fresh")).toBe("still here");
    expect(await cache.get("stale")).toBeUndefined();
  });

  it("returns 0 when the directory doesn't exist", async () => {
    const cache = createExternalCache("never-warmed");
    expect(await cache.clearExpired()).toBe(0);
  });

  it("removes corrupt files too", async () => {
    const cache = createExternalCache("p1");
    await cache.set("good", { ok: true }, { ttlSec: 60 });

    // Write a garbage file alongside the good one.
    const garbagePath = join(cache.dir, "garbage.json");
    Bun.write(garbagePath, "{not valid json");
    await new Promise((r) => setTimeout(r, 5));

    // Sanity: file should be there before we sweep.
    expect(readdirSync(cache.dir)).toContain("garbage.json");

    const removed = await cache.clearExpired();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(readdirSync(cache.dir)).not.toContain("garbage.json");
    expect(await cache.get<{ ok: boolean }>("good")).toEqual({ ok: true });
  });
});

describe("clearPluginCacheDir helper", () => {
  it("removes a plugin's whole cache dir without an instance", async () => {
    const cache = createExternalCache("p1");
    await cache.set("k", 1, { ttlSec: 60 });
    expect(existsSync(cache.dir)).toBe(true);
    await clearPluginCacheDir("p1");
    expect(existsSync(cache.dir)).toBe(false);
  });

  it("is a no-op for a plugin that never wrote anything", async () => {
    // Should not throw.
    await clearPluginCacheDir("nope");
  });
});

describe("on-disk format", () => {
  it("writes an entry with expiresAt + value as JSON", async () => {
    const cache = createExternalCache("p1");
    const before = Date.now();
    await cache.set("k", { v: 1 }, { ttlSec: 60 });
    const after = Date.now();

    const files = readdirSync(cache.dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{40}\.json$/);

    const raw = readFileSync(join(cache.dir, files[0]), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.value).toEqual({ v: 1 });
    expect(parsed.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(parsed.expiresAt).toBeLessThanOrEqual(after + 60_000 + 5);
  });

  it("writes are atomic — no .tmp sidecar after a successful set", async () => {
    const cache = createExternalCache("p1");
    await cache.set("k", { v: 1 }, { ttlSec: 60 });
    const files = readdirSync(cache.dir);
    expect(files.every((f) => !f.endsWith(".tmp"))).toBe(true);
  });
});
