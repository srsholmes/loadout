import { describe, expect, it } from "bun:test";

import { createLimiter } from "./limiter";

/** A promise plus its resolver, so a test can hold tasks open deliberately. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createLimiter", () => {
  it("rejects a nonsensical cap", () => {
    expect(() => createLimiter(0)).toThrow(/max/);
    expect(() => createLimiter(-1)).toThrow(/max/);
    expect(() => createLimiter(NaN)).toThrow(/max/);
  });

  it("runs a task and returns its value", async () => {
    const limit = createLimiter(2);
    expect(await limit(async () => 42)).toBe(42);
  });

  it("never exceeds the cap", async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const gates = Array.from({ length: 6 }, () => deferred());

    const tasks = gates.map((gate, i) =>
      limit(async () => {
        active++;
        peak = Math.max(peak, active);
        await gate.promise;
        active--;
        return i;
      }),
    );

    // Let the first wave enter.
    await Promise.resolve();
    await Promise.resolve();
    expect(peak).toBe(2);

    for (const gate of gates) gate.resolve();
    expect(await Promise.all(tasks)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it("admits queued tasks in call order (FIFO, not LIFO)", async () => {
    const limit = createLimiter(1);
    const started: number[] = [];
    const gates = [deferred(), deferred(), deferred()];

    const tasks = gates.map((gate, i) =>
      limit(async () => {
        started.push(i);
        await gate.promise;
      }),
    );

    // Release one at a time so admission order is observable.
    gates[0]!.resolve();
    await Promise.resolve();
    await Promise.resolve();
    gates[1]!.resolve();
    await Promise.resolve();
    await Promise.resolve();
    gates[2]!.resolve();
    await Promise.all(tasks);

    expect(started).toEqual([0, 1, 2]);
  });

  it("releases the slot when a task throws", async () => {
    // The bug this guards: a rejection that leaks its slot permanently
    // shrinks the pool, and enough of them deadlock every later caller.
    const limit = createLimiter(1);

    await expect(
      limit(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // The pool must be whole again.
    expect(await limit(async () => "ok")).toBe("ok");
    expect(await limit(async () => "ok again")).toBe("ok again");
  });

  it("survives a run of failures without deadlocking", async () => {
    const limit = createLimiter(2);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        limit(async () => {
          if (i % 2 === 0) throw new Error(`fail ${i}`);
          return i;
        }),
      ),
    );
    expect(results.filter((r) => r.status === "rejected").length).toBe(5);
    expect(await limit(async () => "still alive")).toBe("still alive");
  });
});
