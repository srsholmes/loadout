import type { PluginBackend, EmitPayload } from "@loadout/types";
import {
  listInstalledGames,
  type InstalledGame,
} from "@loadout/steam-paths";
import {
  readPluginStorage,
  writePluginStorage,
} from "@loadout/plugin-storage";
import {
  CDPClient,
  listCefTabs,
  SHARED_JS_CONTEXT_TITLES,
  type CEFTab,
} from "@loadout/steam-cdp";
import { createExternalCache } from "./lib/external-cache";
import {
  DEFAULT_SETTINGS,
  type ProtonDBSettings,
} from "./lib/settings";
import {
  generateBadgeCSS,
  generateBPMScript,
  generateBPMPushExpression,
  generateCleanupExpression,
  generateStorePushExpression,
  generateStoreScript,
  generateStyleInjectionExpression,
  parseStoreAppId,
} from "./lib/badge-scripts";

// ─── Types ──────────────────────────────────────────────────────────

interface ProtonDBReport {
  tier: string;
  confidence: string;
  score: number;
  trendingTier: string;
}

interface SteamSearchResult {
  appId: string;
  name: string;
  icon: string;
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export type { ProtonDBSettings } from "./lib/settings";

interface CDPConnection {
  client: CDPClient;
  tabTitle: string;
}

// ─── Constants ──────────────────────────────────────────────────────

const PLUGIN_ID = "protondb-badges";

/** In-memory hot-path TTL. Disk cache outlives the process; this map
 *  just skips the disk RTT for reads in the same session. */
const CACHE_TTL = 30 * 60 * 1000;

/** TTL in seconds for the disk cache. Longer window (24 h) than the
 *  in-memory map (30 min) so a freshly-restarted loader doesn't cold-
 *  start by re-fetching every report when warm data is on disk. */
const DISK_CACHE_TTL_SEC = 24 * 60 * 60;

/** Default per-CDP-call timeout. The badge runtime is small + idempotent;
 *  5 s is comfortable headroom for Steam's CEF roundtrips on a Deck. */
const CDP_TIMEOUT_MS = 5000;

/** Style id used for the injected stylesheet — same in BPM + store tabs
 *  so cleanup needs a single selector. */
const BADGE_STYLE_ID = "protondb-badges-styles";

/** Health-check / re-connect cadence. Matches the source plugin. */
const HEALTH_INTERVAL_MS = 5000;

// ─── Backend Class ──────────────────────────────────────────────────

/**
 * ProtonDB Badges backend.
 *
 * Two responsibilities:
 *
 * 1. Serve `getReport` / `searchGames` / `checkLinuxSupport` / `getBadgeData`
 *    RPC calls to the overlay UI (the library-grid + settings page in
 *    `app.tsx`). These hit ProtonDB + Steam's storefront API and cache
 *    in-memory + on-disk.
 *
 * 2. Inject the badge runtime into Steam's CEF (the Big Picture Mode tab
 *    + store tabs) via `@loadout/steam-cdp`, then push badge payloads on
 *    every `__core:game-detection` broadcast (`handleGameLaunch` /
 *    `handleGameExit`). The injected runtime + the CDP push pattern is a
 *    1:1 port of the source steam-loader plugin — see
 *    `lib/badge-scripts.ts` for the pure script generators and the
 *    accompanying test for the contract.
 *
 * Storage persists via `@loadout/plugin-storage` at
 * `~/.config/loadout/plugins/protondb-badges.json`. API responses persist
 * via the inlined `lib/external-cache.ts` TTL disk cache at
 * `~/.cache/loadout/protondb-badges/`.
 */
export default class ProtonDBBadgesBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;

  private reportCache = new Map<string, CacheEntry<ProtonDBReport | null>>();
  private searchCache = new Map<string, CacheEntry<SteamSearchResult[]>>();
  private linuxCache = new Map<string, CacheEntry<boolean>>();

  /** Disk-backed cache for ProtonDB / Steam-search / Linux-support
   *  responses. Writes go through `_safeDiskSet` so a transient
   *  filesystem error can't poison the network-result return path. */
  private diskCache = createExternalCache(PLUGIN_ID);

  private settings: ProtonDBSettings = { ...DEFAULT_SETTINGS };

  /**
   * Concurrency limiter for ProtonDB report fetches. Library-grid view
   * fans out one `getReport` call per installed game (routinely 100+);
   * without throttling, ProtonDB will start 429-ing. Cap at 4 in flight
   * at a time. Cache hits skip the queue entirely.
   */
  private inflightLookups = 0;
  private lookupQueue: Array<() => void> = [];
  private static readonly MAX_CONCURRENT_LOOKUPS = 4;

  // ─── CDP injection state ────────────────────────────────────────

  /**
   * Open CDP connections keyed by a stable label:
   *   - `"SharedJSContext"` for the shared-context tab (regardless of
   *     whichever of SHARED_JS_CONTEXT_TITLES the live tab happens to
   *     use — we normalise on insert).
   *   - `"Steam Big Picture Mode"` for the visible gamepad-UI window.
   *   - `"store:<tab title>"` for every store.steampowered.com tab.
   *
   * Empty when Steam is unreachable; populated by `_tryConnect`.
   */
  private connections = new Map<string, CDPConnection>();

  /** Mirrors `connections.size > 0 AND has a useful tab`. Drives the
   *  status surface returned to `app.tsx`. */
  private connected = false;

  /** Periodic re-connect + dead-connection pruning. Kicks every
   *  HEALTH_INTERVAL_MS; cleared in onUnload. */
  private healthInterval?: ReturnType<typeof setInterval>;

  /** Per-store-tab tracked appId so `_pollStoreTabs` only pushes on
   *  URL change instead of every interval tick. */
  private storeTabAppIds = new Map<string, string | null>();

  /** Cadence for store-tab URL polling. Tabs don't broadcast their own
   *  URL changes; the only way to learn the user navigated to a new
   *  storefront page is to read `window.location.href` on a timer. */
  private storePollInterval?: ReturnType<typeof setInterval>;
  private static readonly STORE_POLL_MS = 500;

  /** Tracks the appId of the currently-running game per the loader's
   *  game-detection broadcast. Drives the BPM badge push. */
  private currentGameAppId: string | null = null;

  // ─── Lifecycle ──────────────────────────────────────────────────

  async onLoad(): Promise<void> {
    console.log("[protondb-badges] Plugin loaded");
    await this._loadSettings();

    // Best-effort Steam connect. The CEF debug port may not be reachable
    // yet (Steam still booting, headless test env, etc.) — the periodic
    // health check below will retry until it succeeds. Failure here is
    // intentionally non-fatal: ProtonDB lookups + the overlay UI still
    // function without the in-CEF badge.
    this._tryConnect()
      .then((ok) => {
        if (ok) {
          return this._injectBadgeSystem();
        }
      })
      .catch((err) => {
        console.log(
          "[protondb-badges] Steam CEF not available at load, will retry:",
          err,
        );
      });

    this.healthInterval = setInterval(
      () => this._checkHealth(),
      HEALTH_INTERVAL_MS,
    );

    // Store tabs need URL polling because the storefront SPA doesn't
    // broadcast nav changes over CDP. The BPM tab is push-driven from
    // `handleGameLaunch` / `handleGameExit` so it doesn't poll.
    this.storePollInterval = setInterval(
      () => this._pollStoreTabs(),
      ProtonDBBadgesBackend.STORE_POLL_MS,
    );
  }

  async onUnload(): Promise<void> {
    if (this.healthInterval) clearInterval(this.healthInterval);
    if (this.storePollInterval) clearInterval(this.storePollInterval);

    await this._removeBadgeSystem();

    for (const conn of this.connections.values()) {
      try {
        conn.client.close();
      } catch {
        /* close errors are non-fatal */
      }
    }
    this.connections.clear();
    this.storeTabAppIds.clear();
    this.connected = false;

    this.reportCache.clear();
    this.searchCache.clear();
    this.linuxCache.clear();
    console.log("[protondb-badges] Plugin unloaded");
  }

  // ─── Game-detection broadcast hooks ─────────────────────────────
  // The loader's GameDetectionService fans out `handleGameLaunch` and
  // `handleGameExit` to every plugin instance that exposes them. We use
  // them to push the BPM badge — no polling needed.

  async handleGameLaunch(appId: number, _gameName: string): Promise<void> {
    if (typeof appId !== "number" || !Number.isFinite(appId)) return;
    this.currentGameAppId = String(appId);
    await this._pushBadgeToBPM(this.currentGameAppId);
  }

  async handleGameExit(appId: number): Promise<void> {
    if (typeof appId !== "number" || !Number.isFinite(appId)) return;
    if (this.currentGameAppId !== String(appId)) return;
    this.currentGameAppId = null;
    await this._pushBadgeToBPM(null);
  }

  // ─── RPC: ProtonDB Data ─────────────────────────────────────────

  async getReport(appId: string): Promise<ProtonDBReport | null> {
    const cached = this.reportCache.get(appId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;

    return this._withLookupSlot(async () => {
      // Re-check the cache once we've actually entered the slot — a
      // sibling caller may have populated it while we were queued.
      const recached = this.reportCache.get(appId);
      if (recached && Date.now() - recached.timestamp < CACHE_TTL) {
        return recached.data;
      }

      // Disk cache lookup before paying the network. Hits hydrate the
      // in-memory Map so subsequent same-session reads stay hot.
      const fromDisk = await this._safeDiskGet<ProtonDBReport | null>(
        `report:${appId}`,
      );
      if (fromDisk !== undefined) {
        this.reportCache.set(appId, { data: fromDisk, timestamp: Date.now() });
        return fromDisk;
      }

      try {
        const res = await fetch(
          `https://www.protondb.com/api/v1/reports/summaries/${appId}.json`,
        );
        if (!res.ok) {
          // 404 means ProtonDB has no reports for this title — cache the
          // null so we don't keep re-fetching. 5xx / rate-limits / network
          // blips return null without caching so the next call retries.
          if (res.status === 404) {
            this.reportCache.set(appId, { data: null, timestamp: Date.now() });
            await this._safeDiskSet(
              `report:${appId}`,
              null,
              DISK_CACHE_TTL_SEC,
            );
          }
          return null;
        }

        const data = await res.json();
        const report: ProtonDBReport = {
          tier: data.tier ?? "pending",
          confidence: data.confidence ?? "unknown",
          score: data.score ?? 0,
          trendingTier: data.trendingTier ?? data.tier ?? "pending",
        };

        this.reportCache.set(appId, { data: report, timestamp: Date.now() });
        await this._safeDiskSet(`report:${appId}`, report, DISK_CACHE_TTL_SEC);
        return report;
      } catch (err) {
        console.error(`[protondb-badges] Failed to fetch report for ${appId}:`, err);
        // Don't cache transient errors — let the next mount retry.
        return null;
      }
    });
  }

  /**
   * Enumerate the user's installed Steam games via
   * `@loadout/steam-paths`. Returns `{appId, name}` pairs sorted
   * alphabetically by name. No ProtonDB calls happen here — just disk
   * reads of `appmanifest_*.acf`.
   */
  async listInstalledGames(): Promise<InstalledGame[]> {
    return listInstalledGames();
  }

  async searchGames(query: string): Promise<SteamSearchResult[]> {
    if (!query || query.trim().length === 0) return [];

    const cacheKey = query.toLowerCase().trim();
    const cached = this.searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;

    const fromDisk = await this._safeDiskGet<SteamSearchResult[]>(
      `search:${cacheKey}`,
    );
    if (fromDisk !== undefined) {
      this.searchCache.set(cacheKey, { data: fromDisk, timestamp: Date.now() });
      return fromDisk;
    }

    try {
      const encoded = encodeURIComponent(query.trim());
      const res = await fetch(
        `https://store.steampowered.com/api/storesearch/?term=${encoded}&cc=us&l=en`,
      );
      if (!res.ok) throw new Error(`Steam search API returned ${res.status}`);

      const data = await res.json();
      const results: SteamSearchResult[] = (data.items ?? []).map(
        (item: { id: number; name: string; tiny_image?: string }) => ({
          appId: String(item.id),
          name: item.name,
          icon: item.tiny_image ?? "",
        }),
      );

      this.searchCache.set(cacheKey, { data: results, timestamp: Date.now() });
      await this._safeDiskSet(
        `search:${cacheKey}`,
        results,
        DISK_CACHE_TTL_SEC,
      );
      return results;
    } catch (err) {
      console.error("[protondb-badges] Steam search failed:", err);
      throw err;
    }
  }

  async checkLinuxSupport(appId: string): Promise<boolean> {
    const cached = this.linuxCache.get(appId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;

    const fromDisk = await this._safeDiskGet<boolean>(`linux:${appId}`);
    if (fromDisk !== undefined) {
      this.linuxCache.set(appId, { data: fromDisk, timestamp: Date.now() });
      return fromDisk;
    }

    try {
      const res = await fetch(
        `https://store.steampowered.com/api/appdetails/?appids=${appId}`,
      );
      if (!res.ok) return false;
      const data = await res.json();
      const hasLinux = !!(data[appId]?.data?.platforms?.linux);
      this.linuxCache.set(appId, { data: hasLinux, timestamp: Date.now() });
      await this._safeDiskSet(`linux:${appId}`, hasLinux, DISK_CACHE_TTL_SEC);
      return hasLinux;
    } catch {
      return false;
    }
  }

  async clearCache(): Promise<void> {
    this.reportCache.clear();
    this.searchCache.clear();
    this.linuxCache.clear();
    try {
      await this.diskCache.clear();
    } catch (err) {
      console.warn("[protondb-badges] disk cache clear failed:", err);
    }
  }

  /**
   * Loader-broadcast entry point for the global "Clear all data caches"
   * button on the Settings page. Same effect as `clearCache` — kept
   * under a distinct, broadcast-safe name so the loader's `__broadcast`
   * fan-out only hits plugins that intentionally implement it.
   */
  async clearExternalCache(): Promise<void> {
    await this.clearCache();
  }

  /** Get badge data in one call (report + linux support). */
  async getBadgeData(appId: string): Promise<{
    report: ProtonDBReport | null;
    linuxSupport: boolean;
    settings: ProtonDBSettings;
  }> {
    const [report, linuxSupport] = await Promise.all([
      this.getReport(appId),
      this.checkLinuxSupport(appId),
    ]);
    return { report, linuxSupport, settings: this.settings };
  }

  // ─── RPC: Settings ──────────────────────────────────────────────

  async getSettings(): Promise<ProtonDBSettings> {
    return { ...this.settings };
  }

  async updateSettings(settings: ProtonDBSettings): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    await this._saveSettings();
    // Re-inject so the in-page runtime's settings snapshot matches the
    // new values. `_injectBadgeSystem` cleans the previous runtime via
    // its own `cleanup()` guard so this is safe to call repeatedly.
    if (this.connected) {
      await this._injectBadgeSystem();
    }
    this._emitState();
  }

  // ─── RPC: Status ────────────────────────────────────────────────

  async getStatus(): Promise<{ connected: boolean; tabs: number }> {
    return {
      connected: this.connected,
      tabs: this.connections.size,
    };
  }

  async reconnect(): Promise<{ success: boolean; error?: string }> {
    for (const conn of this.connections.values()) {
      try {
        conn.client.close();
      } catch {
        /* close errors are non-fatal */
      }
    }
    this.connections.clear();
    this.storeTabAppIds.clear();
    this.connected = false;

    const ok = await this._tryConnect();
    if (ok) {
      await this._injectBadgeSystem();
      this._emitState();
      return { success: true };
    }
    return {
      success: false,
      error: "Could not connect to Steam CEF",
    };
  }

  /**
   * Returns the appId of the currently-running game per the loader's
   * `__core:game-detection` broadcast. The overlay UI uses this for
   * "current game" widgets when the user hasn't manually picked a
   * library entry to inspect.
   *
   * Name retained from the source plugin for app.tsx compatibility,
   * even though the underlying source is now the broadcast rather
   * than CDP URL polling.
   */
  async getCurrentRouteAppId(): Promise<string | null> {
    return this.currentGameAppId;
  }

  // ─── CDP infrastructure ─────────────────────────────────────────

  /**
   * Fetch the CEF tab list and open CDP connections to:
   *   - the SharedJSContext tab (whatever title variant Steam uses)
   *   - the visible "Steam Big Picture Mode" tab
   *   - every store.steampowered.com tab the user has open
   *
   * Returns `true` if at least one of the BPM / SharedJSContext tabs
   * connected; `false` if Steam is unreachable or no useful tabs are
   * present. Idempotent — close-and-reopen, so safe to call from
   * `reconnect()`.
   */
  private async _tryConnect(): Promise<boolean> {
    let tabs: CEFTab[];
    try {
      tabs = await listCefTabs({ timeoutMs: 3000 });
    } catch {
      this.connected = false;
      return false;
    }

    // Close existing — `_tryConnect` is also the reconnect path.
    for (const conn of this.connections.values()) {
      try {
        conn.client.close();
      } catch {
        /* close errors are non-fatal */
      }
    }
    this.connections.clear();
    this.storeTabAppIds.clear();

    // Connect to SharedJSContext + BPM
    for (const tab of tabs) {
      if (!tab.webSocketDebuggerUrl) continue;

      // Normalise the shared-context tab title variants to a single key
      // so consumers always look it up by "SharedJSContext".
      const isShared = SHARED_JS_CONTEXT_TITLES.has(tab.title);
      const isBPM = tab.title === "Steam Big Picture Mode";
      if (!isShared && !isBPM) continue;

      try {
        const conn = await this._openCDP(tab.webSocketDebuggerUrl, tab.title);
        const key = isShared ? "SharedJSContext" : "Steam Big Picture Mode";
        this.connections.set(key, conn);
        console.log(
          `[protondb-badges] Connected to: ${tab.title} (key: ${key})`,
        );
      } catch (err) {
        console.warn(
          `[protondb-badges] Failed to connect to ${tab.title}:`,
          err,
        );
      }
    }

    // Connect to every store.steampowered.com tab
    for (const tab of tabs) {
      if (!tab.webSocketDebuggerUrl) continue;
      if (!tab.url.includes("store.steampowered.com")) continue;
      try {
        const conn = await this._openCDP(tab.webSocketDebuggerUrl, tab.title);
        this.connections.set(`store:${tab.title}`, conn);
        console.log(`[protondb-badges] Connected to store: ${tab.title}`);
      } catch {
        /* a single store tab failing to connect isn't fatal */
      }
    }

    this.connected =
      this.connections.has("SharedJSContext") ||
      this.connections.has("Steam Big Picture Mode");
    this._emitState();
    return this.connected;
  }

  private async _openCDP(
    wsUrl: string,
    tabTitle: string,
  ): Promise<CDPConnection> {
    const client = new CDPClient(wsUrl);
    await client.connect();
    return { client, tabTitle };
  }

  private _cdpEvaluate(
    conn: CDPConnection,
    expression: string,
  ): Promise<unknown> {
    return conn.client.evaluate(expression, { timeoutMs: CDP_TIMEOUT_MS });
  }

  // ─── CSS/JS injection ───────────────────────────────────────────

  private async _injectCSSToTab(
    conn: CDPConnection,
    styleId: string,
    css: string,
  ): Promise<void> {
    await this._cdpEvaluate(
      conn,
      generateStyleInjectionExpression(styleId, css),
    );
  }

  /**
   * Push the badge stylesheet + runtime into every connected CEF tab
   * that should host a badge. Safe to call repeatedly — the in-page
   * runtimes self-cleanup on re-injection. Used by `onLoad`,
   * `updateSettings` (to rebroadcast new settings), and `reconnect`.
   */
  private async _injectBadgeSystem(): Promise<void> {
    const css = generateBadgeCSS();

    // BPM tab — the gamepad-UI window where the library badge renders.
    const bpm = this.connections.get("Steam Big Picture Mode");
    if (bpm && bpm.client.connected) {
      try {
        await this._injectCSSToTab(bpm, BADGE_STYLE_ID, css);
        await this._cdpEvaluate(bpm, generateBPMScript(this.settings));
        console.log(
          "[protondb-badges] Injected badge system into Big Picture Mode",
        );

        // Push the current badge data immediately if game-detection has
        // already told us the user is playing something. Without this,
        // the user sees no badge until the next launch/exit broadcast.
        if (this.currentGameAppId) {
          await this._pushBadgeToBPM(this.currentGameAppId);
        }
      } catch (err) {
        console.warn(
          "[protondb-badges] Failed to inject into BPM:",
          err,
        );
      }
    }

    // Store tabs — each gets the simpler store badge.
    for (const [key, conn] of this.connections) {
      if (!key.startsWith("store:")) continue;
      if (!conn.client.connected) continue;
      try {
        await this._injectCSSToTab(conn, BADGE_STYLE_ID, css);
        await this._cdpEvaluate(conn, generateStoreScript());
        // Reset tracked appId so `_pollStoreTabs` will push data on the
        // next tick.
        this.storeTabAppIds.delete(key);
      } catch {
        /* a single store tab failing to inject isn't fatal */
      }
    }
  }

  private async _removeBadgeSystem(): Promise<void> {
    for (const conn of this.connections.values()) {
      if (!conn.client.connected) continue;
      try {
        await this._cdpEvaluate(
          conn,
          generateCleanupExpression(BADGE_STYLE_ID),
        );
      } catch {
        /* cleanup errors are non-fatal */
      }
    }
  }

  /** Push (or clear) the BPM badge for `appId`. Called on
   *  game-detection broadcasts + after BPM re-injection. */
  private async _pushBadgeToBPM(appId: string | null): Promise<void> {
    const bpm = this.connections.get("Steam Big Picture Mode");
    if (!bpm || !bpm.client.connected) return;

    try {
      if (!appId) {
        await this._cdpEvaluate(bpm, generateBPMPushExpression(null));
        return;
      }

      const data = await this.getBadgeData(appId);
      await this._cdpEvaluate(
        bpm,
        generateBPMPushExpression({ ...data, appId }),
      );
    } catch (err) {
      console.warn("[protondb-badges] Failed to push badge to BPM:", err);
    }
  }

  /**
   * Poll every store-tab CDP connection for URL changes. The storefront
   * SPA doesn't broadcast nav events over CDP, so the only way to learn
   * the user navigated to a different game page is to read
   * `window.location.href` on a timer.
   *
   * Pushes badge data only on URL change, not every tick.
   */
  private async _pollStoreTabs(): Promise<void> {
    for (const [key, conn] of this.connections) {
      if (!key.startsWith("store:")) continue;
      if (!conn.client.connected) continue;

      try {
        const url = (await this._cdpEvaluate(
          conn,
          "window.location.href",
        )) as string | null | undefined;
        const appId = parseStoreAppId(url);
        const prevAppId = this.storeTabAppIds.get(key) ?? null;

        if (appId === prevAppId) continue;
        this.storeTabAppIds.set(key, appId);

        if (!appId || !this.settings.enableStoreBadge) {
          await this._cdpEvaluate(conn, generateStorePushExpression(null));
          continue;
        }

        const report = await this.getReport(appId);
        if (!report) continue;

        await this._cdpEvaluate(
          conn,
          generateStorePushExpression({ report, appId }),
        );
      } catch {
        /* a single tick failing isn't fatal — next iteration retries */
      }
    }
  }

  // ─── Private helpers ────────────────────────────────────────────

  private async _withLookupSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inflightLookups >= ProtonDBBadgesBackend.MAX_CONCURRENT_LOOKUPS) {
      await new Promise<void>((resolve) => {
        this.lookupQueue.push(resolve);
      });
    }
    this.inflightLookups++;
    try {
      return await fn();
    } finally {
      this.inflightLookups--;
      const next = this.lookupQueue.shift();
      if (next) next();
    }
  }

  private async _safeDiskSet<T>(
    key: string,
    value: T,
    ttlSec: number,
  ): Promise<void> {
    try {
      await this.diskCache.set(key, value, { ttlSec });
    } catch (err) {
      console.warn(`[protondb-badges] disk cache write failed for ${key}:`, err);
    }
  }

  private async _safeDiskGet<T>(key: string): Promise<T | undefined> {
    try {
      return await this.diskCache.get<T>(key);
    } catch {
      return undefined;
    }
  }

  private async _loadSettings(): Promise<void> {
    try {
      const stored = await readPluginStorage<Partial<ProtonDBSettings>>(
        PLUGIN_ID,
      );
      this.settings = { ...DEFAULT_SETTINGS, ...stored };
    } catch (err) {
      console.warn("[protondb-badges] Failed to load settings:", err);
    }
  }

  private async _saveSettings(): Promise<void> {
    try {
      await writePluginStorage(PLUGIN_ID, this.settings);
    } catch (err) {
      console.warn("[protondb-badges] Failed to save settings:", err);
    }
  }

  private _emitState(): void {
    this.emit?.({
      event: "stateChanged",
      data: {
        connected: this.connected,
        tabs: this.connections.size,
        settings: this.settings,
      },
    });
  }

  /**
   * Periodic health check: prune dead CDP connections; if no useful
   * connection remains, attempt re-connect + re-inject. Steam restarts,
   * the SharedJSContext tab navigating, the user closing BPM, etc., all
   * land here as detected stale connections.
   */
  private async _checkHealth(): Promise<void> {
    // Prune dead connections.
    for (const [key, conn] of this.connections) {
      if (!conn.client.connected) {
        this.connections.delete(key);
        this.storeTabAppIds.delete(key);
        console.log(
          `[protondb-badges] Pruned dead connection: ${key}`,
        );
      }
    }

    const wasConnected = this.connected;
    this.connected =
      this.connections.has("SharedJSContext") ||
      this.connections.has("Steam Big Picture Mode");

    if (!this.connected) {
      if (wasConnected) this._emitState();
      const ok = await this._tryConnect();
      if (ok) await this._injectBadgeSystem();
    }
  }
}
