import { describe, expect, it } from "bun:test";
import { maybeGiveUp, resolveOverlayMainMenu } from "./injector";

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

/**
 * Issue #169: the main-menu entry setting was renamed from
 * `steamOverlayButtonEnabled` to `steamOverlayButtonMainMenu`. The new key
 * must win once present so toggling it *off* removes the item even for a
 * config still carrying the legacy flag; the legacy flag is honoured only
 * as a fallback when the new key was never written.
 */
describe("resolveOverlayMainMenu (#169 config precedence)", () => {
  it("uses the new key when present (true)", () => {
    expect(resolveOverlayMainMenu({ steamOverlayButtonMainMenu: true })).toBe(true);
  });

  it("new key wins over a truthy legacy flag when explicitly false", () => {
    // The exact bug the reviewer caught: toggling off must remove the item
    // even though the legacy `steamOverlayButtonEnabled` is still true.
    expect(
      resolveOverlayMainMenu({
        steamOverlayButtonMainMenu: false,
        steamOverlayButtonEnabled: true,
      }),
    ).toBe(false);
  });

  it("falls back to the legacy flag only when the new key is absent", () => {
    expect(resolveOverlayMainMenu({ steamOverlayButtonEnabled: true })).toBe(true);
    expect(resolveOverlayMainMenu({ steamOverlayButtonEnabled: false })).toBe(false);
  });

  it("defaults to false for an empty / unrelated config", () => {
    expect(resolveOverlayMainMenu({})).toBe(false);
    expect(resolveOverlayMainMenu({ theme: "midnight" })).toBe(false);
  });

  it("treats non-boolean values as not-enabled (no type coercion)", () => {
    expect(resolveOverlayMainMenu({ steamOverlayButtonMainMenu: "true" })).toBe(false);
    expect(resolveOverlayMainMenu({ steamOverlayButtonMainMenu: 1 })).toBe(false);
  });
});
