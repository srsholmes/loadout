import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";

// Mocks for the external-package surface. Re-applied at module-load
// time so spec ordering doesn't matter.
let storedApiKey: string | null = null;

mock.module("@loadout/plugin-storage", () => ({
  readPluginStorage: async (id: string) =>
    id === "steamgriddb" && storedApiKey ? { apiKey: storedApiKey } : null,
  writePluginStorage: async () => {},
}));

let externalCache: Record<string, unknown> = {};
mock.module("@loadout/external-cache", () => ({
  createExternalCache: () => ({
    getOrFetch: async <T>(
      key: string,
      compute: () => Promise<T>,
    ): Promise<T> => {
      if (key in externalCache) return externalCache[key] as T;
      const v = await compute();
      externalCache[key] = v;
      return v;
    },
  }),
}));

mock.module("@loadout/steam-cdp", () => ({
  withSteamClient: async () => {
    throw new Error("Steam not reachable");
  },
  SteamClientUnreachableError: class extends Error {},
}));

mock.module("@loadout/steam-paths", () => ({
  getSteamDir: () => "/tmp/sgdb-art-test-steam",
  getUserdataDir: () => "/tmp/sgdb-art-test-steam/userdata",
  getUserIds: async () => [],
}));

mock.module("@loadout/vdf", () => ({
  shortcutGameId64: (n: number) => String((BigInt(n) << 32n) | (1n << 25n)),
  parseBinaryVdf: () => ({}),
}));

const originalFetch = globalThis.fetch;
let fetchCalls: string[] = [];
function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  (globalThis as { fetch: typeof fetch }).fetch = ((url: string) => {
    fetchCalls.push(url);
    return Promise.resolve(handler(url));
  }) as unknown as typeof fetch;
}

const envBackup = process.env.STEAMGRIDDB_API_KEY;

beforeEach(() => {
  externalCache = {};
  storedApiKey = null;
  fetchCalls = [];
  process.env.STEAMGRIDDB_API_KEY = "";
});

afterEach(() => {
  (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
  process.env.STEAMGRIDDB_API_KEY = envBackup ?? "";
});

describe("applyAllArtwork", () => {
  it("returns missingApiKey when there's no SGDB key and no fallbacks", async () => {
    const { applyAllArtwork } = await import("./index");
    const r = await applyAllArtwork({
      appId: 1234,
      source: "shortcut",
      title: "Some Game",
    });
    expect(r.missingApiKey).toBe(true);
    expect(r.written).toBe(0);
  });

  it("does NOT mark missingApiKey when a fallback URL is provided", async () => {
    // Stub fetch to fail the image download — we only care that the
    // pipeline got past the no-config short-circuit.
    stubFetch(() => new Response("err", { status: 500 }));
    const { applyAllArtwork } = await import("./index");
    const r = await applyAllArtwork({
      appId: 1234,
      source: "shortcut",
      title: "",
      fallbackUrls: { grid_p: "https://cdn.example/cover.jpg" },
      types: ["grid_p"],
    });
    expect(r.missingApiKey).toBeUndefined();
  });
});

describe("searchSgdbGameId", () => {
  it("returns null for an empty title", async () => {
    const { searchSgdbGameId } = await import("./index");
    expect(await searchSgdbGameId("   ", "key")).toBeNull();
  });

  it("returns the verified hit when present", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            success: true,
            data: [
              { id: 1, name: "Some Other", verified: false },
              { id: 42, name: "Match", verified: true },
            ],
          }),
          { status: 200 },
        ),
    );
    const { searchSgdbGameId } = await import("./index");
    expect(await searchSgdbGameId("Match", "key")).toBe(42);
  });

  it("falls back to the first hit when none are verified", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            success: true,
            data: [
              { id: 7, name: "First" },
              { id: 8, name: "Second" },
            ],
          }),
          { status: 200 },
        ),
    );
    const { searchSgdbGameId } = await import("./index");
    expect(await searchSgdbGameId("First", "key")).toBe(7);
  });

  it("returns null on fetch failure", async () => {
    stubFetch(() => new Response("nope", { status: 500 }));
    const { searchSgdbGameId } = await import("./index");
    expect(await searchSgdbGameId("X", "key")).toBeNull();
  });

  it("returns null when the endpoint says success=false", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ success: false, data: [] }), {
          status: 200,
        }),
    );
    const { searchSgdbGameId } = await import("./index");
    expect(await searchSgdbGameId("X", "key")).toBeNull();
  });
});

describe("getCatalogCoverUrl", () => {
  it("returns null without an API key (without hitting the network)", async () => {
    stubFetch(() => {
      throw new Error("fetch should NOT be called");
    });
    const { getCatalogCoverUrl } = await import("./index");
    expect(
      await getCatalogCoverUrl({ title: "X", cacheKey: "key:X" }),
    ).toBeNull();
    expect(fetchCalls.length).toBe(0);
  });

  it("resolves a grid URL when API key + sgdbId are available", async () => {
    storedApiKey = "test-key";
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            success: true,
            data: [{ id: 1, score: 10, url: "https://cdn/x.png" }],
          }),
          { status: 200 },
        ),
    );
    const { getCatalogCoverUrl } = await import("./index");
    const url = await getCatalogCoverUrl({
      title: "Alba",
      sgdbId: 999,
      cacheKey: "catalog:Alba",
    });
    expect(url).toBe("https://cdn/x.png");
  });

  it("uses the catalog cache so repeat lookups don't refetch", async () => {
    storedApiKey = "test-key";
    let calls = 0;
    stubFetch(() => {
      calls++;
      return new Response(
        JSON.stringify({
          success: true,
          data: [{ id: 1, score: 10, url: "https://cdn/y.png" }],
        }),
        { status: 200 },
      );
    });
    const { getCatalogCoverUrl } = await import("./index");
    await getCatalogCoverUrl({ title: "Cached", sgdbId: 1, cacheKey: "k1" });
    await getCatalogCoverUrl({ title: "Cached", sgdbId: 1, cacheKey: "k1" });
    expect(calls).toBe(1);
  });
});

describe("getCatalogHeroUrl", () => {
  it("returns null without an API key (without hitting the network)", async () => {
    stubFetch(() => {
      throw new Error("fetch should NOT be called");
    });
    const { getCatalogHeroUrl } = await import("./index");
    expect(
      await getCatalogHeroUrl({ title: "X", cacheKey: "hero:X" }),
    ).toBeNull();
    expect(fetchCalls.length).toBe(0);
  });

  it("resolves a hero URL by hitting /heroes/game/<id>", async () => {
    storedApiKey = "test-key";
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            success: true,
            data: [{ id: 7, score: 5, url: "https://cdn/h.png" }],
          }),
          { status: 200 },
        ),
    );
    const { getCatalogHeroUrl } = await import("./index");
    const url = await getCatalogHeroUrl({
      title: "Alba",
      sgdbId: 999,
      cacheKey: "hero:Alba",
    });
    expect(url).toBe("https://cdn/h.png");
    // The hero endpoint must be heroes/game/<id>, not grids/game/<id>.
    expect(fetchCalls.some((u) => u.includes("/heroes/game/"))).toBe(true);
  });

  it("caches separately from the cover-url namespace (catalog-hero: prefix)", async () => {
    storedApiKey = "test-key";
    let calls = 0;
    stubFetch(() => {
      calls++;
      return new Response(
        JSON.stringify({
          success: true,
          data: [{ id: 1, score: 10, url: "https://cdn/cached-hero.png" }],
        }),
        { status: 200 },
      );
    });
    const { getCatalogCoverUrl, getCatalogHeroUrl } = await import("./index");
    // Same cacheKey across cover + hero. If the keys collided in the
    // shared cache we'd see one network call serve both. Distinct
    // prefixes — `catalog-cover:k` vs `catalog-hero:k` — keep them
    // separate.
    await getCatalogCoverUrl({ title: "Same", sgdbId: 1, cacheKey: "k" });
    await getCatalogHeroUrl({ title: "Same", sgdbId: 1, cacheKey: "k" });
    expect(calls).toBe(2);
  });
});
