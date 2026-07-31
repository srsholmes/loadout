/**
 * Batched, throttled, cached resolution of per-game facts.
 *
 * A "fact" is one datum about one game that needs I/O: achievement
 * completion, HowLongToBeat time, ProtonDB tier, is-a-friend-playing.
 * This package owns the plumbing every such fact needs — the three-state
 * value type, staleness policy, batch planning, and the sweep engine that
 * paces requests and backs off when a source complains — so each consumer
 * only writes the part that is actually specific to its source.
 *
 * Consumers:
 *   - `plugins/achievement-hunter` — one resolver, batched over Steam's
 *     authenticated CM transport.
 *   - `plugins/library-tabs` — six planned resolvers feeding its rule
 *     engine, which specified this interface before it was extracted
 *     (see that plugin's `PLAN.md`, "async facts").
 *
 * See `types.ts` for why `FactValue` has three states and why
 * `FactResolver` is generic over its key.
 */

export {
  allUnavailable,
  isOk,
  missing,
  unavailable,
  type FactResolver,
  type FactRow,
  type FactValue,
  type SweepProgress,
} from "./types";

export {
  classify,
  countFresh,
  fixedTtl,
  type Staleness,
  type StalenessPolicy,
} from "./staleness";

export {
  planBatches,
  planCost,
  type PlanBatchesOptions,
} from "./plan";

export {
  createFactStore,
  type CreateFactStoreOptions,
  type FactStore,
  type FactStoreSnapshot,
} from "./store";

export { createLimiter, type Limiter } from "./limiter";

export {
  createSweeper,
  FactFetchError,
  type BackoffState,
  type BackoffStore,
  type Sweeper,
  type SweeperOptions,
} from "./sweeper";
