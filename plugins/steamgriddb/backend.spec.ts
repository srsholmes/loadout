import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import type { EmitPayload } from "@loadout/types";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

// Steam-paths returns `~/.local/share/Steam` from `homedir()`, which
// Bun resolves eagerly and won't repick up from `process.env.HOME`
// changes. We override the whole module so applyArt's file-write path
// can be exercised against a temp directory.
let fakeSteamDir = "/__not_set__";
mock.module("@loadout/steam-paths", () => ({
  getSteamDir: () => fakeSteamDir,
  getUserdataDir: () => join(fakeSteamDir, "userdata"),
  getSteamAppsDir: () => join(fakeSteamDir, "steamapps"),
}));

import SteamGridDBBackend, {
  cleanTitleForSearch,
  filenameFor,
  filenameMatcherFor,
  filenameStemsFor,
  migrateConfig,
} from "./backend";
import { shortcutGameId64 } from "@loadout/vdf";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function mockFetchJson(json: unknown, status = 200, ok = true) {
  const fn = mock(() =>
    Promise.resolve({
      ok,
      status,
      statusText: ok ? "OK" : "Not Found",
      json: () => Promise.resolve(json),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    } as unknown as Response),
  );
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

// CRITICAL: every test that calls `setApiKey`, `saveSgdbMatch`,
// `forgetSgdbMatch`, or `pruneMatches` will hit
// `writePluginStorage("steamgriddb", …)`, which resolves to
// `$XDG_CONFIG_HOME/loadout/plugins/steamgriddb.json` (defaulting
// to `~/.config/...`). Without a sandbox these tests CLOBBER the
// developer's real plugin state on every run — and have done so in
// the past. Point XDG_CONFIG_HOME at a per-spec tmpdir so the writes
// stay isolated. Restored in `afterAll` even if tests throw.
//
// Same story for XDG_CACHE_HOME: the @loadout/external-cache
// package writes API responses under `$XDG_CACHE_HOME/loadout/
// steamgriddb/`. Without an isolated tmpdir, `searchGames("test")`
// in one test caches a null/empty response and the next test's
// "throws on HTTP error" assertion silently passes against the
// stale cache instead of exercising the real fetch path.
const savedXdgConfigHome = process.env.XDG_CONFIG_HOME;
const savedXdgCacheHome = process.env.XDG_CACHE_HOME;
const specSandboxRoot = join(
  tmpdir(),
  `sgdb-spec-storage-${randomBytes(6).toString("hex")}`,
);
const specCacheRoot = join(
  tmpdir(),
  `sgdb-spec-cache-${randomBytes(6).toString("hex")}`,
);

describe("SteamGridDBBackend", () => {
  let backend: SteamGridDBBackend;
  let emittedEvents: EmitPayload[];

  beforeEach(async () => {
    process.env.XDG_CONFIG_HOME = specSandboxRoot;
    process.env.XDG_CACHE_HOME = specCacheRoot;
    await mkdir(specSandboxRoot, { recursive: true });
    await mkdir(specCacheRoot, { recursive: true });
    backend = new SteamGridDBBackend();
    emittedEvents = [];
    backend.emit = (payload: EmitPayload) => {
      emittedEvents.push(payload);
    };
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    // Wipe between tests so cross-test bleed-through (e.g. a prior
    // test's apiKey leaking into a "fresh backend" assertion, or a
    // cached SGDB response answering for a fresh fetch mock) can't
    // hide bugs.
    await rm(specSandboxRoot, { recursive: true, force: true });
    await rm(specCacheRoot, { recursive: true, force: true });
    if (savedXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = savedXdgConfigHome;
    }
    if (savedXdgCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = savedXdgCacheHome;
    }
  });

  // ── API key management ──────────────────────────────────────────────

  describe("API key management", () => {
    it("hasApiKey returns false when no key is set", async () => {
      expect(await backend.hasApiKey()).toBe(false);
    });

    it("hasApiKey returns true after setApiKey", async () => {
      // setApiKey probes /grids/steam/730 to validate; mock the
      // probe so the test doesn't depend on real network.
      mockFetchJson({ success: true, data: [] });
      await backend.setApiKey("test-key-123");
      expect(await backend.hasApiKey()).toBe(true);
    });

    it("hasApiKey returns false for empty string", async () => {
      await backend.setApiKey("");
      expect(await backend.hasApiKey()).toBe(false);
    });
  });

  // ── searchGames response parsing ────────────────────────────────────

  describe("searchGames", () => {
    it("parses successful API response", async () => {
      const apiResponse = {
        success: true,
        data: [
          { id: 1, name: "Half-Life 2", types: ["steam"], verified: true },
          { id: 2, name: "Half-Life", types: ["steam"], verified: false },
        ],
      };
      mockFetchJson(apiResponse);

      const results = await backend.searchGames("Half-Life");
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe(1);
      expect(results[0].name).toBe("Half-Life 2");
      expect(results[0].verified).toBe(true);
      expect(results[1].id).toBe(2);
    });

    it("throws on non-OK HTTP response", async () => {
      mockFetchJson({}, 404, false);
      await expect(backend.searchGames("test")).rejects.toThrow(
        /SteamGridDB search failed: 404/,
      );
    });

    it("throws on unsuccessful API response body", async () => {
      mockFetchJson({ success: false, data: [] });
      await expect(backend.searchGames("test")).rejects.toThrow(
        /unsuccessful response/,
      );
    });

    it("URL-encodes the query string", async () => {
      const fetchMock = mockFetchJson({ success: true, data: [] });
      await backend.searchGames("hello world & more");
      const calledUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toContain("hello%20world%20%26%20more");
    });

    it("includes Authorization header when API key is set", async () => {
      // Validation probe + the searchGames call both go through fetch;
      // a single mock that returns success twice covers both.
      mockFetchJson({ success: true, data: [] });
      await backend.setApiKey("my-secret-key");
      const fetchMock = mockFetchJson({ success: true, data: [] });
      await backend.searchGames("test");
      const opts = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
      expect((opts.headers as Record<string, string>)["Authorization"]).toBe(
        "Bearer my-secret-key",
      );
    });
  });

  // ── Asset fetching (grids/heroes/logos/icons) ───────────────────────

  describe("fetchAssets (grids, heroes, logos, icons)", () => {
    const sampleImages = {
      success: true,
      data: [
        {
          id: 10,
          score: 5,
          style: "alternate",
          width: 600,
          height: 900,
          nsfw: false,
          humor: false,
          language: "en",
          url: "https://cdn.example.com/img.png",
          thumb: "https://cdn.example.com/img_thumb.png",
          lock: false,
          epilepsy: false,
          notes: null,
          author: { name: "user1", steam64: "123", avatar: "https://avatar" },
        },
      ],
    };

    it("getGrids returns parsed image array", async () => {
      mockFetchJson(sampleImages);
      const results = await backend.getGrids("12345");
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(10);
      expect(results[0].url).toBe("https://cdn.example.com/img.png");
    });

    it("getGrids calls the Steam-app-id-keyed endpoint", async () => {
      const fetchMock = mockFetchJson(sampleImages);
      await backend.getGrids("12345");
      const calledUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toContain("/grids/steam/12345");
    });

    it("getHeroes calls the heroes endpoint", async () => {
      const fetchMock = mockFetchJson(sampleImages);
      await backend.getHeroes("999");
      const calledUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toContain("/heroes/steam/999");
    });

    it("getLogos calls the logos endpoint", async () => {
      const fetchMock = mockFetchJson(sampleImages);
      await backend.getLogos("42");
      const calledUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toContain("/logos/steam/42");
    });

    it("getIcons calls the icons endpoint", async () => {
      const fetchMock = mockFetchJson(sampleImages);
      await backend.getIcons("7");
      const calledUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toContain("/icons/steam/7");
    });

    it("returns empty array when success is false", async () => {
      mockFetchJson({ success: false, data: [] });
      const results = await backend.getGrids("12345");
      expect(results).toEqual([]);
    });

    it("throws on HTTP error from asset endpoint", async () => {
      mockFetchJson({}, 500, false);
      await expect(backend.getGrids("12345")).rejects.toThrow(
        /SteamGridDB API error: 500/,
      );
    });
  });

  // ── SGDB-game-id-keyed asset fetchers (non-Steam shortcuts) ─────────

  describe("by-SGDB-game-id asset fetchers", () => {
    const sample = { success: true, data: [] };

    it("getGridsByGameId hits /grids/game/{sgdbId}", async () => {
      const fetchMock = mockFetchJson(sample);
      await backend.getGridsByGameId(42);
      const calledUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toContain("/grids/game/42");
      expect(calledUrl).not.toContain("/grids/steam/");
    });

    it("getHeroesByGameId hits /heroes/game/{sgdbId}", async () => {
      const fetchMock = mockFetchJson(sample);
      await backend.getHeroesByGameId(99);
      const calledUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toContain("/heroes/game/99");
    });

    it("getLogosByGameId hits /logos/game/{sgdbId}", async () => {
      const fetchMock = mockFetchJson(sample);
      await backend.getLogosByGameId(7);
      const calledUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toContain("/logos/game/7");
    });

    it("getIconsByGameId hits /icons/game/{sgdbId}", async () => {
      const fetchMock = mockFetchJson(sample);
      await backend.getIconsByGameId(123);
      const calledUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toContain("/icons/game/123");
    });
  });

  // ── Art type -> filename mapping ────────────────────────────────────

  describe("applyArt filename resolution", () => {
    // We cannot fully test applyArt since it touches the filesystem via
    // getSteamDir() / Bun.write, but we can test it throws appropriately
    // when Steam userdata does not exist. The filename logic is exercised
    // indirectly when the method tries to write files.

    it("throws when image download fails", async () => {
      // Mock fetch to return a failed response for the image download
      globalThis.fetch = mock(() =>
        Promise.resolve({
          ok: false,
          status: 404,
        } as unknown as Response),
      ) as unknown as typeof fetch;

      await expect(
        backend.applyArt("730", "https://cdn.example.com/img.png", "grid_p"),
      ).rejects.toThrow(/Failed to download image/);
    });
  });

  // ── applyArt end-to-end on a fake Steam userdata tree ──────────────
  //
  // `getSteamDir()` resolves to `$HOME/.local/share/Steam`. We point
  // HOME at a fresh tmpdir per test, pre-create a single user dir,
  // and let `applyArt` use the real fs paths underneath. This catches
  // regressions in the per-stem-per-user write loop that the unit
  // tests for `filenameStemsFor` / `filenameFor` can't see.

  describe("applyArt — dual-stem writes for shortcuts", () => {
    let fakeRoot: string;
    let userdataDir: string;

    beforeEach(async () => {
      fakeRoot = join(tmpdir(), `sgdb-spec-${randomBytes(6).toString("hex")}`);
      fakeSteamDir = join(fakeRoot, ".local", "share", "Steam");
      userdataDir = join(fakeSteamDir, "userdata");
      await mkdir(join(userdataDir, "12345678"), { recursive: true });
    });

    afterEach(async () => {
      await rm(fakeRoot, { recursive: true, force: true });
    });

    it("Steam app writes a single file under each user dir", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        } as unknown as Response),
      ) as unknown as typeof fetch;

      const res = await backend.applyArt(
        "730",
        "https://cdn.example.com/cs2_hero.png",
        "hero",
        "steam",
      );

      const gridDir = join(userdataDir, "12345678", "config", "grid");
      const files = await readdir(gridDir);
      expect(files).toEqual(["730_hero.png"]);
      expect(res.paths).toHaveLength(1);
    });

    it("Shortcut writes BOTH 32-bit and 64-bit stems under each user dir", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        } as unknown as Response),
      ) as unknown as typeof fetch;

      const shortcutAppId = "3735928559";
      const expectedGameid64 = shortcutGameId64(parseInt(shortcutAppId, 10));

      const res = await backend.applyArt(
        "3735928559",
        "https://cdn.example.com/mario.png",
        "hero",
        "shortcut",
      );

      const gridDir = join(userdataDir, "12345678", "config", "grid");
      const files = (await readdir(gridDir)).sort();
      expect(files).toEqual(
        [`${shortcutAppId}_hero.png`, `${expectedGameid64}_hero.png`].sort(),
      );
      expect(res.paths).toHaveLength(2);
    });

    it("Shortcut + icon without Steam open throws the user-friendly error", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        } as unknown as Response),
      ) as unknown as typeof fetch;

      await expect(
        backend.applyArt(
          "3735928559",
          "https://cdn.example.com/mario.png",
          "icon",
          "shortcut",
        ),
      ).rejects.toThrow(/Steam to be running/);
    });
  });

  // ── filenameStemsFor / filenameFor / filenameMatcherFor ─────────────

  describe("filenameStemsFor", () => {
    it("returns just the appId for Steam apps", () => {
      expect(filenameStemsFor("730", "steam")).toEqual(["730"]);
    });

    it("returns appId + 64-bit gameid64 for shortcuts", () => {
      const stems = filenameStemsFor("3735928559", "shortcut");
      expect(stems[0]).toBe("3735928559");
      expect(stems[1]).toBe(shortcutGameId64(3735928559));
      expect(stems).toHaveLength(2);
    });

    it("falls back to single stem when appId is non-numeric", () => {
      expect(filenameStemsFor("not-a-number", "shortcut")).toEqual([
        "not-a-number",
      ]);
    });
  });

  describe("filenameFor", () => {
    it("appends p for portrait grid", () => {
      expect(filenameFor("730", "grid_p", ".png")).toBe("730p.png");
    });
    it("uses bare stem for landscape grid", () => {
      expect(filenameFor("730", "grid_l", ".jpg")).toBe("730.jpg");
    });
    it("appends _hero for hero", () => {
      expect(filenameFor("730", "hero", ".png")).toBe("730_hero.png");
    });
    it("appends _logo for logo", () => {
      expect(filenameFor("730", "logo", ".png")).toBe("730_logo.png");
    });
    it("appends _icon for icon", () => {
      expect(filenameFor("730", "icon", ".png")).toBe("730_icon.png");
    });
  });

  describe("filenameMatcherFor", () => {
    it("matches portrait grid for Steam apps across .png/.jpg", () => {
      const matcher = filenameMatcherFor("12345", "grid_p", "steam");
      expect(matcher.test("12345p.png")).toBe(true);
      expect(matcher.test("12345p.jpg")).toBe(true);
      expect(matcher.test("12345p.jpeg")).toBe(true);
      expect(matcher.test("12345.png")).toBe(false);
      expect(matcher.test("99999p.png")).toBe(false);
    });

    it("matches both 32-bit and 64-bit stems for shortcuts", () => {
      const appId32 = "3735928559";
      const gameid64 = shortcutGameId64(parseInt(appId32, 10));
      const matcher = filenameMatcherFor(appId32, "hero", "shortcut");
      expect(matcher.test(`${appId32}_hero.png`)).toBe(true);
      expect(matcher.test(`${gameid64}_hero.png`)).toBe(true);
      expect(matcher.test(`${appId32}_hero.jpg`)).toBe(true);
      expect(matcher.test(`${gameid64}_hero.jpg`)).toBe(true);
      expect(matcher.test(`${appId32}.png`)).toBe(false);
      expect(matcher.test("anything-else.png")).toBe(false);
    });

    it("defaults to Steam source when omitted", () => {
      const matcher = filenameMatcherFor("12345", "logo");
      expect(matcher.test("12345_logo.png")).toBe(true);
      expect(matcher.test("12345_logo.jpg")).toBe(true);
    });
  });

  // ── cleanTitleForSearch ─────────────────────────────────────────────

  describe("cleanTitleForSearch", () => {
    it("strips trailing region tags", () => {
      expect(cleanTitleForSearch("Super Mario 64 (USA)")).toBe(
        "Super Mario 64",
      );
    });

    it("strips bracketed tags", () => {
      expect(cleanTitleForSearch("Chrono Trigger [SNES]")).toBe(
        "Chrono Trigger",
      );
    });

    it("strips disc markers", () => {
      expect(cleanTitleForSearch("Final Fantasy VII - Disc 1")).toBe(
        "Final Fantasy VII",
      );
    });

    it("strips version suffixes", () => {
      expect(cleanTitleForSearch("DOOM v1.10")).toBe("DOOM");
    });

    it("collapses multiple cleanups + whitespace", () => {
      expect(
        cleanTitleForSearch("Super Mario 64 (USA) [v1.0] - Disc 1"),
      ).toBe("Super Mario 64");
    });

    it("leaves clean titles untouched", () => {
      expect(cleanTitleForSearch("Hades")).toBe("Hades");
    });
  });

  // ── PersistedConfig migration ───────────────────────────────────────

  describe("migrateConfig", () => {
    it("upgrades v1 with apiKey to v2 preserving the key", () => {
      const v2 = migrateConfig({ version: 1, apiKey: "abc-123" });
      expect(v2.version).toBe(2);
      expect(v2.apiKey).toBe("abc-123");
      expect(v2.matches).toBeUndefined();
    });

    it("preserves matches when reading existing v2 config", () => {
      const matches = { "12345": { sgdbId: 999, name: "Some Game" } };
      const v2 = migrateConfig({ version: 2, apiKey: "k", matches });
      expect(v2.matches).toEqual(matches);
    });

    it("returns sane defaults for an empty record", () => {
      const v2 = migrateConfig({});
      expect(v2.version).toBe(2);
      expect(v2.apiKey).toBeUndefined();
      expect(v2.matches).toBeUndefined();
    });

    it("ignores non-string apiKey and non-object matches", () => {
      const v2 = migrateConfig({
        apiKey: 42 as unknown as string,
        matches: ["a", "b"] as unknown as Record<string, never>,
      });
      expect(v2.apiKey).toBeUndefined();
      expect(v2.matches).toBeUndefined();
    });
  });

  // ── Saved SGDB matches ─────────────────────────────────────────────

  describe("getSavedSgdbMatch / saveSgdbMatch", () => {
    it("returns null for an unseen appId", async () => {
      expect(await backend.getSavedSgdbMatch("999")).toBeNull();
    });

    it("round-trips a saved match in memory", async () => {
      // Mock writePluginStorage's filesystem path so saveSgdbMatch
      // doesn't actually touch disk during the unit test. We just
      // need persist() to resolve.
      const writeMock = mock(() => Promise.resolve());
      // The backend's persist() calls writePluginStorage internally;
      // in this Bun test environment that resolves to a no-op write
      // under the test's XDG_CONFIG_HOME if set. We don't assert on
      // disk state here — just that the in-memory map round-trips.
      void writeMock;
      await backend.saveSgdbMatch("440", 12345, "Team Fortress 2");
      const got = await backend.getSavedSgdbMatch("440");
      expect(got).toEqual({ sgdbId: 12345, name: "Team Fortress 2" });
    });

    it("forgetSgdbMatch drops the entry", async () => {
      await backend.saveSgdbMatch("440", 12345, "TF2");
      await backend.forgetSgdbMatch("440");
      expect(await backend.getSavedSgdbMatch("440")).toBeNull();
    });

    it("pruneMatches removes entries not in the valid set", async () => {
      await backend.saveSgdbMatch("440", 1, "TF2");
      await backend.saveSgdbMatch("730", 2, "CS2");
      await backend.saveSgdbMatch("999", 3, "Deleted Shortcut");
      const res = await backend.pruneMatches(["440", "730"]);
      expect(res.removed).toBe(1);
      expect(await backend.getSavedSgdbMatch("440")).not.toBeNull();
      expect(await backend.getSavedSgdbMatch("730")).not.toBeNull();
      expect(await backend.getSavedSgdbMatch("999")).toBeNull();
    });

    it("pruneMatches skips when the valid set is empty (transient-fail guard)", async () => {
      await backend.saveSgdbMatch("440", 1, "TF2");
      const res = await backend.pruneMatches([]);
      expect(res.removed).toBe(0);
      // Match still there — we didn't wipe everything on what's almost
      // certainly a `getGames` failure.
      expect(await backend.getSavedSgdbMatch("440")).not.toBeNull();
    });
  });
});
