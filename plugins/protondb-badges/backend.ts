import type { PluginBackend, EmitPayload } from "@loadout/types";
import {
  listInstalledGames,
  type InstalledGame,
} from "@loadout/steam-paths";
import { CDPClient } from "@loadout/steam-cdp";
import {
  readPluginStorage,
  writePluginStorage,
} from "@loadout/plugin-storage";
import { createExternalCache } from "./lib/external-cache";

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

export interface ProtonDBSettings {
  size: "regular" | "small" | "minimalist";
  position: "tl" | "tm" | "tr" | "bl" | "bm" | "br";
  labelOnHover: "off" | "small" | "regular";
  showSubmitButton: boolean;
  enableLibraryBadge: boolean;
  enableStoreBadge: boolean;
}

/** Combined payload pushed into the injected CEF badge runtime. The
 *  injected scripts only read `report` + `settings`; Linux-support is
 *  deliberately NOT carried here so the 500 ms push path never pays the
 *  extra (rate-limited) Steam appdetails fetch. */
interface BadgeData {
  appId: string;
  report: ProtonDBReport | null;
  settings: ProtonDBSettings;
}

interface CEFTab {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
  type: string;
}

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

/** Steam's CEF remote-debugging port. */
const DEBUG_PORT = 8080;
/** Per-evaluate CDP timeout. Steam can stall mid game-state transition;
 *  5 s matches the sibling CEF-injection plugins (hltb / theme-loader). */
const CDP_TIMEOUT_MS = 5000;

const DEFAULT_SETTINGS: ProtonDBSettings = {
  size: "regular",
  position: "tl",
  labelOnHover: "off",
  showSubmitButton: false,
  enableLibraryBadge: true,
  enableStoreBadge: true,
};

// ─── Backend Class ──────────────────────────────────────────────────

/**
 * ProtonDB Badges backend.
 *
 * Two surfaces:
 *
 *  1. **Overlay UI** — exposes the ProtonDB compatibility tier (plus a
 *     few Steam-store side fetches: per-title Linux support, free-text
 *     search) as RPC methods consumed by `app.tsx`. The grid view fans
 *     out one `getReport` call per installed game, so the backend caps
 *     concurrent ProtonDB requests at 4 (cache hits skip the queue) to
 *     avoid 429s from a 100+ game library.
 *
 *  2. **Steam-CEF badge injection** — connects to Steam's CEF debug
 *     port over CDP, discovers the Big Picture Mode / SharedJSContext /
 *     store tabs, and injects a CSS rule + a passive JS runtime
 *     (`window.__protondb_badges = { updateBadge, removeBadge, cleanup }`)
 *     into each. The backend polls the SharedJSContext route for the
 *     viewed appId, fetches the report server-side, and pushes it into
 *     the runtime — so a tier badge appears on the live Steam game /
 *     store page, not just inside the overlay. This is the layer PR #50
 *     dropped and issue #59 restored; it mirrors the sibling `hltb`
 *     plugin's injection architecture.
 *
 * Settings persist via `@loadout/plugin-storage` at
 * `~/.config/loadout/plugins/protondb-badges.json`. API responses
 * persist via the inlined `lib/external-cache.ts` TTL disk cache at
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

  /** Open CDP connections keyed by tab title (SharedJSContext variants
   *  collapse to the canonical `SharedJSContext` key; store tabs use a
   *  `store:<title>` key; BPM popups keep their per-session title). */
  private connections = new Map<string, CDPConnection>();
  private connected = false;
  private healthInterval?: ReturnType<typeof setInterval>;
  private urlPollInterval?: ReturnType<typeof setInterval>;

  /** appId of the game page currently viewed in BPM (route-derived). */
  private currentAppId: string | null = null;

  /** Re-entrancy guards for the two background interval ticks
   *  (`_checkHealth` 5 s, `_pollCurrentAppId` 500 ms). A slow CDP
   *  evaluate (up to `CDP_TIMEOUT_MS`) must not let the next tick fire
   *  on top and race on `connections` / `bpmRenderKeys`. */
  private polling = false;
  private healthChecking = false;

  /** Tail-queue for `_pushBadgeDataToBPM`: when a push is in flight and
   *  a new appId arrives, stash the latest and let the running push
   *  drain to it. `pendingPushSet` (not a null check) because `null` is
   *  a valid pending value (= "navigated away from a game page"). */
  private pushingBadgeData = false;
  private pendingPushAppId: string | null = null;
  private pendingPushSet = false;

  /**
   * Connection keys that are candidate render targets for the BPM badge
   * — either the parent `Steam Big Picture Mode` tab or any per-session
   * `MainMenu_uid<N>` popup. Which one hosts the visible React UI is
   * build-dependent, so we inject into all of them and push data to all
   * of them; only the visible tab composites to the user. Refilled by
   * health-check rediscovery when popups die.
   */
  private bpmRenderKeys: string[] = [];

  /**
   * Debounce window for re-injecting the badge system after a settings
   * change. Dragging a position/style control fires `updateSettings`
   * many times a second; re-pushing the full CSS+script bundle over CDP
   * on every call stalls the bridge. Trailing-edge debounce collapses
   * the burst into one re-injection.
   */
  private static readonly INJECT_DEBOUNCE_MS = 250;
  private injectDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // ─── Lifecycle ──────────────────────────────────────────────────

  async onLoad(): Promise<void> {
    console.log("[protondb-badges] Plugin loaded");
    await this._loadSettings();

    // Try the initial CEF connection, but don't block startup if Steam
    // isn't up yet — the health check retries every 5 s.
    this._tryConnect()
      .then((ok) => {
        if (ok) void this._injectBadgeSystem();
      })
      .catch(() => {
        console.log("[protondb-badges] Steam CEF not available yet, will retry");
      });

    this.healthInterval = setInterval(() => void this._checkHealth(), 5000);
    this.urlPollInterval = setInterval(() => void this._pollCurrentAppId(), 500);
  }

  async onUnload(): Promise<void> {
    clearInterval(this.healthInterval);
    clearInterval(this.urlPollInterval);
    if (this.injectDebounceTimer) clearTimeout(this.injectDebounceTimer);
    await this._removeBadgeSystem();

    // Silent catch: `ws.close()` may throw if the socket is already
    // CLOSING/CLOSED — harmless during unload.
    for (const conn of this.connections.values()) {
      try {
        conn.client.close();
      } catch {
        /* already closed */
      }
    }
    this.connections.clear();
    this.bpmRenderKeys = [];
    this.connected = false;

    this.reportCache.clear();
    this.searchCache.clear();
    this.linuxCache.clear();
    console.log("[protondb-badges] Plugin unloaded");
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
    this._emitState();

    // Re-inject the badge system so style/position/toggle changes show
    // up live on the Steam side. Debounced so dragging a control doesn't
    // peg the CDP bridge.
    if (!this.connected) return;
    if (this.injectDebounceTimer) clearTimeout(this.injectDebounceTimer);
    this.injectDebounceTimer = setTimeout(() => {
      this.injectDebounceTimer = null;
      void this._injectBadgeSystem();
    }, ProtonDBBadgesBackend.INJECT_DEBOUNCE_MS);
  }

  // ─── RPC: Steam-CEF status ──────────────────────────────────────

  async getStatus(): Promise<{ connected: boolean; tabs: number }> {
    return { connected: this.connected, tabs: this.connections.size };
  }

  async reconnect(): Promise<{ success: boolean; error?: string }> {
    for (const conn of this.connections.values()) {
      try {
        conn.client.close();
      } catch {
        /* already closed */
      }
    }
    this.connections.clear();
    this.bpmRenderKeys = [];
    this.connected = false;

    const ok = await this._tryConnect();
    if (ok) {
      await this._injectBadgeSystem();
      this._emitState();
      return { success: true };
    }
    return { success: false, error: "Could not connect to Steam CEF. Is Steam running?" };
  }

  /**
   * appId of the game page currently viewed in Steam BPM (route-derived,
   * NOT the running game). Mirrors hltb's route polling; will fold into a
   * `__core:game-detection` subscribe once that lands for backends.
   */
  async getCurrentRouteAppId(): Promise<string | null> {
    return this.currentAppId;
  }

  // ─── Route Polling (SharedJSContext) ────────────────────────────
  //
  // In BPM / gamescope, window.location.href stays pinned to the BPM
  // entry URL forever — navigation happens inside a React Router SPA.
  // Steam exposes the router on SharedJSContext as `window.tempNavStore`
  // (a MobX store mirroring React Router v5); on a game page the
  // pathname is `/library/app/<id>` (or `/routes/library/app/<id>` on
  // some builds). Polling that covers both BPM and Desktop Steam, with a
  // fallback to window.location.pathname.

  private async _pollCurrentAppId(): Promise<void> {
    if (this.polling) return;
    const conn = this.connections.get("SharedJSContext");
    if (!conn || !conn.client.connected) return;

    this.polling = true;
    try {
      const pathname = (await this._cdpEvaluate(
        conn,
        "(window.tempNavStore && window.tempNavStore.m_history && window.tempNavStore.m_history.location && window.tempNavStore.m_history.location.pathname) || window.location.pathname || ''",
      )) as string;
      const match = pathname?.match?.(/^\/(?:routes\/)?library\/app\/(\d+)/);
      const newAppId = match ? match[1] : null;

      if (newAppId !== this.currentAppId) {
        this.currentAppId = newAppId;
        this._pushBadgeDataToBPM(newAppId).catch(() => {});
      }
    } catch {
      // Ignore — will retry next tick.
    } finally {
      this.polling = false;
    }
  }

  /**
   * Fetch ProtonDB data server-side and push it into the BPM tab(s) via
   * CDP. Pushing server-side (rather than letting the injected script
   * fetch) sidesteps the mixed-content block on https://steamloopback.host.
   */
  private async _pushBadgeDataToBPM(appId: string | null): Promise<void> {
    // Coalesce rapid route changes: stash the latest appId and let the
    // running push drain to it, so a fast navigation never strands a
    // stale badge on screen.
    this.pendingPushAppId = appId;
    this.pendingPushSet = true;
    if (this.pushingBadgeData) return;
    this.pushingBadgeData = true;

    try {
      while (this.pendingPushSet) {
        const targetAppId = this.pendingPushAppId;
        this.pendingPushSet = false;

        const targets = this.bpmRenderKeys
          .map((k) => ({ key: k, conn: this.connections.get(k) }))
          .filter((t) => t.conn && t.conn.client.connected);
        if (targets.length === 0) continue;

        let expr: string;
        if (!targetAppId) {
          expr = `if (window.__protondb_badges) window.__protondb_badges.removeBadge();`;
        } else {
          // Fetch only the report — the injected runtime never reads
          // Linux-support, so don't pay `checkLinuxSupport` on every
          // navigation (see `BadgeData`).
          const report = await this.getReport(targetAppId);
          // If a newer appId arrived while awaiting the fetch, drop this
          // batch and let the loop re-run for the latest.
          if (this.pendingPushSet) continue;
          const data: BadgeData = {
            appId: targetAppId,
            report,
            settings: this.settings,
          };
          expr = `if (window.__protondb_badges) window.__protondb_badges.updateBadge(${JSON.stringify(data)});`;
        }

        const pushed: string[] = [];
        for (const t of targets) {
          try {
            await this._cdpEvaluate(t.conn!, expr);
            pushed.push(t.key);
          } catch (err) {
            console.warn(
              `[protondb-badges] Failed to push badge data to ${t.key}:`,
              err,
            );
          }
        }
        if (targetAppId && pushed.length > 0) {
          console.log(
            `[protondb-badges] Pushed badge data to ${pushed.join(", ")} for app ${targetAppId}`,
          );
        }
      }
    } finally {
      this.pushingBadgeData = false;
    }
  }

  // ─── CDP Infrastructure ─────────────────────────────────────────

  private async _tryConnect(): Promise<boolean> {
    try {
      const res = await fetch(`http://localhost:${DEBUG_PORT}/json`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`/json returned ${res.status}`);

      const tabs = (await res.json()) as CEFTab[];

      // Close any existing connections before rediscovering.
      for (const conn of this.connections.values()) {
        try {
          conn.client.close();
        } catch {
          /* already closed */
        }
      }
      this.connections.clear();
      this.bpmRenderKeys = [];

      const sharedJSNames = [
        "SharedJSContext",
        "Steam Shared Context presented by Valve™",
        "SP",
        "Steam",
      ];
      const exactTargets = [...sharedJSNames, "Steam Big Picture Mode"];
      // Steam splits the BPM UI across the parent `Steam Big Picture
      // Mode` tab and per-session `MainMenu_uid<N>` popups; which hosts
      // the visible React UI is build-dependent, so both are candidate
      // render targets.
      const prefixTargets = ["MainMenu"];

      // Tabs we've already opened a socket to this pass — so the store
      // loop below never opens a second WebSocket to a tab that already
      // matched an exact/prefix target (which would orphan one socket
      // from health-check pruning, since the two are stored under
      // different keys).
      const connectedTabIds = new Set<string>();

      for (const tab of tabs) {
        if (!tab.webSocketDebuggerUrl) continue;

        const isExact = exactTargets.includes(tab.title);
        const prefixHit = prefixTargets.find((p) => tab.title.startsWith(p));
        if (!isExact && !prefixHit) continue;

        try {
          const conn = await this._openCDP(tab.webSocketDebuggerUrl, tab.title);
          // Collapse SharedJSContext title variants to one canonical key;
          // MainMenu popups keep their per-session title.
          const key = sharedJSNames.includes(tab.title)
            ? "SharedJSContext"
            : tab.title;
          this.connections.set(key, conn);
          connectedTabIds.add(tab.id);
          if (
            prefixHit === "MainMenu" ||
            tab.title === "Steam Big Picture Mode"
          ) {
            this.bpmRenderKeys.push(key);
          }
          console.log(`[protondb-badges] Connected to: ${tab.title} (key: ${key})`);
        } catch (err) {
          console.warn(`[protondb-badges] Failed to connect to ${tab.title}:`, err);
        }
      }

      // Also connect to Steam store tabs (store.steampowered.com).
      for (const tab of tabs) {
        if (!tab.webSocketDebuggerUrl) continue;
        if (!tab.url.includes("store.steampowered.com")) continue;
        if (connectedTabIds.has(tab.id)) continue;
        try {
          const conn = await this._openCDP(tab.webSocketDebuggerUrl, tab.title);
          this.connections.set(`store:${tab.title}`, conn);
          connectedTabIds.add(tab.id);
          console.log(`[protondb-badges] Connected to store: ${tab.title}`);
        } catch {
          /* store tab optional */
        }
      }

      this.connected =
        this.connections.has("SharedJSContext") ||
        this.bpmRenderKeys.length > 0;
      this._emitState();
      return this.connected;
    } catch {
      this.connected = false;
      return false;
    }
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

  // ─── CSS / JS Injection ─────────────────────────────────────────

  private async _injectCSSToTab(
    conn: CDPConnection,
    styleId: string,
    css: string,
  ): Promise<void> {
    const escaped = css
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .replace(/\$/g, "\\$");
    await this._cdpEvaluate(
      conn,
      `
      (function() {
        var e = document.getElementById("${styleId}");
        if (e) e.remove();
        var s = document.createElement("style");
        s.id = "${styleId}";
        s.dataset.loadoutPlugin = "protondb-badges";
        document.head.appendChild(s);
        s.textContent = \`${escaped}\`;
      })()
    `,
    );
  }

  private async _injectBadgeSystem(): Promise<void> {
    const css = this._generateBadgeCSS();

    // Inject into every candidate BPM render tab — only the visible one
    // composites to the user; hidden tabs update their off-screen DOM
    // harmlessly. See `bpmRenderKeys` for why we fan out.
    const bpmConns = this.bpmRenderKeys
      .map((k) => ({ key: k, conn: this.connections.get(k) }))
      .filter((t) => t.conn && t.conn.client.connected);

    if (bpmConns.length > 0) {
      for (const t of bpmConns) {
        try {
          await this._injectCSSToTab(t.conn!, "protondb-badges-styles", css);
          await this._cdpEvaluate(t.conn!, this._generateBPMScript());
          console.log(`[protondb-badges] Injected badge system into ${t.key}`);
        } catch (err) {
          console.warn(`[protondb-badges] Failed to inject into ${t.key}:`, err);
        }
      }
      if (this.currentAppId) {
        this._pushBadgeDataToBPM(this.currentAppId).catch(() => {});
      }
    } else {
      console.warn(
        "[protondb-badges] No BPM render tab discovered — badge will not appear. Tabs:",
        Array.from(this.connections.keys()).join(", "),
      );
    }

    // Inject into store tabs — fetch the report server-side and embed it
    // at injection time (no fetch() from inside CEF).
    for (const [key, conn] of this.connections) {
      if (!key.startsWith("store:")) continue;
      if (!conn.client.connected) continue;
      try {
        const url = (await this._cdpEvaluate(
          conn,
          "window.location.href",
        )) as string;
        const appIdMatch = url?.match?.(
          /store\.steampowered\.com\/app\/(\d+)/,
        );
        let badgeData: BadgeData | null = null;
        if (appIdMatch) {
          badgeData = {
            appId: appIdMatch[1],
            report: await this.getReport(appIdMatch[1]),
            settings: this.settings,
          };
        }

        await this._injectCSSToTab(conn, "protondb-badges-styles", css);
        await this._cdpEvaluate(conn, this._generateStoreScript(badgeData));
      } catch {
        /* store tab transient — health check will retry */
      }
    }
  }

  private async _removeBadgeSystem(): Promise<void> {
    for (const conn of this.connections.values()) {
      if (!conn.client.connected) continue;
      try {
        await this._cdpEvaluate(
          conn,
          `
          if (window.__protondb_badges) window.__protondb_badges.cleanup();
          if (window.__protondb_store_badges) window.__protondb_store_badges.cleanup();
          var s = document.getElementById("protondb-badges-styles"); if (s) s.remove();
        `,
        );
      } catch {
        /* best effort */
      }
    }
  }

  // ─── Badge CSS ──────────────────────────────────────────────────

  private _generateBadgeCSS(): string {
    return `
/* ProtonDB Badges - loadout */
#protondb-badge-container {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  pointer-events: auto;
  transition: filter 0.2s, transform 0.2s;
}
#protondb-badge-container:hover {
  filter: brightness(1.12);
}
#protondb-badge-container .pdb-inner {
  display: flex;
  align-items: center;
  gap: 8px;
}
#protondb-badge-container .pdb-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 6px;
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  box-shadow: 0 2px 10px rgba(0,0,0,0.35);
  background: rgba(14,20,27,0.9);
  backdrop-filter: blur(8px);
}
#protondb-badge-container .pdb-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  box-shadow: 0 1px 4px rgba(0,0,0,0.5);
}
#protondb-badge-container .pdb-dot-label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #fff;
  background: rgba(14,20,27,0.9);
  padding: 3px 8px;
  border-radius: 5px;
  opacity: 0;
  transition: opacity 0.15s;
}
#protondb-badge-container.pdb-show-label .pdb-dot-label,
#protondb-badge-container:hover .pdb-dot-label {
  opacity: 1;
}
#protondb-badge-container .pdb-submit {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #fff;
  background: rgba(26,159,255,0.92);
  padding: 5px 9px;
  border-radius: 5px;
  cursor: pointer;
  box-shadow: 0 2px 10px rgba(0,0,0,0.35);
}
#protondb-badge-container .pdb-submit:hover { filter: brightness(1.12); }
`;
  }

  // ─── Big Picture Mode Badge Script ──────────────────────────────

  /**
   * Passive renderer injected into the BPM / SharedJSContext tab(s). It
   * does NOT fetch — the backend pushes data via
   * `window.__protondb_badges.updateBadge(data)`. Exposes the exact
   * surface the source plugin used:
   *   `{ updateBadge, removeBadge, cleanup }`.
   */
  private _generateBPMScript(): string {
    return `
(function() {
  if (window.__protondb_badges) window.__protondb_badges.cleanup();

  var TIER_INFO = {
    platinum: { label: "Platinum", color: "#b4c7dc", text: "#1a1a1a" },
    gold:     { label: "Gold",     color: "#cfb53b", text: "#1a1a1a" },
    silver:   { label: "Silver",   color: "#a6a6a6", text: "#1a1a1a" },
    bronze:   { label: "Bronze",   color: "#cd7f32", text: "#1a1a1a" },
    borked:   { label: "Borked",   color: "#ff5c5c", text: "#1a1a1a" },
    pending:  { label: "Pending",  color: "#6b7280", text: "#ffffff" }
  };

  var badgeEl = null;

  function removeBadge() {
    if (badgeEl) { badgeEl.remove(); badgeEl = null; }
  }

  function positionStyle(container, position) {
    var p = position || "tl";
    container.style.position = "fixed";
    container.style.zIndex = "99999";
    if (p[0] === "t") container.style.top = "60px"; else container.style.bottom = "60px";
    if (p[1] === "l") container.style.left = "20px";
    else if (p[1] === "m") { container.style.left = "50%"; container.style.transform = "translateX(-50%)"; }
    else container.style.right = "20px";
  }

  function createBadge(data) {
    var settings = data.settings || {};
    var report = data.report;
    if (!settings.enableLibraryBadge || !report || !report.tier) { removeBadge(); return; }

    var tier = String(report.tier).toLowerCase();
    var info = TIER_INFO[tier] || { label: tier, color: "#6b7280", text: "#ffffff" };

    removeBadge();

    var container = document.createElement("div");
    container.id = "protondb-badge-container";
    container.style.cursor = "pointer";
    positionStyle(container, settings.position);

    var inner = document.createElement("div");
    inner.className = "pdb-inner";

    var size = settings.size || "regular";
    if (size === "minimalist") {
      var dot = document.createElement("span");
      dot.className = "pdb-dot";
      dot.style.background = info.color;
      inner.appendChild(dot);

      var hover = settings.labelOnHover || "off";
      if (hover !== "off") {
        var dlabel = document.createElement("span");
        dlabel.className = "pdb-dot-label";
        dlabel.textContent = info.label;
        if (hover === "regular") dlabel.style.fontSize = "13px";
        inner.appendChild(dlabel);
      }
    } else {
      var pill = document.createElement("span");
      pill.className = "pdb-pill";
      pill.style.background = info.color;
      pill.style.color = info.text;
      if (size === "small") {
        pill.style.fontSize = "11px";
        pill.style.padding = "4px 9px";
      }
      pill.textContent = info.label;
      inner.appendChild(pill);
    }

    if (settings.showSubmitButton && data.appId) {
      var submit = document.createElement("span");
      submit.className = "pdb-submit";
      submit.textContent = "Submit";
      submit.addEventListener("click", function(ev) {
        ev.stopPropagation();
        window.open("https://www.protondb.com/app/" + data.appId, "_blank");
      });
      inner.appendChild(submit);
    }

    container.appendChild(inner);
    container.addEventListener("click", function() {
      if (data.appId) window.open("https://www.protondb.com/app/" + data.appId, "_blank");
    });

    document.body.appendChild(container);
    badgeEl = container;
  }

  window.__protondb_badges = {
    cleanup: function() { removeBadge(); },
    removeBadge: function() { removeBadge(); },
    updateBadge: function(data) {
      if (!data) { removeBadge(); return; }
      createBadge(data);
    }
  };
})();
`;
  }

  // ─── Store Badge Script ─────────────────────────────────────────

  /**
   * Store-page badge script with data embedded at injection time (no
   * HTTP fetch from inside CEF). Exposes
   * `window.__protondb_store_badges = { updateBadge, removeBadge, cleanup }`.
   */
  private _generateStoreScript(badgeData: BadgeData | null): string {
    const settingsJson = JSON.stringify(this.settings);
    const dataJson = badgeData ? JSON.stringify(badgeData) : "null";
    return `
(function() {
  if (window.__protondb_store_badges) window.__protondb_store_badges.cleanup();

  var SETTINGS = ${settingsJson};
  var BADGE_DATA = ${dataJson};

  var TIER_INFO = {
    platinum: { label: "Platinum", color: "#b4c7dc", text: "#1a1a1a" },
    gold:     { label: "Gold",     color: "#cfb53b", text: "#1a1a1a" },
    silver:   { label: "Silver",   color: "#a6a6a6", text: "#1a1a1a" },
    bronze:   { label: "Bronze",   color: "#cd7f32", text: "#1a1a1a" },
    borked:   { label: "Borked",   color: "#ff5c5c", text: "#1a1a1a" },
    pending:  { label: "Pending",  color: "#6b7280", text: "#ffffff" }
  };

  var badgeEl = null;
  function removeBadge() { if (badgeEl) { badgeEl.remove(); badgeEl = null; } }

  function showBadge(data) {
    if (!data || !SETTINGS.enableStoreBadge) { removeBadge(); return; }
    var report = data.report;
    if (!report || !report.tier) { removeBadge(); return; }
    removeBadge();

    var tier = String(report.tier).toLowerCase();
    var info = TIER_INFO[tier] || { label: tier, color: "#6b7280", text: "#ffffff" };

    var el = document.createElement("div");
    el.id = "protondb-store-badge";
    el.style.cssText = "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:999999;display:flex;align-items:center;gap:10px;cursor:pointer;font-family:sans-serif;";

    var pill = document.createElement("span");
    pill.style.cssText = "display:inline-flex;align-items:center;padding:8px 16px;border-radius:6px;font-weight:700;font-size:14px;letter-spacing:0.04em;text-transform:uppercase;box-shadow:0 2px 12px rgba(0,0,0,0.4);";
    pill.style.background = info.color;
    pill.style.color = info.text;
    pill.textContent = "ProtonDB: " + info.label;
    el.appendChild(pill);

    if (SETTINGS.showSubmitButton && data.appId) {
      var submit = document.createElement("span");
      submit.style.cssText = "font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#fff;background:rgba(26,159,255,0.92);padding:6px 11px;border-radius:5px;box-shadow:0 2px 12px rgba(0,0,0,0.4);";
      submit.textContent = "Submit";
      submit.addEventListener("click", function(ev) {
        ev.stopPropagation();
        window.open("https://www.protondb.com/app/" + data.appId, "_blank");
      });
      el.appendChild(submit);
    }

    el.addEventListener("click", function() {
      if (data.appId) window.open("https://www.protondb.com/app/" + data.appId, "_blank");
    });
    document.body.appendChild(el);
    badgeEl = el;
  }

  if (BADGE_DATA) showBadge(BADGE_DATA);

  window.__protondb_store_badges = {
    cleanup: function() { removeBadge(); },
    removeBadge: function() { removeBadge(); },
    updateBadge: function(data) { showBadge(data); }
  };
})();
`;
  }

  // ─── Health Check ───────────────────────────────────────────────

  private async _checkHealth(): Promise<void> {
    if (this.healthChecking) return;
    this.healthChecking = true;
    try {
      for (const [key, conn] of this.connections) {
        if (!conn.client.connected) {
          this.connections.delete(key);
          this.bpmRenderKeys = this.bpmRenderKeys.filter((k) => k !== key);
          console.log(`[protondb-badges] Pruned dead connection: ${key}`);
        }
      }

      const wasConnected = this.connected;
      this.connected =
        this.connections.has("SharedJSContext") ||
        this.bpmRenderKeys.length > 0;

      if (!this.connected || this.bpmRenderKeys.length === 0) {
        if (wasConnected && !this.connected) this._emitState();
        // Re-run discovery so a reopened BPM (new MainMenu popup set) or
        // a freshly-started Steam reconnects without a manual nudge.
        const ok = await this._tryConnect();
        if (ok) await this._injectBadgeSystem();
      }
    } finally {
      this.healthChecking = false;
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
        settings: this.settings,
        connected: this.connected,
        tabs: this.connections.size,
      },
    });
  }
}
