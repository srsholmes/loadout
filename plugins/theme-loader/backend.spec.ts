import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import type { EmitPayload } from "@loadout/types";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ThemeLoaderBackend from "./backend";
import { _resetForTests as resetThemesCache } from "./lib/themes-cache";

/**
 * Backend tests.
 *
 * The backend relies heavily on Chrome DevTools Protocol (CDP) WebSocket
 * connections to Steam's CEF browser, which cannot be replicated in unit
 * tests. We test state management and the methods that don't require a
 * live CDP connection.
 *
 * The community theme directory used to be a bundled JSON snapshot;
 * it now comes from the live deckthemes.com API via lib/themes-cache.
 * Tests mock the upstream fetch so we have deterministic input without
 * touching the network.
 */

const originalFetch = globalThis.fetch;

const FIXTURE_THEMES = [
  {
    id: "alpha",
    name: "Alpha",
    type: "CSS",
    download: { id: "blob-alpha", downloadCount: 100 },
    starCount: 5,
    target: "Library",
    description: "alpha desc",
    version: "1.0",
    submitted: "2026-01-01T00:00:00Z",
    updated: "2026-02-01T00:00:00Z",
    specifiedAuthor: "Author A",
  },
  {
    id: "bravo",
    name: "Bravo",
    type: "CSS",
    download: { id: "blob-bravo", downloadCount: 50 },
    starCount: 1,
    target: "Library",
    description: "bravo desc",
    version: "0.9",
    submitted: "2026-03-01T00:00:00Z",
    updated: "2026-03-15T00:00:00Z",
    specifiedAuthor: "Author B",
  },
];

function mockDeckthemesFetch() {
  globalThis.fetch = mock(async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("api.deckthemes.com/themes")) {
      return new Response(
        JSON.stringify({ total: FIXTURE_THEMES.length, items: FIXTURE_THEMES }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not mocked", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("ThemeLoaderBackend", () => {
  let backend: ThemeLoaderBackend;
  let emittedEvents: EmitPayload[];
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "theme-loader-spec-"));
    resetThemesCache({ cacheDir });
    mockDeckthemesFetch();
    backend = new ThemeLoaderBackend();
    emittedEvents = [];
    backend.emit = (payload: EmitPayload) => {
      emittedEvents.push(payload);
    };
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    resetThemesCache();
    await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  });

  // ── Status (no connection) ────────────────────────────────────────

  describe("getStatus", () => {
    it("reports disconnected state initially", async () => {
      const status = await backend.getStatus();
      expect(status.connected).toBe(false);
      expect(status.tabCount).toBe(0);
      expect(status.activeThemeCount).toBe(0);
    });
  });

  // ── Active themes ─────────────────────────────────────────────────

  describe("getActiveThemes", () => {
    it("returns empty array when no themes are active", async () => {
      const active = await backend.getActiveThemes();
      expect(active).toEqual([]);
    });
  });

  // ── enableTheme / disableTheme without connection ─────────────────

  describe("enableTheme (disconnected)", () => {
    it("returns error when not connected and cannot connect", async () => {
      const result = await backend.enableTheme("nonexistent-theme");
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("disableTheme", () => {
    it("returns success when theme is not active", async () => {
      const result = await backend.disableTheme("nonexistent");
      expect(result.success).toBe(true);
    });
  });

  // ── reconnect (disconnected) ──────────────────────────────────────

  describe("reconnect", () => {
    it("returns failure when Steam CEF is not running", async () => {
      // Mock fetch to simulate Steam CEF not running
      globalThis.fetch = mock(() => Promise.reject(new Error("Connection refused"))) as unknown as typeof fetch;
      const result = await backend.reconnect();
      expect(result.success).toBe(false);
      expect(result.error).toContain("Could not connect");
    });
  });

  // ── getThemes ─────────────────────────────────────────────────────

  describe("getThemes", () => {
    it("returns array with id, name, kind, active fields", async () => {
      const themes = await backend.getThemes();
      expect(Array.isArray(themes)).toBe(true);
      for (const theme of themes) {
        expect(theme).toHaveProperty("id");
        expect(theme).toHaveProperty("name");
        expect(theme).toHaveProperty("kind");
        expect(theme).toHaveProperty("active");
        expect(theme.kind).toBe("pack");
        expect(typeof theme.active).toBe("boolean");
      }
    });
  });

  // ── Community theme listing ───────────────────────────────────────

  describe("listCommunityThemes", () => {
    it("returns the live API result with installed flags", async () => {
      const themes = await backend.listCommunityThemes();
      expect(themes).toHaveLength(FIXTURE_THEMES.length);
      for (const theme of themes) {
        expect(theme).toHaveProperty("id");
        expect(theme).toHaveProperty("name");
        expect(theme).toHaveProperty("downloadBlobId");
        expect(theme).toHaveProperty("installed");
        expect(typeof theme.installed).toBe("boolean");
      }
    });

    it("preserves the upstream order returned by the API", async () => {
      const themes = await backend.listCommunityThemes();
      expect(themes.map((t) => t.id)).toEqual(["alpha", "bravo"]);
    });
  });

  // ── installCommunityTheme / uninstallCommunityTheme ───────────────

  describe("installCommunityTheme", () => {
    it("rejects malformed ids (path traversal attempts)", async () => {
      const cases = ["../../etc/passwd", ".secret", "/absolute/path", "has space"];
      for (const badId of cases) {
        const result = await backend.installCommunityTheme(badId);
        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      }
    });

    it("rejects ids not present in the live registry", async () => {
      const result = await backend.installCommunityTheme(
        "00000000-0000-0000-0000-000000000000",
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found in registry");
    });
  });

  describe("uninstallCommunityTheme", () => {
    it("rejects malformed ids", async () => {
      const result = await backend.uninstallCommunityTheme("../../etc/passwd");
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("returns error for themes that aren't installed", async () => {
      const result = await backend.uninstallCommunityTheme(
        "00000000-0000-0000-0000-000000000000",
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("not installed");
    });
  });

  // ── setThemePackVariant ───────────────────────────────────────────

  describe("setThemePackVariant", () => {
    it("returns error for non-installed themes", async () => {
      const result = await backend.setThemePackVariant(
        "00000000-0000-0000-0000-000000000000",
        "Intensity",
        "10px",
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("not installed");
    });
  });

  // ── openThemeGithub ───────────────────────────────────────────────

  describe("openThemeGithub", () => {
    it("returns error when the theme has no GitHub URL / is unknown", async () => {
      const result = await backend.openThemeGithub(
        "00000000-0000-0000-0000-000000000000",
      );
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
