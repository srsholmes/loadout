import type { PluginBackend, EmitPayload } from "@loadout/types";
import {
  listInstalledGames,
  type InstalledGame,
} from "@loadout/steam-paths";
import { SteamCefBadgeInjector } from "@loadout/steam-cef-badges";
import {
  SteamClientUnreachableError,
  withSteamClient,
} from "@loadout/steam-cdp";
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

// ─── Constants ──────────────────────────────────────────────────────

const PLUGIN_ID = "protondb-badges";

/** In-memory hot-path TTL. Disk cache outlives the process; this map
 *  just skips the disk RTT for reads in the same session. */
const CACHE_TTL = 30 * 60 * 1000;

/** TTL in seconds for the disk cache. Longer window (24 h) than the
 *  in-memory map (30 min) so a freshly-restarted loader doesn't cold-
 *  start by re-fetching every report when warm data is on disk. */
const DISK_CACHE_TTL_SEC = 24 * 60 * 60;

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

  /** Shared Steam-CEF badge-injection lifecycle (connection discovery,
   *  BPM render-tab fan-out, health check, route polling, push coalescing,
   *  Gaming-Mode gating). Constructed in onLoad. See
   *  `@loadout/steam-cef-badges`. */
  private injector!: SteamCefBadgeInjector<BadgeData>;

  // ─── Lifecycle ──────────────────────────────────────────────────

  async onLoad(): Promise<void> {
    console.log("[protondb-badges] Plugin loaded");
    await this._loadSettings();

    this.injector = new SteamCefBadgeInjector<BadgeData>({
      pluginId: PLUGIN_ID,
      styleId: "protondb-badges-styles",
      bpmGlobalName: "__protondb_badges",
      storeGlobalName: "__protondb_store_badges",
      css: this._generateBadgeCSS(),
      bpmScript: this._generateBPMScript(),
      buildStoreScript: (d) => this._generateStoreScript(d),
      // Report only — the injected runtime never reads Linux-support, so
      // don't pay the rate-limited checkLinuxSupport on every navigation
      // (see the BadgeData doc comment).
      fetchBadgeData: async (appId) => ({
        appId,
        report: await this.getReport(appId),
        settings: this.settings,
      }),
      buildBpmUpdateExpr: (d) =>
        d
          ? `if (window.__protondb_badges) window.__protondb_badges.updateBadge(${JSON.stringify(d)});`
          : `if (window.__protondb_badges) window.__protondb_badges.removeBadge();`,
      onStateChange: () => this._emitState(),
    });
    void this.injector.start();
  }

  async onUnload(): Promise<void> {
    await this.injector?.stop();

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

  /**
   * Enumerate the user's *entire owned* Steam library (not just the
   * installed titles) by reading `window.appStore.allApps` from Steam's
   * SharedJSContext tab over CDP. Unlike `listInstalledGames`, this
   * reaches owned-but-not-installed games — there's no
   * `appmanifest_*.acf` on disk for those, so the CDP read is the only
   * source.
   *
   * Returns the same `{ appId, name }` shape as `listInstalledGames`,
   * sorted alphabetically by name so the grid order is stable. Throws
   * `SteamClientUnreachableError` (surfaced to the overlay) when Steam
   * isn't reachable on its CDP port — the overlay then falls back to
   * the installed list.
   */
  async listAllGames(): Promise<InstalledGame[]> {
    const apps = await withSteamClient((sc) => sc.apps.getAllApps());
    return apps
      .map((a) => ({ appId: a.appId, name: a.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Open a game in the Steam UI and navigate to its ProtonDB page —
   * the same destination the injected library/store badge reaches when
   * clicked. Invoked from the overlay grid after the overlay hides
   * itself, so the user lands on the Steam app's details page with the
   * ProtonDB site open in Steam's in-client browser.
   *
   * Two steps through one serialised `withSteamClient` session:
   *   1. `steam://nav/games/details/<appId>` — focuses the game's
   *      details page in the Steam UI.
   *   2. `window.open("https://www.protondb.com/app/<appId>")` — opens
   *      ProtonDB in Steam's built-in browser, mirroring the badge's
   *      own `window.open` exactly.
   */
  async openProtonDb({ appId }: { appId: string }): Promise<void> {
    if (typeof appId !== "string" || appId.length === 0) {
      throw new Error("openProtonDb: appId must be a non-empty string");
    }
    try {
      await withSteamClient(async (sc) => {
        await sc.url.executeSteamURL(`steam://nav/games/details/${appId}`);
        await sc.url.openWebUrl(`https://www.protondb.com/app/${appId}`);
      });
    } catch (err) {
      if (err instanceof SteamClientUnreachableError) {
        console.warn(
          `[protondb-badges] openProtonDb: Steam unreachable for ${appId}: ${err.message}`,
        );
      } else {
        console.error(
          `[protondb-badges] openProtonDb failed for ${appId}:`,
          err,
        );
      }
      throw err;
    }
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

    // Re-inject so style/position/toggle changes show live on the Steam
    // side (debounced inside the injector so dragging a control doesn't
    // peg the CDP bridge).
    this.injector?.reinjectDebounced();
  }

  // ─── RPC: Steam-CEF status ──────────────────────────────────────

  async getStatus(): Promise<{ connected: boolean; tabs: number }> {
    return this.injector?.getStatus() ?? { connected: false, tabs: 0 };
  }

  async reconnect(): Promise<{ success: boolean; error?: string }> {
    if (!this.injector) return { success: false, error: "Not initialized" };
    return this.injector.reconnect();
  }

  /**
   * appId of the game page currently viewed in Steam BPM (route-derived,
   * NOT the running game). Mirrors hltb's route polling; will fold into a
   * `__core:game-detection` subscribe once that lands for backends.
   */
  async getCurrentRouteAppId(): Promise<string | null> {
    return this.injector?.getCurrentAppId() ?? null;
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
    const { connected, tabs } = this.injector?.getStatus() ?? {
      connected: false,
      tabs: 0,
    };
    this.emit?.({
      event: "stateChanged",
      data: { settings: this.settings, connected, tabs },
    });
  }
}
