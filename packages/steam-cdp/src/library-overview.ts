/**
 * Reads the user's whole Steam library — including the games they own but
 * have not installed — out of Steam's in-page stores over CDP.
 *
 * **Why this exists next to `SteamClient.apps.getAllApps`.** That method
 * filters `app_type === 1` and projects `{appId, name}`, which is exactly what
 * `protondb-badges` wants and cannot supply anything else. Widening it would
 * change a shipped contract, so this is a sibling rather than an edit.
 *
 * **Where the owned set comes from.** Not `appStore.allApps` — that mixes in
 * shortcuts and needs the `app_type` enum decoded by hand. Instead
 * `collectionStore.appTypeCollectionMap`, which Steam maintains one collection
 * per app type (`type-games`, `type-software`, `type-music`, `type-videos`,
 * `type-tools`). Iterating those gives the owned set *and* the app kind in one
 * pass, with no enum table to keep in sync. Measured on a real device: 2346
 * games in `type-games` against 60 in `local-install`.
 *
 * Everything is projected to plain JSON **inside the page** before it crosses
 * the CDP boundary. The overview objects are MobX proxies with getters that
 * throw on some fields; structured-cloning them directly is not an option.
 *
 * Read-only. It reads stores and calls `BIs*` / `Get*` predicates, and writes
 * nothing.
 */

import { SteamClientUnreachableError, type SteamClient } from "./steam-client";

/** Steam's app-type collections, and the `AppKind` each maps to. */
const TYPE_COLLECTIONS: ReadonlyArray<readonly [string, string]> = [
  ["type-games", "game"],
  ["type-software", "application"],
  ["type-music", "music"],
  ["type-videos", "video"],
  ["type-tools", "tool"],
];

/**
 * One app as Steam sees it. Numeric fields follow this repo's sentinel
 * discipline: **-1 means unknown**, never 0 and never undefined. `lastPlayed`
 * and `playtimeMinutes` additionally use 0 for "provably never", which is a
 * real answer and must not be collapsed into unknown.
 */
export interface SteamLibraryEntry {
  appId: string;
  name: string;
  sortAs: string;
  /** Derived from which `type-*` collection the app appeared in. */
  kind: string;
  installed: boolean;
  owned: boolean;
  /** Installed on some *other* machine — Steam's "streamable". */
  streamable: boolean;
  sizeOnDisk: number;
  lastPlayed: number;
  playtimeMinutes: number;
  /** Decoded 0–3 category, not the packed bitfield. */
  deckCompat: number;
  steamOsCompat: number;
  reviewPercentage: number;
  metacritic: number;
  releaseDate: number;
  purchasedAt: number;
  comingSoon: boolean;
  familyShared: boolean;
  /** Human-readable tag names, already resolved from Steam's numeric ids. */
  storeTags: string[];
  /** Collection ids this app belongs to, Steam's own and the user's. */
  collections: string[];
  /** Platform name when this is a Steam ROM Manager entry, else null. */
  romPlatform: string | null;
}

export interface SteamLibrarySnapshot {
  entries: SteamLibraryEntry[];
  /** Apps in `local-install`, for cross-checking the installed flag. */
  installedCount: number;
  /** How many store-tag ids resolved to names — 0 means the map wasn't ready. */
  resolvedTagCount: number;
}

/**
 * The in-page program. Kept as one expression so the whole read is a single
 * round trip: 2300+ apps × a dozen getters each is far too chatty otherwise.
 */
const READ_LIBRARY = `(() => {
  const cs = window.collectionStore;
  const as = window.appStore;
  if (!cs || !as || !cs.appTypeCollectionMap) return { tag: "no-store" };

  // Steam stores numeric tag ids on the app and the names in a separate map.
  // Resolve once here rather than shipping ids out and joining on the far side.
  let resolvedTagCount = 0;
  const tagName = (id) => {
    try {
      if (typeof as.GetLocalizationForStoreTag === "function") {
        const name = as.GetLocalizationForStoreTag(id);
        if (name) { resolvedTagCount++; return String(name); }
      }
      const fromMap = as.m_mapStoreTagLocalization && as.m_mapStoreTagLocalization[id];
      if (fromMap) {
        const name = typeof fromMap === "string" ? fromMap : fromMap.name;
        if (name) { resolvedTagCount++; return String(name); }
      }
    } catch (e) { /* a missing tag must not lose the whole app */ }
    return null;
  };

  // appId -> collection ids. Built once by walking the collections, rather
  // than calling GetCollectionListForAppID per app (2300 store lookups).
  const collectionsByApp = new Map();
  const romPlatformByApp = new Map();
  const addCollection = (appid, id, romPlatform) => {
    const key = String(appid);
    const list = collectionsByApp.get(key);
    if (list) list.push(id); else collectionsByApp.set(key, [id]);
    if (!romPlatform) return;
    // Steam ROM Manager files most ROMs under both a generic "Emulation"
    // collection and a specific console one. Last-write-wins would leave half
    // the library on "Emulation", so prefer the specific name.
    const existing = romPlatformByApp.get(key);
    if (!existing || existing === "Emulation") romPlatformByApp.set(key, romPlatform);
  };

  for (const coll of (cs.userCollections || [])) {
    // Steam ROM Manager names its collections srm-<base64 platform>. That is
    // the only signal distinguishing a ROM from any other non-Steam shortcut
    // (Konsole, an emulator launcher), which otherwise look identical.
    let romPlatform = null;
    if (typeof coll.id === "string" && coll.id.startsWith("srm-")) {
      try { romPlatform = atob(coll.id.slice(4)); } catch (e) { romPlatform = null; }
    }
    for (const app of (coll.allApps || [])) addCollection(app.appid, coll.id, romPlatform);
  }
  for (const id of ["favorite", "hidden"]) {
    try {
      for (const app of (cs.GetCollection(id)?.allApps || [])) addCollection(app.appid, id, null);
    } catch (e) { /* a collection Steam doesn't have is not an error */ }
  }

  // The per-app \`installed\` getter reports true for ~91% of a real library
  // while local-install holds 138, so it plainly means something else
  // (available-to-install, most likely). Steam's own local-install collection
  // is the authority on what is on this machine.
  const installedSet = new Set();
  try {
    for (const app of (cs.GetCollection("local-install")?.allApps || [])) {
      installedSet.add(String(app.appid));
    }
  } catch (e) { /* no collection: everything reads uninstalled, which is honest */ }

  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : -1);
  // Steam writes 0 for "no answer" on dates, scores and sizes, where this
  // repo's convention is -1. Collapsing them matters: left as 0 they read as
  // populated, and a "released before 2015" rule would silently match every
  // game Steam has no date for. \`lastPlayed\` and \`playtimeMinutes\` are
  // excluded on purpose — for those, 0 is the real answer "never".
  const pos = (v) => { const n = num(v); return n > 0 ? n : -1; };
  const call = (obj, method, fallback) => {
    try { return typeof obj[method] === "function" ? obj[method]() : fallback; }
    catch (e) { return fallback; }
  };

  const seen = new Set();
  const entries = [];
  const types = ${JSON.stringify(TYPE_COLLECTIONS)};

  for (const [collectionId, kind] of types) {
    let collection;
    try { collection = cs.appTypeCollectionMap.get(collectionId); } catch (e) { collection = null; }
    if (!collection || !Array.isArray(collection.allApps)) continue;

    for (const a of collection.allApps) {
      if (!a) continue;
      const appId = String(a.appid);
      // An app can sit in more than one type collection; first wins so the
      // kind stays stable rather than depending on iteration order.
      if (seen.has(appId)) continue;
      seen.add(appId);

      try {
        const perClient = Array.isArray(a.per_client_data) ? a.per_client_data : [];
        const installedHere = installedSet.has(appId);
        // Steam labels this machine clientid "0"; anything else installed on a
        // different clientid is what Steam calls streamable.
        const installedElsewhere = perClient.some(
          (p) => p && p.installed && String(p.clientid) !== "0",
        );

        const tagIds = call(a, "GetStoreTags", null) || a.store_tag || [];
        const storeTags = [];
        for (const id of Array.from(tagIds).slice(0, 20)) {
          const name = tagName(id);
          if (name) storeTags.push(name);
        }

        // A ROM lands in type-games like any other entry, so the type
        // collection alone would file 1878 emulator entries as "game". The SRM
        // collection is the only thing that distinguishes them, and BIsShortcut
        // separates the remaining non-Steam entries (Konsole, emulators) from
        // real Steam apps.
        const romPlatform = romPlatformByApp.get(appId) || null;
        const resolvedKind = romPlatform
          ? "rom"
          : call(a, "BIsShortcut", false)
            ? "shortcut"
            : kind;

        entries.push({
          appId,
          name: a.display_name || appId,
          sortAs: a.sort_as || a.display_name || appId,
          kind: resolvedKind,
          installed: installedHere,
          owned: call(a, "BIsOwned", true),
          streamable: installedElsewhere,
          sizeOnDisk: pos(a.size_on_disk),
          lastPlayed: num(a.rt_last_time_played),
          playtimeMinutes: num(a.minutes_playtime_forever),
          deckCompat: num(a.steam_deck_compat_category),
          steamOsCompat: num(a.steam_os_compat_category),
          reviewPercentage: pos(a.review_percentage),
          metacritic: pos(a.metacritic_score),
          releaseDate: pos(call(a, "GetCanonicalReleaseDate", -1)),
          purchasedAt: pos(a.rt_purchased_time),
          comingSoon: call(a, "BIsUnreleased", false),
          familyShared: call(a, "BIsBorrowed", false),
          storeTags,
          collections: collectionsByApp.get(appId) || [],
          romPlatform,
        });
      } catch (e) {
        // One malformed overview degrades one app, never the whole read.
      }
    }
  }

  let installedCount = 0;
  try { installedCount = cs.GetCollection("local-install")?.allApps?.length ?? 0; } catch (e) {}

  return { tag: "ok", entries, installedCount, resolvedTagCount };
})()`;

/**
 * Read the full owned library. Throws `SteamClientUnreachableError` when
 * Steam's stores have not booted — the caller should degrade to whatever it
 * captured last rather than treating an unreachable Steam as an empty library.
 */
export async function readSteamLibrary(
  client: SteamClient,
): Promise<SteamLibrarySnapshot> {
  const result = (await client._evaluateAsync(READ_LIBRARY)) as {
    tag?: string;
    entries?: SteamLibraryEntry[];
    installedCount?: number;
    resolvedTagCount?: number;
  };

  if (result?.tag === "no-store") {
    throw new SteamClientUnreachableError(
      "window.collectionStore / appStore are not available on the SharedJSContext " +
        "tab — has Steam's library UI opened this session?",
    );
  }
  if (result?.tag !== "ok" || !Array.isArray(result.entries)) {
    throw new Error(
      `Steam library read returned unexpected value: ${JSON.stringify(result)?.slice(0, 200)}`,
    );
  }

  return {
    entries: result.entries,
    installedCount: result.installedCount ?? 0,
    resolvedTagCount: result.resolvedTagCount ?? 0,
  };
}
