import type { PluginBackend, EmitPayload } from "@loadout/types";
import {
  listInstalledGames,
  type InstalledGame,
} from "@loadout/steam-paths";
import { CDPClient } from "@loadout/steam-cdp";
import { createExternalCache } from "@loadout/external-cache";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

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

/** Default per-request timeout. Used to be inline at every cdpSend call. */
const CDP_TIMEOUT_MS = 5000;

// ─── Constants ──────────────────────────────────────────────────────

const CACHE_TTL = 30 * 60 * 1000;
/** TTL in seconds for the disk cache. The disk cache outlives the
 *  process; we use a longer window than the in-memory map (24h vs
 *  30min) so a freshly-restarted loader doesn't cold-start by
 *  re-fetching every report when warm data is sitting on disk. */
const DISK_CACHE_TTL_SEC = 24 * 60 * 60;
const DEBUG_PORT = 8080;
const DATA_DIR = join(homedir(), ".config", "loadout", "protondb-badges");
const SETTINGS_PATH = join(DATA_DIR, "settings.json");

const PLUGIN_ID = "protondb-badges";

const DEFAULT_SETTINGS: ProtonDBSettings = {
  size: "regular",
  position: "tl",
  labelOnHover: "off",
  showSubmitButton: false,
  enableLibraryBadge: true,
  enableStoreBadge: true,
};

// ─── Backend Class ──────────────────────────────────────────────────

export default class ProtonDBBadgesBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;

  private reportCache = new Map<string, CacheEntry<ProtonDBReport | null>>();
  private searchCache = new Map<string, CacheEntry<SteamSearchResult[]>>();
  private linuxCache = new Map<string, CacheEntry<boolean>>();

  /** Disk-backed cache for ProtonDB / Steam-search / Linux-support
   *  responses. The in-memory Maps above stay as the hot-path cache
   *  (skip the disk RTT for reads inside the same session); the disk
   *  cache makes responses persist across loader restarts so we don't
   *  re-pay the network on every cold start.
   *
   *  All disk-cache writes go through `safeDiskSet` so a transient
   *  filesystem error (e.g. read-only /home, permissions glitch
   *  during a Bazzite update) can't poison the network-result
   *  return path — we'd rather lose the persistence and fall back
   *  to in-memory than throw an upstream "couldn't fetch" to the
   *  badge UI. */
  private diskCache = createExternalCache(PLUGIN_ID);

  private async safeDiskSet<T>(
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

  private async safeDiskGet<T>(key: string): Promise<T | undefined> {
    try {
      return await this.diskCache.get<T>(key);
    } catch {
      return undefined;
    }
  }

  private settings: ProtonDBSettings = { ...DEFAULT_SETTINGS };

  /** CDP connections keyed by tab title */
  private connections = new Map<string, CDPConnection>();
  private connected = false;
  private healthInterval?: Timer;
  private urlPollInterval?: Timer;

  /** Current appId derived from SharedJSContext URL */
  private currentAppId: string | null = null;

  /** Track appIds per store tab so we only push on change */
  private storeTabAppIds = new Map<string, string | null>();

  /**
   * Concurrency limiter for ProtonDB report fetches. The library-grid
   * view fans out one `getReport` call per installed game (routinely
   * 100+); without throttling, ProtonDB will start 429-ing or
   * intermittently failing. Cap at 4 in flight at a time. Cache hits
   * skip the queue entirely.
   */
  private inflightLookups = 0;
  private lookupQueue: Array<() => void> = [];
  private static readonly MAX_CONCURRENT_LOOKUPS = 4;

  private async withLookupSlot<T>(fn: () => Promise<T>): Promise<T> {
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

  // ─── Lifecycle ──────────────────────────────────────────────────

  async onLoad(): Promise<void> {
    console.log("[protondb-badges] Plugin loaded");
    await this.loadSettings();

    this.tryConnect()
      .then((ok) => {
        if (ok) this.injectBadgeSystem();
      })
      .catch(() => {
        console.log("[protondb-badges] Steam CEF not available yet, will retry");
      });

    this.healthInterval = setInterval(() => this.checkHealth(), 5000);

    // Poll SharedJSContext URL to track current appId
    this.urlPollInterval = setInterval(() => this.pollCurrentAppId(), 500);
  }

  async onUnload(): Promise<void> {
    clearInterval(this.healthInterval);
    clearInterval(this.urlPollInterval);
    await this.removeBadgeSystem();

    for (const conn of this.connections.values()) {
      try { conn.client.close(); } catch {}
    }
    this.connections.clear();
    this.connected = false;

    this.reportCache.clear();
    this.searchCache.clear();
    this.linuxCache.clear();
    this.storeTabAppIds.clear();
    console.log("[protondb-badges] Plugin unloaded");
  }

  // ─── RPC: ProtonDB Data ─────────────────────────────────────────

  async getReport(appId: string): Promise<ProtonDBReport | null> {
    const cached = this.reportCache.get(appId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;

    return this.withLookupSlot(async () => {
      // Re-check the cache once we've actually entered the slot — a
      // sibling caller may have populated it while we were queued.
      const recached = this.reportCache.get(appId);
      if (recached && Date.now() - recached.timestamp < CACHE_TTL) {
        return recached.data;
      }

      // Disk cache lookup before paying the network. Hits hydrate the
      // in-memory Map so subsequent same-session reads stay hot.
      const fromDisk = await this.safeDiskGet<ProtonDBReport | null>(
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
            await this.safeDiskSet(
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
        await this.safeDiskSet(`report:${appId}`, report, DISK_CACHE_TTL_SEC);
        return report;
      } catch (err) {
        console.error(`[protondb-badges] Failed to fetch report for ${appId}:`, err);
        // Don't cache transient errors — let the next mount retry.
        return null;
      }
    });
  }

  /**
   * Enumerate the user's installed Steam games via the shared
   * `@loadout/steam-paths` helper. Returns `{appId, name}`
   * pairs sorted alphabetically by name. The library-grid view in
   * the plugin UI uses this as its source of truth — no ProtonDB
   * calls happen here, just disk reads of `appmanifest_*.acf`.
   */
  async listInstalledGames(): Promise<InstalledGame[]> {
    return listInstalledGames();
  }

  async searchGames(query: string): Promise<SteamSearchResult[]> {
    if (!query || query.trim().length === 0) return [];

    const cacheKey = query.toLowerCase().trim();
    const cached = this.searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;

    // Disk cache lookup before paying the network. Hits hydrate the
    // in-memory map for the rest of the session.
    const fromDisk = await this.safeDiskGet<SteamSearchResult[]>(
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
      await this.safeDiskSet(`search:${cacheKey}`, results, DISK_CACHE_TTL_SEC);
      return results;
    } catch (err) {
      console.error("[protondb-badges] Steam search failed:", err);
      throw err;
    }
  }

  async checkLinuxSupport(appId: string): Promise<boolean> {
    const cached = this.linuxCache.get(appId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;

    // Disk cache lookup before the network.
    const fromDisk = await this.safeDiskGet<boolean>(`linux:${appId}`);
    if (fromDisk !== undefined) {
      this.linuxCache.set(appId, { data: fromDisk, timestamp: Date.now() });
      return fromDisk;
    }

    try {
      const res = await fetch(`https://store.steampowered.com/api/appdetails/?appids=${appId}`);
      if (!res.ok) return false;
      const data = await res.json();
      const hasLinux = !!(data[appId]?.data?.platforms?.linux);
      this.linuxCache.set(appId, { data: hasLinux, timestamp: Date.now() });
      await this.safeDiskSet(`linux:${appId}`, hasLinux, DISK_CACHE_TTL_SEC);
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
   * Loader-broadcast entry point for the global "Clear all data
   * caches" button on the Settings page. Same effect as `clearCache`
   * — kept under a distinct, broadcast-safe name so the loader's
   * `__broadcast` fan-out only hits plugins that intentionally
   * implement it (we don't want to nuke an unrelated plugin's
   * `clearCache` that happens to share the name and means something
   * different — e.g. the ROM cache in a hypothetical emulator
   * plugin).
   */
  async clearExternalCache(): Promise<void> {
    await this.clearCache();
  }

  /**
   * Get the appId from the current Steam route URL (the game page being
   * viewed in BPM), NOT the actually-running game. Will be replaced by
   * a `__core:game-detection` subscribe once E-004 lands.
   */
  async getCurrentRouteAppId(): Promise<string | null> {
    return this.currentAppId;
  }

  /** Get badge data in one call (report + linux support) */
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
    await this.saveSettings();
    if (this.connected) await this.injectBadgeSystem();
    this.emitState();
  }

  // ─── RPC: Status ────────────────────────────────────────────────

  async getStatus(): Promise<{
    connected: boolean;
    tabs: number;
  }> {
    return {
      connected: this.connected,
      tabs: this.connections.size,
    };
  }

  async reconnect(): Promise<{ success: boolean; error?: string }> {
    for (const conn of this.connections.values()) {
      try { conn.client.close(); } catch {}
    }
    this.connections.clear();
    this.connected = false;
    this.storeTabAppIds.clear();

    const ok = await this.tryConnect();
    if (ok) {
      await this.injectBadgeSystem();
      this.emitState();
      return { success: true };
    }
    return { success: false, error: "Could not connect to Steam CEF" };
  }

  // ─── URL Polling (SharedJSContext) ──────────────────────────────

  private async pollCurrentAppId(): Promise<void> {
    const conn = this.connections.get("SharedJSContext");
    if (!conn || !conn.client.connected) return;

    try {
      const url = (await this.cdpEvaluate(conn, "window.location.href")) as string;
      const match = url?.match?.(/\/(?:routes\/)?library\/app\/(\d+)/);
      const newAppId = match ? match[1] : null;
      const prevAppId = this.currentAppId;
      this.currentAppId = newAppId;

      // Push badge data to BPM when appId changes
      if (newAppId !== prevAppId) {
        await this.pushBadgeToBPM(newAppId);
      }

      // Also poll store tabs for URL changes and push data
      await this.pollStoreTabs();
    } catch {
      // Ignore — will retry next tick
    }
  }

  /** Push badge data (or removal) to the BPM tab via CDP */
  private async pushBadgeToBPM(appId: string | null): Promise<void> {
    const bpm = this.connections.get("Steam Big Picture Mode");
    if (!bpm || !bpm.client.connected) return;

    try {
      if (!appId) {
        await this.cdpEvaluate(bpm, `
          if (window.__protondb_badges) window.__protondb_badges.removeBadge();
        `);
        return;
      }

      const data = await this.getBadgeData(appId);
      const dataJson = JSON.stringify({ ...data, appId });
      await this.cdpEvaluate(bpm, `
        if (window.__protondb_badges) window.__protondb_badges.updateBadge(${dataJson});
      `);
    } catch (err) {
      console.warn("[protondb-badges] Failed to push badge to BPM:", err);
    }
  }

  /** Poll store tabs for URL changes and push badge data via CDP */
  private async pollStoreTabs(): Promise<void> {
    for (const [key, conn] of this.connections) {
      if (!key.startsWith("store:")) continue;
      if (!conn.client.connected) continue;

      try {
        const url = (await this.cdpEvaluate(conn, "window.location.href")) as string;
        const match = url?.match?.(/store\.steampowered\.com\/app\/(\d+)/);
        const appId = match ? match[1] : null;
        const prevAppId = this.storeTabAppIds.get(key) ?? null;

        if (appId !== prevAppId) {
          this.storeTabAppIds.set(key, appId);
          if (!appId || !this.settings.enableStoreBadge) {
            await this.cdpEvaluate(conn, `
              if (window.__protondb_store_badges) window.__protondb_store_badges.removeBadge();
            `);
          } else {
            const report = await this.getReport(appId);
            if (report) {
              const dataJson = JSON.stringify({ report, appId });
              await this.cdpEvaluate(conn, `
                if (window.__protondb_store_badges) window.__protondb_store_badges.updateBadge(${dataJson});
              `);
            }
          }
        }
      } catch {
        // Ignore — will retry next tick
      }
    }
  }

  // ─── CDP Infrastructure ─────────────────────────────────────────

  private async tryConnect(): Promise<boolean> {
    try {
      const res = await fetch(`http://localhost:${DEBUG_PORT}/json`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`/json returned ${res.status}`);

      const tabs = (await res.json()) as CEFTab[];

      // Close existing
      for (const conn of this.connections.values()) {
        try { conn.client.close(); } catch {}
      }
      this.connections.clear();

      // We need: SharedJSContext (for URL tracking) and Steam Big Picture Mode (for badge rendering)
      const sharedJSNames = [
        "SharedJSContext",
        "Steam Shared Context presented by Valve\u2122",
        "SP",
        "Steam",
      ];
      const targetTitles = [...sharedJSNames, "Steam Big Picture Mode"];

      for (const tab of tabs) {
        if (!tab.webSocketDebuggerUrl) continue;
        if (!targetTitles.includes(tab.title)) continue;

        try {
          const conn = await this.openCDP(tab.webSocketDebuggerUrl, tab.title);
          // Normalize SharedJSContext variants to canonical key
          const key = sharedJSNames.includes(tab.title) ? "SharedJSContext" : tab.title;
          this.connections.set(key, conn);
          console.log(`[protondb-badges] Connected to: ${tab.title} (key: ${key})`);
        } catch (err) {
          console.warn(`[protondb-badges] Failed to connect to ${tab.title}:`, err);
        }
      }

      // Also connect to store tabs
      for (const tab of tabs) {
        if (!tab.webSocketDebuggerUrl) continue;
        if (!tab.url.includes("store.steampowered.com")) continue;
        try {
          const conn = await this.openCDP(tab.webSocketDebuggerUrl, tab.title);
          this.connections.set(`store:${tab.title}`, conn);
          console.log(`[protondb-badges] Connected to store: ${tab.title}`);
        } catch {}
      }

      this.connected = this.connections.has("SharedJSContext") ||
                        this.connections.has("Steam Big Picture Mode");
      this.emitState();
      return this.connected;
    } catch {
      this.connected = false;
      return false;
    }
  }

  private async openCDP(wsUrl: string, tabTitle: string): Promise<CDPConnection> {
    const client = new CDPClient(wsUrl);
    await client.connect();
    return { client, tabTitle };
  }

  private cdpEvaluate(conn: CDPConnection, expression: string): Promise<unknown> {
    return conn.client.evaluate(expression, { timeoutMs: CDP_TIMEOUT_MS });
  }

  // ─── CSS/JS Injection ───────────────────────────────────────────

  private async injectCSSToTab(conn: CDPConnection, styleId: string, css: string): Promise<void> {
    const escaped = css.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");
    await this.cdpEvaluate(conn, `
      (function() {
        var e = document.getElementById("${styleId}");
        if (e) e.remove();
        var s = document.createElement("style");
        s.id = "${styleId}";
        s.dataset.steamLoaderPlugin = "protondb-badges";
        document.head.appendChild(s);
        s.textContent = \`${escaped}\`;
      })()
    `);
  }

  private async injectBadgeSystem(): Promise<void> {
    const css = this.generateBadgeCSS();

    // Inject CSS + badge script into Big Picture Mode (the visible window)
    const bpm = this.connections.get("Steam Big Picture Mode");
    if (bpm && bpm.client.connected) {
      try {
        await this.injectCSSToTab(bpm, "protondb-badges-styles", css);
        await this.cdpEvaluate(bpm, this.generateBPMScript());
        console.log("[protondb-badges] Injected badge system into Big Picture Mode");

        // Push current badge data immediately if we already know the appId
        if (this.currentAppId) {
          await this.pushBadgeToBPM(this.currentAppId);
        }
      } catch (err) {
        console.warn("[protondb-badges] Failed to inject into BPM:", err);
      }
    }

    // Inject store badge into store tabs
    for (const [key, conn] of this.connections) {
      if (!key.startsWith("store:")) continue;
      if (!conn.client.connected) continue;
      try {
        await this.injectCSSToTab(conn, "protondb-badges-styles", css);
        await this.cdpEvaluate(conn, this.generateStoreScript());
        // Reset tracked appId so pollStoreTabs will push data on next tick
        this.storeTabAppIds.delete(key);
      } catch {}
    }
  }

  private async removeBadgeSystem(): Promise<void> {
    for (const conn of this.connections.values()) {
      if (!conn.client.connected) continue;
      try {
        await this.cdpEvaluate(conn, `
          if(window.__protondb_badges) window.__protondb_badges.cleanup();
          if(window.__protondb_store_badges) window.__protondb_store_badges.cleanup();
          var s=document.getElementById("protondb-badges-styles"); if(s)s.remove();
        `);
      } catch {}
    }
  }

  // ─── Badge CSS ──────────────────────────────────────────────────

  private generateBadgeCSS(): string {
    return `
/* ProtonDB Badges - loadout */
#protondb-badges-container {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  pointer-events: auto;
  transition: filter 0.2s, outline 0.2s;
}
#protondb-badges-container:hover {
  filter: brightness(1.3);
  outline: 2px solid rgba(0,0,0,0.8);
}
#protondb-badges-container .protondb-badge-inner {
  display: flex; align-items: center;
}

/* Regular */
#protondb-badges-container.protondb-size-regular .protondb-icon { width: 28px; height: 28px; display: flex; align-items: center; }
#protondb-badges-container.protondb-size-regular .protondb-icon svg { width: 28px; height: 28px; }
#protondb-badges-container.protondb-size-regular .protondb-badge-inner { padding: 6px 18px; }
#protondb-badges-container.protondb-size-regular .protondb-label {
  margin-left: 10px; font-size: 24px; line-height: 24px; white-space: nowrap; font-weight: 500;
}

/* Small */
#protondb-badges-container.protondb-size-small .protondb-icon { width: 20px; height: 20px; display: flex; align-items: center; }
#protondb-badges-container.protondb-size-small .protondb-icon svg { width: 20px; height: 20px; }
#protondb-badges-container.protondb-size-small .protondb-badge-inner { padding: 6px 8px; }
#protondb-badges-container.protondb-size-small .protondb-label {
  margin-left: 6px; font-size: 12px; line-height: 12px; white-space: nowrap; font-weight: 500;
}

/* Minimalist */
#protondb-badges-container.protondb-size-minimalist .protondb-icon { width: 20px; height: 20px; display: flex; align-items: center; }
#protondb-badges-container.protondb-size-minimalist .protondb-icon svg { width: 20px; height: 20px; }
#protondb-badges-container.protondb-size-minimalist .protondb-badge-inner { padding: 6px; }
#protondb-badges-container.protondb-size-minimalist .protondb-label {
  display: none; margin-left: 10px; white-space: nowrap; font-weight: 500;
}
#protondb-badges-container.protondb-size-minimalist.protondb-hover-small:hover .protondb-label {
  display: inline; font-size: 12px; line-height: 12px;
}
#protondb-badges-container.protondb-size-minimalist.protondb-hover-small:hover .protondb-badge-inner {
  padding: 6px 8px;
}
#protondb-badges-container.protondb-size-minimalist.protondb-hover-regular:hover .protondb-label {
  display: inline; font-size: 24px; line-height: 24px;
}
#protondb-badges-container.protondb-size-minimalist.protondb-hover-regular:hover .protondb-badge-inner {
  padding: 6px 18px;
}

/* Tux */
#protondb-badges-container .protondb-tux {
  display: flex; align-items: center; background: #1a1a2e; padding: 6px; color: #fff;
}
#protondb-badges-container.protondb-size-regular .protondb-tux svg { width: 28px; height: 28px; }
#protondb-badges-container.protondb-size-small .protondb-tux svg { width: 20px; height: 20px; }
#protondb-badges-container.protondb-size-minimalist .protondb-tux svg { width: 20px; height: 20px; }

/* Submit */
#protondb-badges-container .protondb-submit {
  display: flex; align-items: center; background: rgba(166,166,166,0.9);
  padding: 6px 10px; color: #000; font-size: 14px; font-weight: 500;
  cursor: pointer; border: none; text-decoration: none;
}
#protondb-badges-container .protondb-submit:hover { background: rgba(180,180,180,1); }

/* Tiers */
.protondb-tier-platinum .protondb-badge-inner { background: rgb(180,199,220); color: #000; }
.protondb-tier-gold .protondb-badge-inner     { background: rgb(207,181,59);  color: #000; }
.protondb-tier-silver .protondb-badge-inner   { background: rgb(166,166,166); color: #000; }
.protondb-tier-bronze .protondb-badge-inner   { background: rgb(205,127,50);  color: #000; }
.protondb-tier-borked .protondb-badge-inner   { background: rgb(255,0,0);     color: #000; }
.protondb-tier-pending .protondb-badge-inner  { background: rgb(68,68,68);    color: #fff; }
`;
  }

  // ─── Big Picture Mode Badge Script ──────────────────────────────
  // This script runs in the VISIBLE Big Picture Mode tab.
  // The backend pushes badge data via CDP — no fetch() from CEF context
  // (which would fail due to mixed content: https://steamloopback.host -> http://localhost).

  private generateBPMScript(): string {
    const settingsJson = JSON.stringify(this.settings);
    return `
(function() {
  if (window.__protondb_badges) window.__protondb_badges.cleanup();

  var currentAppId = null;
  var currentTier = null;
  var badgeEl = null;
  var settings = ${settingsJson};

  var TIER_LABELS = {
    platinum: "Platinum", gold: "Gold", silver: "Silver",
    bronze: "Bronze", borked: "Borked", pending: "Pending"
  };

  function removeBadge() {
    if (badgeEl) { badgeEl.remove(); badgeEl = null; currentTier = null; currentAppId = null; }
  }

  function createBadge(data) {
    var report = data.report;
    if (!report || !settings.enableLibraryBadge) { removeBadge(); return; }

    currentAppId = data.appId || null;
    var tier = (report.tier || "pending").toLowerCase();

    // Skip re-render if same tier and badge exists
    if (badgeEl && currentTier === tier) return;
    removeBadge();
    currentAppId = data.appId || null;
    currentTier = tier;

    var label = TIER_LABELS[tier] || report.tier;

    var container = document.createElement("div");
    container.id = "protondb-badges-container";
    container.className = "protondb-tier-" + tier + " protondb-size-" + (settings.size || "regular");
    if (settings.size === "minimalist" && settings.labelOnHover !== "off") {
      container.className += " protondb-hover-" + settings.labelOnHover;
    }

    // Position
    var p = settings.position || "tl";
    container.style.position = "fixed";
    container.style.zIndex = "99999";
    container.style.display = "flex";
    container.style.alignItems = "center";
    container.style.cursor = "pointer";
    if (p[0] === "t") container.style.top = "60px"; else container.style.bottom = "60px";
    if (p[1] === "l") container.style.left = "20px";
    else if (p[1] === "m") { container.style.left = "50%"; container.style.transform = "translateX(-50%)"; }
    else container.style.right = "20px";

    // SVG icons
    var ATOM_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" style="display:block"><circle cx="12" cy="12" r="2.5"/><g fill="none" stroke="currentColor" stroke-width="1.2"><ellipse cx="12" cy="12" rx="10" ry="3.5"/><ellipse cx="12" cy="12" rx="10" ry="3.5" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="3.5" transform="rotate(-60 12 12)"/></g></svg>';
    var TUX_SVG = '<svg viewBox="0 0 32 32" fill="currentColor" style="display:block"><path d="M16 2c-2.4 0-4.2 1.7-4.8 4-.3 1.2-.2 2.4.2 3.5-2.2 2-3.9 5-3.9 8.5 0 2 .6 3.8 1.6 5.3-.3.5-.6 1.1-.6 1.7 0 1.1.5 2 1.2 2.6.5.4 1.2.6 1.8.6h9c.6 0 1.3-.2 1.8-.6.7-.6 1.2-1.5 1.2-2.6 0-.6-.3-1.2-.6-1.7 1-1.5 1.6-3.3 1.6-5.3 0-3.5-1.7-6.5-3.9-8.5.4-1.1.5-2.3.2-3.5C20.2 3.7 18.4 2 16 2zm-3 8.5c.8 0 1.5.7 1.5 1.5s-.7 1.5-1.5 1.5-1.5-.7-1.5-1.5.7-1.5 1.5-1.5zm6 0c.8 0 1.5.7 1.5 1.5s-.7 1.5-1.5 1.5-1.5-.7-1.5-1.5.7-1.5 1.5-1.5zm-4.5 5h3c0 1.7-.7 3-1.5 3s-1.5-1.3-1.5-3z"/></svg>';

    // Badge inner
    var inner = document.createElement("div");
    inner.className = "protondb-badge-inner";
    var icon = document.createElement("span");
    icon.className = "protondb-icon";
    icon.innerHTML = ATOM_SVG;
    inner.appendChild(icon);
    var labelEl = document.createElement("span");
    labelEl.className = "protondb-label";
    labelEl.textContent = label;
    inner.appendChild(labelEl);
    container.appendChild(inner);

    // Tux
    if (data.linuxSupport) {
      var tux = document.createElement("div");
      tux.className = "protondb-tux";
      tux.innerHTML = TUX_SVG;
      container.appendChild(tux);
    }

    // Submit
    if (settings.showSubmitButton && currentAppId) {
      var submit = document.createElement("a");
      submit.className = "protondb-submit";
      submit.href = "https://www.protondb.com/contribute?appId=" + currentAppId;
      submit.target = "_blank";
      submit.textContent = "Submit";
      submit.addEventListener("click", function(e) { e.stopPropagation(); });
      container.appendChild(submit);
    }

    container.addEventListener("click", function() {
      if (currentAppId) window.open("https://www.protondb.com/app/" + currentAppId, "_blank");
    });

    document.body.appendChild(container);
    badgeEl = container;
  }

  // Backend pushes data via CDP — no polling needed
  window.__protondb_badges = {
    cleanup: function() {
      removeBadge();
    },
    updateBadge: function(data) {
      createBadge(data);
    },
    removeBadge: removeBadge,
    updateSettings: function(newSettings) {
      settings = newSettings;
    }
  };
})();
`;
  }

  // ─── Store Badge Script ─────────────────────────────────────────

  private generateStoreScript(): string {
    return `
(function() {
  if (window.__protondb_store_badges) window.__protondb_store_badges.cleanup();

  var currentAppId = null;
  var badgeEl = null;

  var TIER_LABELS = { platinum:"Platinum", gold:"Gold", silver:"Silver", bronze:"Bronze", borked:"Borked", pending:"Pending" };
  var TIER_COLORS = { platinum:"#b4c7dc", gold:"#cfb53b", silver:"#a6a6a6", bronze:"#cd7f32", borked:"#ff0000", pending:"#444" };
  var TIER_TEXT = { platinum:"#000", gold:"#000", silver:"#000", bronze:"#000", borked:"#000", pending:"#fff" };

  function removeBadge() { if (badgeEl) { badgeEl.remove(); badgeEl = null; currentAppId = null; } }

  function createBadge(data) {
    var report = data.report;
    if (!report) { removeBadge(); return; }
    removeBadge();
    currentAppId = data.appId || null;
    var tier = (report.tier||"pending").toLowerCase();
    var el = document.createElement("div");
    el.id = "protondb-store-badge";
    el.style.cssText = "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:999999;display:flex;align-items:center;padding:8px 20px;border-radius:8px;cursor:pointer;background:"+
      (TIER_COLORS[tier]||"#444")+";color:"+(TIER_TEXT[tier]||"#000")+";font-family:sans-serif;font-weight:700;box-shadow:0 2px 12px rgba(0,0,0,0.4);transition:filter 0.2s;";
    el.innerHTML='<span style="width:28px;height:28px;display:flex;align-items:center"><svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28"><circle cx="12" cy="12" r="2.5"/><g fill="none" stroke="currentColor" stroke-width="1.2"><ellipse cx="12" cy="12" rx="10" ry="3.5"/><ellipse cx="12" cy="12" rx="10" ry="3.5" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="3.5" transform="rotate(-60 12 12)"/></g></svg></span><span style="margin-left:10px;font-size:24px">'+(TIER_LABELS[tier]||tier)+'</span>';
    el.addEventListener("click",function(){if(currentAppId)window.open("https://www.protondb.com/app/"+currentAppId,"_blank");});
    el.addEventListener("mouseenter",function(){el.style.filter="brightness(1.3)";});
    el.addEventListener("mouseleave",function(){el.style.filter="";});
    document.body.appendChild(el);
    badgeEl = el;
  }

  // Backend pushes data via CDP — no polling or fetch needed
  window.__protondb_store_badges = {
    cleanup: function() { removeBadge(); },
    updateBadge: function(data) { createBadge(data); },
    removeBadge: removeBadge
  };
})();
`;
  }

  // ─── Settings Persistence ───────────────────────────────────────

  private async loadSettings(): Promise<void> {
    try {
      const file = Bun.file(SETTINGS_PATH);
      if (await file.exists()) {
        this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(await file.text()) };
        console.log("[protondb-badges] Loaded settings from disk");
      }
    } catch (err) {
      console.warn("[protondb-badges] Failed to load settings:", err);
    }
  }

  private async saveSettings(): Promise<void> {
    try {
      await mkdir(DATA_DIR, { recursive: true });
      await Bun.write(SETTINGS_PATH, JSON.stringify(this.settings, null, 2));
    } catch (err) {
      console.warn("[protondb-badges] Failed to save settings:", err);
    }
  }

  // ─── State Emission ─────────────────────────────────────────────

  private emitState(): void {
    this.emit?.({
      event: "stateChanged",
      data: {
        connected: this.connected,
        tabs: this.connections.size,
        settings: this.settings,
      },
    });
  }

  // ─── Health Check ───────────────────────────────────────────────

  private async checkHealth(): Promise<void> {
    // Prune dead connections
    for (const [key, conn] of this.connections) {
      if (!conn.client.connected) {
        this.connections.delete(key);
        console.log(`[protondb-badges] Pruned dead connection: ${key}`);
      }
    }

    const wasConnected = this.connected;
    this.connected = this.connections.has("SharedJSContext") ||
                     this.connections.has("Steam Big Picture Mode");

    if (!this.connected) {
      if (wasConnected) this.emitState();
      const ok = await this.tryConnect();
      if (ok) await this.injectBadgeSystem();
    }
  }
}
