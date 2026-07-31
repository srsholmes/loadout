// Deliberately uses an in-memory ExternalCache double rather than the real
// `@loadout/external-cache`.
//
// Two other specs — packages/sgdb-art/src/index.test.ts and
// plugins/store-bridge/lib/stores/epic/index.test.ts — call
// `mock.module("@loadout/external-cache", …)` with a partial double that
// implements only `getOrFetch`. Those mocks leak across files despite
// `--isolate` (see docs/test-mock-contamination.md), so importing the real
// module here yields a cache whose `set` is undefined: green in isolation,
// twelve failures in the full suite.
//
// Injecting a double is the fix rather than a workaround. `ExternalCache` is
// a collaborator of `createFactStore`, not part of it, and the real one has
// its own disk-backed specs. The double JSON round-trips on read and write so
// it degrades exactly like disk does — a caller can never be handed a live
// reference to what it wrote, which is what makes the detached-copy and
// corrupt-document cases meaningful.

import { beforeEach, describe, expect, it } from "bun:test";

import type { ExternalCache } from "@loadout/external-cache";

import { createFactStore } from "./store";
import type { FactRow } from "./types";

const KEY = "progress:v1";
const ME = "76561198000000001";
const SOMEONE_ELSE = "76561198000000002";

/** In-memory ExternalCache that serialises like the disk-backed one. */
function fakeCache(): ExternalCache & { raw: Map<string, unknown> } {
  const raw = new Map<string, unknown>();
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  return {
    raw,
    pluginId: "game-facts-test",
    get dir() {
      return "/fake/cache/game-facts-test";
    },
    async get<T>(key: string): Promise<T | undefined> {
      return raw.has(key) ? clone(raw.get(key) as T) : undefined;
    },
    async set<T>(key: string, value: T): Promise<void> {
      raw.set(key, clone(value));
    },
    async delete(key: string): Promise<void> {
      raw.delete(key);
    },
    async clear(): Promise<void> {
      raw.clear();
    },
    async clearExpired(): Promise<number> {
      return 0;
    },
    async getOrFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
      if (raw.has(key)) return clone(raw.get(key) as T);
      const value = await fetcher();
      raw.set(key, clone(value));
      return value;
    },
  };
}

let cache: ExternalCache & { raw: Map<string, unknown> };

beforeEach(() => {
  cache = fakeCache();
});

function row(at: number, value: number): FactRow<number> {
  return { at, value };
}

describe("createFactStore", () => {
  it("reads empty on a cold cache and reports no match", async () => {
    const snap = await createFactStore<number>(cache, KEY, ME).load();
    expect(snap.matched).toBe(false);
    expect(snap.rows.size).toBe(0);
  });

  it("round-trips rows through the cache to a fresh store instance", async () => {
    const a = createFactStore<number>(cache, KEY, ME);
    await a.commit(new Map([["620", row(1000, 26)]]));

    // A second instance shares no memory with the first, so this proves the
    // write was persisted rather than only landing in the in-process memo.
    const b = createFactStore<number>(cache, KEY, ME);
    const snap = await b.load();
    expect(snap.matched).toBe(true);
    expect(snap.rows.get("620")).toEqual({ at: 1000, value: 26 });
  });

  it("merges successive commits rather than replacing", async () => {
    const store = createFactStore<number>(cache, KEY, ME);
    await store.commit(new Map([["620", row(1, 1)]]));
    await store.commit(new Map([["570", row(2, 2)]]));
    const merged = await store.commit(new Map([["292030", row(3, 3)]]));

    expect([...merged.keys()].sort()).toEqual(["292030", "570", "620"]);
    const reread = await createFactStore<number>(cache, KEY, ME).load();
    expect(reread.rows.size).toBe(3);
  });

  it("overwrites a row on re-commit", async () => {
    const store = createFactStore<number>(cache, KEY, ME);
    await store.commit(new Map([["620", row(1, 10)]]));
    const after = await store.commit(new Map([["620", row(2, 20)]]));
    expect(after.get("620")).toEqual({ at: 2, value: 20 });
  });

  it("writes once per commit, so a 40-batch sweep costs 40 writes not 1600", async () => {
    let writes = 0;
    const counting: ExternalCache = {
      ...cache,
      set: async (k, v, o) => {
        writes++;
        return cache.set(k, v, o);
      },
    };
    const store = createFactStore<number>(counting, KEY, ME);
    await store.commit(new Map([["a", row(1, 1)]]));
    await store.commit(new Map([["b", row(2, 2)]]));
    expect(writes).toBe(2);
  });

  it("reads the cache once, then serves later loads from memory", async () => {
    let reads = 0;
    const counting: ExternalCache = {
      ...cache,
      get: async (k) => {
        reads++;
        return cache.get(k);
      },
    };
    const store = createFactStore<number>(counting, KEY, ME);
    await store.load();
    await store.load();
    await store.commit(new Map([["a", row(1, 1)]]));
    await store.load();
    expect(reads).toBe(1);
  });

  it("returns a detached copy from load, so callers cannot corrupt the memo", async () => {
    const store = createFactStore<number>(cache, KEY, ME);
    await store.commit(new Map([["620", row(1, 1)]]));

    const first = await store.load();
    first.rows.delete("620");
    first.rows.set("junk", row(9, 9));

    const second = await store.load();
    expect(second.rows.has("620")).toBe(true);
    expect(second.rows.has("junk")).toBe(false);
  });

  describe("identity", () => {
    it("treats another account's document as empty", async () => {
      await createFactStore<number>(cache, KEY, ME).commit(
        new Map([["620", row(1, 26)]]),
      );

      // Switching Steam users must not mix two people's progress into one
      // ranking — the class of bug that is otherwise very hard to notice.
      const snap = await createFactStore<number>(cache, KEY, SOMEONE_ELSE).load();
      expect(snap.matched).toBe(false);
      expect(snap.rows.size).toBe(0);
    });

    it("does not leak the previous identity's rows into a later commit", async () => {
      await createFactStore<number>(cache, KEY, ME).commit(
        new Map([["620", row(1, 26)]]),
      );

      const theirs = createFactStore<number>(cache, KEY, SOMEONE_ELSE);
      await theirs.commit(new Map([["570", row(2, 5)]]));

      const snap = await theirs.load();
      expect(snap.rows.has("620")).toBe(false);
      expect(snap.rows.size).toBe(1);

      // And the original owner's rows are gone, not silently merged back in.
      expect((await createFactStore<number>(cache, KEY, ME).load()).matched).toBe(
        false,
      );
    });
  });

  describe("resilience", () => {
    it("treats a corrupt document as an empty cache", async () => {
      // A hand-edited or truncated file must degrade to a re-fetch, never throw.
      await cache.set(KEY, "not a document at all", { ttlSec: 1000 });
      const snap = await createFactStore<number>(cache, KEY, ME).load();
      expect(snap.matched).toBe(false);
      expect(snap.rows.size).toBe(0);
    });

    it("survives a cache read that throws", async () => {
      const hostile: ExternalCache = {
        ...cache,
        get: async () => {
          throw new Error("EIO");
        },
      };
      const snap = await createFactStore<number>(hostile, KEY, ME).load();
      expect(snap.matched).toBe(false);
      expect(snap.rows.size).toBe(0);
    });

    it("drops individual rows with a missing or non-numeric timestamp", async () => {
      await cache.set(
        KEY,
        {
          identity: ME,
          rows: {
            good: { at: 1000, value: 1 },
            noAt: { value: 2 },
            badAt: { at: "yesterday", value: 3 },
            nanAt: { at: NaN, value: 4 },
            nullRow: null,
          },
        },
        { ttlSec: 1000 },
      );

      const snap = await createFactStore<number>(cache, KEY, ME).load();
      // A row with no usable staleness is worse than absent: it would read as
      // fresh-or-stale by accident. Only `good` survives.
      expect([...snap.rows.keys()]).toEqual(["good"]);
    });

    it("survives a document with a missing rows object", async () => {
      await cache.set(KEY, { identity: ME }, { ttlSec: 1000 });
      const snap = await createFactStore<number>(cache, KEY, ME).load();
      expect(snap.matched).toBe(false);
      expect(snap.rows.size).toBe(0);
    });
  });

  describe("prune", () => {
    it("removes rows outside the keep set and reports the count", async () => {
      const store = createFactStore<number>(cache, KEY, ME);
      await store.commit(
        new Map([
          ["a", row(1, 1)],
          ["b", row(1, 2)],
          ["c", row(1, 3)],
          ["d", row(1, 4)],
        ]),
      );

      expect(await store.prune(new Set(["a", "c"]))).toBe(2);

      const snap = await createFactStore<number>(cache, KEY, ME).load();
      expect([...snap.rows.keys()].sort()).toEqual(["a", "c"]);
    });

    it("is a no-op when everything is kept", async () => {
      const store = createFactStore<number>(cache, KEY, ME);
      await store.commit(new Map([["a", row(1, 1)]]));
      expect(await store.prune(new Set(["a"]))).toBe(0);
      expect((await store.load()).rows.size).toBe(1);
    });

    it("does not write when nothing was removed", async () => {
      let writes = 0;
      const counting: ExternalCache = {
        ...cache,
        set: async (k, v, o) => {
          writes++;
          return cache.set(k, v, o);
        },
      };
      const store = createFactStore<number>(counting, KEY, ME);
      await store.commit(new Map([["a", row(1, 1)]]));
      writes = 0;
      await store.prune(new Set(["a"]));
      expect(writes).toBe(0);
    });
  });

  describe("clear", () => {
    it("deletes the document and reads empty afterwards", async () => {
      const store = createFactStore<number>(cache, KEY, ME);
      await store.commit(new Map([["a", row(1, 1)]]));
      await store.clear();

      expect((await store.load()).rows.size).toBe(0);
      expect((await createFactStore<number>(cache, KEY, ME).load()).matched).toBe(
        false,
      );
    });
  });
});
