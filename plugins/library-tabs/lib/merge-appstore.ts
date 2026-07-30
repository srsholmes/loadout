/**
 * Merge Steam's live library view over the on-disk manifest scan. [iso]
 *
 * The manifest scan (`__core:game-library`) only sees what is installed — it
 * reads `appmanifest_*.acf` files, and an uninstalled game has none. On a real
 * device that meant the plugin saw 74 Steam games out of 417 owned, and every
 * rule that depends on ownership, review scores, release dates, compatibility
 * or play history had literally no data to work with.
 *
 * `readSteamLibrary` supplies the missing set and the missing fields. This
 * module decides who wins where:
 *
 * - **The manifest wins on anything measured from disk** — `sizeOnDisk` and
 *   artwork. Steam's overview populates size on 3% of apps, and the loader's
 *   local `/api/steam-grid/` routes serve the user's own custom art, which the
 *   CDN does not have.
 * - **Steam wins on everything else**, because for most of these fields the
 *   manifest has nothing at all.
 *
 * Precedence is deliberately per-field rather than per-record: a game can be
 * installed (manifest, with real art and size) *and* carry a review score and
 * a deck-compat rating that only Steam knows.
 */

import type { AppKind, DeckCompat, GameMetadata, SteamOsCompat } from "@loadout/types";
import type { SteamLibraryEntry } from "@loadout/steam-cdp";
import { emptyFeatures } from "@loadout/types";

/** Steam's decoded compatibility categories, in its own numeric order. */
const DECK_COMPAT: readonly DeckCompat[] = ["unknown", "unsupported", "playable", "verified"];
const STEAMOS_COMPAT: readonly SteamOsCompat[] = ["unknown", "unsupported", "compatible"];

function deckCompatFrom(value: number): DeckCompat {
  return DECK_COMPAT[value] ?? "unknown";
}

function steamOsCompatFrom(value: number): SteamOsCompat {
  return STEAMOS_COMPAT[value] ?? "unknown";
}

/** Steam's own kind strings, narrowed to the `AppKind` union. */
const KINDS = new Set<string>([
  "game",
  "demo",
  "dlc",
  "tool",
  "application",
  "music",
  "video",
  "series",
  "mod",
  "config",
  "beta",
  "shortcut",
  "rom",
  "unknown",
]);

function kindFrom(value: string): AppKind {
  return KINDS.has(value) ? (value as AppKind) : "unknown";
}

/**
 * Artwork for a game the manifest has never seen. The loader's local route
 * only helps for apps with cached or custom art on this machine, which an
 * uninstalled game has neither of, so the public CDN is the honest source.
 */
function cdnArt(appId: string): { headerUrl: string; capsuleUrl: string } {
  return {
    headerUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`,
    capsuleUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`,
  };
}

export interface MergeResult {
  games: GameMetadata[];
  /** Games Steam knows about that the manifest scan had never seen. */
  addedFromSteam: number;
  /** Games present in both, whose fields were enriched. */
  enriched: number;
}

/**
 * Overlay `entries` onto `manifestGames`, keyed by appId.
 *
 * `manifestGames` are already `GameMetadata` (from `adaptLibrary`), so this
 * takes the honest-but-empty Phase-1 records and fills them in, rather than
 * re-deriving everything from scratch.
 */
export function mergeSteamLibrary(
  manifestGames: readonly GameMetadata[],
  entries: readonly SteamLibraryEntry[],
): MergeResult {
  const byAppId = new Map<string, GameMetadata>();
  for (const game of manifestGames) byAppId.set(game.appId, game);

  let addedFromSteam = 0;
  let enriched = 0;

  for (const entry of entries) {
    const existing = byAppId.get(entry.appId);

    const fromSteam = {
      sortAs: entry.sortAs || entry.name,
      kind: kindFrom(entry.kind),
      installed: entry.installed,
      owned: entry.owned,
      releaseDate: entry.releaseDate,
      purchasedAt: entry.purchasedAt,
      lastPlayed: entry.lastPlayed,
      deckCompat: deckCompatFrom(entry.deckCompat),
      steamOsCompat: steamOsCompatFrom(entry.steamOsCompat),
      reviewPercentage: entry.reviewPercentage,
      metacritic: entry.metacritic,
      comingSoon: entry.comingSoon,
      familyShared: entry.familyShared,
      streamable: entry.streamable,
      storeTags: entry.storeTags,
    };

    if (existing) {
      enriched++;
      byAppId.set(entry.appId, {
        ...existing,
        ...fromSteam,
        // The manifest measured this from disk; Steam guesses at it for 3% of
        // apps. Keep the real number when we have one.
        sizeOnDisk: existing.sizeOnDisk >= 0 ? existing.sizeOnDisk : entry.sizeOnDisk,
        // Playtime may come from the `playtime` plugin, which counts sessions
        // Steam does not (non-Steam games). Prefer it when it has an answer.
        playtimeMinutes:
          existing.playtimeMinutes >= 0 ? existing.playtimeMinutes : entry.playtimeMinutes,
        // Union: the manifest reads collections out of localconfig.vdf, Steam
        // knows the live set, and each occasionally has one the other lacks.
        collections: [...new Set([...existing.collections, ...entry.collections])],
        contributors: [...new Set([...existing.contributors, "appstore" as const])],
      });
      continue;
    }

    addedFromSteam++;
    byAppId.set(entry.appId, {
      appId: entry.appId,
      name: entry.name,
      source: entry.kind === "rom" || entry.kind === "shortcut" ? "shortcut" : "steam",
      ...fromSteam,
      sizeOnDisk: entry.sizeOnDisk,
      installPath: null,
      playtimeMinutes: entry.playtimeMinutes,
      // Nothing on-disk describes an uninstalled game, so these stay unknown
      // until the appinfo provider (Phase 3) lands.
      developers: [],
      publishers: [],
      franchises: [],
      genres: [],
      features: emptyFeatures(),
      collections: entry.collections,
      ...cdnArt(entry.appId),
      contributors: ["appstore"],
    });
  }

  return { games: [...byAppId.values()], addedFromSteam, enriched };
}
