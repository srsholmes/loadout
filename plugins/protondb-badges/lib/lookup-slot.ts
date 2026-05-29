/**
 * Concurrency-limited slot allocator.
 *
 * Used by the ProtonDB backend to cap parallel fetches: the
 * library-grid view fans out one report request per installed game
 * (routinely 100+); without throttling, protondb.com starts 429-ing
 * us. The allocator keeps a small in-flight count and queues every
 * caller past the cap.
 *
 * Extracted from `backend.ts` so the FIFO + saturation invariants
 * are independently testable. The shape is a factory that closes
 * over private state — callers get a single `withSlot` function
 * with no `this` binding, which makes it trivially usable from
 * arrow callbacks (the original `_withLookupSlot` method captured
 * `this` and needed an arrow-bind at every callsite).
 */

export interface LookupSlots {
  /** Run `fn` inside an available slot. Blocks until one is free. */
  withSlot<T>(fn: () => Promise<T>): Promise<T>;
  /** Current in-flight count. Mostly for tests / introspection. */
  readonly inflight: number;
  /** Current queue length. Mostly for tests / introspection. */
  readonly queueLength: number;
}

export function createLookupSlots(max: number): LookupSlots {
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`createLookupSlots: max must be a positive integer, got ${max}`);
  }
  let inflight = 0;
  const queue: Array<() => void> = [];

  return {
    async withSlot<T>(fn: () => Promise<T>): Promise<T> {
      if (inflight >= max) {
        await new Promise<void>((resolve) => {
          queue.push(resolve);
        });
      }
      inflight++;
      try {
        return await fn();
      } finally {
        inflight--;
        const next = queue.shift();
        if (next) next();
      }
    },
    get inflight() {
      return inflight;
    },
    get queueLength() {
      return queue.length;
    },
  };
}
