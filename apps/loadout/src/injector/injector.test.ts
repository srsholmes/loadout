import { describe, expect, it } from "bun:test";
import { maybeGiveUp } from "./injector";

// The injectBPMBundles (A-019) and buildPanelMountScript (A-008) test
// blocks were removed alongside their subjects — issue #60: the
// plugin-bundle / panel-mount path was dead code.

/**
 * Audit A-021: when the injector exhausted its crash-retry budget it
 * just flipped `running = false` and disappeared. The host now passes an
 * `onGiveUp` callback so a `__system` event can be broadcast. The
 * decision lives in `maybeGiveUp` so it is testable in isolation —
 * driving the full 5-retry × 5s loop in a unit test is not.
 */
describe("maybeGiveUp (A-021)", () => {
  it("returns false and does not fire callback below threshold", () => {
    const calls: Array<{ reason: string; crashCount: number }> = [];
    const cb = (info: { reason: string; crashCount: number }) => { calls.push(info); };
    const log = () => {};
    expect(maybeGiveUp(0, cb, log)).toBe(false);
    expect(maybeGiveUp(4, cb, log)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("returns true and fires the callback once above threshold", () => {
    const calls: Array<{ reason: string; crashCount: number }> = [];
    const cb = (info: { reason: string; crashCount: number }) => { calls.push(info); };
    const log = () => {};
    expect(maybeGiveUp(5, cb, log)).toBe(true);
    expect(calls).toEqual([
      { reason: "crash-retry-budget-exhausted", crashCount: 5 },
    ]);
  });

  it("still signals give-up if the callback is undefined", () => {
    const log = () => {};
    expect(maybeGiveUp(7, undefined, log)).toBe(true);
  });

  it("swallows callback errors so the give-up path always completes", () => {
    const cb = () => {
      throw new Error("downstream broadcast blew up");
    };
    const logs: string[] = [];
    const log = (msg: string) => { logs.push(msg); };
    expect(maybeGiveUp(5, cb, log)).toBe(true);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("onGiveUp callback threw");
    expect(logs[0]).toContain("downstream broadcast blew up");
  });
});
