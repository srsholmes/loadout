import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import type { EmitPayload } from "@loadout/types";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ProtonDBBadgesBackend from "./backend";

// ── Mock fs and Bun APIs ─────────────────────────────────────────

const mockMkdir = mock(() => Promise.resolve(undefined as unknown as string));
mock.module("node:fs/promises", () => ({ mkdir: mockMkdir }));

const originalFetch = globalThis.fetch;
const mockFetch = mock(() => Promise.resolve(new Response("", { status: 500 })));

const originalBunFile = Bun.file;
const originalBunWrite = Bun.write;
const mockFileExists = mock(() => Promise.resolve(false));
const mockFileText = mock(() => Promise.resolve("{}"));

describe("ProtonDBBadgesBackend", () => {
  let backend: ProtonDBBadgesBackend;
  let emittedEvents: EmitPayload[];
  let savedXdgCacheHome: string | undefined;
  let tmpCacheRoot: string;

  beforeEach(() => {
    mockFetch.mockClear();
    mockFileExists.mockReset();
    mockFileText.mockReset();

    // Sandbox XDG_CACHE_HOME so the @loadout/external-cache
    // disk cache writes go to a per-test tmpdir instead of the
    // dev's real `~/.cache/loadout/protondb-badges/`. The
    // backend resolves the dir lazily per call, so flipping the
    // env var here is enough.
    savedXdgCacheHome = process.env.XDG_CACHE_HOME;
    tmpCacheRoot = mkdtempSync(join(tmpdir(), "protondb-spec-cache-"));
    process.env.XDG_CACHE_HOME = tmpCacheRoot;

    globalThis.fetch = mockFetch as unknown as typeof fetch;

    // Default: no settings file
    mockFileExists.mockImplementation(() => Promise.resolve(false));

    // @ts-expect-error -- mock
    Bun.file = mock(() => ({
      exists: mockFileExists,
      text: mockFileText,
      json: () => mockFileText().then((t) => JSON.parse(t)),
    }));
    // @ts-expect-error -- mock
    Bun.write = mock(() => Promise.resolve(0));

    // Default: fetch returns 404/500 for CEF connection (tryConnect in onLoad)
    mockFetch.mockImplementation((url: string | URL) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      // Block CEF connection attempts
      if (urlStr.includes("localhost:8080")) {
        return Promise.reject(new Error("Connection refused"));
      }
      return Promise.resolve(new Response("", { status: 500 }));
    });

    backend = new ProtonDBBadgesBackend();
    emittedEvents = [];
    backend.emit = (payload: EmitPayload) => {
      emittedEvents.push(payload);
    };
  });

  afterEach(async () => {
    await backend.onUnload();
    globalThis.fetch = originalFetch;
    Bun.file = originalBunFile;
    // @ts-expect-error -- restore
    Bun.write = originalBunWrite;

    try {
      rmSync(tmpCacheRoot, { recursive: true, force: true });
    } catch {
      /* tmpdir reaped on reboot anyway */
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
              JSON.stringify({ tier: "silver", confidence: "moderate", score: 0.5 }),
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
                  { id: 12345, name: "Portal 2", tiny_image: "https://cdn.steam/img.jpg" },
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
      await backend.searchGames("Test"); // same normalized key
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
                "12345": { data: { platforms: { linux: true, windows: true, mac: false } } },
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
              JSON.stringify({ "12345": { data: { platforms: { linux: true } } } }),
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
              JSON.stringify({ "12345": { data: { platforms: { linux: true } } } }),
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

    it("updateSettings merges with defaults", async () => {
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
  });

  // ── getStatus ────────────────────────────────────────────────

  describe("getStatus", () => {
    it("reports disconnected when no CEF tabs connected", async () => {
      const status = await backend.getStatus();
      expect(status.connected).toBe(false);
      expect(status.tabs).toBe(0);
    });
  });

  // ── getCurrentRouteAppId ─────────────────────────────────────

  describe("getCurrentRouteAppId", () => {
    it("returns null when no app is being viewed", async () => {
      const appId = await backend.getCurrentRouteAppId();
      expect(appId).toBeNull();
    });
  });
});
