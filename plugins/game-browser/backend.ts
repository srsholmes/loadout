import type { PluginBackend, EmitPayload } from "@loadout/types";
import {
  getLibraryPaths,
  getUserdataDir,
  getUserIds,
} from "@loadout/steam-paths";
import {
  parseBinaryVdf,
  shortcutGameId64,
} from "@loadout/vdf";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Loader-hosted artwork URLs must be absolute. The CEF webview loads
 * from `views://overlay/index.html`, so a relative `/api/...` resolves
 * to `views:///api/...` and never reaches the Bun server. The loader
 * binds 33820 in both dev and prod (Vite's dev server runs on a
 * different port and reverse-proxies `/api`, but plugins emit URLs
 * that the WEBVIEW consumes directly), so we hardcode the origin —
 * same convention as `packages/ui/src/ws-client.ts`. The
 * `/api/steam-grid` route on the loader returns
 * `Access-Control-Allow-Origin: *` so the cross-origin GET works.
 */
const LOADER_ORIGIN = "http://localhost:33820";

export type GameSource = "steam" | "shortcut";

export interface GameInfo {
  appId: string;
  name: string;
  /** Size on disk in bytes (manifest-reported; 0 for shortcuts) */
  sizeOnDisk: number;
  /** Header artwork URL — local `/api/steam-grid/*` when the user has
   *  applied custom art (file exists in `userdata/<id>/config/grid/`),
   *  Steam CDN otherwise for real games. Shortcuts always use local. */
  headerUrl: string;
  /** Capsule artwork URL — same scheme as headerUrl */
  capsuleUrl: string;
  /** Forced local-endpoint URL for the header — always points at the
   *  loader's `/api/steam-grid/<stem>/<userId>/header` route regardless
   *  of whether a file exists right now. Consumers that just wrote
   *  custom art use this with a cache-busting query string to refresh
   *  the tile without waiting for the public `Cache-Control: max-age`. */
  localHeaderUrl: string;
  /** Forced local-endpoint URL for the capsule. See `localHeaderUrl`. */
  localCapsuleUrl: string;
  /** Where the entry came from. */
  source: GameSource;
  /** Steam categories / collections this game belongs to (collection ids or
   *  legacy tag names). Used by callers to build collection filters. */
  tags: string[];
}

/**
 * Build the local-endpoint URL the loader exposes for an art stem.
 * The route lives in `packages/loader/src/index.ts` and probes a
 * small set of filename suffixes server-side.
 */
function localArtUrl(
  stem: string,
  userId: string,
  type: "header" | "capsule",
): string {
  return `${LOADER_ORIGIN}/api/steam-grid/${stem}/${userId}/${type}`;
}

/**
 * Read all non-Steam shortcut entries (added via "Add a non-Steam game" or
 * by tools like EmuDeck) from `userdata/<id>/config/shortcuts.vdf`. Each
 * entry includes its own appid, display name, and embedded `tags` set.
 */
async function readShortcutsForUser(userId: string): Promise<GameInfo[]> {
  const path = join(
    getUserdataDir(),
    userId,
    "config",
    "shortcuts.vdf",
  );
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch {
    return []; // file may not exist if user has never added a shortcut
  }

  let parsed: Record<string, any>;
  try {
    parsed = parseBinaryVdf(buf) as Record<string, any>;
  } catch (err) {
    console.warn(
      `[game-browser] Failed to parse shortcuts.vdf for user ${userId}:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }

  const shortcuts = (parsed.shortcuts ?? {}) as Record<string, any>;
  const games: GameInfo[] = [];

  for (const entry of Object.values(shortcuts)) {
    if (typeof entry !== "object" || entry === null) continue;
    const sc = entry as Record<string, any>;

    // Required fields. `appid` may be parsed as signed (top bit set →
    // negative); `>>> 0` re-interprets it as the uint32 Steam stores.
    const rawAppId = sc.appid;
    if (typeof rawAppId !== "number") continue;
    const appIdUint = rawAppId >>> 0;
    const appIdStr = String(appIdUint);

    const name = typeof sc.appname === "string" ? sc.appname : appIdStr;

    // Tags live as a sub-object with numeric keys mapping to tag strings:
    //   tags: { "0": "Nintendo Switch - Eden", "1": "Emulation" }
    const tagsObj = (sc.tags ?? {}) as Record<string, unknown>;
    const tags: string[] = Object.values(tagsObj)
      .filter((t): t is string => typeof t === "string" && t.length > 0);

    // Local artwork lives under userdata/<id>/config/grid/ keyed by the
    // 64-bit gameid (NOT the 32-bit appid). The HTTP route on the loader
    // resolves the actual file extension (png / jpg) at request time.
    const gameid64 = shortcutGameId64(appIdUint);
    const localHeader = localArtUrl(gameid64, userId, "header");
    const localCapsule = localArtUrl(gameid64, userId, "capsule");

    games.push({
      appId: appIdStr,
      name,
      sizeOnDisk: 0,
      headerUrl: localHeader,
      capsuleUrl: localCapsule,
      localHeaderUrl: localHeader,
      localCapsuleUrl: localCapsule,
      source: "shortcut",
      tags,
    });
  }

  return games;
}

/**
 * Read user-defined Steam Library Collections from
 * `userdata/<id>/config/localconfig.vdf`. Steam serialises these as a
 * single string value `"user-collections"` whose body is escape-encoded
 * JSON of shape `{ <collectionId>: { id, added: [appid, …], removed: [] }}`.
 *
 * Returns a Map: appId (string) → list of collection ids that include it.
 */
async function readUserCollections(
  userId: string,
): Promise<Map<string, string[]>> {
  const path = join(
    getUserdataDir(),
    userId,
    "config",
    "localconfig.vdf",
  );
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch {
    return new Map();
  }

  // Surgical extraction so we don't have to parse the whole VDF tree.
  // The value is a single JSON string with backslash-escaped quotes.
  const match = text.match(/"user-collections"\s*"((?:[^"\\]|\\.)*)"/);
  if (!match) return new Map();

  const escaped = match[1];
  const unescaped = escaped
    .replace(/\\\\/g, "\\")
    .replace(/\\"/g, '"');

  let collections: Record<string, { id?: string; added?: number[] }>;
  try {
    collections = JSON.parse(unescaped);
  } catch (err) {
    console.warn(
      `[game-browser] Failed to parse user-collections for user ${userId}:`,
      err instanceof Error ? err.message : err,
    );
    return new Map();
  }

  const byApp = new Map<string, string[]>();
  for (const [collectionKey, c] of Object.entries(collections)) {
    if (!c || typeof c !== "object") continue;
    const collectionId = c.id ?? collectionKey;
    const added = Array.isArray(c.added) ? c.added : [];
    for (const rawId of added) {
      if (typeof rawId !== "number") continue;
      const appIdStr = String(rawId >>> 0);
      const list = byApp.get(appIdStr);
      if (list) {
        if (!list.includes(collectionId)) list.push(collectionId);
      } else {
        byApp.set(appIdStr, [collectionId]);
      }
    }
  }
  return byApp;
}

export default class GameBrowserBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;

  private games: GameInfo[] = [];

  async onLoad(): Promise<void> {
    console.log("[game-browser] Loading...");
    await this.scanLibrary();
    console.log(
      `[game-browser] Found ${this.games.length} entries (Steam + shortcuts)`,
    );
  }

  /** Return all installed games sorted alphabetically. */
  async getGames(): Promise<GameInfo[]> {
    return this.games;
  }

  /** Re-scan the Steam library and return the updated list. */
  async rescan(): Promise<GameInfo[]> {
    await this.scanLibrary();
    this.emit?.({ event: "libraryUpdated", data: this.games.length });
    return this.games;
  }

  /**
   * Return the unique set of collection / tag names across the current
   * library, in display order: most-populated first. Powers picker
   * filter dropdowns.
   */
  async getCollections(): Promise<{ id: string; count: number }[]> {
    const counts = new Map<string, number>();
    for (const g of this.games) {
      for (const t of g.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  }

  private async scanLibrary(): Promise<void> {
    // Dedupe by appId. Steam can leave stale appmanifest_*.acf files in
    // a previous library folder when a game is moved between drives, so
    // the same appId can show up under multiple library paths. First
    // occurrence wins (libraryPaths is in Steam's own preferred order).
    const byAppId = new Map<string, GameInfo>();

    // Steam apps always use Steam's CDN `library_600x900.jpg` for the
    // tile artwork — that's the canonical 2:3 portrait every other
    // surface (Steam Library, Big Picture) shows. We keep
    // `localCapsuleUrl` / `localHeaderUrl` on every GameInfo so the
    // SGDB plugin can swap to the loader's local-grid endpoint *after*
    // applying custom art (with a refresh-token cache buster). We
    // intentionally don't try to detect pre-existing local art at
    // scan time — landscape files would crop weirdly in the portrait
    // tiles, and any wins from showing local portraits up-front
    // aren't worth that visual regression.
    const userIds = await getUserIds();
    const primaryUserId = userIds[0] ?? null;

    try {
      // Real Steam games — appmanifest_*.acf scan
      const libraryPaths = await getLibraryPaths();
      for (const appsPath of libraryPaths) {
        let entries: string[];
        try {
          entries = await readdir(appsPath);
        } catch {
          continue;
        }

        for (const entry of entries) {
          if (!entry.startsWith("appmanifest_") || !entry.endsWith(".acf"))
            continue;

          try {
            const content = await readFile(join(appsPath, entry), "utf-8");
            const appId = this.parseVdfValue(content, "appid");
            const name = this.parseVdfValue(content, "name");
            const sizeStr = this.parseVdfValue(content, "SizeOnDisk");

            if (!appId || !name) continue;
            if (byAppId.has(appId)) continue;
            const stateFlags = this.parseVdfValue(content, "StateFlags");
            if (stateFlags && parseInt(stateFlags) & 2) {
              // StateFlags & 2 = needs update; still show it
            }

            const sizeOnDisk = sizeStr ? parseInt(sizeStr) : 0;
            // `header.jpg` is 460×215 landscape, used as the fallback
            // when the portrait isn't there. `library_600x900.jpg` is
            // the 600×900 portrait Steam itself shows in the library
            // grid — every picker UI wants this for its tiles, so
            // emit it as `capsuleUrl` rather than the much smaller
            // `capsule_231x87.jpg` (which is a landscape mini-tile
            // used for store pages, not library tiles).
            const cdnHeader = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;
            const cdnCapsule = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`;
            // `localHeader`/`localCapsule` are always emitted so the
            // SGDB plugin (or any other consumer) can force a refresh
            // after applying custom art without having to look up the
            // user id itself.
            const localHeader = primaryUserId
              ? localArtUrl(appId, primaryUserId, "header")
              : cdnHeader;
            const localCapsule = primaryUserId
              ? localArtUrl(appId, primaryUserId, "capsule")
              : cdnCapsule;

            byAppId.set(appId, {
              appId,
              name,
              sizeOnDisk,
              headerUrl: cdnHeader,
              capsuleUrl: cdnCapsule,
              localHeaderUrl: localHeader,
              localCapsuleUrl: localCapsule,
              source: "steam",
              tags: [],
            });
          } catch {
            // Skip unreadable manifests
          }
        }
      }

      // Non-Steam shortcuts + collections — per Steam user
      for (const userId of userIds) {
        const shortcuts = await readShortcutsForUser(userId);
        for (const sc of shortcuts) {
          if (byAppId.has(sc.appId)) continue; // shouldn't happen but defensive
          byAppId.set(sc.appId, sc);
        }

        // User-collection tags also apply to real Steam games (e.g. the
        // `favorite` collection). Merge those into existing entries' tags.
        const collectionsByApp = await readUserCollections(userId);
        for (const [appId, collections] of collectionsByApp) {
          const game = byAppId.get(appId);
          if (!game) continue;
          for (const c of collections) {
            if (!game.tags.includes(c)) game.tags.push(c);
          }
        }
      }
    } catch (err) {
      console.error("[game-browser] Failed to scan library:", err);
    }

    // Sort alphabetically, case-insensitive
    const games = Array.from(byAppId.values());
    games.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
    this.games = games;
  }

  /** Extract a value from Steam's VDF/ACF key-value format. */
  private parseVdfValue(content: string, key: string): string | null {
    const regex = new RegExp(`"${key}"\\s+"([^"]*)"`, "i");
    const match = content.match(regex);
    return match ? match[1] : null;
  }
}
