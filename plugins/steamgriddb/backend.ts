import type { PluginBackend, EmitPayload } from "@loadout/types";
import { getSteamDir } from "@loadout/steam-paths";
import { CDPClient } from "@loadout/steam-cdp";
import {
  readPluginStorage,
  writePluginStorage,
} from "@loadout/plugin-storage";
import { createExternalCache } from "@loadout/external-cache";
import { readdir, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";

const SGDB_API_BASE = "https://www.steamgriddb.com/api/v2";
const PLUGIN_ID = "steamgriddb";
const STEAM_DEBUG_PORT = 8080;

/** TTL in seconds for the disk cache. SGDB metadata (game records,
 *  search results, asset listings) changes infrequently — uploads
 *  happen but per-game additions are rare. 6h is a sensible
 *  middle-ground: keep the network quiet across short browse
 *  sessions, refresh often enough that newly-uploaded art shows up
 *  the same day. The user can force-refresh from the per-plugin
 *  "Clear Cache" button on the gear/cog menu. */
const DISK_CACHE_TTL_SEC = 6 * 60 * 60;

// Single source of truth for the grid-folder write contract lives in
// `@loadout/sgdb-art`: `stemsFor` (dual-stem rule for shortcuts),
// `filenameFor` + `STEM_SUFFIX` (per-art-type filename), and
// `STEAM_ASSET_TYPE` (the eAssetType numeric map for the CDP write).
// This plugin's per-tile picker re-uses those exports so its byte
// layout stays identical to the bulk `applyAllArtwork` pipeline.
import {
  filenameFor as artFilenameFor,
  stemsFor as artStemsFor,
  STEAM_ASSET_TYPE,
  type ArtType,
  type SgdbGameSource,
} from "@loadout/sgdb-art";

export type GameSource = SgdbGameSource;

interface CEFTab {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
  type: string;
}

/**
 * Persisted plugin storage (v2). v1 was `{ version: 1, apiKey? }`;
 * v2 added `matches` so non-Steam shortcuts keep their resolved SGDB
 * game-id between sessions. v1 files round-trip through
 * `migrateConfig()` and are rewritten the next time we touch storage.
 */
interface PersistedConfig {
  version: 2;
  /** User's SteamGridDB API key (from steamgriddb.com/profile/preferences/api). */
  apiKey?: string;
  /** Saved SGDB-game-id per local appId (Steam appId or shortcut uint32). */
  matches?: Record<string, { sgdbId: number; name: string }>;
}

/** Loosely-typed shape we read from disk — both v1 and v2 fit. */
interface PersistedConfigStored {
  version?: 1 | 2;
  apiKey?: unknown;
  matches?: unknown;
}

export function migrateConfig(raw: PersistedConfigStored): PersistedConfig {
  return {
    version: 2,
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey : undefined,
    matches:
      raw.matches && typeof raw.matches === "object" && !Array.isArray(raw.matches)
        ? (raw.matches as Record<string, { sgdbId: number; name: string }>)
        : undefined,
  };
}

/**
 * SteamGridDB plugin backend.
 *
 * Provides:
 * - Game search via SteamGridDB autocomplete API
 * - Per-Steam-app-id and per-SGDB-game-id asset fetchers (the latter
 *   for non-Steam shortcuts where the Steam-platform-gated endpoints
 *   don't apply)
 * - Saved SGDB-match persistence so a shortcut's resolved game-id
 *   survives across sessions
 * - Downloading and applying art to Steam's grid folder, including
 *   non-Steam shortcuts (writes both the 32-bit-keyed filename Steam
 *   itself uses for Big Picture and the 64-bit-keyed filename the
 *   loader's /api/steam-grid endpoint probes)
 *
 * The API key is persisted via plugin-storage so the user enters it
 * once. STEAMGRIDDB_API_KEY env var still wins for dev / CI.
 */
export default class SteamGridDBBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;

  private apiKey: string | null = null;
  /** In-memory mirror of `PersistedConfig.matches` — keyed by local appId. */
  private matches: Record<string, { sgdbId: number; name: string }> = {};

  /** Disk-backed cache for SGDB API responses. Wraps the SGDB
   *  endpoint hits in `getOrFetch` so repeat browsing of the same
   *  game pulls from disk on the next session instead of re-paying
   *  the network round-trip. Writes go through `safeDiskSet` /
   *  reads through `safeDiskGet` so a transient filesystem glitch
   *  can't poison the network-result return path — the SGDB UI
   *  must keep working even if disk persistence is broken.
   *
   *  Cache keys never include the API token, so the file names are
   *  stable across key rotations (we don't accidentally orphan an
   *  N MB grid-listing because the user pasted a fresh key). */
  private diskCache = createExternalCache(PLUGIN_ID);

  private async safeDiskSet<T>(
    key: string,
    value: T,
    ttlSec: number,
  ): Promise<void> {
    try {
      await this.diskCache.set(key, value, { ttlSec });
    } catch (err) {
      console.warn(`[steamgriddb] disk cache write failed for ${key}:`, err);
    }
  }

  private async safeDiskGet<T>(key: string): Promise<T | undefined> {
    try {
      return await this.diskCache.get<T>(key);
    } catch {
      return undefined;
    }
  }

  async onLoad(): Promise<void> {
    // Env var first (dev / CI). Falls back to persisted plugin storage.
    const fromEnv = process.env.STEAMGRIDDB_API_KEY;
    const stored = await readPluginStorage<PersistedConfigStored>(PLUGIN_ID);
    const migrated = migrateConfig(stored);
    if (fromEnv && fromEnv.length > 0) {
      this.apiKey = fromEnv;
    } else {
      this.apiKey = migrated.apiKey ?? null;
    }
    this.matches = migrated.matches ?? {};

    // Probe the persisted key once on load. If SGDB rejects it
    // (401/403), clear the in-memory copy so `hasApiKey()` returns
    // false and the UI lands on the Connect screen instead of
    // pretending to be authenticated. The on-disk file is left
    // alone — the user re-enters via the Connect screen which goes
    // through `setApiKey()` and overwrites it. Network failures
    // (timeout / DNS) are tolerated: keep the key so the user isn't
    // bounced offline.
    if (this.apiKey) {
      try {
        const probe = await fetch(`${SGDB_API_BASE}/grids/steam/730`, {
          headers: this.getHeaders(),
          signal: AbortSignal.timeout(5_000),
        });
        if (probe.status === 401 || probe.status === 403) {
          console.warn(
            "[steamgriddb] Stored API key was rejected by SGDB — clearing it.",
          );
          this.apiKey = null;
        }
      } catch {
        /* network blip — keep the key */
      }
    }

    console.log(
      `[steamgriddb] Plugin loaded${this.apiKey ? " (API key configured)" : " (no API key — paste one from steamgriddb.com/profile/preferences/api)"}`,
    );
  }

  async onUnload(): Promise<void> {
    console.log("[steamgriddb] Plugin unloaded");
  }

  /**
   * Set the API key at runtime, validating it against SGDB before
   * persisting. Returns `{ success: true }` on accept, or
   * `{ success: false, error }` if SGDB rejects the key — in which
   * case the in-memory key and the on-disk file are left unchanged.
   *
   * The probe hits `/grids/steam/730` (Counter-Strike, always
   * present in SGDB's index) — a 200 means the key is valid; 401/403
   * means it isn't; other failure codes are surfaced verbatim.
   */
  async setApiKey(
    key: string,
  ): Promise<{ success: boolean; error?: string }> {
    const trimmed = key.trim();
    if (trimmed.length === 0) {
      return { success: false, error: "API key cannot be empty." };
    }

    // Probe with the candidate key directly — don't touch the
    // in-memory copy until we know SGDB accepts it.
    try {
      const probe = await fetch(`${SGDB_API_BASE}/grids/steam/730`, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${trimmed}`,
        },
      });
      if (probe.status === 401 || probe.status === 403) {
        return {
          success: false,
          error: "SteamGridDB rejected that API key. Double-check it on steamgriddb.com/profile/preferences/api.",
        };
      }
      if (!probe.ok) {
        return {
          success: false,
          error: `SteamGridDB returned HTTP ${probe.status} during validation. Try again in a moment.`,
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `Couldn't reach SteamGridDB to validate the key: ${msg}`,
      };
    }

    this.apiKey = trimmed;
    await this.persist();
    return { success: true };
  }

  /** Write the current in-memory state back to plugin-storage. */
  private async persist(): Promise<void> {
    await writePluginStorage<PersistedConfig>(PLUGIN_ID, {
      version: 2,
      apiKey: this.apiKey ?? undefined,
      matches: Object.keys(this.matches).length > 0 ? this.matches : undefined,
    });
  }

  /** Check whether an API key is configured. */
  async hasApiKey(): Promise<boolean> {
    return this.apiKey !== null && this.apiKey.length > 0;
  }

  /** Build headers for SteamGridDB API requests. */
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  // ─── Saved SGDB matches (per local appId) ─────────────────────
  //
  // For non-Steam shortcuts the Steam-platform-gated SGDB endpoints
  // (/grids/steam/{appid}) don't apply — we resolve the SGDB game id
  // via /search/autocomplete and then call /grids/game/{sgdbId}.
  // We cache the resolution so the user doesn't pay the round-trip
  // (or worse, get prompted to re-pick) on every session.

  /** Return the SGDB-game-id we previously resolved for an appId, if any. */
  async getSavedSgdbMatch(
    appId: string,
  ): Promise<{ sgdbId: number; name: string } | null> {
    return this.matches[appId] ?? null;
  }

  /** Persist a chosen SGDB-game-id for a given local appId. */
  async saveSgdbMatch(
    appId: string,
    sgdbId: number,
    name: string,
  ): Promise<void> {
    this.matches[appId] = { sgdbId, name };
    await this.persist();
  }

  /**
   * GC saved matches against the user's current library. Frontend
   * calls this once after pulling `getGames` from game-browser so
   * shortcuts the user has since removed from `shortcuts.vdf` don't
   * hang around in plugin storage forever.
   *
   * Returns the number of entries dropped so callers can log it.
   * If `validAppIds` is empty (e.g. game-browser failed and returned
   * nothing) we skip the prune — wiping every match on a transient
   * failure would be worse than the leak.
   */
  async pruneMatches(validAppIds: string[]): Promise<{ removed: number }> {
    if (validAppIds.length === 0) return { removed: 0 };
    const keep = new Set(validAppIds);
    let removed = 0;
    for (const appId of Object.keys(this.matches)) {
      if (!keep.has(appId)) {
        delete this.matches[appId];
        removed += 1;
      }
    }
    if (removed > 0) await this.persist();
    return { removed };
  }

  // ─── SGDB lookups keyed off the Steam app id ──────────────────

  /**
   * Search SteamGridDB for games matching a query.
   * Returns an array of { id, name, types, verified } objects.
   */
  async searchGames(
    query: string
  ): Promise<{ id: number; name: string; types: string[]; verified: boolean }[]> {
    const trimmed = query.trim().toLowerCase();
    if (trimmed.length === 0) return [];
    const cacheKey = `search:${trimmed}`;
    const fromDisk = await this.safeDiskGet<
      { id: number; name: string; types: string[]; verified: boolean }[]
    >(cacheKey);
    if (fromDisk !== undefined) return fromDisk;

    const encoded = encodeURIComponent(query);
    const res = await fetch(`${SGDB_API_BASE}/search/autocomplete/${encoded}`, {
      headers: this.getHeaders(),
    });

    if (!res.ok) {
      throw new Error(`SteamGridDB search failed: ${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as {
      success: boolean;
      data: { id: number; name: string; types: string[]; verified: boolean }[];
    };

    if (!json.success) {
      throw new Error("SteamGridDB search returned unsuccessful response");
    }

    await this.safeDiskSet(cacheKey, json.data, DISK_CACHE_TTL_SEC);
    return json.data;
  }

  /**
   * Fetch grid images for a game.
   * Asset type 0 = portrait grid, 3 = landscape grid.
   */
  // Asset fetchers. SGDB exposes `/{assetType}/steam/{steamAppId}` as
  // a direct lookup that bypasses the SGDB-game-id resolution step,
  // matching what the official Decky plugin uses
  // (DeckThemes/SDH-CssLoader and SteamGridDB/decky-steamgriddb both
  // hit this shape). The `gameId` argument is the user's local Steam
  // app id — we no longer go via /games/steam/{appid} first.

  /** Fetch grid images for a Steam app id. */
  async getGrids(steamAppId: string): Promise<SgdbImage[]> {
    return this.fetchAssets(`/grids/steam/${steamAppId}`);
  }

  /** Fetch hero images for a Steam app id. */
  async getHeroes(steamAppId: string): Promise<SgdbImage[]> {
    return this.fetchAssets(`/heroes/steam/${steamAppId}`);
  }

  /** Fetch logo images for a Steam app id. */
  async getLogos(steamAppId: string): Promise<SgdbImage[]> {
    return this.fetchAssets(`/logos/steam/${steamAppId}`);
  }

  /** Fetch icon images for a Steam app id. */
  async getIcons(steamAppId: string): Promise<SgdbImage[]> {
    return this.fetchAssets(`/icons/steam/${steamAppId}`);
  }

  // ─── SGDB-game-id-keyed fetchers (for non-Steam shortcuts) ─────
  //
  // Non-Steam shortcuts have no Steam app id, so the /{type}/steam/
  // endpoints don't apply. After resolving the SGDB game id (via
  // /search/autocomplete in `searchGames`), the UI calls these to
  // pull assets the same way SRM's image-providers do.

  async getGridsByGameId(sgdbId: number): Promise<SgdbImage[]> {
    return this.fetchAssets(`/grids/game/${sgdbId}`);
  }

  async getHeroesByGameId(sgdbId: number): Promise<SgdbImage[]> {
    return this.fetchAssets(`/heroes/game/${sgdbId}`);
  }

  async getLogosByGameId(sgdbId: number): Promise<SgdbImage[]> {
    return this.fetchAssets(`/logos/game/${sgdbId}`);
  }

  async getIconsByGameId(sgdbId: number): Promise<SgdbImage[]> {
    return this.fetchAssets(`/icons/game/${sgdbId}`);
  }

  /**
   * Download an image from a URL and apply it as the user's custom
   * artwork for `appId`. Two paths in priority order:
   *
   *   1. CDP: when Steam's CEF debug port (8080) is reachable, call
   *      `SteamClient.Apps.SetCustomArtworkForApp(appId, base64,
   *      "png", eAssetType)` via Runtime.evaluate. This is the same
   *      IPC the official Decky plugin uses — Steam writes the file
   *      and refreshes its library *immediately*, no relaunch
   *      required.
   *   2. File fallback: if CDP isn't available, write the image
   *      directly into every user profile's
   *      `userdata/{userId}/config/grid/` folder under the Steam-
   *      expected filename. Steam picks it up on next library scan
   *      / restart, but the application surface is the same.
   *
   * Filename suffix for the fallback path:
   *   - "grid_p" (portrait)  -> {stem}p.png
   *   - "grid_l" (landscape) -> {stem}.png
   *   - "hero"               -> {stem}_hero.png
   *   - "logo"               -> {stem}_logo.png
   *   - "icon"               -> {stem}_icon.png
   *
   * For Steam apps, `stem` = the Steam appId. For non-Steam shortcuts
   * we write the file twice — once under the 32-bit shortcut appid
   * (Steam Big Picture reads from this, same convention SRM uses)
   * and once under the 64-bit `gameid64` (the form the loader's
   * `/api/steam-grid/<gameid64>/...` route probes, so the
   * game-browser plugin's row image resolves). Icons skip the file
   * write entirely for shortcuts: Steam stores shortcut icons in
   * `shortcuts.vdf`'s `icon` field, not the grid folder, so blindly
   * dropping a `{stem}_icon.png` doesn't help. The CDP path still
   * runs — when Steam is open the icon is applied through
   * SetCustomArtworkForApp.
   */
  async applyArt(
    appId: string,
    url: string,
    type: string,
    source: GameSource = "steam",
  ): Promise<{ success: boolean; instant: boolean; paths: string[] }> {
    const imageRes = await fetch(url);
    if (!imageRes.ok) {
      throw new Error(`Failed to download image: ${imageRes.status}`);
    }
    const imageData = await imageRes.arrayBuffer();

    // Path 1 — CDP / SteamClient. Try first; if Steam isn't running
    // or the debug port isn't open we fall through to the file
    // path. Either way the user gets the artwork applied.
    let instant = false;
    try {
      instant = await this.applyArtViaCDP(appId, imageData, type);
    } catch (err) {
      console.warn(`[steamgriddb] CDP apply failed: ${err}`);
    }

    // For non-Steam shortcuts, icons live in shortcuts.vdf — there's
    // no useful filename to drop into the grid folder, and writing a
    // bogus one would be silently ignored. Treat the CDP outcome as
    // the result for icon+shortcut.
    if (source === "shortcut" && type === "icon") {
      if (instant) {
        return { success: true, instant: true, paths: [] };
      }
      throw new Error(
        "Setting an icon for a non-Steam game requires Steam to be running. Open Steam and try again.",
      );
    }

    // Path 2 — file write into userdata/<id>/config/grid. Always
    // run this even after a CDP success: it's how Steam stores
    // custom art on disk regardless, and it makes the change
    // survive a Steam restart without re-touching CDP.
    const ext = extFromUrl(url);
    const stems = filenameStemsFor(appId, source);
    const filenames = stems.map((stem) => filenameFor(stem, type, ext));

    const steamPath = getSteamDir();
    const userdataPath = join(steamPath, "userdata");
    let userDirs: string[];
    try {
      userDirs = await readdir(userdataPath);
    } catch {
      // If userdata isn't there but CDP succeeded, we still applied
      // — return that success. Otherwise it's a real failure.
      if (instant) {
        return { success: true, instant, paths: [] };
      }
      throw new Error(`Steam userdata directory not found at ${userdataPath}`);
    }

    // Fan out across (users × filenames). Multi-account Steam setups
    // would otherwise pay N×M sequential write latency — and even
    // single-user shortcuts write two stems (32-bit appid + 64-bit
    // gameid64). Per-user isolation: a single user's mkdir failure
    // (perm error, weird symlink) must not abort the whole batch —
    // other users' grid dirs are independent. Skip the user whose
    // mkdir failed and write the rest; log the failure for visibility.
    const validUserDirs = userDirs.filter((u) => /^\d+$/.test(u));
    const mkdirResults = await Promise.allSettled(
      validUserDirs.map(async (userDir) => {
        await mkdir(join(userdataPath, userDir, "config", "grid"), {
          recursive: true,
        });
        return userDir;
      }),
    );
    const writableUserDirs: string[] = [];
    for (let i = 0; i < mkdirResults.length; i++) {
      const r = mkdirResults[i];
      if (r.status === "fulfilled") {
        writableUserDirs.push(r.value);
      } else {
        console.warn(
          `[steamgriddb] skipping user ${validUserDirs[i]}: mkdir failed (${r.reason}).`,
        );
      }
    }
    const targets = writableUserDirs.flatMap((userDir) =>
      filenames.map((filename) => ({
        userDir,
        outputPath: join(userdataPath, userDir, "config", "grid", filename),
      })),
    );
    // Same isolation for writes: a single broken target shouldn't
    // sabotage every other Steam profile's art update.
    const writeResults = await Promise.allSettled(
      targets.map((t) => Bun.write(t.outputPath, imageData)),
    );
    const savedPaths: string[] = [];
    for (let i = 0; i < writeResults.length; i++) {
      const r = writeResults[i];
      if (r.status === "fulfilled") {
        savedPaths.push(targets[i].outputPath);
      } else {
        console.warn(
          `[steamgriddb] write failed for ${targets[i].outputPath}: ${r.reason}`,
        );
      }
    }

    if (savedPaths.length === 0 && !instant) {
      throw new Error("No Steam user profiles found in userdata");
    }

    return { success: true, instant, paths: savedPaths };
  }

  /**
   * Reset a single asset type back to Steam's default art. Mirrors
   * `applyArt`:
   *
   *   1. CDP: call `SteamClient.Apps.ClearCustomArtworkForApp(appId,
   *      eAssetType)` if Steam's debug port is reachable. Steam
   *      removes the asset from its on-disk store and refreshes the
   *      library tile immediately.
   *   2. File sweep: also delete any matching files in every Steam
   *      user profile's `userdata/{userId}/config/grid/` directory,
   *      because the apply path writes those files redundantly. The
   *      sweep matches by the same suffix scheme apply uses, across
   *      png/jpg/jpeg, so we don't leave stale art behind if the
   *      user picked a non-png source.
   */
  async clearArt(
    appId: string,
    type: string,
    source: GameSource = "steam",
  ): Promise<{ success: boolean; instant: boolean; paths: string[] }> {
    let instant = false;
    try {
      instant = await this.clearArtViaCDP(appId, type);
    } catch (err) {
      console.warn(`[steamgriddb] CDP clear failed: ${err}`);
    }

    const matcher = filenameMatcherFor(appId, type, source);
    const steamPath = getSteamDir();
    const userdataPath = join(steamPath, "userdata");
    let userDirs: string[];
    try {
      userDirs = await readdir(userdataPath);
    } catch {
      // No userdata dir — if CDP cleared, that's enough.
      if (instant) return { success: true, instant, paths: [] };
      throw new Error(`Steam userdata directory not found at ${userdataPath}`);
    }

    const removedPaths: string[] = [];
    for (const userDir of userDirs) {
      if (!/^\d+$/.test(userDir)) continue;
      const gridDir = join(userdataPath, userDir, "config", "grid");
      let entries: string[];
      try {
        entries = await readdir(gridDir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!matcher.test(entry)) continue;
        const filePath = join(gridDir, entry);
        try {
          await unlink(filePath);
          removedPaths.push(filePath);
        } catch (err) {
          // ENOENT is fine; surface anything else.
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") {
            console.warn(`[steamgriddb] failed to unlink ${filePath}: ${err}`);
          }
        }
      }
    }

    return { success: true, instant, paths: removedPaths };
  }

  /**
   * CDP sibling of `applyArtViaCDP` — drives Steam's
   * `ClearCustomArtworkForApp` IPC over the debug port. Returns
   * `true` only when the IPC actually ran; missing port / missing
   * tab / unknown asset type all return `false` so the file sweep
   * is the source of truth.
   */
  private async clearArtViaCDP(
    appId: string,
    type: string,
  ): Promise<boolean> {
    const eAssetType = STEAM_ASSET_TYPE[type as ArtType];
    if (eAssetType == null) return false;

    const targetUrl = await this.findSharedJsContextTab();
    if (!targetUrl) return false;

    const numericAppId = parseInt(appId, 10);
    // ClearCustomArtworkForApp resolves before the clear actually
    // lands, so wait briefly to let Steam's UI catch up before any
    // follow-up render reads the stale URL.
    const expression = `
      (async () => {
        if (typeof SteamClient === 'undefined' || !SteamClient.Apps) {
          return { ok: false, error: 'SteamClient not available' };
        }
        try {
          await SteamClient.Apps.ClearCustomArtworkForApp(
            ${JSON.stringify(numericAppId)},
            ${eAssetType}
          );
          await new Promise((r) => setTimeout(r, 500));
          return { ok: true };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      })()
    `;

    const result = await this.cdpOneShot(targetUrl, expression);
    if (
      result &&
      typeof result === "object" &&
      "ok" in result &&
      (result as { ok: boolean }).ok
    ) {
      console.log(
        `[steamgriddb] CDP cleared ${type} for app ${appId} (instant)`,
      );
      return true;
    }
    return false;
  }

  // ─── CDP / SteamClient.Apps.SetCustomArtworkForApp injection ──
  //
  // We open a one-shot WebSocket to Steam's CEF debug port, find the
  // SharedJSContext tab (where `SteamClient` lives), evaluate the
  // SetCustomArtworkForApp call, then close. This avoids the
  // long-lived multi-tab connection the theme-loader plugin needs —
  // we just need a single round-trip per Apply.

  private async applyArtViaCDP(
    appId: string,
    imageData: ArrayBuffer,
    type: string,
  ): Promise<boolean> {
    const eAssetType = STEAM_ASSET_TYPE[type as ArtType];
    if (eAssetType == null) return false;

    // Find the SharedJSContext tab.
    const targetUrl = await this.findSharedJsContextTab();
    if (!targetUrl) return false;

    // Base64-encode the image. Bun supports
    // `Buffer.from(buf).toString("base64")` natively.
    const base64 = Buffer.from(imageData).toString("base64");

    // Build the JS expression. We swallow the inner promise's
    // resolve value so CDP doesn't try to serialize anything large
    // back over the wire.
    const numericAppId = parseInt(appId, 10);
    // Clear-then-Set with a 500 ms gap. Set-only leaves Steam's
    // internal art cache pointed at the previous image, so library
    // tiles keep painting the stale src — worst on non-Steam
    // shortcuts. Decky's plugin (sibling repo) does the same dance:
    // ClearCustomArtworkForApp resolves before the clear actually
    // lands, so we wait before issuing Set.
    //
    // Failure-rollback: if Set throws after Clear succeeded, Steam's
    // runtime state is wiped (the on-disk file from `applyArt`'s
    // path-2 write still arrives a moment later, so the persistent
    // state is correct — only the live tile is briefly empty). The
    // inner expression reports `clearedButNoSet: true` in that case
    // so the surrounding `applyArt` flow knows the disk write has to
    // be relied upon for the user-visible recovery and can surface a
    // "Steam may need a restart to show the new art" hint instead of
    // a flat "apply failed". No silent destructive failure.
    const expression = `
      (async () => {
        if (typeof SteamClient === 'undefined' || !SteamClient.Apps) {
          return { ok: false, error: 'SteamClient not available' };
        }
        let cleared = false;
        try {
          await SteamClient.Apps.ClearCustomArtworkForApp(
            ${JSON.stringify(numericAppId)},
            ${eAssetType}
          );
          cleared = true;
          await new Promise((r) => setTimeout(r, 500));
          await SteamClient.Apps.SetCustomArtworkForApp(
            ${JSON.stringify(numericAppId)},
            ${JSON.stringify(base64)},
            'png',
            ${eAssetType}
          );
          return { ok: true };
        } catch (err) {
          return {
            ok: false,
            error: String(err),
            clearedButNoSet: cleared,
          };
        }
      })()
    `;

    const result = await this.cdpOneShot(targetUrl, expression);
    if (
      result &&
      typeof result === "object" &&
      "ok" in result &&
      (result as { ok: boolean }).ok
    ) {
      console.log(
        `[steamgriddb] CDP applied ${type} for app ${appId} (instant)`,
      );
      return true;
    }
    if (
      result &&
      typeof result === "object" &&
      "clearedButNoSet" in result &&
      (result as { clearedButNoSet: boolean }).clearedButNoSet
    ) {
      // Steam's runtime art was cleared but the Set step failed. The
      // disk write that follows in `applyArt`'s path-2 is the user-
      // facing recovery: it lands the new art at the correct
      // userdata/.../grid path, and Steam picks it up on next
      // restart. Log + emit a friendly hint so the UI surfaces this.
      console.warn(
        `[steamgriddb] CDP Set failed after Clear for app ${appId}; ` +
          `disk write will rescue — Steam restart may be needed for instant view.`,
      );
      this.emit?.({
        event: "cdpPartialFailure",
        data: { appId, type, error: (result as { error?: string }).error },
      });
    }
    return false;
  }

  /** Discover Steam's SharedJSContext CEF tab over the /json HTTP API. */
  private async findSharedJsContextTab(): Promise<string | null> {
    try {
      const res = await fetch(`http://localhost:${STEAM_DEBUG_PORT}/json`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!res.ok) return null;
      const tabs = (await res.json()) as CEFTab[];
      // SharedJSContext is the most reliable host for SteamClient.
      // Fall back to "Steam" / "SP" / the first tab whose URL looks
      // shared if the title isn't an exact match.
      const target =
        tabs.find((t) =>
          [
            "SharedJSContext",
            "Steam Shared Context presented by Valve™",
          ].includes(t.title),
        ) ??
        tabs.find((t) => t.title === "Steam" || t.title === "SP") ??
        null;
      return target?.webSocketDebuggerUrl ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Open a CDP WebSocket, evaluate `expression`, return the value,
   * close the socket. One round-trip with a generous timeout to
   * cover Steam's first-time IPC handshake when applying art.
   *
   * Delegates to @loadout/steam-cdp's CDPClient — same pending-
   * promises plumbing every other CDP-touching plugin uses.
   */
  private async cdpOneShot(
    wsUrl: string,
    expression: string,
  ): Promise<unknown> {
    const client = new CDPClient(wsUrl);
    try {
      await client.connect();
      return await client.evaluate(expression, {
        awaitPromise: true,
        timeoutMs: 10_000,
      });
    } finally {
      try {
        client.close();
      } catch {
        /* already closed */
      }
    }
  }

  /** Generic asset fetcher for SteamGridDB API endpoints. Wraps the
   *  network call in the disk cache so repeat browsing of the same
   *  game's grids/heroes/logos/icons doesn't pay the round-trip on
   *  the next session. The path itself (e.g. `/grids/steam/440`)
   *  is the cache key — it includes the asset type and either the
   *  Steam appId or the SGDB game id, so collisions across types
   *  and games are impossible. */
  private async fetchAssets(path: string): Promise<SgdbImage[]> {
    const cacheKey = `assets:${path}`;
    const fromDisk = await this.safeDiskGet<SgdbImage[]>(cacheKey);
    if (fromDisk !== undefined) return fromDisk;

    const res = await fetch(`${SGDB_API_BASE}${path}`, {
      headers: this.getHeaders(),
    });

    if (!res.ok) {
      throw new Error(`SteamGridDB API error: ${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as {
      success: boolean;
      data: SgdbImage[];
    };

    if (!json.success) {
      return [];
    }

    await this.safeDiskSet(cacheKey, json.data, DISK_CACHE_TTL_SEC);
    return json.data;
  }

  /**
   * Wipe the on-disk SGDB API response cache. Exposed as
   * `clearCache` for the plugin's per-plugin "Clear Cache" button
   * and as `clearExternalCache` for the loader-level "Clear all
   * data caches" broadcast. The two share an implementation so
   * either entry point produces the same result.
   *
   * Does NOT touch the saved API key (in plugin-storage, not
   * external-cache) or saved SGDB matches — those are user state,
   * not regenerable response data.
   */
  async clearCache(): Promise<void> {
    try {
      await this.diskCache.clear();
    } catch (err) {
      console.warn("[steamgriddb] disk cache clear failed:", err);
    }
    console.log("[steamgriddb] external cache cleared");
  }

  async clearExternalCache(): Promise<void> {
    await this.clearCache();
  }
}

/**
 * Filename stems `applyArt` should write for (appId, source). Steam
 * apps use just the appId. Non-Steam shortcuts get two stems so that
 * Steam Big Picture (which reads `{shortcut_appid_uint32}*.png`) and
 * the loader's `/api/steam-grid/<gameid64>/...` route (which probes
 * `{gameid64}*.png`) both resolve.
 *
 * Thin string-appId adapter around `stemsFor` in `@loadout/sgdb-art` —
 * the package's numeric-appId version is the canonical implementation.
 * If a shortcut has a non-numeric appId we fall back to a single stem
 * (the appId itself) rather than crashing.
 */
export function filenameStemsFor(appId: string, source: GameSource): string[] {
  if (source === "shortcut") {
    const n = parseInt(appId, 10);
    if (Number.isFinite(n)) return artStemsFor(n, source);
  }
  return [appId];
}

/** Build the full filename for a single stem + asset type + extension.
 *
 * Thin re-export of `@loadout/sgdb-art`'s `filenameFor` — kept as a
 * named export so `backend.test.ts` and the per-tile picker both go
 * through one entry-point, and so a non-`ArtType` `type` string from
 * the wire side gets a sane "${stem}${ext}" fallback instead of a
 * `STEM_SUFFIX[undefined]` runtime undefined-concat.
 */
export function filenameFor(
  stem: string,
  type: string,
  ext: string,
): string {
  if (type in ({ grid_p: 1, grid_l: 1, hero: 1, logo: 1, icon: 1 } as const)) {
    return artFilenameFor(stem, type as ArtType, ext);
  }
  return `${stem}${ext}`;
}

/**
 * Build a regex that matches every on-disk filename `applyArt` would
 * write for a given (appId, type, source) tuple, across png/jpg/jpeg.
 * Used by `clearArt`'s file sweep so we don't leave stale art behind
 * when the source URL was a non-png. For shortcuts the matcher
 * accepts both stems (32-bit appid AND 64-bit gameid64) so the sweep
 * mirrors the apply path exactly.
 */
export function filenameMatcherFor(
  appId: string,
  type: string,
  source: GameSource = "steam",
): RegExp {
  const stems = filenameStemsFor(appId, source);
  const cores = stems.map((stem) => {
    const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    switch (type) {
      case "grid_p":
        return `${escaped}p`;
      case "grid_l":
        return `${escaped}`;
      case "hero":
        return `${escaped}_hero`;
      case "logo":
        return `${escaped}_logo`;
      case "icon":
        return `${escaped}_icon`;
      default:
        return `${escaped}`;
    }
  });
  const alt = cores.length === 1 ? cores[0] : `(?:${cores.join("|")})`;
  // Keep this extension set in lockstep with `extFromUrl`'s
  // ALLOWED_IMAGE_EXTS in `./shared` — apply writes whatever ext the
  // source URL has, so the clear sweep must recognise all of them or
  // a `.webp` apply followed by a clear would leave orphaned files
  // behind in the user's `userdata/.../grid` dir.
  return new RegExp(`^${alt}\\.(png|jpe?g|webp|ico)$`, "i");
}

// Pure helpers live in `./shared` so the frontend can use the
// same regex without taking a dep on this backend module.
import { cleanTitleForSearch, extFromUrl } from "./shared";
export { cleanTitleForSearch };

interface SgdbImage {
  id: number;
  score: number;
  style: string;
  width: number;
  height: number;
  nsfw: boolean;
  humor: boolean;
  language: string;
  url: string;
  thumb: string;
  lock: boolean;
  epilepsy: boolean;
  notes: string | null;
  author: {
    name: string;
    steam64: string;
    avatar: string;
  };
}
