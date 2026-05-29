import { describe, it, expect } from "bun:test";
import { createLookupSlots } from "./lookup-slot";

/** Make a manually-resolvable promise the test can release on demand. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
} {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("createLookupSlots", () => {
  it("rejects non-positive / non-integer caps at construction", () => {
    expect(() => createLookupSlots(0)).toThrow();
    expect(() => createLookupSlots(-1)).toThrow();
    expect(() => createLookupSlots(1.5)).toThrow();
  });

  it("runs callers immediately when below the cap", async () => {
    const slots = createLookupSlots(2);
    const ok1 = await slots.withSlot(async () => "a");
    const ok2 = await slots.withSlot(async () => "b");
    expect(ok1).toBe("a");
    expect(ok2).toBe("b");
    expect(slots.inflight).toBe(0);
    expect(slots.queueLength).toBe(0);
  });

  it("caps in-flight at max and queues callers past the cap", async () => {
    const slots = createLookupSlots(2);
    const d1 = deferred<string>();
    const d2 = deferred<string>();
    const d3 = deferred<string>();
    const p1 = slots.withSlot(() => d1.promise);
    const p2 = slots.withSlot(() => d2.promise);
    const p3 = slots.withSlot(() => d3.promise);
    // p1 + p2 are running, p3 is queued.
    await Promise.resolve();
    expect(slots.inflight).toBe(2);
    expect(slots.queueLength).toBe(1);

    // Releasing p1 frees a slot — p3 takes it.
    d1.resolve("a");
    expect(await p1).toBe("a");
    // Give the queued caller a turn.
    await Promise.resolve();
    await Promise.resolve();
    expect(slots.inflight).toBe(2);
    expect(slots.queueLength).toBe(0);

    d2.resolve("b");
    d3.resolve("c");
    expect(await p2).toBe("b");
    expect(await p3).toBe("c");
    expect(slots.inflight).toBe(0);
  });

  it("releases the slot when fn throws (no leak)", async () => {
    const slots = createLookupSlots(1);
    await expect(
      slots.withSlot(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(slots.inflight).toBe(0);
    // Next caller can run unblocked.
    expect(await slots.withSlot(async () => "ok")).toBe("ok");
  });

  it("preserves FIFO order under saturation", async () => {
    const slots = createLookupSlots(1);
    const order: number[] = [];
    const blocker = deferred();
    // First in-flight caller holds the only slot until we release it.
    const head = slots.withSlot(async () => {
      await blocker.promise;
      order.push(0);
    });
    // Queue four more — they should run 1, 2, 3, 4 in submission order.
    const tail = Promise.all(
      [1, 2, 3, 4].map((i) => slots.withSlot(async () => order.push(i))),
    );
    await Promise.resolve();
    expect(slots.queueLength).toBe(4);
    blocker.resolve();
    await head;
    await tail;
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });
});
