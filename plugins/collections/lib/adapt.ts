/**
 * Adapting Phase-1 data sources into `GameMetadata`.
 *
 * The rule engine is written against `GameMetadata`, the full record that
 * `__core:game-metadata` will serve from Phase 2 onwards. Phase 1 has no such
 * service, only `__core:game-library` (installed apps + shortcuts +
 * collections) and the `playtime` plugin.
 *
 * Rather than write the engine against the smaller type and migrate it later,
 * we adapt upward here: every field a Phase-1 source can't answer gets its
 * unknown sentinel, and `contributors` records who actually spoke. The
 * evaluator, the builder and the UI are then already written against their
 * final input, and Phase 2 replaces this module's *caller* without touching
 * anything downstream.
 *
 * Being honest about what we don't know is what makes that safe. If this
 * returned `0` for an unknown release date instead of `-1`, every
 * release-date rule would quietly treat the whole library as released in
 * 1970 — and the bug would only surface once Phase 2 made the field real.
 *
 * Isomorphic: pure, no I/O.
 */

import type { GameInfo, GameMetadata, MetadataProviderId, ProviderState } from "@loadout/types";
import { emptyFeatures } from "@loadout/types";

/** `plugins/playtime`'s `getSteamPlaytime()` row shape. */
export interface PlaytimeRow {
  appId: string;
  gameName: string;
  totalMs: number;
}

export interface AdaptOptions {
  /** Playtime from the `playtime` plugin, if it's installed and enabled. */
  playtime?: readonly PlaytimeRow[];
  /**
   * Last-played times, epoch seconds, keyed by appId. Not available in
   * Phase 1 — `playtime` exposes durations, not timestamps — so callers pass
   * nothing and the field stays honestly unknown.
   */
  lastPlayed?: ReadonlyMap<string, number>;
}

/**
 * Turn a `__core:game-library` scan into `GameMetadata`.
 *
 * Note what is deliberately *not* inferred:
 * - `owned` mirrors `installed`. Phase 1 has no ownership source at all
 *   (appmanifest scanning only sees installed games), so claiming otherwise
 *   would be a lie. The provider state below says so, and the builder
 *   disables owned-only rules on the strength of it.
 * - `kind` is `"shortcut"` for shortcuts and `"game"` otherwise. We cannot
 *   tell a demo or a soundtrack from a game without appinfo, so everything
 *   Steam-shaped reads as a game rather than being guessed at.
 */
export function adaptLibrary(
  games: readonly GameInfo[],
  opts: AdaptOptions = {},
): GameMetadata[] {
  const playtimeByApp = new Map<string, number>();
  for (const row of opts.playtime ?? []) {
    // GameStats.totalMs -> minutes, floored. A session under a minute reads
    // as 0, which is correct: 0 means "played, but not measurably".
    playtimeByApp.set(row.appId, Math.floor(row.totalMs / 60_000));
  }

  return games.map((game): GameMetadata => {
    const playtimeMinutes = playtimeByApp.get(game.appId);
    const lastPlayed = opts.lastPlayed?.get(game.appId);

    return {
      appId: game.appId,
      name: game.name,
      // No `common.sortas` until appinfo lands; the name is the honest
      // fallback and the type guarantees it is non-empty.
      sortAs: game.name,
      kind: game.source === "shortcut" ? "shortcut" : "game",
      source: game.source,
      installed: true, // game-library only ever reports installed apps
      owned: true,
      // Shortcuts genuinely occupy 0 as far as Steam is concerned; a Steam
      // app reporting 0 in its manifest means the size is unknown.
      sizeOnDisk:
        game.source === "shortcut" ? 0 : game.sizeOnDisk > 0 ? game.sizeOnDisk : -1,
      installPath: null,
      releaseDate: -1,
      purchasedAt: -1,
      lastPlayed: lastPlayed ?? -1,
      playtimeMinutes: playtimeMinutes ?? -1,
      deckCompat: "unknown",
      steamOsCompat: "unknown",
      reviewPercentage: -1,
      metacritic: -1,
      comingSoon: false,
      familyShared: false,
      streamable: false,
      developers: [],
      publishers: [],
      franchises: [],
      genres: [],
      storeTags: [],
      collections: [...game.tags],
      features: emptyFeatures(),
      headerUrl: game.headerUrl,
      capsuleUrl: game.capsuleUrl,
      contributors: playtimeMinutes !== undefined
        ? ["manifest", "appstore"]
        : ["manifest"],
    };
  });
}

/**
 * Provider states for a Phase-1 snapshot.
 *
 * `appstore` and `appinfo` report `unavailable` with a plain-English reason
 * rather than being omitted. That reason is rendered verbatim next to any
 * rule those providers own, so a user who builds a "Deck Verified" tab is
 * told *why* it can't be evaluated instead of watching it come back empty.
 */
export function phase1Providers(
  hasPlaytime: boolean,
  now: number = Date.now(),
): Record<MetadataProviderId, ProviderState> {
  return {
    manifest: {
      status: "ok",
      capturedAt: now,
      ownsFields: ["installed", "sizeOnDisk", "name", "collections"],
    },
    appstore: {
      status: hasPlaytime ? "stale" : "unavailable",
      capturedAt: hasPlaytime ? now : 0,
      reason: hasPlaytime
        ? "Only play time is available yet — ownership, reviews and Deck ratings need a newer Loadout."
        : "Ownership, reviews, Deck ratings and play time aren't available yet.",
      ownsFields: [
        "owned",
        "lastPlayed",
        "playtimeMinutes",
        "reviewPercentage",
        "deckCompat",
        "steamOsCompat",
        "purchasedAt",
        "comingSoon",
        "familyShared",
        "streamable",
        "storeTags",
      ],
    },
    appinfo: {
      status: "unavailable",
      capturedAt: 0,
      reason: "Genres, developers and Metacritic scores aren't available yet.",
      ownsFields: [
        "genres",
        "developers",
        "publishers",
        "franchises",
        "metacritic",
        "features",
        "sortAs",
        "releaseDate",
        "kind",
      ],
    },
  };
}

/**
 * Provider states once Steam's live library has been read.
 *
 * `appstore` becomes `ok` and takes ownership of `kind` and `releaseDate` from
 * `appinfo`: the app-type collections classify every app, and
 * `GetCanonicalReleaseDate()` is populated more often than either raw `rt_*`
 * field. `appinfo` keeps only what genuinely needs `appinfo.vdf` — genres,
 * studios, Metacritic and the feature flags.
 */
export function appStoreProviders(
  hasPlaytime: boolean,
  now: number = Date.now(),
): Record<MetadataProviderId, ProviderState> {
  const base = phase1Providers(hasPlaytime, now);
  return {
    manifest: base.manifest,
    appstore: {
      status: "ok",
      capturedAt: now,
      ownsFields: [
        "owned",
        "installed",
        "kind",
        "lastPlayed",
        "playtimeMinutes",
        "reviewPercentage",
        "deckCompat",
        "steamOsCompat",
        "purchasedAt",
        "releaseDate",
        "comingSoon",
        "familyShared",
        "streamable",
        "storeTags",
      ],
    },
    appinfo: {
      ...base.appinfo,
      reason: "Genres, developers and Metacritic scores aren't available yet.",
      ownsFields: ["genres", "developers", "publishers", "franchises", "metacritic", "features"],
    },
  };
}
