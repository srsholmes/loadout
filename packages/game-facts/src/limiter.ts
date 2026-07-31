/**
 * A FIFO concurrency limiter.
 *
 * Extracted because two shipped plugins already hand-roll it —
 * `plugins/protondb-badges/backend.ts` (cap 4) and `plugins/hltb/backend.ts`
 * (cap 3) are near-identical copies — and library-tabs' planned
 * HTTP-backed fact resolvers need a third. Achievement Hunter's own sweep
 * runs at concurrency 1, where a limiter is redundant; it lives here for the
 * consumers that need N > 1, and so those two copies have somewhere to
 * migrate onto.
 *
 * Deliberately not a rate limiter. This caps *simultaneity*, not requests
 * per second. Pacing is the sweeper's job, because the right inter-request
 * gap depends on the source and belongs next to the backoff policy.
 */

/** Run `fn` when a slot is free. Resolves/rejects with `fn`'s result. */
export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Create a limiter allowing `max` concurrent tasks.
 *
 * Queued tasks start in call order. A task that throws still releases its
 * slot — without that, one rejection permanently shrinks the pool and a
 * few of them deadlock the caller.
 */
export function createLimiter(max: number): Limiter {
  if (!Number.isFinite(max) || max < 1) {
    throw new Error(`createLimiter: max must be >= 1, got ${max}`);
  }

  let active = 0;
  const queue: Array<() => void> = [];

  return async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) {
      await new Promise<void>((resolve) => {
        queue.push(resolve);
      });
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      // Hand the slot to the longest-waiting caller. `shift` is what makes
      // this FIFO; a `pop` here would starve early callers under load.
      const next = queue.shift();
      if (next) next();
    }
  };
}
