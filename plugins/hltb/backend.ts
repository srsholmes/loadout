import type { PluginBackend, EmitPayload } from "@loadout/types";
import {
  getUserdataDir,
  listInstalledGames,
  type InstalledGame,
} from "@loadout/steam-paths";
import { SteamCefBadgeInjector } from "@loadout/steam-cef-badges";
import { createExternalCache } from "@loadout/external-cache";
import { parseBinaryVdf } from "@loadout/vdf";
import {
  readPluginStorage,
  writePluginStorage,
} from "@loadout/plugin-storage";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import fuzzysort from "fuzzysort";

// ─── Types ──────────────────────────────────────────────────────────

interface HltbGameResult {
  game_id: number;
  game_name: string;
  game_image: string;
  comp_main: number;
  comp_plus: number;
  comp_100: number;
  comp_all: number;
  comp_all_count: number;
  profile_steam: number;
  // Richer fields surfaced by the /_next/data/.../game/<id>.json
  // deep-link. Search results don't carry these; only `getGameTimes`
  // (detail view) reads them. Optional everywhere so existing search
  // codepaths don't have to know about them.
  game_alias?: string;
  profile_summary?: string;
  profile_dev?: string;
  profile_pub?: string;
  profile_platform?: string;
  profile_genre?: string;
  release_world?: string;
  release_na?: string;
  release_eu?: string;
  release_jp?: string;
  review_score?: number;
  count_review?: number;
  count_playing?: number;
  count_backlog?: number;
  count_comp?: number;
}

interface GameTimes {
  gameId: number;
  gameName: string;
  gameImage: string;
  mainStory: string;
  mainPlusExtras: string;
  completionist: string;
  allStyles: string;
  mainStorySeconds: number;
  mainPlusExtrasSeconds: number;
  completionistSeconds: number;
  allStylesSeconds: number;
}

/**
 * Detail-view payload returned by `getGameDetailForSteamApp` /
 * `getGameDetailById`. Wraps the time data with the richer metadata
 * the /_next/data/game/<id>.json deep-link exposes. All metadata
 * fields are optional — HLTB populates them inconsistently per
 * title, and we'd rather omit a row than render a blank one.
 */
interface GameDetail extends GameTimes {
  alias?: string;
  summary?: string;
  developer?: string;
  publisher?: string;
  /** Comma-separated list as HLTB returns it (e.g. "PC, PlayStation 5"). */
  platforms?: string;
  /** Comma-separated genre tags (e.g. "Action, Open World"). */
  genres?: string;
  /** ISO date (YYYY-MM-DD); HLTB uses release_world. */
  releaseWorld?: string;
  /** Aggregate review score (0–100) when HLTB has enough samples. */
  reviewScore?: number;
  /** Number of HLTB users who reviewed. */
  reviewCount?: number;
  /** Number of HLTB users currently playing. */
  playingCount?: number;
  /** Number of HLTB users who marked it as completed. */
  completedCount?: number;
  /** Permalink back to HLTB. */
  hltbUrl: string;
}

interface SearchResult {
  gameId: number;
  gameName: string;
  gameImage: string;
  mainStory: string;
  mainPlusExtras: string;
  completionist: string;
  allStyles: string;
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export interface HltbSettings {
  position: "tl" | "tm" | "tr" | "bl" | "bm" | "br";
  showMainStory: boolean;
  showMainPlusExtras: boolean;
  showCompletionist: boolean;
  showAllStyles: boolean;
  enableLibraryBadge: boolean;
  enableStoreBadge: boolean;
}

/** Badge payload pushed into the injected HLTB runtime (BPM + store). */
type HltbBadgeData = { times: GameTimes | null; settings: HltbSettings };

// ─── Constants ──────────────────────────────────────────────────────

const CACHE_TTL = 12 * 60 * 60 * 1000;
/** TTL in seconds for the disk cache. We mirror the in-memory window
 *  (12h) so a long-running session and a freshly-restarted loader
 *  see roughly the same staleness profile — HLTB times don't change
 *  fast and re-fetching everything on cold start is what motivated
 *  the disk cache in the first place. */
const DISK_CACHE_TTL_SEC = 12 * 60 * 60;
const PLUGIN_ID = "hltb";
/**
 * Fuzzysort score floor for accepting a name-based HLTB match.
 *
 * Scores are non-positive: 0 = perfect substring, more negative = worse.
 * Empirically, scores around -2000 are the boundary between "the
 * obvious match for a typo'd query" and "the strings happen to share
 * a few letters." Anything below this is rejected so the badge doesn't
 * lie about an obscure title (and the wrong answer doesn't get cached
 * for 12 h).
 */
const FUZZY_SCORE_THRESHOLD = -2000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const DEFAULT_SETTINGS: HltbSettings = {
  position: "tl",
  showMainStory: true,
  showMainPlusExtras: true,
  showCompletionist: true,
  showAllStyles: true,
  enableLibraryBadge: true,
  enableStoreBadge: true,
};

// ─── Helpers ────────────────────────────────────────────────────────

function formatTime(seconds: number): string {
  if (seconds <= 0) return "--";
  const hours = seconds / 3600;
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  return `${hours.toFixed(1)}h`;
}

function normalize(str: string): string {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9/\s-]/g, "")
    .trim();
}

// Levenshtein lived here previously for HLTB result fuzzy-matching;
// replaced by fuzzysort below (same package the picker UI uses for
// game search). fuzzysort scores beat hand-rolled DP for typo
// tolerance and edge cases like "Game: Subtitle" vs "Game - Subtitle".

// ─── Backend Class ──────────────────────────────────────────────────

export default class HltbBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;

  /**
   * Settings persistence now routes through `@loadout/plugin-storage`
   * (writes to `~/.config/loadout/plugins/hltb.json`); the previous
   * `dataDir` injection seam was retired with that move. Tests can
   * scope writes by mocking the `@loadout/plugin-storage` module.
   */
  constructor() {}

  // HLTB API state (token + anti-abuse headers, all issued by /api/bleed/init)
  private auth: { token: string; hpKey: string; hpVal: string } | null = null;

  // Caches
  private searchCache = new Map<string, CacheEntry<SearchResult[]>>();
  private steamTimesCache = new Map<string, CacheEntry<GameTimes | null>>();
  private gameNameCache = new Map<string, CacheEntry<string>>();

  /** Disk-backed cache for HLTB / Steam-appdetails responses. The
   *  in-memory Maps above stay as the hot-path cache; the disk cache
   *  lets responses survive a loader restart so we don't re-pay
   *  HLTB's heavily rate-limited search API on every cold start.
   *  Writes go through `safeDiskSet` so a transient filesystem glitch
   *  can't poison the network-result return path. */
  private diskCache = createExternalCache(PLUGIN_ID);

  private async safeDiskSet<T>(
    key: string,
    value: T,
    ttlSec: number,
  ): Promise<void> {
    try {
      await this.diskCache.set(key, value, { ttlSec });
    } catch (err) {
      console.warn(`[hltb] disk cache write failed for ${key}:`, err);
    }
  }

  private async safeDiskGet<T>(key: string): Promise<T | undefined> {
    try {
      return await this.diskCache.get<T>(key);
    } catch {
      return undefined;
    }
  }

  // Settings
  private settings: HltbSettings = { ...DEFAULT_SETTINGS };

  /** Shared Steam-CEF badge-injection lifecycle (connection discovery,
   *  BPM render-tab fan-out, health check, route polling, push coalescing,
   *  Gaming-Mode gating). Constructed in onLoad. See
   *  `@loadout/steam-cef-badges`. */
  private injector!: SteamCefBadgeInjector<HltbBadgeData>;

  /** Re-seed timer for non-Steam shortcut names — NOT CEF machinery,
   *  so it stays in the plugin (the injector owns the CEF intervals). */
  private shortcutSeedInterval?: Timer;

  /**
   * Concurrency limiter for HLTB lookups. Without this, the new
   * library-grid view (one card per installed game) fires N parallel
   * `getTimesForSteamApp` calls — N is the user's library size,
   * routinely 100+. HLTB rate-limits aggressively and will start
   * 429-ing or blocking the IP. We cap at 3 in flight at a time;
   * beyond that, callers wait their turn.
   *
   * Cache hits skip the queue entirely (see
   * `getTimesForSteamApp`) so the throttle only applies to actual
   * network work.
   */
  private inflightLookups = 0;
  private lookupQueue: Array<() => void> = [];
  private static readonly MAX_CONCURRENT_LOOKUPS = 3;

  private async withLookupSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inflightLookups >= HltbBackend.MAX_CONCURRENT_LOOKUPS) {
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
    console.log("[hltb] Plugin loaded");
    await this.loadSettings();

    this.fetchAuth().catch((err) =>
      console.warn("[hltb] Background auth init failed:", err),
    );

    // Seed name caches for both Steam installs and non-Steam
    // shortcuts so the BPM-pill push path can resolve any appId →
    // name without falling through to the heavily-rate-limited Steam
    // appdetails endpoint (which doesn't know about shortcuts at all,
    // hence the previous "pill never appears for non-Steam games"
    // bug). Fire-and-forget — failure just means the cache is empty
    // and lookups proceed via the slower live paths.
    this.seedShortcutNames().catch((err) =>
      console.warn("[hltb] Shortcut name seed failed:", err),
    );
    listInstalledGames()
      .then((games) => {
        const now = Date.now();
        for (const g of games) {
          this.gameNameCache.set(g.appId, { data: g.name, timestamp: now });
        }
      })
      .catch(() => {});

    this.injector = new SteamCefBadgeInjector<HltbBadgeData>({
      pluginId: PLUGIN_ID,
      styleId: "hltb-badges-styles",
      bpmGlobalName: "__hltb_badges",
      storeGlobalName: "__hltb_store_badges",
      css: this.generateBadgeCSS(),
      bpmScript: this.generateBPMScript(),
      buildStoreScript: (d) => this.generateStoreScript(d),
      fetchBadgeData: (appId) => this.getBadgeData(appId),
      buildBpmUpdateExpr: (d) =>
        d
          ? `if (window.__hltb_badges) window.__hltb_badges.update(${JSON.stringify(d)});`
          : `if (window.__hltb_badges) window.__hltb_badges.update(null);`,
      onStateChange: () => this.emitState(),
    });
    void this.injector.start();

    // Re-seed shortcuts every 5 minutes so newly-added non-Steam games
    // (e.g. EmuDeck just imported a ROM) become resolvable without a
    // plugin reload. Piggyback the same tick to prune expired cache
    // entries so the Maps don't grow unbounded across a long session.
    this.shortcutSeedInterval = setInterval(() => {
      this.seedShortcutNames().catch(() => {});
      this.pruneExpiredCaches();
    }, 5 * 60_000);
  }

  /**
   * Drop entries past `CACHE_TTL` from the three rolling Maps. Without
   * this `searchCache` / `steamTimesCache` / `gameNameCache` grew for
   * the lifetime of the loader process (TTL was only consulted on
   * read), which is fine for a 12h session but leaks across days of
   * uptime. Cheap to run — three full-Map scans capped at the size of
   * each Map.
   */
  private pruneExpiredCaches(): void {
    const now = Date.now();
    let dropped = 0;
    for (const [k, v] of this.searchCache) {
      if (now - v.timestamp >= CACHE_TTL) {
        this.searchCache.delete(k);
        dropped++;
      }
    }
    for (const [k, v] of this.steamTimesCache) {
      if (now - v.timestamp >= CACHE_TTL) {
        this.steamTimesCache.delete(k);
        dropped++;
      }
    }
    for (const [k, v] of this.gameNameCache) {
      if (now - v.timestamp >= CACHE_TTL) {
        this.gameNameCache.delete(k);
        dropped++;
      }
    }
    if (dropped > 0) {
      console.log(`[hltb] Pruned ${dropped} expired cache entries`);
    }
  }

  /**
   * Read every user's `shortcuts.vdf` and seed `gameNameCache` with
   * each non-Steam entry's `(appId, name)`. Mirrors the small subset
   * of shortcut-reading logic we need here — the equivalent live scan
   * lives in `@loadout/game-library` (behind `__core:game-library`)
   * but it's an async RPC, so for the seed-on-start path we keep the
   * duplication local rather than blocking startup on the service.
   */
  private async seedShortcutNames(): Promise<void> {
    const userdata = getUserdataDir();
    let userDirs: string[];
    try {
      const entries = await readdir(userdata, { withFileTypes: true });
      userDirs = entries
        .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
        .map((e) => e.name);
    } catch {
      return;
    }

    const now = Date.now();
    let count = 0;
    for (const userId of userDirs) {
      const path = join(userdata, userId, "config", "shortcuts.vdf");
      let buf: Buffer;
      try {
        buf = await readFile(path);
      } catch {
        continue; // user has never added a shortcut
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = parseBinaryVdf(buf) as Record<string, unknown>;
      } catch {
        continue;
      }
      const shortcuts = (parsed.shortcuts ?? {}) as Record<string, unknown>;
      for (const entry of Object.values(shortcuts)) {
        if (typeof entry !== "object" || entry === null) continue;
        const sc = entry as Record<string, unknown>;
        const rawAppId = sc.appid;
        if (typeof rawAppId !== "number") continue;
        // `>>> 0` re-interprets the (possibly signed) 32-bit appid as
        // uint32 — Steam stores it that way.
        const appIdStr = String(rawAppId >>> 0);
        const name = typeof sc.appname === "string" ? sc.appname : null;
        if (!name) continue;
        this.gameNameCache.set(appIdStr, { data: name, timestamp: now });
        count++;
      }
    }
    if (count > 0) {
      console.log(`[hltb] Seeded ${count} shortcut name(s) for BPM lookup`);
    }
  }

  async onUnload(): Promise<void> {
    clearInterval(this.shortcutSeedInterval);
    await this.injector?.stop();

    this.searchCache.clear();
    this.steamTimesCache.clear();
    this.gameNameCache.clear();
    console.log("[hltb] Plugin unloaded");
  }

  // ─── HLTB Auth ─────────────────────────────────────────────────
  //
  // As of 2026-05 HLTB renamed the endpoints from `/api/find*` to
  // `/api/bleed*` (presumably to break scrapers — they cycled the name
  // about every 6 weeks during the 2025-2026 Cloudflare-anti-bot push).
  // Three request-scoped credentials still flow on every search:
  // `x-auth-token`, `x-hp-key`, `x-hp-val`. All three are issued by
  // a single GET `/api/bleed/init?t=<ms>` call and expire per-session.
  // Search endpoint is always `/api/bleed` (POST). If HLTB returns 404
  // here again, scan their `_next/static/chunks/*.js` for the next
  // `/api/<name>/init` template literal — they're consistent about the
  // pattern.

  private async fetchAuth(): Promise<typeof this.auth> {
    try {
      const url = `https://howlongtobeat.com/api/bleed/init?t=${Date.now()}`;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://howlongtobeat.com",
          Referer: "https://howlongtobeat.com/",
          "User-Agent": USER_AGENT,
        },
      });

      if (response.status !== 200) {
        console.warn("[hltb] Auth request failed:", response.status);
        return null;
      }

      const data = (await response.json()) as {
        token?: string;
        hpKey?: string;
        hpVal?: string;
      };
      if (!data.token || !data.hpKey || !data.hpVal) {
        console.warn(
          "[hltb] Incomplete auth response (missing token/hpKey/hpVal)",
        );
        return null;
      }

      this.auth = { token: data.token, hpKey: data.hpKey, hpVal: data.hpVal };
      console.log("[hltb] Auth acquired");
      return this.auth;
    } catch (error) {
      console.warn("[hltb] Error fetching auth:", error);
      return null;
    }
  }

  private async ensureAuth(): Promise<typeof this.auth> {
    if (!this.auth) await this.fetchAuth();
    return this.auth;
  }

  // ─── HLTB Search (internal) ────────────────────────────────────

  private async hltbSearch(
    terms: string[],
    size: number,
  ): Promise<HltbGameResult[]> {
    const searchData = {
      searchType: "games",
      searchTerms: terms,
      searchPage: 1,
      size,
      searchOptions: {
        games: {
          userId: 0,
          platform: "",
          sortCategory: "name",
          rangeCategory: "main",
          rangeTime: { min: 0, max: 0 },
          gameplay: { perspective: "", flow: "", genre: "", difficulty: "" },
          modifier: "hide_dlc",
        },
        users: {},
        filter: "",
        sort: 0,
        randomizer: 0,
      },
    };

    const doFetch = async (
      auth: NonNullable<typeof this.auth>,
    ): Promise<Response> => {
      // HLTB's anti-bot check requires hpKey/hpVal BOTH as headers AND as a
      // body property (where the property name is hpKey and value is hpVal).
      // The browser app mirrors it into the body like this:
      //   let s = { searchType, ... }; if (hpKey) s[hpKey] = hpVal;
      // Missing the body pair returns 404/403 with an HTML error page (not JSON).
      const body: Record<string, unknown> = {
        ...searchData,
        [auth.hpKey]: auth.hpVal,
      };
      return fetch("https://howlongtobeat.com/api/bleed", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://howlongtobeat.com",
          Referer: "https://howlongtobeat.com/",
          "User-Agent": USER_AGENT,
          "x-auth-token": auth.token,
          "x-hp-key": auth.hpKey,
          "x-hp-val": auth.hpVal,
        },
        body: JSON.stringify(body),
      });
    };

    let auth = await this.ensureAuth();
    if (!auth) return [];

    let response = await doFetch(auth);

    // If the triple expired, HLTB returns 403 (authenticated) or 404 (bad hp pair).
    // Refresh and retry once in either case.
    if (response.status === 403 || response.status === 404) {
      this.auth = null;
      auth = await this.fetchAuth();
      if (!auth) return [];
      response = await doFetch(auth);
    }

    if (response.status !== 200) return [];

    const json = (await response.json()) as { data?: HltbGameResult[] };
    return Array.isArray(json.data) ? json.data : [];
  }

  // ─── RPC: Search (frontend panel) ─────────────────────────────

  async searchGame(query: string): Promise<SearchResult[]> {
    if (!query || query.trim().length === 0) return [];

    const normalizedQuery = query.trim().toLowerCase();

    const cached = this.searchCache.get(normalizedQuery);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;

    // Disk cache before paying HLTB's rate-limited search endpoint.
    const fromDisk = await this.safeDiskGet<SearchResult[]>(
      `search:${normalizedQuery}`,
    );
    if (fromDisk !== undefined) {
      this.searchCache.set(normalizedQuery, {
        data: fromDisk,
        timestamp: Date.now(),
      });
      return fromDisk;
    }

    const raw = await this.hltbSearch(normalizedQuery.split(" "), 10);

    const results: SearchResult[] = raw.map((item) => ({
      gameId: item.game_id,
      gameName: item.game_name,
      gameImage: item.game_image
        ? `https://howlongtobeat.com/games/${item.game_image}`
        : "",
      mainStory: formatTime(item.comp_main),
      mainPlusExtras: formatTime(item.comp_plus),
      completionist: formatTime(item.comp_100),
      allStyles: formatTime(item.comp_all),
    }));

    this.searchCache.set(normalizedQuery, {
      data: results,
      timestamp: Date.now(),
    });
    await this.safeDiskSet(
      `search:${normalizedQuery}`,
      results,
      DISK_CACHE_TTL_SEC,
    );
    return results;
  }

  // ─── RPC: App Times (for badge injection + library grid) ──────

  /** Get HLTB times for a Steam game by appId. Used by the injected
   * badge script — the BPM / store integration only has the Steam
   * appId, so we have to hit Steam's appdetails API for the name.
   * Cache hits are synchronous (no queueing); cache misses are gated
   * through the concurrency limiter so a 100+ game library fan-out
   * doesn't get 429'd by HLTB.
   *
   * The in-overlay library grid already has the name from the
   * `__core:game-library` service — it calls
   * `getTimesForGame(appId, name)` instead (skips the appdetails
   * roundtrip and works for non-Steam shortcuts too).
   */
  async getTimesForSteamApp(appId: string): Promise<GameTimes | null> {
    const cached = this.steamTimesCache.get(appId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;

    return this.withLookupSlot(async () => {
      const recached = this.steamTimesCache.get(appId);
      if (recached && Date.now() - recached.timestamp < CACHE_TTL) {
        return recached.data;
      }

      // Disk cache lookup before any network. Hits hydrate the
      // in-memory map for the rest of the session.
      const fromDisk = await this.safeDiskGet<GameTimes | null>(
        `times:${appId}`,
      );
      if (fromDisk !== undefined) {
        this.steamTimesCache.set(appId, {
          data: fromDisk,
          timestamp: Date.now(),
        });
        return fromDisk;
      }

      const gameName = await this.getSteamGameName(appId);
      // Don't cache null results — a transient appdetails / HLTB
      // failure would otherwise wedge "No HLTB data" into the cache
      // for 12 hours. Negative results retry naturally next time the
      // card mounts.
      if (!gameName) return null;

      return this.lookupTimesByName(appId, gameName, { matchSteamAppId: true });
    });
  }

  /**
   * Get HLTB times for any installed game by appId + name. Used by
   * the in-overlay library grid where the name is already known from
   * the `__core:game-library` service (Steam appmanifest *or*
   * non-Steam shortcut entry).
   *
   * For Steam apps the `profile_steam` exact-id match still runs as
   * the strongest signal; for shortcuts the appId is a random
   * `vdf`-generated 32-bit number with no HLTB analogue, so the
   * pipeline falls through to name + fuzzy matching. Same concurrency
   * limiter and 12-hour cache as `getTimesForSteamApp` — keying on
   * appId means Steam appIds and shortcut appIds share a namespace
   * without collisions.
   */
  async getTimesForGame(appId: string, name: string): Promise<GameTimes | null> {
    if (!name || !name.trim()) return null;

    const cached = this.steamTimesCache.get(appId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;

    return this.withLookupSlot(async () => {
      const recached = this.steamTimesCache.get(appId);
      if (recached && Date.now() - recached.timestamp < CACHE_TTL) {
        return recached.data;
      }

      // Disk cache lookup before going to the network.
      const fromDisk = await this.safeDiskGet<GameTimes | null>(
        `times:${appId}`,
      );
      if (fromDisk !== undefined) {
        this.steamTimesCache.set(appId, {
          data: fromDisk,
          timestamp: Date.now(),
        });
        return fromDisk;
      }
      // Seed the name cache so any later `getTimesForSteamApp` call
      // (BPM badge path) skips the rate-limited appdetails endpoint.
      this.gameNameCache.set(appId, { data: name, timestamp: Date.now() });
      return this.lookupTimesByName(appId, name, {
        matchSteamAppId: /^\d+$/.test(appId),
      });
    });
  }

  /**
   * Core HLTB search + match pipeline. Caller is responsible for
   * concurrency gating and cache lookup — this just does the network
   * work and caches a successful match.
   */
  private async lookupTimesByName(
    appId: string,
    gameName: string,
    opts: { matchSteamAppId: boolean },
  ): Promise<GameTimes | null> {
    try {
      // HLTB's /api/bleed caps `size` at 25 — anything ≥30 silently
      // returns `{}` with no data array. Keep this ≤25 or the badge
      // will never render.
      const results = await this.hltbSearch(gameName.split(" "), 20);
      if (results.length === 0) return null;

      const normalizedName = normalize(gameName);
      results.forEach((g) => {
        g.game_name = normalize(g.game_name);
      });

      // Match by Steam appId first (only for Steam apps — shortcuts
      // have random vdf appIds that will never equal an HLTB
      // `profile_steam` value).
      let match: HltbGameResult | undefined;
      if (opts.matchSteamAppId) {
        const numericAppId = parseInt(appId, 10);
        match = results.find((g) => g.profile_steam === numericAppId);
      }

      // Then exact normalized-name match
      if (!match) match = results.find((g) => g.game_name === normalizedName);

      // Then fuzzy. fuzzysort returns negative scores (0 = perfect, more
      // negative = worse). We require the best score to clear
      // `FUZZY_SCORE_THRESHOLD` before accepting; below that the match
      // is junk and we'd rather return null than badge an obscure
      // shortcut with the wrong HLTB game (and have the caller cache
      // that wrong answer for 12 h). Tie-break by HLTB `comp_all_count`
      // so a popular game wins over an obscure namesake when scores
      // tie.
      //
      // The previous "fall back to highest-popularity result" path was
      // the bug — it silently mis-identified everything with no fuzzy
      // hits as "whatever was most popular in the result set." Dropped.
      if (!match) {
        const fuzzy = fuzzysort.go(normalizedName, results, {
          key: "game_name",
          limit: results.length,
        });
        const sorted = [...fuzzy].sort((a, b) => {
          if (a.score === b.score)
            return b.obj.comp_all_count - a.obj.comp_all_count;
          return b.score - a.score;
        });
        const top = sorted[0];
        if (top && top.score >= FUZZY_SCORE_THRESHOLD) {
          match = top.obj;
        }
      }

      if (!match) return null;

      const times: GameTimes = {
        gameId: match.game_id,
        gameName: match.game_name,
        gameImage: match.game_image
          ? `https://howlongtobeat.com/games/${match.game_image}`
          : "",
        mainStory: formatTime(match.comp_main),
        mainPlusExtras: formatTime(match.comp_plus),
        completionist: formatTime(match.comp_100),
        allStyles: formatTime(match.comp_all),
        mainStorySeconds: match.comp_main,
        mainPlusExtrasSeconds: match.comp_plus,
        completionistSeconds: match.comp_100,
        allStylesSeconds: match.comp_all,
      };

      this.steamTimesCache.set(appId, { data: times, timestamp: Date.now() });
      await this.safeDiskSet(`times:${appId}`, times, DISK_CACHE_TTL_SEC);
      return times;
    } catch (err) {
      console.error(`[hltb] Failed to look up times for ${appId} (${gameName}):`, err);
      return null;
    }
  }

  /**
   * Enumerate the user's installed Steam games via the shared
   * `@loadout/steam-paths` helper. Returns `{appId, name}`
   * pairs sorted alphabetically by name. The library-grid view
   * uses this as its source of truth — no HLTB calls happen here,
   * just disk reads of `appmanifest_*.acf`.
   *
   * Side-effect: primes `gameNameCache` from the manifest names so
   * subsequent `getTimesForSteamApp` calls skip the Steam appdetails
   * API entirely. That endpoint is heavily rate-limited (~200 req
   * per 5 min); a 100+ game library cold-start would otherwise blow
   * past the limit and lock half the badges into "No HLTB data" for
   * the cache TTL.
   */
  async listInstalledGames(): Promise<InstalledGame[]> {
    const games = await listInstalledGames();
    const now = Date.now();
    for (const g of games) {
      const existing = this.gameNameCache.get(g.appId);
      if (!existing || now - existing.timestamp >= CACHE_TTL) {
        this.gameNameCache.set(g.appId, { data: g.name, timestamp: now });
      }
    }
    return games;
  }

  /** Get badge data in one call (times + settings). Called by injected BPM script. */
  async getBadgeData(appId: string): Promise<{
    times: GameTimes | null;
    settings: HltbSettings;
  }> {
    const times = await this.getTimesForSteamApp(appId);
    return { times, settings: this.settings };
  }

  /**
   * Get the appId from the current Steam route URL (the game page being
   * viewed in BPM), NOT the actually-running game. Will be replaced by
   * a `__core:game-detection` subscribe once E-004 lands.
   */
  async getCurrentRouteAppId(): Promise<string | null> {
    return this.injector?.getCurrentAppId() ?? null;
  }

  /** Get game name from Steam appdetails API. */
  private async getSteamGameName(appId: string): Promise<string | null> {
    const cached = this.gameNameCache.get(appId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;

    // Disk cache before paying the rate-limited appdetails endpoint.
    const fromDisk = await this.safeDiskGet<string>(`name:${appId}`);
    if (fromDisk !== undefined) {
      this.gameNameCache.set(appId, { data: fromDisk, timestamp: Date.now() });
      return fromDisk;
    }

    try {
      const res = await fetch(
        `https://store.steampowered.com/api/appdetails/?appids=${appId}`,
      );
      if (!res.ok) return null;
      const data = await res.json();
      const name = data[appId]?.data?.name;
      if (name) {
        this.gameNameCache.set(appId, { data: name, timestamp: Date.now() });
        await this.safeDiskSet(`name:${appId}`, name, DISK_CACHE_TTL_SEC);
        return name;
      }
    } catch (err) {
      console.warn(`[hltb] Steam appdetails fetch failed for ${appId}: ${err}`);
    }
    return null;
  }

  /** Get detailed game times for a specific HLTB game by ID. */
  async getGameTimes(gameId: number): Promise<GameTimes | null> {
    const detail = await this.getGameDetailById(gameId);
    if (!detail) return null;
    const {
      alias: _alias,
      summary: _s,
      developer: _d,
      publisher: _p,
      platforms: _pl,
      genres: _g,
      releaseWorld: _rw,
      reviewScore: _rs,
      reviewCount: _rc,
      playingCount: _pc,
      completedCount: _cc,
      hltbUrl: _u,
      ...times
    } = detail;
    return times;
  }

  /**
   * Detail-view fetcher used by the new "click a card → full
   * breakdown" route. Pulls the same /_next/data deep-link as
   * `getGameTimes` but surfaces the richer metadata HLTB embeds in
   * the page response (developer, publisher, platforms, genres,
   * release date, review score, summary). The card view continues to
   * use the trimmed `GameTimes` projection so we don't pay for the
   * detail fields on every grid tile.
   */
  async getGameDetailById(gameId: number): Promise<GameDetail | null> {
    try {
      const buildKey = await this.fetchNextJsBuildKey();
      if (!buildKey) return null;

      const response = await fetch(
        `https://howlongtobeat.com/_next/data/${buildKey}/game/${gameId}.json`,
        {
          method: "GET",
          headers: { "User-Agent": USER_AGENT },
        },
      );

      if (response.status !== 200) return null;

      const json = (await response.json()) as {
        pageProps?: {
          game?: { data?: { game?: HltbGameResult[] } };
        };
      };

      const gameDataList = json?.pageProps?.game?.data?.game;
      if (!Array.isArray(gameDataList) || gameDataList.length === 0)
        return null;

      const game = gameDataList[0];
      if (game === undefined) return null; // unreachable: length checked !== 0 above.
      return this.toGameDetail(game);
    } catch (error) {
      console.warn("[hltb] Error fetching game detail:", error);
      return null;
    }
  }

  /**
   * Resolve a Steam appId to a HLTB detail payload. Reuses the
   * search-+-match pipeline (`getTimesForSteamApp`) for the appId →
   * HLTB gameId hop, then hits the deep-link for the richer
   * metadata. The detail view caches via the same in-process map so
   * navigating back and forth between list and detail is free.
   *
   * Why two hops: HLTB's search endpoint (/api/bleed) never returns
   * platforms / genres / release_world. The /_next/data endpoint
   * does — but it's keyed by HLTB id, not Steam id. Search resolves
   * the id; the deep-link fills in the rest.
   */
  async getGameDetailForSteamApp(appId: string): Promise<GameDetail | null> {
    const times = await this.getTimesForSteamApp(appId);
    if (!times) return null;
    return this.getGameDetailById(times.gameId);
  }

  /**
   * Same two-hop pipeline as `getGameDetailForSteamApp`, but takes
   * the game name directly so non-Steam shortcuts (emulator titles,
   * Heroic / Lutris launchers, etc.) get the rich detail payload
   * too. The card-grid → detail-view click handler uses this for any
   * installed game, Steam or not.
   */
  async getGameDetailForGame(
    appId: string,
    name: string,
  ): Promise<GameDetail | null> {
    const times = await this.getTimesForGame(appId, name);
    if (!times) return null;
    return this.getGameDetailById(times.gameId);
  }

  /** Map a raw HLTB search/result row to the typed GameDetail. */
  private toGameDetail(game: HltbGameResult): GameDetail {
    return {
      gameId: game.game_id,
      gameName: game.game_name,
      gameImage: game.game_image
        ? `https://howlongtobeat.com/games/${game.game_image}`
        : "",
      mainStory: formatTime(game.comp_main),
      mainPlusExtras: formatTime(game.comp_plus),
      completionist: formatTime(game.comp_100),
      allStyles: formatTime(game.comp_all),
      mainStorySeconds: game.comp_main,
      mainPlusExtrasSeconds: game.comp_plus,
      completionistSeconds: game.comp_100,
      allStylesSeconds: game.comp_all,
      alias: game.game_alias || undefined,
      summary: game.profile_summary || undefined,
      developer: game.profile_dev || undefined,
      publisher: game.profile_pub || undefined,
      platforms: game.profile_platform || undefined,
      genres: game.profile_genre || undefined,
      releaseWorld: game.release_world || undefined,
      reviewScore:
        typeof game.review_score === "number" && game.review_score > 0
          ? game.review_score
          : undefined,
      reviewCount:
        typeof game.count_review === "number" ? game.count_review : undefined,
      playingCount:
        typeof game.count_playing === "number" ? game.count_playing : undefined,
      completedCount:
        typeof game.count_comp === "number" ? game.count_comp : undefined,
      hltbUrl: `https://howlongtobeat.com/game/${game.game_id}`,
    };
  }

  private async fetchNextJsBuildKey(): Promise<string | null> {
    try {
      const response = await fetch("https://howlongtobeat.com", {
        headers: { "User-Agent": USER_AGENT },
      });
      if (response.status !== 200) return null;
      const html = await response.text();
      const match = html.match(
        /\/_next\/static\/([^/]+)\/(?:_ssgManifest|_buildManifest)\.js/,
      );
      return match?.[1] ?? null;
    } catch {
      return null;
    }
  }

  // ─── RPC: Settings ──────────────────────────────────────────────

  async getSettings(): Promise<HltbSettings> {
    return { ...this.settings };
  }

  /**
   * Debounce window for re-injecting the badge system after settings
   * change. A user dragging the position slider or toggling a tier
   * filter can fire `updateSettings` 5-20× per second. Re-injecting
   * the full CSS+script bundle into Steam over CDP on every call
   * pegs the bridge and the UI stalls visibly. Trailing-edge debounce
   * collapses the burst into a single re-injection after the user
   * stops poking.
   */
  async updateSettings(settings: HltbSettings): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    await this.saveSettings();
    this.emitState();
    // Re-inject so style/position/toggle changes show live (debounced
    // inside the injector so dragging a control doesn't peg the bridge).
    this.injector?.reinjectDebounced();
  }

  // ─── RPC: Status ────────────────────────────────────────────────

  async getStatus(): Promise<{ connected: boolean; tabs: number }> {
    return this.injector?.getStatus() ?? { connected: false, tabs: 0 };
  }

  async reconnect(): Promise<{ success: boolean; error?: string }> {
    if (!this.injector) return { success: false, error: "Not initialized" };
    return this.injector.reconnect();
  }

  async clearCache(): Promise<void> {
    this.searchCache.clear();
    this.steamTimesCache.clear();
    this.gameNameCache.clear();
    this.auth = null;
    try {
      await this.diskCache.clear();
    } catch (err) {
      console.warn("[hltb] disk cache clear failed:", err);
    }
    console.log("[hltb] Cache cleared");
  }

  /**
   * Loader-broadcast entry point for the global "Clear all data
   * caches" button on the Settings page. Same effect as
   * `clearCache` — separate name so the loader's `__broadcast`
   * fan-out only hits plugins that intentionally implement the
   * convention. See packages/external-cache for the rationale.
   */
  async clearExternalCache(): Promise<void> {
    await this.clearCache();
  }

  // ─── Badge CSS ──────────────────────────────────────────────────

  private generateBadgeCSS(): string {
    return `
/* HLTB Badges - loadout */
#hltb-badges-container {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  pointer-events: auto;
  transition: filter 0.2s, outline 0.2s;
}
#hltb-badges-container:hover {
  filter: brightness(1.2);
  outline: 2px solid rgba(0,0,0,0.6);
}
#hltb-badges-container .hltb-inner {
  display: flex;
  align-items: center;
  background: rgba(14, 20, 27, 0.85);
  backdrop-filter: blur(8px);
  padding: 8px 14px;
  gap: 16px;
}
#hltb-badges-container .hltb-icon {
  width: 24px; height: 24px;
  display: flex; align-items: center;
  color: #1a9fff;
  flex-shrink: 0;
}
#hltb-badges-container .hltb-icon svg { width: 24px; height: 24px; }
#hltb-badges-container .hltb-stats {
  display: flex;
  gap: 14px;
}
#hltb-badges-container .hltb-stat {
  text-align: center;
}
#hltb-badges-container .hltb-time {
  font-size: 16px;
  font-weight: 700;
  color: #fff;
  line-height: 1.2;
}
#hltb-badges-container .hltb-stat-label {
  font-size: 9px;
  text-transform: uppercase;
  color: rgba(255,255,255,0.5);
  letter-spacing: 0.5px;
  line-height: 1.4;
}

/* Time colors */
.hltb-time-none { color: rgba(255,255,255,0.3) !important; }
`;
  }

  // ─── Big Picture Mode Badge Script ──────────────────────────────

  private generateBPMScript(): string {
    // This script is a passive renderer — it does NOT fetch from localhost.
    // Badge data is pushed by the backend via CDP evaluate calls to
    // window.__hltb_badges.update(data).
    // This avoids mixed content blocks (https://steamloopback.host -> http://localhost).
    return `
(function() {
  if (window.__hltb_badges) window.__hltb_badges.cleanup();

  var badgeEl = null;

  var CLOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';

  // Times render in a single neutral colour — the threshold-based
  // green/yellow/red was arbitrary (10h short / 30h medium) and the
  // colour didn't encode anything meaningful, so the user removed it.
  // "--" still dims to make missing data legible at a glance.
  function timeColorClass(timeStr) {
    return timeStr === "--" ? "hltb-time-none" : "";
  }

  function removeBadge() {
    if (badgeEl) { badgeEl.remove(); badgeEl = null; }
  }

  function createBadge(data) {
    var times = data.times;
    var settings = data.settings;
    if (!times || !settings.enableLibraryBadge) { removeBadge(); return; }

    // Check if all visible stats are "--"
    var allEmpty = true;
    if (settings.showMainStory && times.mainStory !== "--") allEmpty = false;
    if (settings.showMainPlusExtras && times.mainPlusExtras !== "--") allEmpty = false;
    if (settings.showCompletionist && times.completionist !== "--") allEmpty = false;
    if (settings.showAllStyles && times.allStyles !== "--") allEmpty = false;
    if (allEmpty) { removeBadge(); return; }

    removeBadge();

    var container = document.createElement("div");
    container.id = "hltb-badges-container";

    // Position
    var p = settings.position || "tl";
    container.style.position = "fixed";
    container.style.zIndex = "99999";
    container.style.cursor = "pointer";
    container.style.borderRadius = "4px";
    container.style.overflow = "hidden";
    if (p[0] === "t") container.style.top = "60px"; else container.style.bottom = "60px";
    if (p[1] === "l") container.style.left = "20px";
    else if (p[1] === "m") { container.style.left = "50%"; container.style.transform = "translateX(-50%)"; }
    else container.style.right = "20px";

    var inner = document.createElement("div");
    inner.className = "hltb-inner";

    // Clock icon
    var icon = document.createElement("span");
    icon.className = "hltb-icon";
    icon.innerHTML = CLOCK_SVG;
    inner.appendChild(icon);

    // Stats
    var statsContainer = document.createElement("div");
    statsContainer.className = "hltb-stats";

    var statEntries = [];
    if (settings.showMainStory) statEntries.push({ label: "Main", time: times.mainStory });
    if (settings.showMainPlusExtras) statEntries.push({ label: "Main+", time: times.mainPlusExtras });
    if (settings.showCompletionist) statEntries.push({ label: "100%", time: times.completionist });
    if (settings.showAllStyles) statEntries.push({ label: "All", time: times.allStyles });

    statEntries.forEach(function(entry) {
      var stat = document.createElement("div");
      stat.className = "hltb-stat";
      var timeEl = document.createElement("div");
      timeEl.className = "hltb-time " + timeColorClass(entry.time);
      timeEl.textContent = entry.time;
      var labelEl = document.createElement("div");
      labelEl.className = "hltb-stat-label";
      labelEl.textContent = entry.label;
      stat.appendChild(timeEl);
      stat.appendChild(labelEl);
      statsContainer.appendChild(stat);
    });

    inner.appendChild(statsContainer);
    container.appendChild(inner);

    container.addEventListener("click", function() {
      if (data.times && data.times.gameId) {
        window.open("https://howlongtobeat.com/game/" + data.times.gameId, "_blank");
      }
    });

    document.body.appendChild(container);
    badgeEl = container;
  }

  window.__hltb_badges = {
    cleanup: function() {
      removeBadge();
    },
    update: function(data) {
      if (!data) { removeBadge(); return; }
      createBadge(data);
    }
  };
})();
`;
  }

  // ─── Store Badge Script ─────────────────────────────────────────

  /**
   * Generate a store badge script with data embedded directly.
   * No HTTP fetches from within CEF — data is passed in at injection time.
   */
  private generateStoreScript(
    badgeData: { times: GameTimes | null; settings: HltbSettings } | null,
  ): string {
    const settingsJson = JSON.stringify(this.settings);
    const dataJson = badgeData ? JSON.stringify(badgeData) : "null";
    return `
(function() {
  if (window.__hltb_store_badges) window.__hltb_store_badges.cleanup();

  var SETTINGS = ${settingsJson};
  var BADGE_DATA = ${dataJson};
  var badgeEl = null;

  function timeColor(timeStr) {
    // Single neutral colour — see BPM script for rationale.
    return timeStr === "--" ? "rgba(255,255,255,0.3)" : "#fff";
  }

  function removeBadge() { if (badgeEl) { badgeEl.remove(); badgeEl = null; } }

  function showBadge(data) {
    if (!data || !data.times || !SETTINGS.enableStoreBadge) { removeBadge(); return; }
    removeBadge();

    var times = data.times;
    var el = document.createElement("div");
    el.id = "hltb-store-badge";
    el.style.cssText = "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:999999;display:flex;align-items:center;gap:16px;padding:8px 20px;border-radius:8px;cursor:pointer;background:rgba(14,20,27,0.9);backdrop-filter:blur(8px);font-family:sans-serif;box-shadow:0 2px 12px rgba(0,0,0,0.4);transition:filter 0.2s;";

    var html = '<span style="width:24px;height:24px;display:flex;align-items:center;color:#1a9fff"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="24" height="24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></span>';

    var stats = [];
    if (SETTINGS.showMainStory) stats.push({l:"Main",t:times.mainStory});
    if (SETTINGS.showMainPlusExtras) stats.push({l:"Main+",t:times.mainPlusExtras});
    if (SETTINGS.showCompletionist) stats.push({l:"100%",t:times.completionist});
    if (SETTINGS.showAllStyles) stats.push({l:"All",t:times.allStyles});

    stats.forEach(function(s) {
      html += '<div style="text-align:center"><div style="font-size:16px;font-weight:700;' + "color:" + timeColor(s.t) + '">' + s.t + '</div><div style="font-size:9px;text-transform:uppercase;color:rgba(255,255,255,0.5);letter-spacing:0.5px">' + s.l + '</div></div>';
    });

    el.innerHTML = html;
    el.addEventListener("click",function(){if(times.gameId)window.open("https://howlongtobeat.com/game/"+times.gameId,"_blank");});
    el.addEventListener("mouseenter",function(){el.style.filter="brightness(1.2)";});
    el.addEventListener("mouseleave",function(){el.style.filter="";});
    document.body.appendChild(el);
    badgeEl = el;
  }

  // Show badge immediately with embedded data
  if (BADGE_DATA) showBadge(BADGE_DATA);

  window.__hltb_store_badges = {
    cleanup: function() { removeBadge(); },
    update: function(data) { showBadge(data); }
  };
})();
`;
  }

  // ─── Settings Persistence ───────────────────────────────────────

  private async loadSettings(): Promise<void> {
    try {
      const stored = await readPluginStorage<Partial<HltbSettings>>(PLUGIN_ID);
      if (stored) {
        this.settings = { ...DEFAULT_SETTINGS, ...stored };
        console.log("[hltb] Loaded settings from plugin-storage");
      }
    } catch (err) {
      console.warn("[hltb] Failed to load settings:", err);
    }
  }

  private async saveSettings(): Promise<void> {
    try {
      await writePluginStorage(PLUGIN_ID, this.settings);
    } catch (err) {
      console.warn("[hltb] Failed to save settings:", err);
    }
  }

  // ─── State Emission ─────────────────────────────────────────────

  private emitState(): void {
    const { connected, tabs } = this.injector?.getStatus() ?? {
      connected: false,
      tabs: 0,
    };
    this.emit?.({
      event: "stateChanged",
      data: { connected, tabs, settings: this.settings },
    });
  }
}
