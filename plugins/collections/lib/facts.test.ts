import { describe, expect, it } from "bun:test";
import { buildEvalGames } from "./facts";
import { LIBRARY } from "../test/fixtures/library";


describe("the two kinds of absence", () => {
  // The distinction this whole module exists to preserve: "the source ran and
  // has nothing for this game" is a definite no; "nobody has asked yet" is
  // not. Collapsing them made unanswered games *match* under the default
  // "pass" policy, silently.

  it("marks a game the resolver skipped as missing, not loading", () => {
    // A resolver that only emits what it found — the natural way to write one
    // — used to leave every other game indeterminate.
    const games = buildEvalGames(LIBRARY, {
      protonTier: new Map([[LIBRARY[0]!.appId, { state: "ok", value: "gold" }]]),
    });
    expect(games[0]!.facts.protonTier).toEqual({ state: "ok", value: "gold" });
    expect(games[1]!.facts.protonTier).toEqual({ state: "missing" });
  });

  it("leaves a fact nobody asked for absent entirely", () => {
    // Absent from the bag means no resolver has run: still indeterminate, so
    // the first render shows games rather than an empty grid.
    const games = buildEvalGames(LIBRARY, {});
    expect(games[0]!.facts.protonTier).toBeUndefined();
  });

  it("keeps an explicit unavailable, so the outage reaches diagnostics", () => {
    const games = buildEvalGames(LIBRARY, {
      protonTier: new Map([
        [LIBRARY[0]!.appId, { state: "unavailable", reason: "ProtonDB is off" }],
      ]),
    });
    expect(games[0]!.facts.protonTier).toEqual({
      state: "unavailable",
      reason: "ProtonDB is off",
    });
  });
});
