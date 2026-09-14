import { describe, expect, it } from "bun:test";
import { ReleaseDrain, type DrainOutcome } from "./release-drain";

/** Fake clock + scheduler so the drain runs without real timers. */
function fx(maxMs = 400, tickMs = 25) {
  let t = 0;
  const held = new Set<string>();
  const finishes: Array<[DrainOutcome, number]> = [];
  let ticker: (() => void) | null = null;
  let scheduled = 0;
  let unscheduled = 0;
  const drain = new ReleaseDrain({
    maxMs,
    tickMs,
    isHeld: (k) => held.has(k),
    onFinish: (o, e) => finishes.push([o, e]),
    now: () => t,
    schedule: (fn) => {
      scheduled++;
      ticker = fn;
      return "h";
    },
    unschedule: () => {
      unscheduled++;
      ticker = null;
    },
  });
  const tick = (dt: number) => {
    t += dt;
    ticker?.();
  };
  return { drain, held, finishes, tick, counts: () => ({ scheduled, unscheduled }) };
}

describe("ReleaseDrain", () => {
  it("finishes immediately when nothing is held", () => {
    const f = fx();
    f.drain.start([]);
    expect(f.finishes).toEqual([["immediate", 0]]);
    expect(f.drain.active).toBe(false);
    expect(f.counts()).toEqual({ scheduled: 0, unscheduled: 0 });
  });

  it("waits for the snapshot to release, then finishes once via poke()", () => {
    const f = fx();
    f.held.add("nav:a");
    f.drain.start(f.held);
    expect(f.drain.active).toBe(true);
    expect(f.finishes).toEqual([]);
    f.tick(25);
    expect(f.finishes).toEqual([]); // still held
    f.held.delete("nav:a");
    f.tick(10); // clock only; the release is reported through poke()
    f.drain.poke();
    expect(f.finishes).toEqual([["complete", 35]]);
    expect(f.drain.active).toBe(false);
    expect(f.counts()).toEqual({ scheduled: 1, unscheduled: 1 });
    // Further pokes/ticks are inert.
    f.drain.poke();
    expect(f.finishes.length).toBe(1);
  });

  it("times out at maxMs while the snapshot is still down", () => {
    const f = fx(400, 25);
    f.held.add("wake:ui_guide");
    f.drain.start(f.held);
    for (let i = 0; i < 15; i++) f.tick(25); // 375 ms
    expect(f.finishes).toEqual([]);
    f.tick(25); // 400 ms
    expect(f.finishes).toEqual([["timeout", 400]]);
    expect(f.drain.active).toBe(false);
  });

  it("ignores input that starts during the drain (only the snapshot counts)", () => {
    const f = fx();
    f.held.add("nav:a");
    f.drain.start(f.held);
    // User starts tilting the stick while A is still down…
    f.held.add("nav:right");
    f.drain.poke();
    expect(f.finishes).toEqual([]);
    // …and releases A. The stick is still held but was never part of the
    // snapshot, so the drain completes.
    f.held.delete("nav:a");
    f.tick(60);
    f.drain.poke();
    expect(f.finishes).toEqual([["complete", 60]]);
  });

  it("start() while active is a no-op", () => {
    const f = fx();
    f.held.add("nav:a");
    f.drain.start(f.held);
    f.drain.start(["nav:b"]);
    expect(f.counts().scheduled).toBe(1);
    f.held.delete("nav:a");
    f.drain.poke();
    expect(f.finishes.length).toBe(1);
  });

  it("cancel() stops the timer without calling onFinish", () => {
    const f = fx();
    f.held.add("nav:a");
    f.drain.start(f.held);
    f.drain.cancel();
    expect(f.drain.active).toBe(false);
    expect(f.counts()).toEqual({ scheduled: 1, unscheduled: 1 });
    f.tick(1000);
    f.drain.poke();
    expect(f.finishes).toEqual([]);
    // cancel when idle is harmless
    f.drain.cancel();
    expect(f.counts().unscheduled).toBe(1);
  });

  it("snapshot is copied, so mutating the source set later doesn't matter", () => {
    const f = fx();
    const src = new Set(["nav:a"]);
    f.held.add("nav:a");
    f.drain.start(src);
    src.clear();
    f.tick(25);
    expect(f.finishes).toEqual([]); // still waiting on nav:a
    f.held.delete("nav:a");
    f.drain.poke();
    expect(f.finishes[0]?.[0]).toBe("complete");
  });
});
