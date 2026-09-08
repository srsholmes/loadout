import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import type { EmitPayload } from "@loadout/types";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
  /**
   * Classify an expression by what it does, so tests assert on intent
   * rather than on a substring of generated JavaScript. Rewriting a
   * builder in a behaviour-preserving way then can't fail these tests
   * with a misleading message pointing at the backend.
   */
  function kindOf(expression: string): "probe" | "sweep" | "inject" | "remove" | "other" {
    if (expression.includes("missing.push")) return "probe";
    if (expression.includes("querySelectorAll")) return "sweep";
    if (expression.includes("createElement")) return "inject";
    if (expression.includes("removeChild")) return "remove";
    return "other";
  }

  function stubCdp(
    target: ThemeLoaderBackend,
    missingPerTab: Record<string, string[]> = {},
  ) {
    const evaluated: { tab: string; expression: string; kind: string }[] = [];
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
      const kind = kindOf(expression);
      evaluated.push({ tab: conn.id, expression, kind });
      // A stub that silently returns undefined for an expression it does
      // not recognise would make a renamed builder look like "nothing was
      // missing" rather than like a broken stub.
      if (kind === "other") throw new Error(`stubCdp: unrecognised expression: ${expression}`);
      if (kind === "probe") return missingPerTab[conn.id] ?? [];
      if (kind === "sweep") return [];
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

    it("does nothing but the one load-time sweep when no theme is active", async () => {
      mockCefTabs([{ id: "shared", title: "SharedJSContext" }]);
      const { evaluated } = stubCdp(backend);

      // A fresh instance sweeps once — it cannot know what a previous one
      // left behind, and "all themes disabled while disconnected" is
      // exactly the case where an orphan exists with nothing active.
      await verify(backend);
      expect(evaluated.map((e) => e.kind)).toEqual(["sweep"]);

      // Thereafter there is genuinely nothing to do, and no CDP traffic.
      evaluated.length = 0;
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

      const injections = evaluated.filter((e) => e.kind === "inject");
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
      const injections = evaluated.filter((e) => e.kind === "inject");
      expect(injections.map((e) => e.tab)).toEqual(["qa"]);
    });

    it("leaves a healthy tab untouched, so themed tabs never flash", async () => {
      mockCefTabs([{ id: "shared", title: "SharedJSContext" }]);
      activateTheme(backend, "alpha");
      const { evaluated } = stubCdp(backend, {});

      await verify(backend);

      expect(evaluated.filter((e) => e.kind === "inject")).toEqual([]);
      expect(evaluated.filter((e) => e.kind === "probe")).toHaveLength(1);
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

      expect(evaluated.filter((e) => e.kind === "inject")).toEqual([]);
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

      expect(evaluated.filter((e) => e.kind === "inject")).toEqual([]);
    });
  });

  describe("class translations", () => {
    const verify = (target: ThemeLoaderBackend) =>
      (target as unknown as { verifyAndHealInjection: () => Promise<void> })
        .verifyAndHealInjection();

    const loadCss = (target: ThemeLoaderBackend, id: string) =>
      (target as unknown as { loadThemeCss: (id: string) => Promise<string | null> })
        .loadThemeCss(id);

    const staleFlag = (target: ThemeLoaderBackend) =>
      (target as unknown as { cssBuiltWithoutTranslations: boolean })
        .cssBuiltWithoutTranslations;

    /** Write a real pack to disk and register it, so assemblePackCss runs. */
    async function installPack(target: ThemeLoaderBackend, id: string) {
      const dir = join(cacheDir, "packs", id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "theme.css"), ".someclass { color: red; }");
      const manifest = { name: id, inject: { "theme.css": ["SharedJSContext"] } };
      await writeFile(join(dir, "theme.json"), JSON.stringify(manifest));
      (target as unknown as { installedPacks: Map<string, unknown> })
        .installedPacks.set(id, { id, dir, manifest });
      return dir;
    }

    /**
     * The map records only names that actually CHANGED between Steam
     * builds — `buildMap` skips `variant === current`. So a theme
     * authored against the current build needs no translation at all, and
     * refusing to inject without the map would break themes that work
     * perfectly offline. Degraded beats absent.
     */
    it("still assembles CSS without the map, and records that it did", async () => {
      await installPack(backend, "alpha");
      expect(getTranslationsStatus().state).toBe("pending");

      const css = await loadCss(backend, "alpha");

      expect(css).toContain(".someclass");
      expect(staleFlag(backend)).toBe(true);
    });

    it("does not flag CSS assembled with the map", async () => {
      await installPack(backend, "alpha");
      await ensureTranslations();
      expect(getTranslationsStatus().state).toBe("ready");

      const css = await loadCss(backend, "alpha");

      expect(css).toContain(".someclass");
      expect(staleFlag(backend)).toBe(false);
    });

    it("rebuilds every active theme once the map arrives after injection", async () => {
      mockCefTabs([
        { id: "shared", title: "SharedJSContext" },
        { id: "qa", title: "QuickAccess" },
      ]);
      activateTheme(backend, "alpha");
      const { evaluated } = stubCdp(backend, {});
      // Injected during boot, before the map landed.
      (backend as unknown as { cssBuiltWithoutTranslations: boolean })
        .cssBuiltWithoutTranslations = true;
      await ensureTranslations();

      await verify(backend);

      // Every tab is rebuilt, not just the ones failing a DOM probe —
      // the probe cannot see that the CSS carries the wrong selectors.
      const injections = evaluated.filter((e) => e.kind === "inject");
      expect(injections.map((e) => e.tab).sort()).toEqual(["qa", "shared"]);
      expect(staleFlag(backend)).toBe(false);
      expect(evaluated.filter((e) => e.kind === "probe")).toEqual([]);
    });

    it("still heals while offline rather than leaving the user unthemed", async () => {
      globalThis.fetch = mock(async (input: unknown) => {
        const url = typeof input === "string" ? input : (input as { url: string }).url;
        if (url.includes("localhost:8080/json")) {
          return new Response(
            JSON.stringify([{
              id: "shared",
              title: "SharedJSContext",
              url: "about:blank",
              webSocketDebuggerUrl: "ws://localhost:8080/devtools/page/shared",
              type: "page",
            }]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return Promise.reject(new Error("Network unreachable"));
      }) as unknown as typeof fetch;

      activateTheme(backend, "alpha");
      const { evaluated } = stubCdp(backend, { shared: ["theme-loader-alpha"] });

      await verify(backend);

      expect(getTranslationsStatus().state).not.toBe("ready");
      expect(
        evaluated.filter((e) => e.kind === "inject").map((e) => e.tab),
      ).toEqual(["shared"]);
    });

    it("retries a sync that had not landed, in the background", async () => {
      mockCefTabs([{ id: "shared", title: "SharedJSContext" }]);
      activateTheme(backend, "alpha");
      stubCdp(backend, {});
      expect(getTranslationsStatus().state).toBe("pending");

      await verify(backend);
      // Deliberately not awaited inside the health pass — see
      // retryTranslationsInBackground.
      await Bun.sleep(20);

      expect(getTranslationsStatus().state).toBe("ready");
    });

    it("backs off after a failed sync instead of hammering the API", async () => {
      let translationFetches = 0;
      globalThis.fetch = mock(async (input: unknown) => {
        const url = typeof input === "string" ? input : (input as { url: string }).url;
        if (url.includes("localhost:8080/json")) {
          return new Response(JSON.stringify([]), {
            status: 200, headers: { "content-type": "application/json" },
          });
        }
        translationFetches++;
        return Promise.reject(new Error("Network unreachable"));
      }) as unknown as typeof fetch;

      activateTheme(backend, "alpha");
      stubCdp(backend, {});

      for (let i = 0; i < 5; i++) {
        await verify(backend);
        await Bun.sleep(10);
      }

      // One attempt, then a backoff window that has not elapsed.
      expect(translationFetches).toBe(1);
      expect(
        (backend as unknown as { translationRetryAt: number }).translationRetryAt,
      ).toBeGreaterThan(Date.now());
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
      // Pretend Steam came up an hour ago, closing the startup window.
      (backend as unknown as { startupWindowFrom: number }).startupWindowFrom =
        Date.now() - 3_600_000;

      expect(await tick(backend, 12)).toBe(2);
    });
  });

  describe("lifecycle", () => {
    /**
     * The behaviour this plugin's boot fix is named after, and the one
     * thing a passing suite used to prove nothing about: themes must not
     * be injected before the class-translation map has landed, because
     * CSS assembled without it may carry the wrong build's selectors.
     */
    it("onLoad injects only after the translation map has settled", async () => {
      mockCefTabs([{ id: "shared", title: "SharedJSContext" }]);
      const { evaluated } = stubCdp(backend);
      const order: string[] = [];
      const inner = backend as unknown as {
        loadStateFromDisk: () => Promise<void>;
        activeThemes: Map<string, { styleId: string }>;
        loadThemeCss: (id: string) => Promise<string | null>;
      };
      // Stand in for restored-from-disk state.
      inner.loadStateFromDisk = async () => {
        inner.activeThemes.set("alpha", { styleId: "theme-loader-alpha" });
      };
      inner.loadThemeCss = async () => {
        order.push("inject");
        return "body{}";
      };
      const realFetch = globalThis.fetch;
      globalThis.fetch = mock(async (input: unknown, init?: unknown) => {
        const url = typeof input === "string" ? input : (input as { url: string }).url;
        if (url.includes("stable.json")) {
          // Lose the race the way a cold boot does.
          await Bun.sleep(30);
          order.push("translations");
        }
        return realFetch(input as string, init as RequestInit);
      }) as unknown as typeof fetch;

      await backend.onLoad();
      await Bun.sleep(80);
      await backend.onUnload();

      expect(order).toEqual(["translations", "inject"]);
      expect(evaluated.some((e) => e.kind === "inject")).toBe(true);
    });

    it("onUnload stops a verify pass already in flight from re-injecting", async () => {
      mockCefTabs([{ id: "shared", title: "SharedJSContext" }]);
      activateTheme(backend, "alpha");
      const { evaluated, inner } = stubCdp(backend, { shared: ["theme-loader-alpha"] });
      // Unload lands while the pass is reading the pack off disk.
      const innerAny = backend as unknown as {
        loadThemeCss: (id: string) => Promise<string | null>;
        verifyAndHealInjection: () => Promise<void>;
      };
      innerAny.loadThemeCss = async () => {
        await backend.onUnload();
        return "body{}";
      };

      await innerAny.verifyAndHealInjection();

      expect(evaluated.filter((e) => e.kind === "inject")).toEqual([]);
      expect(inner.connections).toHaveLength(0);
    });

    it("checkHealth will not run two passes at once", async () => {
      mockCefTabs([{ id: "shared", title: "SharedJSContext" }]);
      stubCdp(backend);
      const innerAny = backend as unknown as {
        checkHealth: () => Promise<void>;
        verifyAndHealInjection: () => Promise<void>;
        tryConnect: () => Promise<boolean>;
        startupWindowFrom: number;
      };
      await innerAny.tryConnect();
      let concurrent = 0;
      let maxConcurrent = 0;
      innerAny.verifyAndHealInjection = async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await Bun.sleep(20);
        concurrent--;
      };

      // Fire overlapping ticks the way setInterval would.
      await Promise.all([innerAny.checkHealth(), innerAny.checkHealth(), innerAny.checkHealth()]);

      expect(maxConcurrent).toBe(1);
    });

    it("does not open a second socket per tab when discovery runs concurrently", async () => {
      mockCefTabs([
        { id: "shared", title: "SharedJSContext" },
        { id: "qa", title: "QuickAccess" },
      ]);
      const { inner } = stubCdp(backend);
      let opened = 0;
      const openCDP = inner.openCDP;
      inner.openCDP = async (o) => {
        opened++;
        await Bun.sleep(10);
        return openCDP(o);
      };
      const tryConnect = (backend as unknown as { tryConnect: () => Promise<boolean> })
        .tryConnect.bind(backend);

      await Promise.all([tryConnect(), tryConnect(), tryConnect()]);

      expect(opened).toBe(2);
      expect(inner.connections.map((c) => c.id).sort()).toEqual(["qa", "shared"]);
    });
  });

  describe("injectToAllTabs", () => {
    it("keeps a tab adopted while it was awaiting", async () => {
      mockCefTabs([{ id: "shared", title: "SharedJSContext" }]);
      const { inner } = stubCdp(backend);
      await (backend as unknown as { tryConnect: () => Promise<boolean> }).tryConnect();

      // A discovery pass adopts a new tab mid-injection.
      const innerAny = backend as unknown as {
        cdpEvaluate: (c: FakeConn, e: string) => Promise<unknown>;
        injectToAllTabs: (styleId: string, css: string) => Promise<void>;
      };
      const evaluate = innerAny.cdpEvaluate;
      innerAny.cdpEvaluate = async (conn, expression) => {
        inner.connections = [
          ...inner.connections,
          { id: "qa", title: "QuickAccess", client: { connected: true, close: () => {} } },
        ];
        innerAny.cdpEvaluate = evaluate;
        return evaluate(conn, expression);
      };

      await innerAny.injectToAllTabs("theme-loader-alpha", "body{}");

      expect(inner.connections.map((c) => c.id).sort()).toEqual(["qa", "shared"]);
    });

    it("closes a connection it drops, so the socket cannot leak", async () => {
      mockCefTabs([{ id: "shared", title: "SharedJSContext" }]);
      const { inner } = stubCdp(backend);
      await (backend as unknown as { tryConnect: () => Promise<boolean> }).tryConnect();
      let closed = false;
      inner.connections[0]!.client.close = () => { closed = true; };
      const innerAny = backend as unknown as {
        cdpEvaluate: () => Promise<unknown>;
        injectToAllTabs: (styleId: string, css: string) => Promise<void>;
      };
      innerAny.cdpEvaluate = async () => { throw new Error("CDP timeout"); };

      await innerAny.injectToAllTabs("theme-loader-alpha", "body{}");

      expect(closed).toBe(true);
      expect(inner.connections).toHaveLength(0);
    });
  });

  describe("orphan sweep", () => {
    const verify = (target: ThemeLoaderBackend) =>
      (target as unknown as { verifyAndHealInjection: () => Promise<void> })
        .verifyAndHealInjection();

    /**
     * `disableTheme` removes the style from the tabs it is connected to
     * and then deletes the entry regardless. If the connection list was
     * empty at that moment, the CSS stays in a tab that is about to be
     * re-adopted and nothing ever looks at it again — the theme reads as
     * off everywhere and is still on screen, and Reapply won't clear it
     * because that only re-injects what is active.
     */
    it("removes CSS left behind by a disable that reached no tabs", async () => {
      mockCefTabs([{ id: "shared", title: "SharedJSContext" }]);
      activateTheme(backend, "alpha");
      const { evaluated } = stubCdp(backend, {});
      // Disabled while disconnected: nothing to remove from, entry gone.
      await backend.disableTheme("alpha");
      expect(await backend.getActiveThemes()).toEqual([]);

      await verify(backend);

      const sweeps = evaluated.filter((e) => e.kind === "sweep");
      expect(sweeps).toHaveLength(1);
      // Nothing is active, so the sweep keeps nothing.
      expect(sweeps[0]!.expression).toContain("[]");
    });

    /**
     * Regression: changing the style-id scheme orphaned every element the
     * previous build had written — they were live in the page, matched no
     * id this build knew, and nothing would ever remove them. Observed on
     * hardware as 26 styles where there should have been 13.
     */
    it("sweeps on load, so a previous build's styles cannot linger", async () => {
      mockCefTabs([{ id: "shared", title: "SharedJSContext" }]);
      const { evaluated, inner } = stubCdp(backend);
      inner.loadThemeCss = async () => "body{}";
      (backend as unknown as { activeThemes: Map<string, { styleId: string }> })
        .activeThemes.set("alpha", { styleId: "theme-loader-alpha-x1" });

      await (backend as unknown as { verifyAndHealInjection: () => Promise<void> })
        .verifyAndHealInjection();

      const sweeps = evaluated.filter((e) => e.kind === "sweep");
      expect(sweeps).toHaveLength(1);
      // Keeps what this build knows about, removes anything else.
      expect(sweeps[0]!.expression).toContain("theme-loader-alpha-x1");
    });

    it("does not sweep again once a pass has come back clean", async () => {
      mockCefTabs([{ id: "shared", title: "SharedJSContext" }]);
      activateTheme(backend, "alpha");
      const { evaluated } = stubCdp(backend, {});
      // Spend the load-time sweep.
      await verify(backend);
      evaluated.length = 0;

      await verify(backend);

      expect(evaluated.filter((e) => e.kind === "sweep")).toEqual([]);
    });

    it("stops sweeping once a pass completes cleanly", async () => {
      mockCefTabs([{ id: "shared", title: "SharedJSContext" }]);
      activateTheme(backend, "alpha");
      const { evaluated } = stubCdp(backend, {});
      await backend.disableTheme("alpha");
      activateTheme(backend, "beta");

      await verify(backend);
      const afterFirst = evaluated.filter((e) => e.kind === "sweep").length;
      await verify(backend);
      const afterSecond = evaluated.filter((e) => e.kind === "sweep").length;

      expect(afterFirst).toBe(1);
      expect(afterSecond).toBe(1);
    });

    it("keeps sweeping if a tab could not be swept", async () => {
      mockCefTabs([{ id: "shared", title: "SharedJSContext" }]);
      activateTheme(backend, "alpha");
      const { evaluated, inner } = stubCdp(backend, {});
      await backend.disableTheme("alpha");
      activateTheme(backend, "beta");
      const stubbed = inner.cdpEvaluate;
      let sweepAttempts = 0;
      inner.cdpEvaluate = async (conn, expression) => {
        if (expression.includes("querySelectorAll")) {
          sweepAttempts++;
          throw new Error("target closed");
        }
        return stubbed(conn, expression);
      };

      await verify(backend);
      await verify(backend);

      expect(sweepAttempts).toBe(2);
      expect(evaluated.filter((e) => e.kind === "sweep")).toEqual([]);
    });
  });

  describe("emit", () => {
    /**
     * Discovery runs on a timer now, so an unconditional emit would
     * re-render the UI every tick for a status that never moved.
     */
    it("does not re-emit when discovery finds nothing new", async () => {
      mockCefTabs([{ id: "shared", title: "SharedJSContext" }]);
      stubCdp(backend);
      const tryConnect = (backend as unknown as { tryConnect: () => Promise<boolean> })
        .tryConnect.bind(backend);

      await tryConnect();
      const afterFirst = emittedEvents.length;
      await tryConnect();
      await tryConnect();

      expect(afterFirst).toBeGreaterThan(0);
      expect(emittedEvents.length).toBe(afterFirst);
    });

    it("emits when a tab is adopted", async () => {
      mockCefTabs([{ id: "shared", title: "SharedJSContext" }]);
      stubCdp(backend);
      const tryConnect = (backend as unknown as { tryConnect: () => Promise<boolean> })
        .tryConnect.bind(backend);
      await tryConnect();
      // Connectedness is already true and stays true, so this only emits
      // if the payload itself is compared.
      backend.emit = () => { throw new Error("should not emit for an unchanged payload"); };
      mockCefTabs([
        { id: "shared", title: "SharedJSContext" },
        { id: "qa", title: "QuickAccess" },
      ]);

      await expect(tryConnect()).resolves.toBe(true);
    });
  });

  describe("verification budget", () => {
    it("stands down while a full re-inject is already in flight", async () => {
      mockCefTabs([{ id: "shared", title: "SharedJSContext" }]);
      activateTheme(backend, "alpha");
      const { evaluated } = stubCdp(backend, { shared: ["theme-loader-alpha"] });
      const innerAny = backend as unknown as {
        inflightReinject: Promise<void> | null;
        verifyAndHealInjection: () => Promise<void>;
      };
      innerAny.inflightReinject = new Promise<void>(() => { /* still running */ });

      await innerAny.verifyAndHealInjection();

      expect(evaluated).toEqual([]);
    });


    /**
     * CDPClient.evaluate queues behind every other evaluate against the
     * same CEF target — a chain shared with the badge and loader
     * injectors — and its own timeout only starts once it reaches the
     * front. Without a cap here, one hung evaluate elsewhere holds the
     * health guard open, and with it dead-connection pruning.
     */
    it("stops mid-pass when the budget is spent, resuming next tick", async () => {
      mockCefTabs([
        { id: "shared", title: "SharedJSContext" },
        { id: "qa", title: "QuickAccess" },
        { id: "mm", title: "MainMenu_uid2" },
      ]);
      activateTheme(backend, "alpha");
      const { evaluated, inner } = stubCdp(backend, {});
      const innerAny = backend as unknown as {
        verifyPassBudgetMs: number;
        verifyAndHealInjection: () => Promise<void>;
      };
      innerAny.verifyPassBudgetMs = 5;
      const stubbed = inner.cdpEvaluate;
      inner.cdpEvaluate = async (conn, expression) => {
        await Bun.sleep(10);
        return stubbed(conn, expression);
      };

      await innerAny.verifyAndHealInjection();

      // Budget spent after the first tab, so the rest wait for next tick
      // rather than holding the health guard open.
      expect(evaluated.filter((e) => e.kind === "probe")).toHaveLength(1);
    });

    it("gives up on an evaluate that never settles", async () => {
      mockCefTabs([{ id: "shared", title: "SharedJSContext" }]);
      activateTheme(backend, "alpha");
      const { evaluated, inner } = stubCdp(backend, { shared: ["theme-loader-alpha"] });
      inner.cdpEvaluate = async () => new Promise(() => { /* never settles */ });

      const innerAny = backend as unknown as {
        boundedEvaluate: (o: { conn: FakeConn; expression: string; timeoutMs?: number })
          => Promise<unknown>;
        connections: FakeConn[];
      };
      await expect(
        innerAny.boundedEvaluate({
          conn: innerAny.connections[0]!,
          expression: "1",
          timeoutMs: 20,
        }),
      ).rejects.toThrow(/did not settle/);
      expect(evaluated).toEqual([]);
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
