import { describe, expect, it } from "bun:test";

import { allUnavailable, isOk, missing, unavailable, type FactValue } from "./types";

describe("isOk", () => {
  it("narrows the ok variant", () => {
    const fact: FactValue = { state: "ok", value: 42 };
    expect(isOk(fact)).toBe(true);
    if (isOk(fact)) {
      // Compile-time narrowing is the point; assert the runtime read too.
      expect(fact.value).toBe(42);
    }
  });

  it("rejects loading, missing, unavailable and undefined alike", () => {
    expect(isOk({ state: "loading" })).toBe(false);
    expect(isOk(missing())).toBe(false);
    expect(isOk(unavailable("Steam is not running"))).toBe(false);
    expect(isOk(undefined)).toBe(false);
  });

  it("does not treat a falsy ok value as not-ok", () => {
    // The trap this guard exists to avoid: `fact?.value` reads false/0 as absent.
    expect(isOk({ state: "ok", value: false })).toBe(true);
    expect(isOk({ state: "ok", value: 0 })).toBe(true);
    expect(isOk({ state: "ok", value: "" })).toBe(true);
  });
});

describe("missing", () => {
  it("is a distinct state, not an ok carrying a sentinel", () => {
    // `{state:"ok", value:-1}` would claim a real measurement of -1 and force
    // every consumer to know the sentinel. `plugins/collections` pays for this
    // distinction in its evaluator: `loading` and `unavailable` are
    // indeterminate, `missing` is a definite no routed through the range's
    // includeUnknown escape hatch (lib/rules.ts:118).
    expect(missing()).toEqual({ state: "missing" });
    expect(isOk(missing())).toBe(false);
  });

  it("is not the same answer as loading", () => {
    // Collapsing these is the bug that made every unscanned game *match*
    // under a "pass" indeterminate policy, silently and with no diagnostic.
    expect(missing()).not.toEqual({ state: "loading" });
  });

  it("carries no reason, because the source is fine", () => {
    // A reason belongs on `unavailable` — the source being down is the
    // user-actionable case. "This game has no achievements" needs no excuse.
    expect(Object.keys(missing())).toEqual(["state"]);
  });
});

describe("unavailable", () => {
  it("carries the user-facing reason verbatim for empty states to quote", () => {
    const reason = "Achievement data hasn't been scanned yet.";
    expect(unavailable(reason)).toEqual({ state: "unavailable", reason });
  });

  it("is distinct from missing: one source is down, one game has no data", () => {
    expect(unavailable("Steam is not running")).not.toEqual(missing());
  });
});

describe("allUnavailable", () => {
  it("answers for every appId, honouring the resolve-never-reject contract", () => {
    const map = allUnavailable(["620", "570"], "Steam is not running");
    expect(map.size).toBe(2);
    expect(map.get("620")).toEqual({
      state: "unavailable",
      reason: "Steam is not running",
    });
    expect(map.get("570")).toEqual({
      state: "unavailable",
      reason: "Steam is not running",
    });
  });

  it("returns an empty map for an empty batch", () => {
    expect(allUnavailable([], "nope").size).toBe(0);
  });
});
