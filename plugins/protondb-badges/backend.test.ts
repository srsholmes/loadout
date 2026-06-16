import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import type { EmitPayload } from "@loadout/types";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pluginStorage from "@loadout/plugin-storage";

import ProtonDBBadgesBackend from "./backend";

// ── Module-level fetch mock ─────────────────────────────────────────

const originalFetch = globalThis.fetch;
const mockFetch = mock(() => Promise.resolve(new Response("", { status: 500 })));

describe("ProtonDBBadgesBackend", () => {
  let backend: ProtonDBBadgesBackend;
  let emittedEvents: EmitPayload[];
  let savedXdgCacheHome: string | undefined;
  let tmpCacheRoot: string;
  let readPluginStorageSpy: ReturnType<typeof spyOn>;
  let writePluginStorageSpy: ReturnType<typeof spyOn>;
  // Persistence sink across the test — mirrors the disk file we'd
  // otherwise write. Defaults to empty so onLoad seeds defaults.
  let stored: Record<string, unknown>;

  beforeEach(async () => {
    mockFetch.mockReset();
    stored = {};

    // Sandbox XDG_CACHE_HOME so the disk cache writes go to a per-
    // test tmpdir instead of the dev's real ~/.cache/loadout/. The
    // backend resolves the dir lazily per call so flipping the env
    // var here is enough.
    savedXdgCacheHome = process.env.XDG_CACHE_HOME;
    tmpCacheRoot = mkdtempSync(join(tmpdir(), "protondb-spec-cache-"));
    process.env.XDG_CACHE_HOME = tmpCacheRoot;

    globalThis.fetch = mockFetch as unknown as typeof fetch;

    // spyOn instead of mock.module — the backend imports from
    // @loadout/plugin-storage as a namespace, so a spy patches the
    // live binding without leaking across spec files.
    readPluginStorageSpy = spyOn(
      pluginStorage,
      "readPluginStorage",
    ).mockImplementation(async () => stored);
    writePluginStorageSpy = spyOn(
      pluginStorage,
      "writePluginStorage",
    ).mockImplementation(async (_id: string, data: unknown) => {
      stored = data as Record<string, unknown>;
    });

    backend = new ProtonDBBadgesBackend();
    emittedEvents = [];
    backend.emit = (payload: EmitPayload) => {
      emittedEvents.push(payload);
    };
    await backend.onLoad();
  });

  afterEach(async () => {
    await backend.onUnload();
    globalThis.fetch = originalFetch;

    readPluginStorageSpy.mockRestore();
    writePluginStorageSpy.mockRestore();

    try {
      rmSync(tmpCacheRoot, { recursive: true, force: true });
    } catch {
      /* tmpdir reaped on reboot */
    }
    if (savedXdgCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = savedXdgCacheHome;
    }
  });

  // ── getReport ────────────────────────────────────────────────

  describe("getReport", () => {
    it("fetches and parses ProtonDB report", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("protondb.com/api/v1/reports/summaries/12345")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                tier: "gold",
                confidence: "good",
                score: 0.75,
                trendingTier: "platinum",
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.reject(new Error("Connection refused"));
      });

      const report = await backend.getReport("12345");
      expect(report).not.toBeNull();
      expect(report!.tier).toBe("gold");
      expect(report!.confidence).toBe("good");
      expect(report!.score).toBe(0.75);
      expect(report!.trendingTier).toBe("platinum");
    });

    it("returns null for 404 (no report exists)", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("protondb.com")) {
          return Promise.resolve(new Response("", { status: 404 }));
        }
        return Promise.reject(new Error("Connection refused"));
      });

      const report = await backend.getReport("99999");
      expect(report).toBeNull();
    });

    it("caches reports and avoids duplicate fetches", async () => {
      let fetchCount = 0;
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("protondb.com")) {
          fetchCount++;
          return Promise.resolve(
            new Response(
              JSON.stringify({
                tier: "silver",
                confidence: "moderate",
                score: 0.5,
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.reject(new Error("Connection refused"));
      });

      const r1 = await backend.getReport("555");
      const r2 = await backend.getReport("555");
      expect(r1).toEqual(r2);
      expect(fetchCount).toBe(1);
    });

    it("caches 404 results so it does not re-fetch", async () => {
      let fetchCount = 0;
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("protondb.com")) {
          fetchCount++;
          return Promise.resolve(new Response("", { status: 404 }));
        }
        return Promise.reject(new Error("Connection refused"));
      });

      const r1 = await backend.getReport("99999");
      const r2 = await backend.getReport("99999");
      expect(r1).toBeNull();
      expect(r2).toBeNull();
      expect(fetchCount).toBe(1);
    });

    it("returns null on non-404 HTTP errors without caching (next call retries)", async () => {
      let fetchCount = 0;
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("protondb.com")) {
          fetchCount++;
          return Promise.resolve(new Response("", { status: 503 }));
        }
        return Promise.reject(new Error("Connection refused"));
      });

      const r1 = await backend.getReport("777");
      const r2 = await backend.getReport("777");
      expect(r1).toBeNull();
      expect(r2).toBeNull();
      expect(fetchCount).toBe(2);
    });

    it("defaults missing fields to safe values", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("protondb.com")) {
          return Promise.resolve(
            new Response(JSON.stringify({}), { status: 200 }),
          );
        }
        return Promise.reject(new Error("Connection refused"));
      });

      const report = await backend.getReport("888");
      expect(report!.tier).toBe("pending");
      expect(report!.confidence).toBe("unknown");
      expect(report!.score).toBe(0);
    });
  });

  // ── searchGames ──────────────────────────────────────────────

  describe("searchGames", () => {
    it("returns empty array for empty query", async () => {
      expect(await backend.searchGames("")).toEqual([]);
      expect(await backend.searchGames("   ")).toEqual([]);
    });

    it("parses Steam store search results", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("store.steampowered.com/api/storesearch")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                items: [
                  {
                    id: 12345,
                    name: "Portal 2",
                    tiny_image: "https://cdn.steam/img.jpg",
                  },
                  { id: 67890, name: "Portal", tiny_image: "" },
                ],
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.reject(new Error("Connection refused"));
      });

      const results = await backend.searchGames("Portal");
      expect(results).toHaveLength(2);
      expect(results[0].appId).toBe("12345");
      expect(results[0].name).toBe("Portal 2");
      expect(results[1].icon).toBe("");
    });

    it("caches search results", async () => {
      let fetchCount = 0;
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("storesearch")) {
          fetchCount++;
          return Promise.resolve(
            new Response(JSON.stringify({ items: [] }), { status: 200 }),
          );
        }
        return Promise.reject(new Error("Connection refused"));
      });

      await backend.searchGames("test");
      await backend.searchGames("Test"); // same normalised key
      expect(fetchCount).toBe(1);
    });

    it("throws on Steam API error", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("storesearch")) {
          return Promise.resolve(new Response("", { status: 500 }));
        }
        return Promise.reject(new Error("Connection refused"));
      });

      await expect(backend.searchGames("test")).rejects.toThrow("500");
    });
  });

  // ── checkLinuxSupport ────────────────────────────────────────

  describe("checkLinuxSupport", () => {
    it("returns true when Linux platform is supported", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("appdetails")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                "12345": {
                  data: { platforms: { linux: true, windows: true, mac: false } },
                },
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.reject(new Error("Connection refused"));
      });

      expect(await backend.checkLinuxSupport("12345")).toBe(true);
    });

    it("returns false when Linux platform is not supported", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("appdetails")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                "12345": { data: { platforms: { linux: false, windows: true } } },
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.reject(new Error("Connection refused"));
      });

      expect(await backend.checkLinuxSupport("12345")).toBe(false);
    });

    it("returns false on API error", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("appdetails")) {
          return Promise.resolve(new Response("", { status: 500 }));
        }
        return Promise.reject(new Error("Connection refused"));
      });

      expect(await backend.checkLinuxSupport("12345")).toBe(false);
    });

    it("caches linux support results", async () => {
      let fetchCount = 0;
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("appdetails")) {
          fetchCount++;
          return Promise.resolve(
            new Response(
              JSON.stringify({
                "12345": { data: { platforms: { linux: true } } },
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.reject(new Error("Connection refused"));
      });

      await backend.checkLinuxSupport("12345");
      await backend.checkLinuxSupport("12345");
      expect(fetchCount).toBe(1);
    });
  });

  // ── getBadgeData ─────────────────────────────────────────────

  describe("getBadgeData", () => {
    it("returns combined report, linux support, and settings", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("protondb.com")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ tier: "gold", confidence: "good", score: 0.8 }),
              { status: 200 },
            ),
          );
        }
        if (urlStr.includes("appdetails")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                "12345": { data: { platforms: { linux: true } } },
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.reject(new Error("Connection refused"));
      });

      const badge = await backend.getBadgeData("12345");
      expect(badge.report).not.toBeNull();
      expect(badge.report!.tier).toBe("gold");
      expect(badge.linuxSupport).toBe(true);
      expect(badge.settings).toHaveProperty("size");
      expect(badge.settings).toHaveProperty("position");
    });
  });

  // ── Settings ─────────────────────────────────────────────────

  describe("settings", () => {
    it("returns default settings", async () => {
      const settings = await backend.getSettings();
      expect(settings.size).toBe("regular");
      expect(settings.position).toBe("tl");
      expect(settings.labelOnHover).toBe("off");
      expect(settings.showSubmitButton).toBe(false);
      expect(settings.enableLibraryBadge).toBe(true);
      expect(settings.enableStoreBadge).toBe(true);
    });

    it("returns a copy not a reference", async () => {
      const s1 = await backend.getSettings();
      s1.size = "small";
      const s2 = await backend.getSettings();
      expect(s2.size).toBe("regular");
    });

    it("updateSettings merges with defaults and persists", async () => {
      await backend.updateSettings({
        size: "minimalist",
        position: "br",
        labelOnHover: "small",
        showSubmitButton: true,
        enableLibraryBadge: true,
        enableStoreBadge: false,
      });

      const settings = await backend.getSettings();
      expect(settings.size).toBe("minimalist");
      expect(settings.position).toBe("br");
      expect(settings.enableStoreBadge).toBe(false);
      // Persisted via @loadout/plugin-storage
      expect(writePluginStorageSpy).toHaveBeenCalled();
      expect(stored.size).toBe("minimalist");
    });

    it("emits stateChanged event on settings update", async () => {
      await backend.updateSettings({
        size: "small",
        position: "tl",
        labelOnHover: "off",
        showSubmitButton: false,
        enableLibraryBadge: true,
        enableStoreBadge: true,
      });

      const event = emittedEvents.find((e) => e.event === "stateChanged");
      expect(event).toBeDefined();
    });
  });

  // ── clearCache ───────────────────────────────────────────────

  describe("clearCache", () => {
    it("clears all caches, forcing re-fetch", async () => {
      let fetchCount = 0;
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("protondb.com")) {
          fetchCount++;
          return Promise.resolve(
            new Response(
              JSON.stringify({ tier: "bronze", confidence: "low", score: 0.3 }),
              { status: 200 },
            ),
          );
        }
        return Promise.reject(new Error("Connection refused"));
      });

      await backend.getReport("111");
      expect(fetchCount).toBe(1);

      await backend.clearCache();
      await backend.getReport("111");
      expect(fetchCount).toBe(2);
    });

    it("clearExternalCache delegates to clearCache", async () => {
      // Smoke test: just exercising the broadcast-safe alias to
      // confirm it doesn't throw and clears caches.
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("protondb.com")) {
          return Promise.resolve(
            new Response(JSON.stringify({ tier: "gold" }), { status: 200 }),
          );
        }
        return Promise.reject(new Error("Connection refused"));
      });
      await backend.getReport("222");
      await backend.clearExternalCache();
      // Second call should re-fetch (in-memory cache cleared)
      let fetchCount = 0;
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("protondb.com")) {
          fetchCount++;
          return Promise.resolve(
            new Response(JSON.stringify({ tier: "silver" }), { status: 200 }),
          );
        }
        return Promise.reject(new Error("Connection refused"));
      });
      await backend.getReport("222");
      expect(fetchCount).toBe(1);
    });
  });

  // ── Steam-CEF injection ──────────────────────────────────────
  //
  // No Steam CEF debug port is reachable in the test env: the module-
  // level fetch mock returns HTTP 500 for localhost:8080/json (and never
  // touches the real network), so `_tryConnect` bails, the CDP layer
  // reports disconnected, and reconnect fails cleanly. These assert the
  // graceful-degradation contract; injection itself is exercised on-device.

  describe("Steam-CEF injection", () => {
    it("getStatus reports disconnected when no Steam CEF is reachable", async () => {
      const status = await backend.getStatus();
      expect(status.connected).toBe(false);
      expect(status.tabs).toBe(0);
    });

    it("reconnect fails cleanly when Steam CEF is unreachable", async () => {
      const result = await backend.reconnect();
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("getCurrentRouteAppId returns null before any route is observed", async () => {
      const appId = await backend.getCurrentRouteAppId();
      expect(appId).toBeNull();
    });
  });
});
