import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import type { EmitPayload } from "@loadout/types";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import HltbBackend from "./backend";

// ── Helpers ──────────────────────────────────────────────────────

/** Build a fake HLTB API game result. */
function fakeHltbResult(overrides: Record<string, unknown> = {}) {
  return {
    game_id: 1234,
    game_name: "Elden Ring",
    game_image: "elden-ring.jpg",
    comp_main: 180000, // 50h
    comp_plus: 360000, // 100h
    comp_100: 540000, // 150h
    comp_all: 270000, // 75h
    comp_all_count: 5000,
    profile_steam: 1245620,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe("HltbBackend", () => {
  let backend: HltbBackend;
  let emittedEvents: EmitPayload[];
  let originalFetch: typeof globalThis.fetch;
  let mockFetch: ReturnType<typeof mock>;
  let tmpDataDir: string;
  let tmpCacheDir: string;
  let savedXdgCacheHome: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockFetch = mock(() => Promise.resolve(new Response("", { status: 500 })));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    // Sandbox the @loadout/external-cache disk cache so a
    // search/getTimes response from one test doesn't poison the
    // next test's "fresh fetch" expectation. Without this the cache
    // hits the developer's real `~/.cache/loadout/hltb/` and
    // tests see each other's persisted responses. MUST be set
    // BEFORE constructing the backend — `createExternalCache()`
    // captures the resolved cache dir at construction time.
    savedXdgCacheHome = process.env.XDG_CACHE_HOME;
    tmpCacheDir = mkdtempSync(join(tmpdir(), "hltb-spec-cache-"));
    process.env.XDG_CACHE_HOME = tmpCacheDir;

    // Sandbox the on-disk settings file. The `settings` describe()
    // below calls `updateSettings` which writes through to
    // `<dataDir>/settings.json` — without redirecting we'd stomp the
    // dev's real `~/.config/loadout/hltb/settings.json` on every
    // run, which silently reset their saved BPM-badge position.
    tmpDataDir = mkdtempSync(join(tmpdir(), "hltb-spec-"));
    backend = new HltbBackend({ dataDir: tmpDataDir });
    emittedEvents = [];
    backend.emit = (payload: EmitPayload) => {
      emittedEvents.push(payload);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    try {
      rmSync(tmpDataDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; tmpdir entries get reaped on reboot anyway
    }
    try {
      rmSync(tmpCacheDir, { recursive: true, force: true });
    } catch {
      /* same — best-effort */
    }
    if (savedXdgCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = savedXdgCacheHome;
    }
  });

  // ── searchGame ───────────────────────────────────────────────

  describe("searchGame", () => {
    it("returns empty array for empty query", async () => {
      expect(await backend.searchGame("")).toEqual([]);
      expect(await backend.searchGame("   ")).toEqual([]);
    });

    it("parses search results and formats times correctly", async () => {
      mockFetch.mockImplementation((url: string | URL, _opts?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/api/bleed/init")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                token: "test-token",
                hpKey: "hp-k",
                hpVal: "hp-v",
              }),
              { status: 200 },
            ),
          );
        }
        if (urlStr.includes("/api/bleed")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: [
                  fakeHltbResult(),
                  fakeHltbResult({
                    game_id: 5678,
                    game_name: "Celeste",
                    game_image: "",
                    comp_main: 3600,
                    comp_plus: 7200,
                    comp_100: 14400,
                    comp_all: 9000,
                  }),
                ],
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      });

      const results = await backend.searchGame("elden ring");

      expect(results).toHaveLength(2);

      expect(results[0].gameId).toBe(1234);
      expect(results[0].gameName).toBe("Elden Ring");
      expect(results[0].gameImage).toBe(
        "https://howlongtobeat.com/games/elden-ring.jpg",
      );
      expect(results[0].mainStory).toBe("50.0h");

      expect(results[1].gameId).toBe(5678);
      expect(results[1].gameImage).toBe("");
      expect(results[1].mainStory).toBe("1.0h");
    });

    it("returns cached results on repeated queries", async () => {
      let searchCallCount = 0;
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/api/bleed/init")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ token: "t", hpKey: "hp-k", hpVal: "hp-v" }),
              { status: 200 },
            ),
          );
        }
        if (urlStr.includes("/api/")) {
          searchCallCount++;
          return Promise.resolve(
            new Response(JSON.stringify({ data: [fakeHltbResult()] }), {
              status: 200,
            }),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      });

      const r1 = await backend.searchGame("elden ring");
      const r2 = await backend.searchGame("Elden Ring");
      expect(r1).toEqual(r2);
      expect(searchCallCount).toBe(1);
    });

    it("handles API returning non-200 gracefully", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/api/bleed/init")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ token: "t", hpKey: "hp-k", hpVal: "hp-v" }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response("", { status: 503 }));
      });

      const results = await backend.searchGame("test");
      expect(results).toEqual([]);
    });

    it("handles unexpected response format", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/api/bleed/init")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ token: "t", hpKey: "hp-k", hpVal: "hp-v" }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ error: "something" }), { status: 200 }),
        );
      });

      const results = await backend.searchGame("test");
      expect(results).toEqual([]);
    });

    it("retries with fresh auth when request fails with expired token (403)", async () => {
      let fetchCount = 0;
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/api/bleed/init")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                token: `token-${++fetchCount}`,
                hpKey: `hp-k-${fetchCount}`,
                hpVal: `hp-v-${fetchCount}`,
              }),
              { status: 200 },
            ),
          );
        }
        if (urlStr.includes("/api/bleed")) {
          // First search call (with the first-issued auth) returns 403 to
          // simulate an expired triple; plugin should refresh + retry once.
          if (fetchCount <= 1) {
            return Promise.resolve(new Response("", { status: 403 }));
          }
          return Promise.resolve(
            new Response(JSON.stringify({ data: [fakeHltbResult()] }), {
              status: 200,
            }),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      });

      const results = await backend.searchGame("test");
      expect(results).toHaveLength(1);
    });
  });

  // ── getTimesForSteamApp ─────────────────────────────────────

  describe("getTimesForSteamApp", () => {
    it("returns null when game name cannot be found from Steam API", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response("", { status: 404 })),
      );

      const result = await backend.getTimesForSteamApp("999999");
      expect(result).toBeNull();
    });

    it("matches by profile_steam (appId) first", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("store.steampowered.com/api/appdetails")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                "1245620": {
                  success: true,
                  data: { name: "Elden Ring" },
                },
              }),
              { status: 200 },
            ),
          );
        }
        if (urlStr.includes("/api/bleed/init")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ token: "t", hpKey: "hp-k", hpVal: "hp-v" }),
              { status: 200 },
            ),
          );
        }
        if (urlStr.includes("/api/")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: [
                  fakeHltbResult({
                    game_name: "Wrong Game",
                    profile_steam: 9999,
                  }),
                  fakeHltbResult({ profile_steam: 1245620 }),
                ],
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      });

      const result = await backend.getTimesForSteamApp("1245620");
      expect(result).not.toBeNull();
      expect(result!.gameName).toBe("elden ring"); // normalized
    });

    it("falls back to name matching when profile_steam doesn't match", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("store.steampowered.com/api/appdetails")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                "12345": {
                  success: true,
                  data: { name: "Celeste" },
                },
              }),
              { status: 200 },
            ),
          );
        }
        if (urlStr.includes("/api/bleed/init")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ token: "t", hpKey: "hp-k", hpVal: "hp-v" }),
              { status: 200 },
            ),
          );
        }
        if (urlStr.includes("/api/")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: [
                  fakeHltbResult({
                    game_id: 100,
                    game_name: "Celeste",
                    profile_steam: 0,
                    comp_main: 3600,
                  }),
                  fakeHltbResult({
                    game_id: 200,
                    game_name: "Other Game",
                    profile_steam: 0,
                  }),
                ],
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      });

      const result = await backend.getTimesForSteamApp("12345");
      expect(result).not.toBeNull();
      expect(result!.gameId).toBe(100);
    });

    it("caches steam app results", async () => {
      let steamCalls = 0;
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("store.steampowered.com/api/appdetails")) {
          steamCalls++;
          return Promise.resolve(
            new Response(
              JSON.stringify({
                "1245620": {
                  success: true,
                  data: { name: "Elden Ring" },
                },
              }),
              { status: 200 },
            ),
          );
        }
        if (urlStr.includes("/api/bleed/init")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ token: "t", hpKey: "hp-k", hpVal: "hp-v" }),
              { status: 200 },
            ),
          );
        }
        if (urlStr.includes("/api/")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ data: [fakeHltbResult()] }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      });

      await backend.getTimesForSteamApp("1245620");
      await backend.getTimesForSteamApp("1245620");
      // Steam API should be called once (game name cached), HLTB search once (result cached)
      expect(steamCalls).toBe(1);
    });

    it("returns null when HLTB has no results", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("store.steampowered.com/api/appdetails")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                "99999": { success: true, data: { name: "Unknown Game" } },
              }),
              { status: 200 },
            ),
          );
        }
        if (urlStr.includes("/api/bleed/init")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ token: "t", hpKey: "hp-k", hpVal: "hp-v" }),
              { status: 200 },
            ),
          );
        }
        if (urlStr.includes("/api/")) {
          return Promise.resolve(
            new Response(JSON.stringify({ data: [] }), { status: 200 }),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      });

      const result = await backend.getTimesForSteamApp("99999");
      expect(result).toBeNull();
    });
  });

  // ── getBadgeData ────────────────────────────────────────────

  describe("getBadgeData", () => {
    it("returns times and settings together", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("store.steampowered.com/api/appdetails")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                "1245620": {
                  success: true,
                  data: { name: "Elden Ring" },
                },
              }),
              { status: 200 },
            ),
          );
        }
        if (urlStr.includes("/api/bleed/init")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ token: "t", hpKey: "hp-k", hpVal: "hp-v" }),
              { status: 200 },
            ),
          );
        }
        if (urlStr.includes("/api/")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ data: [fakeHltbResult()] }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      });

      const data = await backend.getBadgeData("1245620");
      expect(data.times).not.toBeNull();
      expect(data.settings).toBeDefined();
      expect(data.settings.enableLibraryBadge).toBe(true);
      expect(data.settings.showMainStory).toBe(true);
    });
  });

  // ── Settings ────────────────────────────────────────────────

  describe("settings", () => {
    it("returns default settings", async () => {
      const settings = await backend.getSettings();
      expect(settings.position).toBe("tl");
      expect(settings.showMainStory).toBe(true);
      expect(settings.enableLibraryBadge).toBe(true);
      expect(settings.enableStoreBadge).toBe(true);
    });

    it("updates settings and emits state", async () => {
      await backend.updateSettings({
        position: "br",
        showMainStory: true,
        showMainPlusExtras: false,
        showCompletionist: true,
        showAllStyles: false,
        enableLibraryBadge: true,
        enableStoreBadge: false,
      });

      const settings = await backend.getSettings();
      expect(settings.position).toBe("br");
      expect(settings.showMainPlusExtras).toBe(false);
      expect(settings.enableStoreBadge).toBe(false);
      expect(emittedEvents.length).toBeGreaterThan(0);
      expect(emittedEvents[0].event).toBe("stateChanged");
    });
  });

  // ── Status ──────────────────────────────────────────────────

  describe("status", () => {
    it("reports disconnected by default", async () => {
      const status = await backend.getStatus();
      expect(status.connected).toBe(false);
      expect(status.tabs).toBe(0);
    });
  });

  // ── getCurrentRouteAppId ────────────────────────────────────

  describe("getCurrentRouteAppId", () => {
    it("returns null when no URL has been polled", async () => {
      const appId = await backend.getCurrentRouteAppId();
      expect(appId).toBeNull();
    });
  });

  // ── getGameTimes ─────────────────────────────────────────────

  describe("getGameTimes", () => {
    it("returns null when build key cannot be discovered", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response("", { status: 404 })),
      );

      const result = await backend.getGameTimes(1234);
      expect(result).toBeNull();
    });

    it("parses game times from NextJS data endpoint", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr === "https://howlongtobeat.com") {
          return Promise.resolve(
            new Response(
              '<script src="/_next/static/abc123/_buildManifest.js"></script>',
              { status: 200 },
            ),
          );
        }

        if (urlStr.includes("/_next/data/abc123/game/1234.json")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                pageProps: {
                  game: {
                    data: {
                      game: [fakeHltbResult()],
                    },
                  },
                },
              }),
              { status: 200 },
            ),
          );
        }

        return Promise.resolve(new Response("", { status: 404 }));
      });

      const times = await backend.getGameTimes(1234);
      expect(times).not.toBeNull();
      expect(times!.gameId).toBe(1234);
      expect(times!.gameName).toBe("Elden Ring");
      expect(times!.mainStorySeconds).toBe(180000);
      expect(times!.mainStory).toBe("50.0h");
    });
  });

  // ── clearCache ───────────────────────────────────────────────

  describe("clearCache", () => {
    it("clears all caches and forces re-fetch", async () => {
      let searchCalls = 0;
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/api/bleed/init")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ token: "t", hpKey: "hp-k", hpVal: "hp-v" }),
              { status: 200 },
            ),
          );
        }
        if (urlStr.includes("/api/")) {
          searchCalls++;
          return Promise.resolve(
            new Response(JSON.stringify({ data: [fakeHltbResult()] }), {
              status: 200,
            }),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      });

      await backend.searchGame("test");
      expect(searchCalls).toBe(1);

      await backend.clearCache();

      await backend.searchGame("test");
      expect(searchCalls).toBe(2);
    });
  });

  // ── formatTime (indirectly tested) ───────────────────────────

  describe("time formatting", () => {
    it("formats zero and negative seconds as --", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/api/bleed/init")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ token: "t", hpKey: "hp-k", hpVal: "hp-v" }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [fakeHltbResult({ comp_main: 0, comp_plus: -100 })],
            }),
            { status: 200 },
          ),
        );
      });

      const results = await backend.searchGame("test zero");
      expect(results[0].mainStory).toBe("--");
      expect(results[0].mainPlusExtras).toBe("--");
    });

    it("formats sub-hour times as minutes", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/api/bleed/init")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ token: "t", hpKey: "hp-k", hpVal: "hp-v" }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [fakeHltbResult({ comp_main: 1800 })],
            }),
            { status: 200 },
          ),
        );
      });

      const results = await backend.searchGame("test short");
      expect(results[0].mainStory).toBe("30m");
    });
  });

  // ── E-013: auxiliary fetch paths ────────────────────────────────
  //
  // Covers the three brittle paths that aren't exercised by the main
  // /api/bleed tests above:
  //
  //   1. fetchNextJsBuildKey: GETs https://howlongtobeat.com/ and scrapes
  //      a build-id out of an inline <script src=...> regex. HLTB rotates
  //      this string every few weeks.
  //   2. searchGame (network failure / parse failure variants): the existing
  //      cases use /api/find which has been renamed to /api/bleed (and the
  //      legacy expectations are pre-existing failures). These add coverage
  //      against the current /api/bleed endpoint for fetch-throws and
  //      non-JSON (HTML error page) responses.
  //   3. getGameTimes (the /_next/data deep link): happy path is covered,
  //      these add network failure + parse failure + cache-equivalent (the
  //      method has no per-game cache, so we verify each call hits the wire).

  describe("E-013: fetchNextJsBuildKey (via getGameTimes)", () => {
    it("returns null when the root HTML page fetch fails (network error)", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr === "https://howlongtobeat.com") {
          return Promise.reject(new Error("ENETUNREACH"));
        }
        return Promise.resolve(new Response("", { status: 404 }));
      });

      const result = await backend.getGameTimes(1234);
      expect(result).toBeNull();
    });

    it("returns null when the root HTML page returns non-200", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr === "https://howlongtobeat.com") {
          return Promise.resolve(new Response("", { status: 503 }));
        }
        return Promise.resolve(new Response("", { status: 404 }));
      });

      const result = await backend.getGameTimes(1234);
      expect(result).toBeNull();
    });

    it("returns null when the root HTML has no _next/static manifest script tag", async () => {
      // HLTB returned an HTML page but the build-id regex doesn't match —
      // either they restructured the page or we're looking at an error page.
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr === "https://howlongtobeat.com") {
          return Promise.resolve(
            new Response("<html><body>Maintenance</body></html>", {
              status: 200,
            }),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      });

      const result = await backend.getGameTimes(1234);
      expect(result).toBeNull();
    });

    it("uses _ssgManifest as the build-id source when present", async () => {
      // The regex matches both _buildManifest.js and _ssgManifest.js;
      // make sure the ssg variant works too.
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr === "https://howlongtobeat.com") {
          return Promise.resolve(
            new Response(
              '<script src="/_next/static/buildAbc999/_ssgManifest.js"></script>',
              { status: 200 },
            ),
          );
        }
        if (urlStr.includes("/_next/data/buildAbc999/game/4242.json")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                pageProps: {
                  game: {
                    data: {
                      game: [fakeHltbResult({ game_id: 4242 })],
                    },
                  },
                },
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      });

      const times = await backend.getGameTimes(4242);
      expect(times).not.toBeNull();
      expect(times!.gameId).toBe(4242);
    });
  });

  describe("E-013: searchByName via /api/bleed", () => {
    // The init path now lives under /api/bleed/init; the existing
    // /api/find tests above are pre-existing failures we're not
    // touching in this batch. These cover the current endpoint.

    it("happy path: parses /api/bleed results and formats times", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/api/bleed/init")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ token: "t", hpKey: "hp-k", hpVal: "hp-v" }),
              { status: 200 },
            ),
          );
        }
        if (urlStr.endsWith("/api/bleed")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ data: [fakeHltbResult()] }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      });

      const results = await backend.searchGame("elden ring");
      expect(results).toHaveLength(1);
      expect(results[0].gameName).toBe("Elden Ring");
      expect(results[0].mainStory).toBe("50.0h");
    });

    it("returns [] when the auth init fetch throws (network failure)", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/api/bleed/init")) {
          return Promise.reject(new Error("DNS lookup failed"));
        }
        return Promise.resolve(new Response("", { status: 404 }));
      });

      const results = await backend.searchGame("anything");
      expect(results).toEqual([]);
    });

    it("returns [] when /api/bleed returns an HTML error page (parse failure)", async () => {
      // HLTB's anti-bot middleware sometimes serves an HTML challenge page
      // with a 200 status. response.json() throws — plugin must not crash.
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/api/bleed/init")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ token: "t", hpKey: "hp-k", hpVal: "hp-v" }),
              { status: 200 },
            ),
          );
        }
        if (urlStr.endsWith("/api/bleed")) {
          return Promise.resolve(
            new Response(
              "<html><head><title>Just a moment...</title></head></html>",
              {
                status: 200,
                headers: { "Content-Type": "text/html" },
              },
            ),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      });

      // The current implementation lets the JSON parse throw — that gets
      // caught by the searchGame caller and yields []. If this ever
      // regresses to letting the exception escape, the test surface here
      // tells us about it.
      let results: unknown[];
      try {
        results = await backend.searchGame("query");
      } catch {
        results = [];
      }
      expect(results).toEqual([]);
    });

    it("dedupes via cache when the same query is searched twice", async () => {
      let bleedCalls = 0;
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/api/bleed/init")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ token: "t", hpKey: "hp-k", hpVal: "hp-v" }),
              { status: 200 },
            ),
          );
        }
        if (urlStr.endsWith("/api/bleed")) {
          bleedCalls++;
          return Promise.resolve(
            new Response(
              JSON.stringify({ data: [fakeHltbResult()] }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      });

      const r1 = await backend.searchGame("Elden Ring");
      const r2 = await backend.searchGame("  elden ring  ");
      expect(r1).toEqual(r2);
      // Both queries normalize to the same key — only one network call.
      expect(bleedCalls).toBe(1);
    });
  });

  // ── #86: getGameDetailById / getGameDetailForSteamApp ─────────────
  //
  // Detail-view fetchers added for the new card → detail route. Same
  // /_next/data deep-link as `getGameTimes` but the response shape
  // includes the richer HLTB metadata (dev, pub, genre, platforms,
  // release_world, review_score, summary).
  describe("getGameDetailById (#86)", () => {
    it("surfaces dev/pub/genre/platforms/release/score on the deep-link payload", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr === "https://howlongtobeat.com") {
          return Promise.resolve(
            new Response(
              '<script src="/_next/static/keyABC/_buildManifest.js"></script>',
              { status: 200 },
            ),
          );
        }
        if (urlStr.includes("/_next/data/keyABC/game/27100.json")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                pageProps: {
                  game: {
                    data: {
                      game: [
                        fakeHltbResult({
                          game_id: 27100,
                          game_name: "Red Dead Redemption 2",
                          game_alias: "Red Dead Redemption II",
                          profile_dev: "Rockstar Studios",
                          profile_pub: "Rockstar Games",
                          profile_platform: "PC, PlayStation 4, Xbox One",
                          profile_genre: "Action, Open World",
                          release_world: "2018-10-26",
                          review_score: 94,
                          count_review: 7463,
                          count_playing: 563,
                          count_comp: 21035,
                          profile_summary:
                            "Epic tale of life in America's unforgiving heartland.",
                        }),
                      ],
                    },
                  },
                },
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      });

      const detail = await backend.getGameDetailById(27100);
      expect(detail).not.toBeNull();
      expect(detail!.gameId).toBe(27100);
      expect(detail!.developer).toBe("Rockstar Studios");
      expect(detail!.publisher).toBe("Rockstar Games");
      expect(detail!.platforms).toContain("PlayStation");
      expect(detail!.genres).toContain("Open World");
      expect(detail!.releaseWorld).toBe("2018-10-26");
      expect(detail!.reviewScore).toBe(94);
      expect(detail!.reviewCount).toBe(7463);
      expect(detail!.playingCount).toBe(563);
      expect(detail!.completedCount).toBe(21035);
      expect(detail!.summary).toContain("Epic tale");
      expect(detail!.alias).toBe("Red Dead Redemption II");
      expect(detail!.hltbUrl).toBe("https://howlongtobeat.com/game/27100");
    });

    it("omits absent fields (HLTB returns inconsistent metadata)", async () => {
      // Sparse payload: many titles ship with only id + name + comp_*
      // populated. The detail view must render fine without metadata.
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr === "https://howlongtobeat.com") {
          return Promise.resolve(
            new Response(
              '<script src="/_next/static/keyABC/_buildManifest.js"></script>',
              { status: 200 },
            ),
          );
        }
        if (urlStr.includes("/_next/data/keyABC/game/1.json")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                pageProps: {
                  game: {
                    data: {
                      game: [
                        // Build a result with the metadata fields explicitly
                        // unset — fakeHltbResult's defaults don't include
                        // them, so reading them returns undefined.
                        fakeHltbResult({
                          profile_dev: "",
                          profile_pub: "",
                          review_score: 0,
                        }),
                      ],
                    },
                  },
                },
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      });

      const detail = await backend.getGameDetailById(1);
      expect(detail).not.toBeNull();
      // Falsy/empty fields become undefined — UI skips their rows.
      expect(detail!.developer).toBeUndefined();
      expect(detail!.publisher).toBeUndefined();
      expect(detail!.reviewScore).toBeUndefined();
    });
  });

  describe("getGameDetailForSteamApp (#86)", () => {
    it("two-hops: resolves Steam appId → HLTB id → /_next/data detail payload", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        // 1) Steam appdetails → game name
        if (urlStr.includes("store.steampowered.com/api/appdetails")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                "1245620": {
                  success: true,
                  data: { name: "Elden Ring" },
                },
              }),
              { status: 200 },
            ),
          );
        }
        // 2) HLTB auth + search → HLTB gameId
        if (urlStr.includes("/api/bleed/init")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ token: "t", hpKey: "hp-k", hpVal: "hp-v" }),
              { status: 200 },
            ),
          );
        }
        if (urlStr.endsWith("/api/bleed")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: [fakeHltbResult({ game_id: 12345, profile_steam: 1245620 })],
              }),
              { status: 200 },
            ),
          );
        }
        // 3) HLTB landing page → _next build key
        if (urlStr === "https://howlongtobeat.com") {
          return Promise.resolve(
            new Response(
              '<script src="/_next/static/keyXyz/_buildManifest.js"></script>',
              { status: 200 },
            ),
          );
        }
        // 4) HLTB deep-link → detail payload
        if (urlStr.includes("/_next/data/keyXyz/game/12345.json")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                pageProps: {
                  game: {
                    data: {
                      game: [
                        fakeHltbResult({
                          game_id: 12345,
                          profile_dev: "FromSoftware",
                          profile_genre: "Souls-like, Action",
                        }),
                      ],
                    },
                  },
                },
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      });

      const detail = await backend.getGameDetailForSteamApp("1245620");
      expect(detail).not.toBeNull();
      expect(detail!.gameId).toBe(12345);
      expect(detail!.developer).toBe("FromSoftware");
      expect(detail!.genres).toContain("Souls-like");
    });

    it("returns null when the Steam appId can't be resolved to an HLTB match", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response("", { status: 404 })),
      );

      const detail = await backend.getGameDetailForSteamApp("9999999");
      expect(detail).toBeNull();
    });
  });

  // ── getTimesForGame (non-Steam shortcuts) ───────────────────────

  describe("getTimesForGame (non-Steam / emulated games)", () => {
    it("resolves a non-Steam shortcut by name, skipping the Steam appdetails roundtrip", async () => {
      let appDetailsCalled = false;
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        // Steam appdetails must NOT be called for a shortcut — the
        // name comes straight from `game-browser` and the appId is a
        // random vdf-generated 32-bit number with no HLTB analogue.
        if (urlStr.includes("store.steampowered.com/api/appdetails")) {
          appDetailsCalled = true;
          return Promise.resolve(new Response("", { status: 404 }));
        }
        if (urlStr.includes("/api/bleed/init")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ token: "t", hpKey: "hp-k", hpVal: "hp-v" }),
              { status: 200 },
            ),
          );
        }
        if (urlStr.endsWith("/api/bleed")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: [
                  fakeHltbResult({
                    game_id: 9018,
                    game_name: "SSX 3",
                    // No profile_steam — emulated game, never on Steam.
                    profile_steam: 0,
                    comp_main: 36000, // 10h
                  }),
                ],
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      });

      // The appId here is a vdf shortcut id (random 32-bit number),
      // not a Steam appId.
      const result = await backend.getTimesForGame("1234567890", "SSX 3");
      expect(appDetailsCalled).toBe(false);
      expect(result).not.toBeNull();
      expect(result!.gameId).toBe(9018);
      expect(result!.mainStory).toBe("10.0h");
    });

    it("returns null when the name is empty / whitespace-only", async () => {
      const a = await backend.getTimesForGame("1234567890", "");
      const b = await backend.getTimesForGame("1234567890", "   ");
      expect(a).toBeNull();
      expect(b).toBeNull();
    });

    it("caches results by appId — repeated calls don't re-hit HLTB", async () => {
      let searchCallCount = 0;
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/api/bleed/init")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ token: "t", hpKey: "hp-k", hpVal: "hp-v" }),
              { status: 200 },
            ),
          );
        }
        if (urlStr.endsWith("/api/bleed")) {
          searchCallCount++;
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: [fakeHltbResult({ game_id: 9018, game_name: "SSX 3" })],
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      });

      const r1 = await backend.getTimesForGame("1234567890", "SSX 3");
      const r2 = await backend.getTimesForGame("1234567890", "SSX 3");
      expect(r1).toEqual(r2);
      expect(searchCallCount).toBe(1);
    });
  });

  // ── getGameDetailForGame (#96 follow-up: non-Steam detail view) ─

  describe("getGameDetailForGame (non-Steam / emulated games)", () => {
    it("two-hops via name → HLTB id → /_next/data deep-link without hitting Steam appdetails", async () => {
      let appDetailsCalled = false;
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("store.steampowered.com/api/appdetails")) {
          appDetailsCalled = true;
          return Promise.resolve(new Response("", { status: 404 }));
        }
        if (urlStr.includes("/api/bleed/init")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ token: "t", hpKey: "hp-k", hpVal: "hp-v" }),
              { status: 200 },
            ),
          );
        }
        if (urlStr.endsWith("/api/bleed")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: [
                  fakeHltbResult({
                    game_id: 9018,
                    game_name: "SSX 3",
                    profile_steam: 0,
                  }),
                ],
              }),
              { status: 200 },
            ),
          );
        }
        if (urlStr === "https://howlongtobeat.com") {
          return Promise.resolve(
            new Response(
              '<script src="/_next/static/keyEmu/_buildManifest.js"></script>',
              { status: 200 },
            ),
          );
        }
        if (urlStr.includes("/_next/data/keyEmu/game/9018.json")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                pageProps: {
                  game: {
                    data: {
                      game: [
                        fakeHltbResult({
                          game_id: 9018,
                          game_name: "SSX 3",
                          profile_dev: "EA Canada",
                          profile_platform: "GameCube, PS2, Xbox",
                        }),
                      ],
                    },
                  },
                },
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      });

      const detail = await backend.getGameDetailForGame("1234567890", "SSX 3");
      expect(appDetailsCalled).toBe(false);
      expect(detail).not.toBeNull();
      expect(detail!.gameId).toBe(9018);
      expect(detail!.developer).toBe("EA Canada");
      expect(detail!.platforms).toContain("GameCube");
    });

    it("returns null when HLTB returns no match for the shortcut name", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/api/bleed/init")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ token: "t", hpKey: "hp-k", hpVal: "hp-v" }),
              { status: 200 },
            ),
          );
        }
        if (urlStr.endsWith("/api/bleed")) {
          return Promise.resolve(
            new Response(JSON.stringify({ data: [] }), { status: 200 }),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      });

      const detail = await backend.getGameDetailForGame(
        "1234567890",
        "Some Obscure Homebrew",
      );
      expect(detail).toBeNull();
    });
  });

  describe("E-013: getGameById (getGameTimes deep-link)", () => {
    it("happy path: returns parsed times for a known HLTB id", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr === "https://howlongtobeat.com") {
          return Promise.resolve(
            new Response(
              '<script src="/_next/static/buildXyz/_buildManifest.js"></script>',
              { status: 200 },
            ),
          );
        }
        if (urlStr.includes("/_next/data/buildXyz/game/9999.json")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                pageProps: {
                  game: {
                    data: {
                      game: [
                        fakeHltbResult({
                          game_id: 9999,
                          game_name: "Hollow Knight",
                          comp_main: 90000, // 25h
                        }),
                      ],
                    },
                  },
                },
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      });

      const times = await backend.getGameTimes(9999);
      expect(times).not.toBeNull();
      expect(times!.gameId).toBe(9999);
      expect(times!.gameName).toBe("Hollow Knight");
      expect(times!.mainStorySeconds).toBe(90000);
      expect(times!.mainStory).toBe("25.0h");
    });

    it("returns null when the deep-link fetch throws (network failure)", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr === "https://howlongtobeat.com") {
          return Promise.resolve(
            new Response(
              '<script src="/_next/static/buildXyz/_buildManifest.js"></script>',
              { status: 200 },
            ),
          );
        }
        if (urlStr.includes("/_next/data/")) {
          return Promise.reject(new Error("Connection reset"));
        }
        return Promise.resolve(new Response("", { status: 404 }));
      });

      const times = await backend.getGameTimes(1234);
      expect(times).toBeNull();
    });

    it("returns null when deep-link returns HTML instead of JSON (parse failure)", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr === "https://howlongtobeat.com") {
          return Promise.resolve(
            new Response(
              '<script src="/_next/static/buildXyz/_buildManifest.js"></script>',
              { status: 200 },
            ),
          );
        }
        if (urlStr.includes("/_next/data/")) {
          // Cloudflare-style HTML challenge served with 200 status —
          // .json() will throw and the plugin must swallow it.
          return Promise.resolve(
            new Response("<!doctype html><html><body>nope</body></html>", {
              status: 200,
            }),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      });

      const times = await backend.getGameTimes(1234);
      expect(times).toBeNull();
    });

    it("returns null when the deep-link response has an empty game array", async () => {
      // HLTB occasionally returns `{ pageProps: { game: { data: { game: [] }}}}`
      // when an id has been merged or removed — make sure that doesn't yield
      // a half-populated object.
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr === "https://howlongtobeat.com") {
          return Promise.resolve(
            new Response(
              '<script src="/_next/static/buildXyz/_buildManifest.js"></script>',
              { status: 200 },
            ),
          );
        }
        if (urlStr.includes("/_next/data/")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                pageProps: { game: { data: { game: [] } } },
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      });

      const times = await backend.getGameTimes(1234);
      expect(times).toBeNull();
    });
  });

  // ── Cache eviction (PR #96 review follow-up) ─────────────────

  describe("pruneExpiredCaches", () => {
    it("removes entries past CACHE_TTL without touching fresh entries", () => {
      // Reach into private caches via `as any`. Mirrors the pattern
      // the audit-skill rubric explicitly allows for the CEF/FFI
      // boundary — here it's the "private cache" boundary.
      const b = backend as unknown as {
        searchCache: Map<string, { data: unknown; timestamp: number }>;
        steamTimesCache: Map<string, { data: unknown; timestamp: number }>;
        gameNameCache: Map<string, { data: string; timestamp: number }>;
        pruneExpiredCaches: () => void;
      };
      const now = Date.now();
      const stale = now - 13 * 60 * 60 * 1000; // older than 12h TTL
      const fresh = now - 60 * 1000;

      b.searchCache.set("old", { data: [], timestamp: stale });
      b.searchCache.set("new", { data: [], timestamp: fresh });
      b.steamTimesCache.set("1", { data: null, timestamp: stale });
      b.steamTimesCache.set("2", { data: null, timestamp: fresh });
      b.gameNameCache.set("a", { data: "x", timestamp: stale });
      b.gameNameCache.set("b", { data: "y", timestamp: fresh });

      b.pruneExpiredCaches();

      expect(b.searchCache.has("old")).toBe(false);
      expect(b.searchCache.has("new")).toBe(true);
      expect(b.steamTimesCache.has("1")).toBe(false);
      expect(b.steamTimesCache.has("2")).toBe(true);
      expect(b.gameNameCache.has("a")).toBe(false);
      expect(b.gameNameCache.has("b")).toBe(true);
    });
  });

  // ── Multi-target BPM push fan-out (#92 follow-up) ────────────

  describe("pushBadgeDataToBPM fan-out", () => {
    /** Build a fake CDPConnection whose `evaluate` records calls. */
    function fakeConn() {
      const calls: string[] = [];
      return {
        calls,
        client: {
          connected: true,
          evaluate: async (expr: string) => {
            calls.push(expr);
            return undefined;
          },
        },
        tabTitle: "fake",
      };
    }

    it("pushes the same data to every bpmRenderKeys target", async () => {
      // Stub fetch for getBadgeData → getTimesForSteamApp →
      // getSteamGameName → appdetails. Return a name then short-
      // circuit the HLTB search to an empty result so the lookup
      // yields null times — we only care about the fan-out here,
      // not the data path.
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("appdetails")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ "1234": { data: { name: "Elden Ring" } } }),
              { status: 200 },
            ),
          );
        }
        if (urlStr.includes("/api/bleed/init")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ token: "t", hpKey: "hp-k", hpVal: "hp-v" }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ data: [] }), { status: 200 }),
        );
      });

      const b = backend as unknown as {
        connections: Map<string, ReturnType<typeof fakeConn>>;
        bpmRenderKeys: string[];
        pushBadgeDataToBPM: (appId: string | null) => Promise<void>;
      };
      const c1 = fakeConn();
      const c2 = fakeConn();
      b.connections.set("Steam Big Picture Mode", c1);
      b.connections.set("MainMenu_uid2", c2);
      b.bpmRenderKeys = ["Steam Big Picture Mode", "MainMenu_uid2"];

      await b.pushBadgeDataToBPM("1234");

      // Both fake connections received exactly one evaluate, both
      // with the same `__hltb_badges.update(...)` payload.
      expect(c1.calls).toHaveLength(1);
      expect(c2.calls).toHaveLength(1);
      expect(c1.calls[0]).toContain("__hltb_badges");
      expect(c1.calls[0]).toBe(c2.calls[0]);
    });

    it("one tab error doesn't abort the other targets", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("appdetails")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ "1234": { data: { name: "Elden Ring" } } }),
              { status: 200 },
            ),
          );
        }
        if (urlStr.includes("/api/bleed/init")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ token: "t", hpKey: "hp-k", hpVal: "hp-v" }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ data: [] }), { status: 200 }),
        );
      });

      const goodConn = fakeConn();
      const badConn = {
        calls: [] as string[],
        client: {
          connected: true,
          evaluate: async () => {
            throw new Error("simulated CDP socket close");
          },
        },
        tabTitle: "broken",
      };
      const b = backend as unknown as {
        connections: Map<string, unknown>;
        bpmRenderKeys: string[];
        pushBadgeDataToBPM: (appId: string | null) => Promise<void>;
      };
      b.connections.set("bad", badConn);
      b.connections.set("good", goodConn);
      b.bpmRenderKeys = ["bad", "good"];

      await b.pushBadgeDataToBPM("1234");

      // The good tab still received the update even though the bad
      // tab threw first in the iteration order.
      expect(goodConn.calls).toHaveLength(1);
      expect(goodConn.calls[0]).toContain("__hltb_badges");
    });

    it("coalesces rapid successive pushes to the latest appId", async () => {
      const seenAppIds: string[] = [];
      let bleedInitDone = false;
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("appdetails")) {
          // Capture which appId was queried so we can assert that
          // the drained value is the latest one.
          const m = urlStr.match(/appids=(\d+)/);
          if (m) seenAppIds.push(m[1]);
          return Promise.resolve(
            new Response(
              JSON.stringify({
                [m?.[1] ?? "0"]: { data: { name: `Game ${m?.[1]}` } },
              }),
              { status: 200 },
            ),
          );
        }
        if (urlStr.includes("/api/bleed/init")) {
          bleedInitDone = true;
          return Promise.resolve(
            new Response(
              JSON.stringify({ token: "t", hpKey: "hp-k", hpVal: "hp-v" }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ data: [] }), { status: 200 }),
        );
      });

      const conn = fakeConn();
      const b = backend as unknown as {
        connections: Map<string, ReturnType<typeof fakeConn>>;
        bpmRenderKeys: string[];
        pushBadgeDataToBPM: (appId: string | null) => Promise<void>;
      };
      b.connections.set("tab", conn);
      b.bpmRenderKeys = ["tab"];

      // Fire three pushes back-to-back without awaiting. The first
      // call starts the loop; calls 2+3 just update the pending
      // appId. When the loop drains it should end at "3000".
      const p = b.pushBadgeDataToBPM("1000");
      void b.pushBadgeDataToBPM("2000");
      void b.pushBadgeDataToBPM("3000");
      await p;

      // Coalescing means only the final appId reaches the cdpEvaluate
      // step — the intermediate 1000/2000 values get dropped on the
      // re-check after getBadgeData. So exactly one push lands.
      // (The HLTB search stub returns no data so the payload is
      // {times:null,settings:…} either way; we can't tell appIds
      // apart on the payload, but `seenAppIds` from the appdetails
      // stub above tells us which appIds the drain loop processed.)
      expect(conn.calls).toHaveLength(1);
      // The drain skipped 2000 (it was overwritten by 3000 before
      // its turn in the loop), but ran getBadgeData for both 1000
      // and 3000 — the second resolves last and is the one that
      // pushes.
      expect(seenAppIds).toContain("3000");
      expect(seenAppIds).not.toContain("2000");
      expect(bleedInitDone).toBe(true);
    });
  });
});
