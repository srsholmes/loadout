import { describe, expect, it } from "bun:test";

import { fixedTtl, type StalenessPolicy } from "./staleness";
import type { FactStore, FactStoreSnapshot } from "./store";
import {
  createSweeper,
  FactFetchError,
  type BackoffState,
  type BackoffStore,
  type SweeperOptions,
} from "./sweeper";
import type { FactRow, SweepProgress } from "./types";

const HOUR_MS = 60 * 60 * 1000;

/** In-memory FactStore. store.test.ts covers the real disk-backed one; here
 *  we want precise control and zero I/O. */
function memStore<V>(initial: Map<string, FactRow<V>> = new Map()): FactStore<V> & {
  rows: Map<string, FactRow<V>>;
  commits: number;
} {
  const rows = new Map(initial);
  const self = {
    rows,
    commits: 0,
    async load(): Promise<FactStoreSnapshot<V>> {
      return { matched: true, rows: new Map(rows) };
    },
    async commit(updates: ReadonlyMap<string, FactRow<V>>) {
      self.commits++;
      for (const [k, v] of updates) rows.set(k, v);
      return new Map(rows);
    },
    async prune() {
      return 0;
    },
    async clear() {
      rows.clear();
    },
  };
  return self;
}

/** In-memory BackoffStore that records every write. */
function memBackoff(initial?: BackoffState) {
  let state = initial;
  const writes: BackoffState[] = [];
  const store: BackoffStore = {
    async read() {
      return state;
    },
    async write(next) {
      state = next;
      writes.push(next);
    },
  };
  return { store, writes, get state() { return state; } };
}

/** A controllable clock. `sleep` advances it instead of waiting, so tests
 *  exercise the real gap logic at zero wall-clock cost. */
function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function ids(n: number, prefix = "app"): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

/** Rows for every appId, as if just fetched. */
function fetchedRows(appIds: string[], at: number): Map<string, FactRow<number>> {
  return new Map(appIds.map((id) => [id, { at, value: 1 }]));
}

interface HarnessOverrides<V = number> extends Partial<SweeperOptions<V>> {
  policy?: StalenessPolicy<V>;
}

function harness(universe: string[], overrides: HarnessOverrides = {}) {
  const clock = fakeClock();
  const store = memStore<number>();
  const calls: string[][] = [];
  const base: SweeperOptions<number> = {
    store,
    policy: fixedTtl(24 * 60 * 60),
    order: () => universe,
    fetchBatch: async (appIds) => {
      calls.push([...appIds]);
      return fetchedRows(appIds, clock.now());
    },
    batchSize: 50,
    gapMs: 300,
    now: clock.now,
    sleep: clock.sleep,
    ...overrides,
  };
  const sweeper = createSweeper<number>(base);
  return { sweeper, store, calls, clock };
}

describe("createSweeper", () => {
  describe("batching", () => {
    it("issues exactly ceil(N/batchSize) requests", async () => {
      const { sweeper, calls } = harness(ids(137));
      const final = await sweeper.start();

      expect(calls.length).toBe(3);
      expect(final.status).toBe("done");
      expect(final.requests).toBe(3);
      expect(final.total).toBe(137);
      expect(final.scanned).toBe(137);
    });

    it("preserves the caller's order across batches", async () => {
      const universe = ["recent", "older", "oldest"];
      const { sweeper, calls } = harness(universe, { batchSize: 2 });
      await sweeper.start();
      expect(calls).toEqual([["recent", "older"], ["oldest"]]);
    });

    it("does nothing and reports done when everything is fresh", async () => {
      const universe = ids(10);
      const clock = fakeClock();
      const store = memStore<number>(fetchedRows(universe, clock.now()));
      const calls: string[][] = [];
      const sweeper = createSweeper<number>({
        store,
        policy: fixedTtl(24 * 60 * 60),
        order: () => universe,
        fetchBatch: async (a) => {
          calls.push(a);
          return fetchedRows(a, clock.now());
        },
        batchSize: 50,
        gapMs: 300,
        now: clock.now,
        sleep: clock.sleep,
      });

      const final = await sweeper.start();
      expect(calls.length).toBe(0);
      expect(final.status).toBe("done");
      expect(final.scanned).toBe(10);
    });

    it("re-fetches everything when forced", async () => {
      const universe = ids(10);
      const clock = fakeClock();
      const store = memStore<number>(fetchedRows(universe, clock.now()));
      const calls: string[][] = [];
      const sweeper = createSweeper<number>({
        store,
        policy: fixedTtl(24 * 60 * 60),
        order: () => universe,
        fetchBatch: async (a) => {
          calls.push(a);
          return fetchedRows(a, clock.now());
        },
        batchSize: 5,
        gapMs: 0,
        now: clock.now,
        sleep: clock.sleep,
      });

      await sweeper.start({ force: true });
      expect(calls.flat().length).toBe(10);
    });
  });

  describe("throttling", () => {
    it("never has two batches in flight at once", async () => {
      // The invariant the whole rate-limit story rests on. A fetchBatch that
      // records overlap proves it rather than trusting the loop's shape.
      let inFlight = 0;
      let peak = 0;
      const clock = fakeClock();
      const { sweeper } = harness(ids(200), {
        batchSize: 10,
        gapMs: 0,
        now: clock.now,
        sleep: clock.sleep,
        fetchBatch: async (appIds) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await Promise.resolve();
          await Promise.resolve();
          inFlight--;
          return fetchedRows(appIds, clock.now());
        },
      });

      await sweeper.start();
      expect(peak).toBe(1);
      expect(inFlight).toBe(0);
    });

    it("waits gapMs between batches but not after the last", async () => {
      const sleeps: number[] = [];
      const clock = fakeClock();
      const { sweeper } = harness(ids(30), {
        batchSize: 10,
        gapMs: 300,
        now: clock.now,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock.advance(ms);
        },
      });

      await sweeper.start();
      // 3 batches → 2 gaps. A trailing gap would make every sweep look
      // slower than it is and delays nothing useful.
      expect(sleeps).toEqual([300, 300]);
    });

    it("skips sleeping entirely when gapMs is 0", async () => {
      const sleeps: number[] = [];
      const { sweeper } = harness(ids(30), {
        batchSize: 10,
        gapMs: 0,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });
      await sweeper.start();
      expect(sleeps).toEqual([]);
    });
  });

  describe("resumability", () => {
    it("commits after every batch so an interrupted sweep resumes", async () => {
      const universe = ids(100);
      const clock = fakeClock();
      const store = memStore<number>();
      let call = 0;

      const first = createSweeper<number>({
        store,
        policy: fixedTtl(24 * 60 * 60),
        order: () => universe,
        fetchBatch: async (appIds) => {
          call++;
          // Die partway through the third batch.
          if (call === 3) throw new FactFetchError("crash", { fatal: true });
          return fetchedRows(appIds, clock.now());
        },
        batchSize: 25,
        gapMs: 0,
        now: clock.now,
        sleep: clock.sleep,
      });

      const stopped = await first.start();
      expect(stopped.status).toBe("backoff");
      // Two batches committed before the failure.
      expect(store.rows.size).toBe(50);

      // A fresh sweeper with no persisted cursor picks up the remainder.
      const resumedCalls: string[][] = [];
      const second = createSweeper<number>({
        store,
        policy: fixedTtl(24 * 60 * 60),
        order: () => universe,
        fetchBatch: async (appIds) => {
          resumedCalls.push([...appIds]);
          return fetchedRows(appIds, clock.now());
        },
        batchSize: 25,
        gapMs: 0,
        now: clock.now,
        sleep: clock.sleep,
      });

      const done = await second.start();
      expect(done.status).toBe("done");
      expect(resumedCalls.flat().length).toBe(50);
      expect(resumedCalls[0]![0]).toBe(universe[50]);
      expect(store.rows.size).toBe(100);
    });
  });

  describe("failure handling", () => {
    it("tolerates a transient failure and carries on", async () => {
      const clock = fakeClock();
      let call = 0;
      const { sweeper, store } = harness(ids(30), {
        batchSize: 10,
        gapMs: 0,
        now: clock.now,
        sleep: clock.sleep,
        fetchBatch: async (appIds) => {
          call++;
          if (call === 2) throw new Error("timeout");
          return fetchedRows(appIds, clock.now());
        },
      });

      const final = await sweeper.start();
      expect(final.status).toBe("done");
      // Batch 2's appIds stay stale; the other 20 landed.
      expect(store.rows.size).toBe(20);
    });

    it("gives up after maxConsecutiveFailures in a row", async () => {
      const { sweeper } = harness(ids(100), {
        batchSize: 10,
        gapMs: 0,
        maxConsecutiveFailures: 3,
        fetchBatch: async () => {
          throw new Error("source is down");
        },
      });

      const final = await sweeper.start();
      expect(final.status).toBe("error");
      expect(final.reason).toBe("source is down");
      expect(final.requests).toBe(3);
    });

    it("resets the consecutive counter after a success", async () => {
      // Two failures, a success, then two more must NOT trip a limit of 3.
      let call = 0;
      const { sweeper } = harness(ids(60), {
        batchSize: 10,
        gapMs: 0,
        maxConsecutiveFailures: 3,
        fetchBatch: async (appIds) => {
          call++;
          if (call === 1 || call === 2 || call === 4 || call === 5) {
            throw new Error("blip");
          }
          return fetchedRows(appIds, 1);
        },
      });

      const final = await sweeper.start();
      expect(final.status).toBe("done");
      expect(final.requests).toBe(6);
    });

    it("stops immediately on a fatal error, without waiting for the limit", async () => {
      // A rate-limit result must not be retried — that is how an account
      // gets flagged.
      const { sweeper, calls } = harness(ids(100), {
        batchSize: 10,
        gapMs: 0,
        maxConsecutiveFailures: 3,
        fetchBatch: async () => {
          throw new FactFetchError("LimitExceeded", { fatal: true });
        },
      });

      const final = await sweeper.start();
      expect(final.status).toBe("backoff");
      expect(final.reason).toBe("LimitExceeded");
      expect(calls.length).toBe(0);
      expect(final.requests).toBe(1);
    });

    it("treats a plain Error as transient, not fatal", async () => {
      // An unexpected throw in a resolver is a bug, and must not silently
      // disable sweeping for an hour.
      const { sweeper } = harness(ids(10), {
        batchSize: 10,
        gapMs: 0,
        maxConsecutiveFailures: 5,
        fetchBatch: async () => {
          throw new TypeError("undefined is not a function");
        },
      });
      const final = await sweeper.start();
      // One batch, one transient failure, under the limit → sweep completes.
      expect(final.status).toBe("done");
    });
  });

  describe("persisted backoff", () => {
    it("writes an exponentially growing retryAt on failure", async () => {
      const backoff = memBackoff();
      const clock = fakeClock();
      const { sweeper } = harness(ids(10), {
        batchSize: 10,
        gapMs: 0,
        backoff: backoff.store,
        backoffBaseMs: 1000,
        now: clock.now,
        sleep: clock.sleep,
        fetchBatch: async () => {
          throw new FactFetchError("LimitExceeded", { fatal: true });
        },
      });

      await sweeper.start();
      expect(backoff.state?.failures).toBe(1);
      expect(backoff.state?.retryAt).toBe(clock.now() + 1000);
      expect(backoff.state?.reason).toBe("LimitExceeded");
    });

    it("doubles the delay across restarts", async () => {
      const backoff = memBackoff({ failures: 2, retryAt: 0 });
      const clock = fakeClock();
      const { sweeper } = harness(ids(10), {
        batchSize: 10,
        gapMs: 0,
        backoff: backoff.store,
        backoffBaseMs: 1000,
        now: clock.now,
        sleep: clock.sleep,
        fetchBatch: async () => {
          throw new FactFetchError("LimitExceeded", { fatal: true });
        },
      });

      await sweeper.start();
      // Third consecutive failure → base * 2^2.
      expect(backoff.state?.failures).toBe(3);
      expect(backoff.state?.retryAt).toBe(clock.now() + 4000);
    });

    it("caps the delay at backoffMaxMs", async () => {
      const backoff = memBackoff({ failures: 30, retryAt: 0 });
      const clock = fakeClock();
      const { sweeper } = harness(ids(10), {
        batchSize: 10,
        gapMs: 0,
        backoff: backoff.store,
        backoffBaseMs: 1000,
        backoffMaxMs: 5000,
        now: clock.now,
        sleep: clock.sleep,
        fetchBatch: async () => {
          throw new FactFetchError("nope", { fatal: true });
        },
      });

      await sweeper.start();
      expect(backoff.state?.retryAt).toBe(clock.now() + 5000);
    });

    it("refuses to sweep while a backoff is live, and says when it expires", async () => {
      const clock = fakeClock();
      const retryAt = clock.now() + HOUR_MS;
      const backoff = memBackoff({ failures: 1, retryAt, reason: "LimitExceeded" });
      const { sweeper, calls } = harness(ids(50), {
        backoff: backoff.store,
        now: clock.now,
        sleep: clock.sleep,
      });

      const final = await sweeper.start();
      expect(final.status).toBe("backoff");
      expect(final.retryAt).toBe(retryAt);
      expect(final.reason).toBe("LimitExceeded");
      expect(calls.length).toBe(0);
    });

    it("sweeps once the backoff has expired", async () => {
      const clock = fakeClock();
      const backoff = memBackoff({ failures: 1, retryAt: clock.now() - 1 });
      const { sweeper, calls } = harness(ids(20), {
        batchSize: 10,
        gapMs: 0,
        backoff: backoff.store,
        now: clock.now,
        sleep: clock.sleep,
      });

      const final = await sweeper.start();
      expect(final.status).toBe("done");
      expect(calls.length).toBe(2);
    });

    it("clears the failure count after a successful batch", async () => {
      const clock = fakeClock();
      const backoff = memBackoff({ failures: 2, retryAt: clock.now() - 1 });
      const { sweeper } = harness(ids(10), {
        batchSize: 10,
        gapMs: 0,
        backoff: backoff.store,
        now: clock.now,
        sleep: clock.sleep,
      });

      await sweeper.start();
      expect(backoff.state).toEqual({ failures: 0, retryAt: 0 });
    });

    it("does not touch the backoff store on a clean sweep from a clean state", async () => {
      // A healthy source shouldn't cause a config write on every sweep.
      const backoff = memBackoff();
      const { sweeper } = harness(ids(10), {
        batchSize: 10,
        gapMs: 0,
        backoff: backoff.store,
      });

      await sweeper.start();
      expect(backoff.writes).toEqual([]);
    });

    it("works with no backoff store at all", async () => {
      const { sweeper } = harness(ids(20), { batchSize: 10, gapMs: 0 });
      const final = await sweeper.start();
      expect(final.status).toBe("done");
    });
  });

  describe("pause, resume and cancel", () => {
    it("halts between batches when paused and continues when resumed", async () => {
      const clock = fakeClock();
      const calls: string[][] = [];
      const { sweeper } = harness(ids(30), {
        batchSize: 10,
        gapMs: 0,
        now: clock.now,
        sleep: clock.sleep,
        fetchBatch: async (appIds) => {
          calls.push([...appIds]);
          if (calls.length === 1) sweeper.pause();
          return fetchedRows(appIds, clock.now());
        },
      });

      const running = sweeper.start();
      // Let the first batch land and the loop reach the pause gate.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(sweeper.progress.status).toBe("paused");
      expect(calls.length).toBe(1);

      sweeper.resume();
      const final = await running;
      expect(final.status).toBe("done");
      expect(calls.length).toBe(3);
    });

    it("stops with status cancelled and leaves committed rows intact", async () => {
      const clock = fakeClock();
      const calls: string[][] = [];
      const { sweeper, store } = harness(ids(50), {
        batchSize: 10,
        gapMs: 0,
        now: clock.now,
        sleep: clock.sleep,
        fetchBatch: async (appIds) => {
          calls.push([...appIds]);
          if (calls.length === 2) sweeper.cancel();
          return fetchedRows(appIds, clock.now());
        },
      });

      const final = await sweeper.start();
      expect(final.status).toBe("cancelled");
      expect(calls.length).toBe(2);
      // Cancelling is not rolling back — what was fetched stays cached.
      expect(store.rows.size).toBe(20);
    });

    it("releases a paused sweep when cancelled", async () => {
      // Without this, cancel() on a paused sweep would hang forever.
      const clock = fakeClock();
      const calls: string[][] = [];
      const { sweeper } = harness(ids(30), {
        batchSize: 10,
        gapMs: 0,
        now: clock.now,
        sleep: clock.sleep,
        fetchBatch: async (appIds) => {
          calls.push([...appIds]);
          if (calls.length === 1) sweeper.pause();
          return fetchedRows(appIds, clock.now());
        },
      });

      const running = sweeper.start();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(sweeper.progress.status).toBe("paused");

      sweeper.cancel();
      const final = await running;
      expect(final.status).toBe("cancelled");
      expect(calls.length).toBe(1);
    });

    it("ignores resume when not paused and pause when not running", async () => {
      const { sweeper } = harness(ids(10), { batchSize: 10, gapMs: 0 });
      sweeper.pause();
      expect(sweeper.progress.status).toBe("idle");
      sweeper.resume();
      expect(sweeper.progress.status).toBe("idle");
      expect((await sweeper.start()).status).toBe("done");
    });
  });

  describe("concurrent starts", () => {
    it("returns the in-flight sweep rather than starting a second", async () => {
      const clock = fakeClock();
      const calls: string[][] = [];
      const { sweeper } = harness(ids(30), {
        batchSize: 10,
        gapMs: 0,
        now: clock.now,
        sleep: clock.sleep,
        fetchBatch: async (appIds) => {
          calls.push([...appIds]);
          return fetchedRows(appIds, clock.now());
        },
      });

      const a = sweeper.start();
      const b = sweeper.start();
      expect(a).toBe(b);
      await Promise.all([a, b]);
      // 3 batches, not 6.
      expect(calls.length).toBe(3);
    });

    it("can be started again after finishing", async () => {
      const { sweeper, calls } = harness(ids(10), { batchSize: 10, gapMs: 0 });
      await sweeper.start();
      expect(calls.length).toBe(1);
      // Everything is fresh now, so a second sweep is a no-op...
      await sweeper.start();
      expect(calls.length).toBe(1);
      // ...unless forced.
      await sweeper.start({ force: true });
      expect(calls.length).toBe(2);
    });
  });

  describe("progress reporting", () => {
    it("reports scanned rising monotonically to total", async () => {
      const seen: SweepProgress[] = [];
      const { sweeper } = harness(ids(50), { batchSize: 10, gapMs: 0 });
      sweeper.onProgress((p) => seen.push(p));

      await sweeper.start();

      const scanned = seen.map((p) => p.scanned);
      for (let i = 1; i < scanned.length; i++) {
        expect(scanned[i]!).toBeGreaterThanOrEqual(scanned[i - 1]!);
      }
      expect(scanned.at(-1)).toBe(50);
      expect(seen.at(-1)!.status).toBe("done");
    });

    it("counts a partially-answered batch honestly", async () => {
      // A source that answers 6 of 10 must not report 10 scanned.
      const clock = fakeClock();
      const { sweeper } = harness(ids(10), {
        batchSize: 10,
        gapMs: 0,
        now: clock.now,
        sleep: clock.sleep,
        fetchBatch: async (appIds) =>
          fetchedRows(appIds.slice(0, 6), clock.now()),
      });

      const final = await sweeper.start();
      expect(final.scanned).toBe(6);
      expect(final.total).toBe(10);
    });

    it("dedupes the total so N-of-M matches what is swept", async () => {
      const { sweeper, calls } = harness(["a", "b", "a", "c"], {
        batchSize: 10,
        gapMs: 0,
      });
      const final = await sweeper.start();
      expect(final.total).toBe(3);
      expect(calls[0]).toEqual(["a", "b", "c"]);
    });

    it("accumulates elapsedMs from the injected clock", async () => {
      const clock = fakeClock();
      const { sweeper } = harness(ids(30), {
        batchSize: 10,
        gapMs: 300,
        now: clock.now,
        sleep: clock.sleep,
      });
      const final = await sweeper.start();
      // Two 300ms gaps between three batches.
      expect(final.elapsedMs).toBe(600);
    });

    it("keeps sweeping when a progress subscriber throws", async () => {
      const { sweeper } = harness(ids(20), { batchSize: 10, gapMs: 0 });
      sweeper.onProgress(() => {
        throw new Error("bad subscriber");
      });
      expect((await sweeper.start()).status).toBe("done");
    });

    it("stops notifying after unsubscribe", async () => {
      const seen: SweepProgress[] = [];
      const { sweeper } = harness(ids(20), { batchSize: 10, gapMs: 0 });
      const off = sweeper.onProgress((p) => seen.push(p));
      off();
      await sweeper.start();
      expect(seen).toEqual([]);
    });
  });
});
