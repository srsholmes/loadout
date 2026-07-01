/**
 * @loadout/game-library — pure scan logic for the `__core:game-library`
 * core service. **Server-only**: plugins must consume the service via
 * `useBackend("__core:game-library")`, not import this package
 * directly. The seal is enforced by the `serverOnly` lint rule in
 * `eslint.config.js` (which reads `loadout.serverOnly: true` from this
 * package's `package.json`).
 *
 * Lifted from the retired `game-browser` plugin's backend; the
 * `PluginBackend`/`EmitPayload` class wrapper was dropped — the loader
 * now hosts the service wrapper (see
 * `apps/loadout/src/loader/services/game-library.ts`). What lives here
 * is pure, mockable async functions.
 */

import type { GameInfo, GameCollection } from "@loadout/types";
import {
  getLibraryPaths,
  getUserdataDir,
  getUserIds,
} from "@loadout/steam-paths";
import { parseBinaryVdf, shortcutGameId64 } from "@loadout/vdf";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Default loader origin. Loader-hosted artwork URLs must be absolute:
 * the CEF webview loads from `views://overlay/index.html`, so a
 * relative `/api/...` resolves to `views:///api/...` and never reaches
 * the Bun server. The loader binds 33820 in both dev and prod, so we
 * hardcode it — same convention as `packages/ui/src/ws-client.ts`.
 * Overridable via `scanLibrary({ loaderOrigin })` for tests and
 * forward-compat with port-discovery wiring.
 */
const DEFAULT_LOADER_ORIGIN = "http://localhost:33820";

export interface ScanLibraryOptions {
  /** Origin used to build local `/api/steam-grid/*` URLs. */
  loaderOrigin?: string;
  /**
   * The user's full *owned* Steam library — every app in Steam's
   * in-memory `appStore.allApps`, sourced by the caller via
   * `@loadout/steam-cdp`'s `getAllApps()`. When provided, owned apps
   * that have no `appmanifest_*.acf` on disk (never downloaded) are
   * synthesized into the returned list so consumers like the
   * SteamGridDB picker can reach them. Installed entries always win —
   * this only fills gaps. Omit it (the default) to keep the classic
   * installed-only behaviour every other consumer relies on.
   */
  ownedApps?: Array<{ appId: string; name: string }>;
}

/**
 * Build the full set of artwork URLs for a Steam app id. Shared by the
 * installed-manifest scan and the owned-but-not-installed synthesis so
 * both paths produce byte-identical URLs. When no primary user id is
 * available (no userdata yet) the local `/api/steam-grid` route can't be
 * built, so every field falls back to the public CDN.
 */
function buildSteamArtUrls(
  origin: string,
  appId: string,
  primaryUserId: string | null,
): Pick<
  GameInfo,
  | "headerUrl"
  | "capsuleUrl"
  | "localHeaderUrl"
  | "localCapsuleUrl"
  | "cdnHeaderUrl"
  | "cdnCapsuleUrl"
> {
  // `header.jpg` is 460×215 landscape (fallback). `library_600x900.jpg`
  // is the 600×900 portrait Steam itself shows in the library grid.
  const cdnHeader = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;
  const cdnCapsule = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`;
  const localHeader = primaryUserId
    ? localArtUrl(origin, appId, primaryUserId, "header")
    : cdnHeader;
  const localCapsule = primaryUserId
    ? localArtUrl(origin, appId, primaryUserId, "capsule")
    : cdnCapsule;
  // Prefer the loader's local `/api/steam-grid/...` route as the
  // canonical art URL — its handler probes the user's
  // `userdata/<id>/config/grid/` first (custom SGDB art wins), falls
  // back to Steam's downloaded appcache, and only then 302-redirects to
  // the public CDN. The pure CDN URLs are kept on `cdnHeaderUrl` /
  // `cdnCapsuleUrl` for the rare plugin that wants the public variant.
  return {
    headerUrl: primaryUserId ? localHeader : cdnHeader,
    capsuleUrl: primaryUserId ? localCapsule : cdnCapsule,
    localHeaderUrl: localHeader,
    localCapsuleUrl: localCapsule,
    cdnHeaderUrl: cdnHeader,
    cdnCapsuleUrl: cdnCapsule,
  };
}

/**
 * Build the local-endpoint URL the loader exposes for an art stem. The
 * route lives in the loader and probes a small set of filename
 * suffixes server-side.
 */
function localArtUrl(
  origin: string,
  stem: string,
  userId: string,
  type: "header" | "capsule",
): string {
  return `${origin}/api/steam-grid/${stem}/${userId}/${type}`;
}

/**
 * Read all non-Steam shortcut entries (added via "Add a non-Steam game"
 * or by tools like EmuDeck) from `userdata/<id>/config/shortcuts.vdf`.
 * Each entry includes its own appid, display name, and embedded `tags`
 * set.
 */
async function readShortcutsForUser(
  origin: string,
  userId: string,
): Promise<GameInfo[]> {
  const path = join(getUserdataDir(), userId, "config", "shortcuts.vdf");
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch {
    return []; // file may not exist if the user has never added a shortcut
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseBinaryVdf(buf) as Record<string, unknown>;
  } catch (err) {
    console.warn(
      `[game-library] Failed to parse shortcuts.vdf for user ${userId}:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }

  const shortcuts = (parsed.shortcuts ?? {}) as Record<string, unknown>;
  const games: GameInfo[] = [];

  for (const entry of Object.values(shortcuts)) {
    if (typeof entry !== "object" || entry === null) continue;
    const sc = entry as Record<string, unknown>;

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
    const tags: string[] = Object.values(tagsObj).filter(
      (t): t is string => typeof t === "string" && t.length > 0,
    );

    // Local artwork lives under userdata/<id>/config/grid/ keyed by the
    // 64-bit gameid (NOT the 32-bit appid). The HTTP route on the
    // loader resolves the actual file extension (png / jpg) at request
    // time.
    const gameid64 = shortcutGameId64(appIdUint);
    const localHeader = localArtUrl(origin, gameid64, userId, "header");
    const localCapsule = localArtUrl(origin, gameid64, userId, "capsule");

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
 * Returns a Map: `appId` (string) → list of collection ids that include it.
 */
async function readUserCollections(
  userId: string,
): Promise<Map<string, string[]>> {
  const path = join(getUserdataDir(), userId, "config", "localconfig.vdf");
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
  const unescaped = escaped.replace(/\\\\/g, "\\").replace(/\\"/g, '"');

  let collections: Record<string, { id?: string; added?: number[] }>;
  try {
    collections = JSON.parse(unescaped);
  } catch (err) {
    console.warn(
      `[game-library] Failed to parse user-collections for user ${userId}:`,
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

/** Extract a value from Steam's VDF/ACF key-value format. */
function parseVdfValue(content: string, key: string): string | null {
  const regex = new RegExp(`"${key}"\\s+"([^"]*)"`, "i");
  const match = content.match(regex);
  return match ? match[1] : null;
}

/**
 * Walk every Steam library path on disk, merge in non-Steam shortcuts
 * and user-defined collection tags, and return the deduped library
 * sorted alphabetically (case-insensitive).
 *
 * - Dedupes by appId. Steam can leave stale `appmanifest_*.acf` files
 *   in a previous library folder when a game is moved between drives,
 *   so the same appId can appear under multiple library paths. First
 *   occurrence wins (libraryPaths is in Steam's own preferred order).
 * - Steam apps always use Steam's CDN `library_600x900.jpg` for the
 *   tile artwork — that's the canonical 2:3 portrait every other
 *   surface (Steam Library, Big Picture) shows. We keep
 *   `localCapsuleUrl` / `localHeaderUrl` on every GameInfo so consumers
 *   that just wrote custom art can refresh the tile via the local
 *   endpoint without waiting for the public `Cache-Control: max-age`.
 *   We intentionally don't try to detect pre-existing local art at
 *   scan time — landscape files would crop weirdly in the portrait
 *   tiles, and any wins from showing local portraits up-front aren't
 *   worth that visual regression.
 */
export async function scanLibrary(
  opts: ScanLibraryOptions = {},
): Promise<GameInfo[]> {
  const origin = opts.loaderOrigin ?? DEFAULT_LOADER_ORIGIN;
  const byAppId = new Map<string, GameInfo>();

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
          const appId = parseVdfValue(content, "appid");
          const name = parseVdfValue(content, "name");
          const sizeStr = parseVdfValue(content, "SizeOnDisk");

          if (!appId || !name) continue;
          if (byAppId.has(appId)) continue;

          const sizeOnDisk = sizeStr ? parseInt(sizeStr) : 0;
          // Art URLs (local `/api/steam-grid` route + CDN fallbacks) are
          // built by the shared `buildSteamArtUrls` helper so the
          // owned-but-not-installed synthesis below stays byte-identical.
          byAppId.set(appId, {
            appId,
            name,
            sizeOnDisk,
            ...buildSteamArtUrls(origin, appId, primaryUserId),
            source: "steam",
            tags: [],
          });
        } catch {
          // Skip unreadable manifests
        }
      }
    }

    // Owned-but-not-installed games. When the caller passes the full
    // owned library (from Steam's in-memory `appStore.allApps` via CDP),
    // synthesize an entry for every owned app we didn't already see on
    // disk. These have no `appmanifest_*.acf` — so `sizeOnDisk` is 0 —
    // but they carry the same CDN + local art URLs as installed Steam
    // apps, so the SGDB picker can art them up. Inserted BEFORE the
    // collection merge below so a not-installed game that lives in a
    // user collection (e.g. "favorite") still gets its tag. Installed
    // entries always win: we only fill gaps, never overwrite the richer
    // manifest-derived record.
    if (opts.ownedApps && opts.ownedApps.length > 0) {
      for (const owned of opts.ownedApps) {
        if (!owned || typeof owned.appId !== "string" || owned.appId.length === 0)
          continue;
        if (byAppId.has(owned.appId)) continue;
        byAppId.set(owned.appId, {
          appId: owned.appId,
          name: owned.name,
          sizeOnDisk: 0,
          ...buildSteamArtUrls(origin, owned.appId, primaryUserId),
          source: "steam",
          tags: [],
        });
      }
    }

    // Non-Steam shortcuts + collections — per Steam user
    for (const userId of userIds) {
      const shortcuts = await readShortcutsForUser(origin, userId);
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
    console.error("[game-library] Failed to scan library:", err);
  }

  // Sort alphabetically, case-insensitive
  const games = Array.from(byAppId.values());
  games.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
  return games;
}

/**
 * Derive the set of collection / tag names across the given library,
 * ordered most-populated first. Powers picker filter dropdowns.
 */
export function getCollectionsFromGames(games: GameInfo[]): GameCollection[] {
  const counts = new Map<string, number>();
  for (const g of games) {
    for (const t of g.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}
