/**
 * Turns a raw metadata snapshot plus a bag of prefetched async facts into
 * the {@link EvalGame} array the evaluator consumes.
 *
 * This module is the seam that makes async data a first-class citizen
 * without making evaluation async. TabMaster's filter signature is
 * `(params, appOverview) => boolean` with nowhere to await, which its
 * maintainers cite as the reason for refusing live player counts,
 * ProtonDB, HowLongToBeat, install paths and friends-playing-now. Here,
 * anything that needs I/O is resolved *outside* the evaluator — batched
 * over the whole library, cached, and materialised onto `facts` — and the
 * tree walk stays a synchronous, allocation-light loop.
 *
 * Isomorphic: no `node:*`, no RPC. Safe to bundle into the CEF webview.
 */

import type { GameMetadata } from "@loadout/types";
import type { EvalGame, FactKey, FactValue } from "./types";

/**
 * Lower-case a list into a Set. Case folding happens here, once per game
 * per snapshot, rather than inside a predicate that runs
 * games × rules times per render.
 */
function lowerSet(values: readonly string[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const v of values) out.add(v.toLowerCase());
  return out;
}

/**
 * Build the evaluator's input.
 *
 * @param games   The snapshot from `__core:game-metadata`.
 * @param facts   Per-fact maps of `appId → FactValue`. A fact absent from
 *                this bag entirely is treated as `{ state: "loading" }` by
 *                the predicates, not as a failure — the first render of a
 *                tab happens before any resolver has finished, and it must
 *                show games rather than an empty grid.
 */
export function buildEvalGames(
  games: readonly GameMetadata[],
  facts: Partial<Record<FactKey, ReadonlyMap<string, FactValue>>> = {},
): EvalGame[] {
  // Materialise the fact keys once; `Object.keys` inside the loop would
  // allocate per game.
  const factKeys = Object.keys(facts) as FactKey[];

  return games.map((meta) => {
    const perGame: Partial<Record<FactKey, FactValue>> = {};
    for (const key of factKeys) {
      // A key present in the bag means its resolver has run. A game with no
      // entry under that key is therefore answered-and-empty — `missing`, a
      // definite `false` — not `loading`.
      //
      // Leaving it absent made a sparse map (the natural way to write a
      // resolver: only emit what you found) turn every unanswered game into
      // `indeterminate`, which the default `"pass"` policy counts as a match.
      // A ProtonDB rule then matched the entire library while `blockedFacts`
      // stayed empty, so the diagnostics said nothing.
      perGame[key] = facts[key]?.get(meta.appId) ?? { state: "missing" };
    }

    return {
      meta,
      norm: {
        nameLower: meta.name.toLowerCase(),
        // Collections are matched by id, which Steam already emits in a
        // stable case — but user tags land in the same array and users
        // type those by hand, so fold anyway.
        collectionSet: lowerSet(meta.collections),
        storeTagSet: lowerSet(meta.storeTags),
        genreSet: lowerSet(meta.genres),
        developerSet: lowerSet(meta.developers),
        publisherSet: lowerSet(meta.publishers),
      },
      facts: perGame,
    };
  });
}
