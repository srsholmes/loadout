/**
 * Drives a batched, throttled, resumable sweep over a library's facts.
 *
 * This is the piece that makes "don't hammer the source" a property of the
 * system rather than a promise in a comment. It owns:
 *
 *   - **one request in flight**, inherent in awaiting each batch in a loop;
 *   - **a gap between batches**, so other consumers of a shared transport
 *     get a real window rather than being starved for the sweep's duration;
 *   - **exponential backoff that survives a restart**, so a source saying
 *     "slow down" isn't re-provoked every time the app relaunches;
 *   - **resumability with no cursor** — each batch commits its rows, so a
 *     re-plan naturally skips what's already fresh (see `plan.ts`);
 *   - **an honest progress record**, including the raw request count, so a
 *     user worried about rate limits can see the cost instead of being
 *     reassured about it.
 *
 * Everything time-related is injectable (`now`, `sleep`) so the whole engine
 * is testable without real delays.
 *
 * ## Failure policy
 *
 * Two kinds of failure, because conflating them is either too brittle or too
 * reckless:
 *
 *   - **fatal** (`FactFetchError` with `fatal: true`) — the source told us
 *     to stop, e.g. a rate-limit result. Abort the sweep now and back off.
 *     Retrying into a rate limit is how an account gets flagged.
 *   - **transient** (anything else) — a timeout or a blip. Tolerated:
 *     the batch's appIds stay stale and the next sweep picks them up. Only
 *     after `maxConsecutiveFailures` in a row does the sweep give up, which
 *     is the circuit breaker for a source that's down but not saying so.
 */

import { planBatches } from "./plan";
import { countFresh, type StalenessPolicy } from "./staleness";
import type { FactStore } from "./store";
import type { FactRow, SweepProgress } from "./types";

/**
 * Thrown by a `fetchBatch` implementation to say *how* it failed.
 *
 * Plain `Error`s are treated as transient, which is the safe default for an
 * unexpected throw — a bug in a resolver shouldn't silently disable sweeping
 * for hours.
 */
export class FactFetchError extends Error {
  readonly fatal: boolean;

  constructor(message: string, opts: { fatal?: boolean; cause?: unknown } = {}) {
    super(message);
    this.name = "FactFetchError";
    this.fatal = opts.fatal ?? false;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

/** Persisted backoff, so a rate limit outlives the process that hit it. */
export interface BackoffState {
  /** Consecutive sweep-level failures. Drives the exponential delay. */
  failures: number;
  /** Unix ms before which no sweep should start. */
  retryAt: number;
  /** User-facing reason for the most recent failure. */
  reason?: string;
}

/**
 * Where backoff is persisted. Injected rather than assumed so this package
 * stays free of any particular config mechanism — a plugin wires this to
 * `@loadout/plugin-storage`, a test to a plain object.
 */
export interface BackoffStore {
  read(): Promise<BackoffState | undefined>;
  write(state: BackoffState): Promise<void>;
}

export interface SweeperOptions<V = unknown> {
  store: FactStore<V>;
  policy: StalenessPolicy<V>;
  /**
   * The sweep universe, in the order it should be fetched. Re-read on every
   * `start()` so a library change is picked up without recreating the
   * sweeper. Callers sort this — recency-first for achievements.
   */
  order: () => Promise<readonly string[]> | readonly string[];
  /**
   * Fetch one batch. Return a row per appId answered; appIds omitted from
   * the result are simply left stale. Throw {@link FactFetchError} to
   * signal failure.
   */
  fetchBatch: (appIds: string[]) => Promise<ReadonlyMap<string, FactRow<V>>>;
  batchSize: number;
  /** Delay between batches, ms. Not applied after the final batch. */
  gapMs: number;
  backoff?: BackoffStore;
  /** First backoff delay; doubles per consecutive failure. Default 60s. */
  backoffBaseMs?: number;
  /** Ceiling for the backoff delay. Default 1 hour. */
  backoffMaxMs?: number;
  /** Consecutive transient failures before giving up. Default 3. */
  maxConsecutiveFailures?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface Sweeper {
  /** Run a sweep. Resolves when it ends for any reason. Calling while a
   *  sweep is running returns the in-flight promise rather than starting a
   *  second one. */
  start(opts?: { force?: boolean }): Promise<SweepProgress>;
  pause(): void;
  resume(): void;
  cancel(): void;
  readonly progress: SweepProgress;
  /** Subscribe to progress changes. Returns an unsubscribe function. */
  onProgress(cb: (progress: SweepProgress) => void): () => void;
}

const DEFAULT_BACKOFF_BASE_MS = 60_000;
const DEFAULT_BACKOFF_MAX_MS = 60 * 60_000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A latch the sweep loop waits on while paused. */
interface PauseGate {
  promise: Promise<void>;
  release: () => void;
}

export function createSweeper<V = unknown>(opts: SweeperOptions<V>): Sweeper {
  const {
    store,
    policy,
    order,
    fetchBatch,
    batchSize,
    gapMs,
    backoff,
    backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
    backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
    maxConsecutiveFailures = DEFAULT_MAX_CONSECUTIVE_FAILURES,
    now = Date.now,
    sleep = defaultSleep,
  } = opts;

  let progress: SweepProgress = {
    status: "idle",
    scanned: 0,
    total: 0,
    requests: 0,
    elapsedMs: 0,
  };

  const listeners = new Set<(p: SweepProgress) => void>();
  let inFlight: Promise<SweepProgress> | null = null;
  let cancelled = false;
  /** Non-null while paused; resolving it releases the loop. */
  let pauseGate: PauseGate | null = null;

  /**
   * Read `pauseGate` through a function with a declared return type.
   *
   * `pause()` assigns the gate from outside `run()`'s control-flow graph, so
   * TypeScript narrows the bare variable to `null` inside the sweep loop and
   * then to `never` at the property access. Going through an annotated
   * accessor is what keeps the union honest.
   */
  function currentPauseGate(): PauseGate | null {
    return pauseGate;
  }

  function emit(patch: Partial<SweepProgress>): void {
    progress = { ...progress, ...patch };
    // Hand each listener its own frozen read so a subscriber can't mutate
    // shared state for the others.
    const snapshot = progress;
    for (const cb of listeners) {
      try {
        cb(snapshot);
      } catch {
        // A throwing subscriber must not abort the sweep.
      }
    }
  }

  function makeGate(): PauseGate {
    let release = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }

  function backoffDelayMs(failures: number): number {
    const exponent = Math.max(0, failures - 1);
    // `2 ** exponent` overflows to Infinity long before this matters, and
    // Math.min pins it to the ceiling, so no guard is needed.
    return Math.min(backoffBaseMs * 2 ** exponent, backoffMaxMs);
  }

  async function recordFailure(reason: string): Promise<number> {
    const prior = (await backoff?.read())?.failures ?? 0;
    const failures = prior + 1;
    const retryAt = now() + backoffDelayMs(failures);
    await backoff?.write({ failures, retryAt, reason });
    return retryAt;
  }

  async function clearFailures(): Promise<void> {
    const current = await backoff?.read();
    // Only write when there's something to clear — a successful sweep on a
    // healthy source shouldn't touch the config file at all.
    if (current && (current.failures > 0 || current.retryAt > 0)) {
      await backoff?.write({ failures: 0, retryAt: 0 });
    }
  }

  async function run(force: boolean): Promise<SweepProgress> {
    const startedAt = now();
    cancelled = false;
    pauseGate = null;

    // A live backoff wins over any request to sweep. Surfaced rather than
    // silently ignored so the UI can say when it will retry.
    const persisted = await backoff?.read();
    if (persisted && persisted.retryAt > startedAt) {
      emit({
        status: "backoff",
        reason: persisted.reason ?? "Waiting before contacting the source again.",
        retryAt: persisted.retryAt,
        elapsedMs: 0,
      });
      return progress;
    }

    const universe = await order();
    const { rows } = await store.load();

    // Dedupe for the denominator so "N of M" matches what's actually swept.
    const total = new Set(universe).size;
    emit({
      status: "running",
      total,
      requests: 0,
      scanned: countFresh(universe, rows, startedAt, policy),
      elapsedMs: 0,
      reason: undefined,
      retryAt: undefined,
    });

    const batches = planBatches({
      appIds: universe,
      rows,
      batchSize,
      policy,
      now: startedAt,
      force,
    });

    if (batches.length === 0) {
      emit({ status: "done", elapsedMs: now() - startedAt });
      return progress;
    }

    let live = rows;
    let consecutiveFailures = 0;
    let requests = 0;

    for (let i = 0; i < batches.length; i++) {
      if (cancelled) {
        emit({ status: "cancelled", elapsedMs: now() - startedAt });
        return progress;
      }
      const gate = currentPauseGate();
      if (gate) {
        await gate.promise;
        // `cancel()` releases the gate too, so re-check rather than assuming
        // a release means "resumed".
        if (cancelled) {
          emit({ status: "cancelled", elapsedMs: now() - startedAt });
          return progress;
        }
      }

      const batch = batches[i]!;
      try {
        const fetched = await fetchBatch(batch);
        requests++;
        live = await store.commit(fetched);
        consecutiveFailures = 0;
        await clearFailures();
        emit({
          requests,
          scanned: countFresh(universe, live, now(), policy),
          elapsedMs: now() - startedAt,
        });
      } catch (err) {
        requests++;
        const fatal = err instanceof FactFetchError && err.fatal;
        const reason = err instanceof Error ? err.message : String(err);
        consecutiveFailures++;

        if (fatal || consecutiveFailures >= maxConsecutiveFailures) {
          const retryAt = await recordFailure(reason);
          emit({
            status: fatal ? "backoff" : "error",
            reason,
            retryAt,
            requests,
            elapsedMs: now() - startedAt,
          });
          return progress;
        }
        // Transient: leave this batch's appIds stale and carry on. The next
        // sweep re-queues them, so nothing is lost.
        emit({ requests, elapsedMs: now() - startedAt });
      }

      const isLast = i === batches.length - 1;
      if (!isLast && gapMs > 0) await sleep(gapMs);
    }

    emit({
      status: cancelled ? "cancelled" : "done",
      scanned: countFresh(universe, live, now(), policy),
      elapsedMs: now() - startedAt,
    });
    return progress;
  }

  return {
    start(startOpts) {
      if (inFlight) return inFlight;
      inFlight = run(startOpts?.force ?? false).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },

    pause() {
      if (progress.status !== "running" || pauseGate) return;
      pauseGate = makeGate();
      emit({ status: "paused" });
    },

    resume() {
      if (!pauseGate) return;
      const gate = pauseGate;
      pauseGate = null;
      emit({ status: "running" });
      gate.release();
    },

    cancel() {
      cancelled = true;
      // Release the loop so it can observe the cancellation rather than
      // sitting on the pause gate forever.
      const gate = pauseGate;
      pauseGate = null;
      gate?.release();
    },

    get progress() {
      return progress;
    },

    onProgress(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
