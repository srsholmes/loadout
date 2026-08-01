import { describe, expect, it } from "bun:test";
import { diagnoseCollection } from "./diagnose";
import { countMatches, evaluateCollection } from "./evaluate";
import { buildEvalGames } from "./facts";
import type { GroupRule, Rule, ManagedCollection } from "./types";
import { LIBRARY } from "../test/fixtures/library";

const evalLibrary = buildEvalGames(LIBRARY);

/**
 * Build a tab from a child list. `combinator` is a separate parameter
 * rather than part of `overrides` on purpose: an earlier version let specs
 * pass a whole `root`, and spreading a partial GroupRule over the real one
 * silently clobbered `children` with `[]`.
 */
function collectionWith(
  children: Rule[],
  overrides: Omit<Partial<ManagedCollection>, "root"> = {},
  combinator: "all" | "any" = "all",
): ManagedCollection {
  const root: GroupRule = { id: "root", kind: "group", combinator, children };
  return {
    id: "t",
    label: "Test",
    visible: true,
    autoHide: false,
    sort: [{ field: "sortAs", dir: "asc" }],
    limit: null,
    group: { kind: "none" },
    display: { tileWidth: 150, showLabels: true, badges: [] },
    mirror: { enabled: false, steamName: "Test" },
    indeterminatePolicy: "pass",
    ...overrides,
    root,
  };
}

/** Diagnose a tab the way the editor does — traced, with the flipped count. */
function diagnose(tab: ManagedCollection, games = evalLibrary) {
  const result = evaluateCollection(tab, games, { trace: true });
  const flipped = countMatches(
    {
      ...tab,
      root: {
        ...tab.root,
        combinator: tab.root.combinator === "all" ? "any" : "all",
      },
    },
    games,
  );
  return diagnoseCollection(tab, result, {
    librarySize: games.length,
    flippedCombinatorCount: flipped,
  });
}

describe("diagnoseCollection — ok", () => {
  it("says nothing when the tab has games", () => {
    expect(diagnose(collectionWith([{ id: "a", kind: "installed" }])).kind).toBe("ok");
  });

  it("stays ok when the cap hides only a minority", () => {
    // 10 games, limit 6 -> 4 hidden, fewer than shown. Not worth a banner.
    const d = diagnose(collectionWith([], { limit: 6 }));
    expect(d.kind).toBe("ok");
  });
});

describe("diagnoseCollection — empty-library", () => {
  it("blames the scan, not the rules, when there is nothing to filter", () => {
    const d = diagnose(collectionWith([{ id: "a", kind: "installed" }]), []);
    expect(d.kind).toBe("empty-library");
    expect(d.kind === "empty-library" && d.message).toMatch(/hasn't been scanned/i);
  });
});

describe("diagnoseCollection — over-capped", () => {
  it("reports a limit of 0 rather than blaming the rules", () => {
    const d = diagnose(collectionWith([{ id: "a", kind: "installed" }], { limit: 0 }));
    expect(d.kind).toBe("over-capped");
    if (d.kind !== "over-capped") throw new Error("wrong kind");
    expect(d.message).toContain("limit is set to 0");
    // And the fix restores the games.
    const fixed = d.fixes[0]!.apply(collectionWith([{ id: "a", kind: "installed" }], { limit: 0 }));
    expect(evaluateCollection(fixed, evalLibrary).matched.length).toBeGreaterThan(0);
  });

  it("warns when the cap is hiding most of the matches", () => {
    const d = diagnose(collectionWith([], { limit: 2 }));
    expect(d.kind).toBe("over-capped");
    if (d.kind !== "over-capped") throw new Error("wrong kind");
    expect(d.total).toBe(LIBRARY.length);
    expect(d.message).toContain("Showing 2 of 10");
  });
});

describe("diagnoseCollection — the advice it gives", () => {
  it("tells you to widen a range rule, not to delete it", () => {
    // The check was `"range" in r`, and no rule variant has a `range`
    // property — only the three date kinds were recognised, so every other
    // range rule was told to remove itself when widening was the fix.
    const collection = collectionWith([
      { id: "a", kind: "playtime", minutes: { min: 999_999 } },
    ]);
    const diagnosis = diagnose(collection);
    expect(diagnosis.message + JSON.stringify(diagnosis)).toMatch(/widen/i);
  });

  it("does not claim an unchecked rule matches everything under a fail policy", () => {
    // Under "fail" an unchecked rule matches *nothing* — the collection is
    // narrower, not wider, and the fix offered alongside says exactly that.
    // Two rules under ANY: the unchecked one contributes nothing, the other
    // matches — so the collection has games *and* a blocked fact, which is the
    // only combination where the sentence gets appended at all.
    const collection = {
      // Combinator is the *third* argument; passing it second silently made
      // this an ALL group, where the unchecked rule zeroes the collection and
      // the sentence is never appended — so the test proved nothing.
      ...collectionWith(
        [
          { id: "a", kind: "hltbMain", hours: { max: 10 } },
          { id: "b", kind: "installed" },
        ],
        {},
        "any",
      ),
      indeterminatePolicy: "fail" as const,
    };
    const diagnosis = diagnose(collection);
    expect(diagnosis.message).not.toMatch(/wider than it looks/);
  });
});

describe("diagnoseCollection — blocked-facts", () => {
  it("still reports them when the collection looks full", () => {
    // The dangerous case, and the one that used to return `ok`: an
    // unanswerable rule passes every game under the default policy, so the
    // collection matches the whole library and reads as healthy — then gets
    // mirrored into Steam that way.
    const collection = collectionWith([{ id: "a", kind: "hltbMain", hours: { max: 10 } }]);
    const result = evaluateCollection(collection, evalLibrary, { trace: true });
    expect(result.matched.length).toBe(evalLibrary.length);

    const diagnosis = diagnose(collection);
    expect(diagnosis.kind).toBe("blocked-facts");
    expect(diagnosis.message).toMatch(/wider than it looks/);
  });


  const blocked = buildEvalGames(LIBRARY, {
    protonTier: new Map(
      LIBRARY.map((g) => [
        g.appId,
        { state: "unavailable", reason: "The ProtonDB plugin is disabled." } as const,
      ]),
    ),
  });

  it("quotes the resolver's reason verbatim and counts the affected rules", () => {
    const tab = collectionWith(
      [{ id: "p", kind: "protonTier", tiers: ["platinum"] }],
      { indeterminatePolicy: "fail" },
    );
    const d = diagnose(tab, blocked);
    expect(d.kind).toBe("blocked-facts");
    if (d.kind !== "blocked-facts") throw new Error("wrong kind");
    expect(d.facts).toEqual(["protonTier"]);
    expect(d.message).toContain("The ProtonDB plugin is disabled.");
    expect(d.message).toContain("1 rule couldn't be checked");
  });

  it("offers to include the unchecked games, and that fix works", () => {
    const tab = collectionWith(
      [{ id: "p", kind: "protonTier", tiers: ["platinum"] }],
      { indeterminatePolicy: "fail" },
    );
    const d = diagnose(tab, blocked);
    if (d.kind !== "blocked-facts") throw new Error("wrong kind");
    const fix = d.fixes.find((f) => /include/i.test(f.label))!;
    const fixed = fix.apply(tab);
    expect(fixed.indeterminatePolicy).toBe("pass");
    expect(evaluateCollection(fixed, blocked).matched).toHaveLength(LIBRARY.length);
  });

  it("outranks a rule-logic diagnosis, since inputs come first", () => {
    // A contradiction AND a blocked fact: report the blocked fact, because
    // the user cannot reason about rules whose data never arrived.
    const tab = collectionWith(
      [
        { id: "p", kind: "protonTier", tiers: ["platinum"] },
        { id: "i", kind: "installed" },
        { id: "o", kind: "owned", invert: true },
      ],
      { indeterminatePolicy: "fail" },
    );
    expect(diagnose(tab, blocked).kind).toBe("blocked-facts");
  });
});

describe("diagnoseCollection — contradiction", () => {
  it("finds a conflicting pair empirically from the leaf masks", () => {
    // "installed" and "not owned" overlap only on the non-Steam shortcut,
    // so exclude shortcuts too and the pair becomes provably disjoint.
    // No table of known-bad combinations is consulted anywhere.
    const tab = collectionWith([
      { id: "steam", kind: "source", sources: ["steam"] },
      { id: "inst", kind: "installed" },
      { id: "unowned", kind: "owned", invert: true },
    ]);
    const d = diagnose(tab);
    expect(d.kind).toBe("contradiction");
    if (d.kind !== "contradiction") throw new Error("wrong kind");
    expect(d.ruleIds).toContain("unowned");
    expect(d.message).toContain("can never both be true");
  });

  it("every offered fix produces a non-empty tab", () => {
    const tab = collectionWith([
      { id: "steam", kind: "source", sources: ["steam"] },
      { id: "inst", kind: "installed" },
      { id: "unowned", kind: "owned", invert: true },
    ]);
    const d = diagnose(tab);
    if (d.kind !== "contradiction") throw new Error("wrong kind");
    expect(d.fixes.length).toBeGreaterThan(0);
    for (const fix of d.fixes) {
      const fixed = fix.apply(tab);
      expect(evaluateCollection(fixed, evalLibrary).matched.length).toBeGreaterThan(0);
    }
  });

  it("does not fire under ANY, where disjoint rules are the normal case", () => {
    const anyTab = collectionWith(
      [
        { id: "steam", kind: "source", sources: ["steam"] },
        { id: "unowned", kind: "owned", invert: true },
      ],
      {},
      "any",
    );
    expect(diagnose(anyTab).kind).toBe("ok");
  });
});

describe("diagnoseCollection — single-culprit", () => {
  it("names the one rule whose removal restores matches", () => {
    // "installed" matches 6, "never released" matches 0 -> removing the
    // latter yields 6, removing the former yields 0. Exactly one candidate.
    const tab = collectionWith([
      { id: "inst", kind: "installed" },
      { id: "impossible", kind: "title", match: "contains", value: "zzzznope" },
    ]);
    const d = diagnose(tab);
    expect(d.kind).toBe("single-culprit");
    if (d.kind !== "single-culprit") throw new Error("wrong kind");
    expect(d.ruleId).toBe("impossible");
    expect(d.wouldMatch).toBe(6);
    expect(d.message).toContain("6 games match");
  });

  it("its fix is a single tap that works", () => {
    const tab = collectionWith([
      { id: "inst", kind: "installed" },
      { id: "impossible", kind: "title", match: "contains", value: "zzzznope" },
    ]);
    const d = diagnose(tab);
    if (d.kind !== "single-culprit") throw new Error("wrong kind");
    expect(d.fixes).toHaveLength(1);
    expect(evaluateCollection(d.fixes[0]!.apply(tab), evalLibrary).matched).toHaveLength(6);
  });

  it("declines to guess when two rules are each individually fatal", () => {
    // Both removals still leave zero, so no single rule is the culprit and
    // naming one arbitrarily would be misleading.
    const tab = collectionWith([
      { id: "n1", kind: "title", match: "contains", value: "zzzznope" },
      { id: "n2", kind: "title", match: "contains", value: "yyyynope" },
    ]);
    const d = diagnose(tab);
    expect(d.kind).not.toBe("single-culprit");
  });
});

describe("diagnoseCollection — combinator", () => {
  it("catches ALL-where-ANY-was-meant, the classic TabMaster mistake", () => {
    // Three collections no single game is in all of; each is populated.
    const tab = collectionWith([
      { id: "c1", kind: "collection", collectionIds: ["uc-backlog"], mode: "anyOf" },
      { id: "c2", kind: "collection", collectionIds: ["uc-finished"], mode: "anyOf" },
      { id: "c3", kind: "collection", collectionIds: ["uc-classics"], mode: "anyOf" },
    ]);
    const d = diagnose(tab);
    expect(["combinator", "contradiction"]).toContain(d.kind);
    // Whichever it picked, a fix must offer the ANY switch with a count.
    const anyFix = ("fixes" in d ? d.fixes : []).find((f) => /ANY/.test(f.label));
    expect(anyFix).toBeDefined();
    const fixed = anyFix!.apply(tab);
    expect(fixed.root.combinator).toBe("any");
    expect(evaluateCollection(fixed, evalLibrary).matched.length).toBeGreaterThan(0);
  });

  it("puts the resulting count in the fix label, so the outcome is visible", () => {
    const tab = collectionWith([
      { id: "c1", kind: "collection", collectionIds: ["uc-backlog"], mode: "anyOf" },
      { id: "c2", kind: "collection", collectionIds: ["uc-finished"], mode: "anyOf" },
      { id: "c3", kind: "collection", collectionIds: ["uc-classics"], mode: "anyOf" },
    ]);
    const d = diagnose(tab);
    const anyFix = ("fixes" in d ? d.fixes : []).find((f) => /ANY/.test(f.label))!;
    expect(anyFix.label).toMatch(/Switch to ANY \(\d+ games?\)/);
  });
});

describe("diagnoseCollection — genuinely-empty", () => {
  it("is the last resort, and says the rules are valid", () => {
    // A single rule nothing matches, with no sibling to blame and no
    // combinator to flip.
    const tab = collectionWith([
      { id: "only", kind: "title", match: "contains", value: "zzzznope" },
    ]);
    const d = diagnose(tab);
    expect(d.kind).toBe("genuinely-empty");
    if (d.kind !== "genuinely-empty") throw new Error("wrong kind");
    expect(d.message).toMatch(/valid/i);
  });
});

describe("diagnoseCollection — fixes are pure", () => {
  it("never mutates the tab they are given", () => {
    const tab = collectionWith([
      { id: "inst", kind: "installed" },
      { id: "impossible", kind: "title", match: "contains", value: "zzzznope" },
    ]);
    const snapshot = JSON.stringify(tab);
    const d = diagnose(tab);
    for (const fix of "fixes" in d ? d.fixes : []) fix.apply(tab);
    expect(JSON.stringify(tab)).toBe(snapshot);
  });
});
