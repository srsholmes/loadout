import type { PluginBackend, EmitPayload } from "@loadout/types";
import {
  listInstalledGames,
  type InstalledGame,
} from "@loadout/steam-paths";
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
 * Exposes the ProtonDB compatibility tier (plus a few Steam-store
 * side fetches: per-title Linux support, free-text search) as RPC
 * methods consumed by `app.tsx`. The grid view in the overlay fans
 * out one `getReport` call per installed game, so the backend caps
 * concurrent ProtonDB requests at 4 (cache hits skip the queue) to
 * avoid 429s from a 100+ game library.
 *
 * Settings persist via `@loadout/plugin-storage` at
 * `~/.config/loadout/plugins/protondb-badges.json`. API responses
 * persist via the inlined `lib/external-cache.ts` TTL disk cache at
 * `~/.cache/loadout/protondb-badges/`.
 *
 * **Removed vs source steam-loader plugin**: the source also did
 * CEF-side badge injection into Steam Big Picture Mode via the
 * `@steam-loader/steam-cdp` `CDPClient`. That helper isn't exposed
 * to Loadout plugins (no public package; lives in `apps/loadout/`),
 * and Steam-CEF panel injection is the responsibility of
 * `target: { type: "panel" }` + `patches[]` in loadout — a
 * fundamentally different mechanism. The native overlay UI is the
 * primary surface in loadout, so the migration drops the CEF-side
 * badge renderer; the overlay's `app.tsx` (library grid + home
 * widget) carries the user-facing functionality.
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

  // ─── Lifecycle ──────────────────────────────────────────────────

  async onLoad(): Promise<void> {
    console.log("[protondb-badges] Plugin loaded");
    await this._loadSettings();
  }

  async onUnload(): Promise<void> {
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
  }

  // ─── RPC: CEF status (stubs) ────────────────────────────────────
  // The source plugin also drove CEF-side badge injection (Big Picture
  // Mode + Steam store tabs) via CDP. That mechanism doesn't exist in
  // Loadout yet — a future panel-target migration would re-add it.
  // These stubs let the existing settings UI render its "Steam CEF"
  // status section without errors; users see "Disconnected" and the
  // Reconnect button is a no-op.

  async getStatus(): Promise<{ connected: boolean; tabs: number }> {
    return { connected: false, tabs: 0 };
  }

  async reconnect(): Promise<{ success: boolean; error?: string }> {
    return {
      success: false,
      error: "Steam CEF injection is not yet supported in Loadout",
    };
  }

  async getCurrentRouteAppId(): Promise<string | null> {
    return null;
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
      data: { settings: this.settings },
    });
  }
}
