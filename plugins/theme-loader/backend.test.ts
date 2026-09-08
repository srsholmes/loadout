import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import type { EmitPayload } from "@loadout/types";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ThemeLoaderBackend from "./backend";
import { _resetForTests as resetThemesCache } from "./lib/themes-cache";
import {
  _resetForTests as resetTranslations,
  ensureTranslations,
  getTranslationsStatus,
} from "./lib/translations-cache";

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

/** Minimal shape of the class-translation feed (`stable.json`). */
const FIXTURE_TRANSLATIONS = {
  quickaccessmenu_Title: ["_1n2bl", "_3xQ7p"],
};

function mockDeckthemesFetch() {
  globalThis.fetch = mock(async (input: unknown) => {
    const url = typeof input === "string" ? input : (input as { url: string }).url;
    if (url.includes("api.deckthemes.com/stable.json")) {
      return new Response(JSON.stringify(FIXTURE_TRANSLATIONS), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
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
    resetTranslations({ cacheDir });
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
    resetTranslations();
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

  // ── Tab discovery / injection healing ─────────────────────────────
  //
  // The boot race these cover: Steam builds its CEF tabs progressively
  // and reloads the documents it hosts while starting up, so a tab can
  // appear after our first discovery pass, or lose its <style> while the
  // CDP socket stays perfectly healthy. Either way the user saw an
  // unthemed Steam until they hit "Reapply themes" by hand.

  interface FakeTab {
    id: string;
    title: string;
    url?: string;
  }

  /** Serve `/json` with the given tabs; everything else stays mocked. */
  function mockCefTabs(tabs: FakeTab[]) {
    const deckthemes = globalThis.fetch;
    globalThis.fetch = mock(async (input: unknown, init?: unknown) => {
      const url = typeof input === "string" ? input : (input as { url: string }).url;
      if (url.includes("localhost:8080/json")) {
        return new Response(
          JSON.stringify(
            tabs.map((t) => ({
              id: t.id,
              title: t.title,
              url: t.url ?? "about:blank",
              webSocketDebuggerUrl: `ws://localhost:8080/devtools/page/${t.id}`,
              type: "page",
            })),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return deckthemes(input as string, init as RequestInit);
    }) as unknown as typeof fetch;
  }

  interface FakeConn {
    id: string;
    title: string;
    client: { connected: boolean; close: () => void };
  }

  /**
   * Replace the two methods that need a real CEF: opening a socket and
   * evaluating JS in a tab. `evaluated` records every expression per tab
   * so tests can assert who was probed and who was re-injected.
   */
  function stubCdp(
    target: ThemeLoaderBackend,
    missingPerTab: Record<string, string[]> = {},
  ) {
    const evaluated: { tab: string; expression: string }[] = [];
    const inner = target as unknown as {
      openCDP: (o: { id: string; title: string; wsUrl: string }) => Promise<FakeConn>;
      cdpEvaluate: (conn: FakeConn, expression: string) => Promise<unknown>;
      connections: FakeConn[];
    };
    inner.openCDP = async ({ id, title }) => ({
      id,
      title,
      client: { connected: true, close: () => {} },
    });
    inner.cdpEvaluate = async (conn, expression) => {
      evaluated.push({ tab: conn.id, expression });
      // Only the probe expression returns a value; injection does not.
      if (expression.includes("missing.push")) return missingPerTab[conn.id] ?? [];
      return undefined;
    };
    return { evaluated, inner };
  }

  /** Mark a theme active without needing an installed pack on disk. */
  function activateTheme(target: ThemeLoaderBackend, id: string) {
    const inner = target as unknown as {
      activeThemes: Map<string, { styleId: string }>;
      loadThemeCss: (id: string) => Promise<string | null>;
    };
    inner.activeThemes.set(id, { styleId: `theme-loader-${id}` });
    inner.loadThemeCss = async () => "body { --themed: 1; }";
  }

  describe("tab discovery", () => {
    it("adopts a tab that appears after the first discovery pass", async () => {
      mockCefTabs([{ id: "shared", title: "SharedJSContext" }]);
      const { inner } = stubCdp(backend);

      await (backend as unknown as { tryConnect: () => Promise<boolean> }).tryConnect();
      expect(inner.connections.map((c) => c.id)).toEqual(["shared"]);

      // Big Picture opens: its window and the QuickAccess popup show up.
      mockCefTabs([
        { id: "shared", title: "SharedJSContext" },
        { id: "bpm", title: "Режим Big Picture", url: "about:blank?browserType=4" },
        { id: "qa", title: "QuickAccess_uid2" },
      ]);
      await (backend as unknown as { tryConnect: () => Promise<boolean> }).tryConnect();

      expect(inner.connections.map((c) => c.id).sort()).toEqual(["bpm", "qa", "shared"]);
    });

    it("keeps the existing connection rather than reopening it", async () => {
      mockCefTabs([{ id: "shared", title: "SharedJSContext" }]);
      const { inner } = stubCdp(backend);
      await (backend as unknown as { tryConnect: () => Promise<boolean> }).tryConnect();
      const first = inner.connections[0];
      let closed = false;
      first!.client.close = () => { closed = true; };

      mockCefTabs([
        { id: "shared", title: "SharedJSContext" },
        { id: "qa", title: "QuickAccess" },
      ]);
      await (backend as unknown as { tryConnect: () => Promise<boolean> }).tryConnect();

      expect(closed).toBe(false);
      expect(inner.connections.find((c) => c.id === "shared")).toBe(first!);
    });

    it("drops a connection whose tab Steam no longer advertises", async () => {
      mockCefTabs([
        { id: "shared", title: "SharedJSContext" },
        { id: "qa", title: "QuickAccess" },
      ]);
      const { inner } = stubCdp(backend);
      await (backend as unknown as { tryConnect: () => Promise<boolean> }).tryConnect();
      expect(inner.connections).toHaveLength(2);

      mockCefTabs([{ id: "shared", title: "SharedJSContext" }]);
      await (backend as unknown as { tryConnect: () => Promise<boolean> }).tryConnect();

      expect(inner.connections.map((c) => c.id)).toEqual(["shared"]);
    });
  });

  describe("verifyAndHealInjection", () => {
    const verify = (target: ThemeLoaderBackend) =>
      (target as unknown as { verifyAndHealInjection: () => Promise<void> })
        .verifyAndHealInjection();

    it("does nothing at all when no theme is active", async () => {
      mockCefTabs([{ id: "shared", title: "SharedJSContext" }]);
      const { evaluated } = stubCdp(backend);
      await verify(backend);
      expect(evaluated).toEqual([]);
    });

    it("re-injects only into the tab that lost its style", async () => {
      mockCefTabs([
        { id: "shared", title: "SharedJSContext" },
        { id: "qa", title: "QuickAccess" },
      ]);
      activateTheme(backend, "alpha");
      // "qa" reloaded and dropped the style; "shared" is fine.
      const { evaluated } = stubCdp(backend, { qa: ["theme-loader-alpha"] });

      await verify(backend);

      const injections = evaluated.filter((e) => e.expression.includes("createElement"));
      expect(injections.map((e) => e.tab)).toEqual(["qa"]);
      expect(injections[0]!.expression).toContain("theme-loader-alpha");
    });

    it("injects into a tab discovered during the pass", async () => {
      mockCefTabs([{ id: "shared", title: "SharedJSContext" }]);
      activateTheme(backend, "alpha");
      const { evaluated, inner } = stubCdp(backend, { qa: ["theme-loader-alpha"] });
      await (backend as unknown as { tryConnect: () => Promise<boolean> }).tryConnect();

      // The QuickAccess popup is created after that first pass.
      mockCefTabs([
        { id: "shared", title: "SharedJSContext" },
        { id: "qa", title: "QuickAccess" },
      ]);
      evaluated.length = 0;
      await verify(backend);

      expect(inner.connections.map((c) => c.id).sort()).toEqual(["qa", "shared"]);
      const injections = evaluated.filter((e) => e.expression.includes("createElement"));
      expect(injections.map((e) => e.tab)).toEqual(["qa"]);
    });

    it("leaves a healthy tab untouched, so themed tabs never flash", async () => {
      mockCefTabs([{ id: "shared", title: "SharedJSContext" }]);
      activateTheme(backend, "alpha");
      const { evaluated } = stubCdp(backend, {});

      await verify(backend);

      expect(evaluated.filter((e) => e.expression.includes("createElement"))).toEqual([]);
      expect(evaluated.filter((e) => e.expression.includes("missing.push"))).toHaveLength(1);
    });

    it("skips a tab whose probe throws instead of re-injecting blind", async () => {
      mockCefTabs([{ id: "shared", title: "SharedJSContext" }]);
      activateTheme(backend, "alpha");
      const { evaluated, inner } = stubCdp(backend, {});
      const stubbed = inner.cdpEvaluate;
      inner.cdpEvaluate = async (conn, expression) => {
        if (expression.includes("missing.push")) throw new Error("target closed");
        return stubbed(conn, expression);
      };

      await verify(backend);

      expect(evaluated.filter((e) => e.expression.includes("createElement"))).toEqual([]);
    });

    it("does not resurrect a theme disabled while the probe was in flight", async () => {
      mockCefTabs([{ id: "shared", title: "SharedJSContext" }]);
      activateTheme(backend, "alpha");
      const { evaluated, inner } = stubCdp(backend, { shared: ["theme-loader-alpha"] });
      const stubbed = inner.cdpEvaluate;
      const active = (backend as unknown as { activeThemes: Map<string, unknown> }).activeThemes;
      inner.cdpEvaluate = async (conn, expression) => {
        const result = await stubbed(conn, expression);
        if (expression.includes("missing.push")) active.delete("alpha");
        return result;
      };

      await verify(backend);

      expect(evaluated.filter((e) => e.expression.includes("createElement"))).toEqual([]);
    });
  });

  describe("class translations", () => {
    const verify = (target: ThemeLoaderBackend) =>
      (target as unknown as { verifyAndHealInjection: () => Promise<void> })
        .verifyAndHealInjection();

    const loadCss = (target: ThemeLoaderBackend, id: string) =>
      (target as unknown as { loadThemeCss: (id: string) => Promise<string | null> })
        .loadThemeCss(id);

    /**
     * Pack CSS carries the obfuscated class names of the Steam build it
     * was authored against, and `assemblePackCss` silently leaves them
     * alone when the map isn't loaded. Injecting in that window puts a
     * well-formed <style> in the page that matches nothing — which looks
     * exactly like a theme that never loaded, and which the DOM probe
     * would go on reporting as healthy.
     */
    it("refuses to assemble CSS before the map has landed", async () => {
      const dir = join(cacheDir, "packs");
      const inner = backend as unknown as {
        installedPacks: Map<string, unknown>;
      };
      inner.installedPacks.set("alpha", {
        id: "alpha",
        dir,
        manifest: { name: "Alpha" },
      });

      expect(getTranslationsStatus().state).toBe("pending");
      expect(await loadCss(backend, "alpha")).toBeNull();

      await ensureTranslations();
      expect(getTranslationsStatus().state).toBe("ready");
      expect(await loadCss(backend, "alpha")).not.toBeNull();
    });

    it("retries a sync that had not landed, then heals", async () => {
      mockCefTabs([{ id: "shared", title: "SharedJSContext" }]);
      activateTheme(backend, "alpha");
      // Booted before wifi associated: nothing cached, nothing fetched.
      expect(getTranslationsStatus().state).toBe("pending");
      const { evaluated } = stubCdp(backend, { shared: ["theme-loader-alpha"] });

      await verify(backend);

      expect(getTranslationsStatus().state).toBe("ready");
      const injections = evaluated.filter((e) => e.expression.includes("createElement"));
      expect(injections.map((e) => e.tab)).toEqual(["shared"]);
    });

    it("skips the CDP round-trips entirely while the map is unavailable", async () => {
      globalThis.fetch = mock(async (input: unknown) => {
        const url = typeof input === "string" ? input : (input as { url: string }).url;
        if (url.includes("localhost:8080/json")) {
          return new Response(
            JSON.stringify([
              {
                id: "shared",
                title: "SharedJSContext",
                url: "about:blank",
                webSocketDebuggerUrl: "ws://localhost:8080/devtools/page/shared",
                type: "page",
              },
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        // Offline: the translation feed is unreachable.
        return Promise.reject(new Error("Network unreachable"));
      }) as unknown as typeof fetch;

      activateTheme(backend, "alpha");
      const { evaluated } = stubCdp(backend, { shared: ["theme-loader-alpha"] });

      await verify(backend);

      expect(getTranslationsStatus().state).toBe("error");
      expect(evaluated).toEqual([]);
    });
  });

  describe("checkHealth verification cadence", () => {
    /** Run N health ticks, counting verification passes. */
    async function tick(target: ThemeLoaderBackend, times: number) {
      const inner = target as unknown as {
        checkHealth: () => Promise<void>;
        verifyAndHealInjection: () => Promise<void>;
        loadedAt: number;
      };
      let verifications = 0;
      inner.verifyAndHealInjection = async () => { verifications++; };
      for (let i = 0; i < times; i++) await inner.checkHealth();
      return verifications;
    }

    it("verifies on every tick while Steam is still starting up", async () => {
      mockCefTabs([{ id: "shared", title: "SharedJSContext" }]);
      stubCdp(backend);
      await (backend as unknown as { tryConnect: () => Promise<boolean> }).tryConnect();

      expect(await tick(backend, 4)).toBe(4);
    });

    it("backs off to one pass every 6 ticks once the startup window closes", async () => {
      mockCefTabs([{ id: "shared", title: "SharedJSContext" }]);
      stubCdp(backend);
      await (backend as unknown as { tryConnect: () => Promise<boolean> }).tryConnect();
      // Pretend the plugin loaded an hour ago.
      (backend as unknown as { loadedAt: number }).loadedAt = Date.now() - 3_600_000;

      expect(await tick(backend, 12)).toBe(2);
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
