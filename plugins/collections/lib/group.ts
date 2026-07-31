/**
 * Splitting a tab's matches into sub-groups — rendered either as a
 * second-level tab strip or as titled sections within the grid.
 *
 * This is the single most-requested TabMaster feature: "sub-tabs", "groups
 * within a tab", "a collection of collections", asked at least five times
 * upstream and declined every time because its synchronous pre-filter
 * architecture had nowhere to put it. It is cheap here — grouping is a
 * partition of an already-computed match list, so it costs one pass over
 * the results, not another pass over the library.
 *
 * Two modes:
 * - `field` — auto-group by a metadata field (genre, developer, first
 *   letter, release year…). Zero configuration; good for browsing.
 * - `rules` — hand-authored sub-tabs, each with its own rule tree. This is
 *   the one people actually ask for by name.
 *
 * Isomorphic: pure, no I/O.
 */

import type { GameMetadata } from "@loadout/types";
import type {
  EvalGroupResult,
  GroupFieldKey,
  GroupSpec,
  RuleMatcher,
} from "./types";
import { buildEvalGames } from "./facts";
import type { EvalGame } from "./types";
import { UNKNOWN } from "./rules";

/** Label used when a field has no value for a game. */
const NO_VALUE = "Unknown";

/**
 * The group key(s) a game belongs to for a given field.
 *
 * Returns an array because some fields are inherently multi-valued — a
 * game has several genres and can sit in several collections, so it
 * legitimately appears under more than one heading. Single-valued fields
 * return a one-element array.
 */
function groupKeysFor(game: GameMetadata, field: GroupFieldKey): string[] {
  switch (field) {
    case "collection":
      return game.collections.length > 0 ? [...game.collections] : [NO_VALUE];
    case "genre":
      return game.genres.length > 0 ? [...game.genres] : [NO_VALUE];
    case "developer":
      return game.developers.length > 0 ? [...game.developers] : [NO_VALUE];
    case "appKind":
      return [game.kind];
    case "deckCompat":
      return [game.deckCompat];
    case "source":
      return [game.source];
    case "firstLetter": {
      const base = (game.sortAs || game.name).trim();
      const first = base.charAt(0).toUpperCase();
      // Bucket every non-letter under "#" so numbered and symbol-prefixed
      // titles don't each get their own single-entry group.
      return [/[A-Z]/.test(first) ? first : "#"];
    }
    case "releaseYear": {
      if (game.releaseDate === UNKNOWN) return [NO_VALUE];
      return [String(new Date(game.releaseDate * 1000).getUTCFullYear())];
    }
  }
}

/** Auto-grouping by a metadata field. */
function groupByField(
  games: readonly GameMetadata[],
  spec: Extract<GroupSpec, { kind: "field" }>,
): EvalGroupResult[] {
  const buckets = new Map<string, GameMetadata[]>();
  for (const game of games) {
    for (const key of groupKeysFor(game, spec.field)) {
      const bucket = buckets.get(key);
      if (bucket) bucket.push(game);
      else buckets.set(key, [game]);
    }
  }

  // `games` arrives already sorted, and Map preserves insertion order, so
  // within each bucket the tab's sort is intact. Only the *order of
  // buckets* is decided here.
  let entries = [...buckets.entries()];
  if (spec.sortGroups === "countDesc") {
    entries.sort(
      (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
    );
  } else {
    entries.sort((a, b) =>
      a[0].localeCompare(b[0], undefined, { sensitivity: "base", numeric: true }),
    );
  }

  // The unknown bucket is never interesting enough to lead. Push it last
  // whichever ordering was chosen.
  entries = [
    ...entries.filter(([k]) => k !== NO_VALUE),
    ...entries.filter(([k]) => k === NO_VALUE),
  ];

  const max = spec.maxGroups;
  if (max !== undefined && max > 0 && entries.length > max) {
    const kept = entries.slice(0, max);
    const tail = entries.slice(max);
    if (spec.otherLabel !== null) {
      // Dedupe across tail buckets: a multi-valued field can put the same
      // game in several of them, and "Other" showing a game twice is a bug.
      const seen = new Set<string>();
      const others: GameMetadata[] = [];
      for (const [, bucket] of tail) {
        for (const game of bucket) {
          if (seen.has(game.appId)) continue;
          seen.add(game.appId);
          others.push(game);
        }
      }
      if (others.length > 0) kept.push([spec.otherLabel, others]);
    }
    entries = kept;
  }

  return entries.map(([label, bucket]) => ({
    id: `field:${label}`,
    label,
    games: bucket,
  }));
}

/**
 * Manual sub-tabs. A game lands in the **first** group whose rule it
 * matches, not every matching group — so overlapping rules behave like a
 * `switch`, and a game can't be double-counted across sub-tab totals.
 */
function groupByRules(
  games: readonly GameMetadata[],
  spec: Extract<GroupSpec, { kind: "rules" }>,
  matches: RuleMatcher,
  evalGames: readonly EvalGame[],
): EvalGroupResult[] {
  const buckets = spec.groups.map((g) => ({
    id: g.id,
    label: g.label,
    games: [] as GameMetadata[],
  }));
  const residual: GameMetadata[] = [];

  // Reuse the caller's `EvalGame`s rather than rebuilding from metadata.
  //
  // Rebuilding dropped the async facts, so every fact-backed sub-tab rule
  // evaluated `indeterminate` — which the default `"pass"` policy counts as a
  // match, so the first sub-group swallowed the entire grid. The games here
  // are a subset of the caller's, so an appId lookup is all that is needed.
  const byAppId = new Map(evalGames.map((g) => [g.meta.appId, g] as const));
  const fallback = buildEvalGames(games.filter((g) => !byAppId.has(g.appId)));
  for (const g of fallback) byAppId.set(g.meta.appId, g);

  outer: for (let i = 0; i < games.length; i++) {
    const evalGame = byAppId.get(games[i]!.appId)!;
    for (let g = 0; g < spec.groups.length; g++) {
      if (matches(spec.groups[g]!.rule, evalGame)) {
        buckets[g]!.games.push(evalGame.meta);
        continue outer;
      }
    }
    residual.push(evalGame.meta);
  }

  const out = buckets.filter((b) => b.games.length > 0);
  if (spec.residualLabel !== null && residual.length > 0) {
    out.push({ id: "residual", label: spec.residualLabel, games: residual });
  }
  return out;
}

/**
 * Partition matched games according to `spec`.
 *
 * When ungrouped, returns exactly one synthetic group carrying the tab's
 * own label. Callers therefore never need to branch on grouped vs not —
 * they render `groups`, and a single group renders as a plain grid.
 */
export function groupGames(
  games: readonly GameMetadata[],
  spec: GroupSpec,
  tabLabel: string,
  matches: RuleMatcher,
  /**
   * The caller's already-normalised games, carrying the async facts. Sub-tab
   * rules are evaluated against these; without them a fact-backed rule is
   * `indeterminate` for every game and the first sub-group takes everything.
   *
   * Required, deliberately. It defaulted to `[]`, which reinstated exactly the
   * bug it was added to fix — silently, with no type error, for any caller
   * that forgot it.
   */
  evalGames: readonly EvalGame[],
): EvalGroupResult[] {
  if (spec.kind === "none") {
    return [{ id: "all", label: tabLabel, games: [...games] }];
  }
  if (spec.kind === "field") return groupByField(games, spec);
  return groupByRules(games, spec, matches, evalGames);
}
