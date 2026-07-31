/**
 * Turning "here is my library" into "here are the batches to fetch".
 *
 * Pure: takes the appIds, the rows already cached, a clock reading and a
 * staleness policy; returns the batches. No I/O, no state, so the whole
 * scheduling decision is unit-testable at exact TTL boundaries.
 *
 * Two properties matter and both are load-bearing:
 *
 * 1. **Input order is preserved.** Callers sort `appIds` before calling —
 *    for achievements that is recency-first, so the games on the dashboard's
 *    hero row land in batch 1 and the view feels instant even though the
 *    sweep runs for another twenty seconds. The planner must not re-sort.
 *
 * 2. **Resumability falls out.** There is no cursor to persist. Each batch
 *    commits its rows to the store, so re-planning after a restart simply
 *    finds those rows fresh and skips them. A sweep interrupted at batch 17
 *    of 40 resumes at 17 because the first 16 are no longer stale — not
 *    because anything wrote down "17".
 */

import { classify, type StalenessPolicy } from "./staleness";
import type { FactRow } from "./types";

export interface PlanBatchesOptions<V = unknown> {
  /**
   * The sweep universe, already in the order it should be fetched.
   * Duplicates are collapsed, keeping first position.
   */
  appIds: readonly string[];
  /** Rows already cached, keyed by appId. */
  rows: ReadonlyMap<string, FactRow<V>>;
  /** Max appIds per batch. Must be ≥ 1. */
  batchSize: number;
  policy: StalenessPolicy<V>;
  /** Unix ms. Injected rather than read from the clock so tests are exact. */
  now: number;
  /**
   * Ignore TTLs and re-fetch everything — the manual "Rescan" button.
   * Note this still respects `appIds`, so it is a rescan of the current
   * library, not of whatever the cache happens to remember.
   */
  force?: boolean;
}

/**
 * The appIds that need fetching, chunked into batches.
 *
 * Returns `[]` when everything is fresh — callers can treat an empty plan
 * as "nothing to do" without a separate check.
 */
export function planBatches<V = unknown>(
  opts: PlanBatchesOptions<V>,
): string[][] {
  const { appIds, rows, batchSize, policy, now, force = false } = opts;

  if (batchSize < 1 || !Number.isFinite(batchSize)) {
    throw new Error(`planBatches: batchSize must be >= 1, got ${batchSize}`);
  }

  const due: string[] = [];
  const seen = new Set<string>();

  for (const appId of appIds) {
    // Collapse duplicates rather than fetching the same app twice in one
    // sweep. `appStore.allApps` can carry the same appid twice for a game
    // that is both owned and family-shared.
    if (seen.has(appId)) continue;
    seen.add(appId);

    if (force || classify(rows.get(appId), now, policy) !== "fresh") {
      due.push(appId);
    }
  }

  const batches: string[][] = [];
  for (let i = 0; i < due.length; i += batchSize) {
    batches.push(due.slice(i, i + batchSize));
  }
  return batches;
}

/**
 * How many requests a plan will cost, without building it.
 *
 * Exposed so the UI can say "Rescan (40 requests)" on a button *before* the
 * user commits to it. Showing the price up front is what turns a
 * rate-limit worry into an informed choice.
 */
export function planCost<V = unknown>(opts: PlanBatchesOptions<V>): number {
  return planBatches(opts).length;
}
