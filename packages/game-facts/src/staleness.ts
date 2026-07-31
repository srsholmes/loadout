/**
 * Deciding which cached rows are worth re-fetching.
 *
 * A single TTL per fact is the obvious design and it is wrong, because the
 * *value* tells you how long it stays true. Achievement completion is the
 * motivating case:
 *
 *   - a game with no achievements at all will never have any    → 30 days
 *   - a game already at 100% cannot go up                        →  7 days
 *   - a game part-way through changes every session              → 24 hours
 *
 * In a real Steam library 40–60% of entries are in the first bucket, so a
 * value-dependent TTL is the difference between a cold sweep every day and
 * a handful of requests. That is the whole reason this module exists rather
 * than a `ttlSec` number.
 *
 * The policy is a function of the stored value, so it stays pure and
 * testable at exact boundaries — no clock, no I/O.
 */

import type { FactRow } from "./types";

/**
 * How fresh a row is.
 *
 * `missing` and `stale` both mean "fetch it"; they are distinguished
 * because the UI counts them differently — `scanned` is rows we have *ever*
 * answered, so a stale row still counts and a missing one does not.
 */
export type Staleness = "fresh" | "stale" | "missing";

export interface StalenessPolicy<V = unknown> {
  /**
   * Freshness window in seconds for a row holding `value`.
   *
   * Return `Infinity` for "never re-fetch once known" — the row is then
   * permanently `fresh`, which is the correct answer for a genuinely
   * immutable fact and the strongest possible rate-limit mitigation.
   * Return `0` to force a re-fetch on every sweep.
   */
  ttlSecFor(value: V): number;
}

/** A policy with one TTL for every value — the degenerate case. */
export function fixedTtl<V = unknown>(ttlSec: number): StalenessPolicy<V> {
  return { ttlSecFor: () => ttlSec };
}

/**
 * Classify one row against the clock.
 *
 * `row === undefined` is `missing`: nothing has been fetched. A row whose
 * `at` is in the future (clock skew, a restored backup) is treated as
 * fresh rather than stale — re-fetching on a skewed clock would spin.
 */
export function classify<V>(
  row: FactRow<V> | undefined,
  now: number,
  policy: StalenessPolicy<V>,
): Staleness {
  if (!row) return "missing";

  const ttlSec = policy.ttlSecFor(row.value);
  if (!Number.isFinite(ttlSec)) return "fresh";
  if (ttlSec <= 0) return "stale";

  const ageMs = now - row.at;
  // Future-dated rows (clock skew) read as fresh, never stale.
  if (ageMs < 0) return "fresh";

  return ageMs < ttlSec * 1000 ? "fresh" : "stale";
}

/**
 * Count how many of `appIds` currently have a fresh row.
 *
 * This is the numerator behind "340 of 812 games scanned". It counts
 * `fresh` only — a stale row is one we are about to re-ask about, and
 * claiming it as scanned would make the progress bar go backwards when the
 * sweep re-queues it.
 */
export function countFresh<V>(
  appIds: readonly string[],
  rows: ReadonlyMap<string, FactRow<V>>,
  now: number,
  policy: StalenessPolicy<V>,
): number {
  let n = 0;
  for (const appId of appIds) {
    if (classify(rows.get(appId), now, policy) === "fresh") n++;
  }
  return n;
}
