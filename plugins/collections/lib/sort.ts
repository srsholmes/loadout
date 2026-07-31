/**
 * Multi-key sorting for a tab's matched games.
 *
 * Two properties worth stating up front, because both are things
 * TabMaster cannot do and both come up constantly in its issue tracker:
 *
 * 1. **Direction is ours.** TabMaster hooks Steam's built-in sorting and
 *    therefore inherits a fixed direction per field — its issue #315
 *    closes "sort ascending" as impossible. We sort our own array, so
 *    every field works both ways.
 * 2. **Ties break deterministically.** `sort` is a list, not a single
 *    field, and the final tiebreak is always `appId`. Without that last
 *    step a re-render could reshuffle equal-valued games, which looks like
 *    a flickering grid on a library where 400 games all have `playtime 0`.
 *
 * Unknown values (`-1`) always sort **last**, in both directions. Sorting
 * "most played first" should not open with a wall of games whose playtime
 * we failed to read.
 *
 * Isomorphic: pure, no I/O.
 */

import type { DeckCompat, GameMetadata } from "@loadout/types";
import type { SortField, SortSpec } from "./types";
import { UNKNOWN } from "./rules";

/** Worst → best, so `desc` puts Verified first. */
const DECK_COMPAT_ORDER: Record<DeckCompat, number> = {
  unknown: UNKNOWN,
  unsupported: 0,
  playable: 1,
  verified: 2,
};

/**
 * Cheap deterministic hash of a string → [0, 1). Used for `random` order.
 *
 * Deliberately *not* `Math.random()`: a tab sorted randomly must keep its
 * order across re-renders, or scrolling it becomes impossible. Seeding
 * from the appId means "random" is really "arbitrary but stable", which is
 * what people actually want from a shuffle in a library grid.
 */
function stableHash01(input: string, seed: number): number {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // >>> 0 to unsigned, then normalise.
  return (h >>> 0) / 4294967296;
}

/** Extract the comparable numeric value for a field, or `null` for text. */
function numericValue(game: GameMetadata, field: SortField, seed: number): number | null {
  switch (field) {
    case "lastPlayed":
      return game.lastPlayed;
    case "playtimeMinutes":
      return game.playtimeMinutes;
    case "sizeOnDisk":
      return game.sizeOnDisk;
    case "releaseDate":
      return game.releaseDate;
    case "reviewPercentage":
      return game.reviewPercentage;
    case "deckCompat":
      return DECK_COMPAT_ORDER[game.deckCompat];
    case "random":
      return stableHash01(game.appId, seed);
    default:
      return null;
  }
}

function textValue(game: GameMetadata, field: SortField): string {
  // `sortAs` is Steam's own sort title — it strips leading articles and
  // normalises numerals, so "The Witcher 3" files under W where players
  // expect it. Falls back to `name`, which the type guarantees non-empty.
  if (field === "sortAs") return game.sortAs || game.name;
  return game.name;
}

/**
 * Compare on one key. Returns a number suitable for `Array.sort`.
 * `dir` is applied here, but the unknown-last rule is applied *before* it
 * so unknowns stay last either way.
 */
function compareOn(
  a: GameMetadata,
  b: GameMetadata,
  spec: SortSpec,
  seed: number,
  manualIndex: ReadonlyMap<string, number> | null,
): number {
  if (spec.field === "manual") {
    if (!manualIndex) return 0;
    // Games absent from the manual order go after every placed game, in
    // their incoming (already alphabetical) order — so adding a game to
    // the library doesn't scatter it into the middle of a hand-built list.
    const ia = manualIndex.get(a.appId) ?? Number.MAX_SAFE_INTEGER;
    const ib = manualIndex.get(b.appId) ?? Number.MAX_SAFE_INTEGER;
    if (ia === ib) return 0;
    const raw = ia < ib ? -1 : 1;
    return spec.dir === "asc" ? raw : -raw;
  }

  const na = numericValue(a, spec.field, seed);
  if (na !== null) {
    const nb = numericValue(b, spec.field, seed)!;
    const aUnknown = na === UNKNOWN;
    const bUnknown = nb === UNKNOWN;
    if (aUnknown && bUnknown) return 0;
    if (aUnknown) return 1; // unknown last, regardless of dir
    if (bUnknown) return -1;
    if (na === nb) return 0;
    const raw = na < nb ? -1 : 1;
    return spec.dir === "asc" ? raw : -raw;
  }

  const raw = textValue(a, spec.field).localeCompare(
    textValue(b, spec.field),
    undefined,
    { sensitivity: "base", numeric: true },
  );
  if (raw === 0) return 0;
  return spec.dir === "asc" ? raw : -raw;
}

export interface SortOptions {
  /** Stable seed for `random`. Same seed ⇒ same order. Defaults to 0. */
  seed?: number;
  /** appIds in display order, for `field: "manual"`. */
  manualOrder?: readonly string[];
}

/**
 * Sort a copy of `games` by every spec in order, always breaking final
 * ties on `appId`. Does not mutate the input.
 */
export function sortGames(
  games: readonly GameMetadata[],
  specs: readonly SortSpec[],
  opts: SortOptions = {},
): GameMetadata[] {
  const seed = opts.seed ?? 0;
  const manualIndex = opts.manualOrder
    ? new Map(opts.manualOrder.map((id, i) => [id, i] as const))
    : null;

  return [...games].sort((a, b) => {
    for (const spec of specs) {
      const cmp = compareOn(a, b, spec, seed, manualIndex);
      if (cmp !== 0) return cmp;
    }
    // Total order guarantee — see the module header.
    return a.appId < b.appId ? -1 : a.appId > b.appId ? 1 : 0;
  });
}
