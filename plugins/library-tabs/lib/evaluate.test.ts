import { describe, expect, it } from "bun:test";
import {
  combineAll,
  combineAny,
  countMatches,
  evaluateRule,
  evaluateTab,
} from "./evaluate";
import { buildEvalGames } from "./facts";
import type { EvalGame, GroupRule, Rule, Tab, Verdict } from "./types";
import { IDS, LIBRARY, game, ids } from "../test/fixtures/library";

const ALL_VERDICTS: Verdict[] = [true, false, "indeterminate"];

/** Minimal tab wrapper so specs only have to describe the rule tree. */
function tabWith(root: GroupRule, overrides: Partial<Tab> = {}): Tab {
  return {
    id: "t",
    label: "Test",
    visible: true,
    autoHide: false,
    root,
    sort: [{ field: "sortAs", dir: "asc" }],
    limit: null,
    group: { kind: "none" },
    display: { tileWidth: 150, showLabels: true, badges: [] },
    mirror: { enabled: false, collectionName: "Test" },
    indeterminatePolicy: "pass",
    ...overrides,
  };
}

function group(
  combinator: "all" | "any",
  children: Rule[],
  extra: Partial<GroupRule> = {},
): GroupRule {
  return { id: "root", kind: "group", combinator, children, ...extra };
}

const evalLibrary = buildEvalGames(LIBRARY);

/** A single game as an EvalGame, for rule-level assertions. */
function one(appId: string): EvalGame {
  const found = evalLibrary.find((g) => g.meta.appId === appId);
  if (!found) throw new Error(`fixture missing ${appId}`);
  return found;
}

describe("combineAll — Kleene strong conjunction", () => {
  it("is vacuously true for an empty set", () => {
    // A brand-new tab shows the whole library rather than nothing, which
    // is the right place to start building from.
    expect(combineAll([])).toBe(true);
  });

  it("returns false when any operand is definitely false", () => {
    for (const other of ALL_VERDICTS) {
      expect(combineAll([false, other])).toBe(false);
      expect(combineAll([other, false])).toBe(false);
    }
  });

  it("returns indeterminate only when nothing is false and something is unknown", () => {
    expect(combineAll(["indeterminate"])).toBe("indeterminate");
    expect(combineAll([true, "indeterminate"])).toBe("indeterminate");
    expect(combineAll([true, true, "indeterminate"])).toBe("indeterminate");
  });

  it("returns true only when every operand is true", () => {
    expect(combineAll([true])).toBe(true);
    expect(combineAll([true, true, true])).toBe(true);
  });

  it("covers the full 3x3 truth table", () => {
    const table: Array<[Verdict, Verdict, Verdict]> = [
      [true, true, true],
      [true, false, false],
      [true, "indeterminate", "indeterminate"],
      [false, true, false],
      [false, false, false],
      [false, "indeterminate", false],
      ["indeterminate", true, "indeterminate"],
      ["indeterminate", false, false],
      ["indeterminate", "indeterminate", "indeterminate"],
    ];
    for (const [a, b, want] of table) {
      expect(combineAll([a, b])).toBe(want);
    }
  });
});

describe("combineAny — Kleene strong disjunction", () => {
  it("is vacuously false for an empty set (dual of combineAll)", () => {
    expect(combineAny([])).toBe(false);
  });

  it("returns true when any operand is definitely true", () => {
    for (const other of ALL_VERDICTS) {
      expect(combineAny([true, other])).toBe(true);
      expect(combineAny([other, true])).toBe(true);
    }
  });

  it("covers the full 3x3 truth table", () => {
    const table: Array<[Verdict, Verdict, Verdict]> = [
      [true, true, true],
      [true, false, true],
      [true, "indeterminate", true],
      [false, true, true],
      [false, false, false],
      [false, "indeterminate", "indeterminate"],
      ["indeterminate", true, true],
      ["indeterminate", false, "indeterminate"],
      ["indeterminate", "indeterminate", "indeterminate"],
    ];
    for (const [a, b, want] of table) {
      expect(combineAny([a, b])).toBe(want);
    }
  });
});

describe("evaluateRule — inversion", () => {
  it("flips a definite group verdict", () => {
    const installed: Rule = { id: "a", kind: "installed" };
    const plain = group("all", [installed]);
    const inverted = group("all", [installed], { invert: true });
    expect(evaluateRule(plain, one(IDS.portal2))).toBe(true);
    expect(evaluateRule(inverted, one(IDS.portal2))).toBe(false);
  });

  it("PRESERVES indeterminate rather than flipping it to true", () => {
    // "not (couldn't check)" is still "couldn't check". If inversion
    // flipped it, ticking `invert` on an unanswerable rule would silently
    // turn it into a rule that matches everything.
    const unanswerable: Rule = {
      id: "a",
      kind: "playtime",
      minutes: { min: 60 },
    };
    const target = buildEvalGames([game({ appId: "x", name: "X" })])[0]!;

    expect(evaluateRule(unanswerable, target)).toBe("indeterminate");
    expect(
      evaluateRule({ ...unanswerable, invert: true }, target),
    ).toBe("indeterminate");
    expect(
      evaluateRule(group("all", [unanswerable], { invert: true }), target),
    ).toBe("indeterminate");
  });

  it("nests to depth 4", () => {
    const deep = group("all", [
      {
        id: "d2",
        kind: "group",
        combinator: "any",
        children: [
          {
            id: "d3",
            kind: "group",
            combinator: "all",
            children: [
              {
                id: "d4",
                kind: "group",
                combinator: "any",
                children: [{ id: "leaf", kind: "installed" }],
              },
            ],
          },
        ],
      },
    ]);
    expect(evaluateRule(deep, one(IDS.portal2))).toBe(true);
    expect(evaluateRule(deep, one(IDS.celeste))).toBe(false);
  });
});

describe("evaluateTab — indeterminatePolicy", () => {
  const unanswerable = group("all", [
    { id: "a", kind: "metacritic", score: { min: 80 } },
  ]);

  it('includes unknown-valued games under "pass"', () => {
    const result = evaluateTab(
      tabWith(unanswerable, { indeterminatePolicy: "pass" }),
      evalLibrary,
    );
    // The obscure indie has metacritic -1; under `pass` it survives.
    expect(ids(result.matched)).toContain(IDS.obscure);
  });

  it('excludes them under "fail"', () => {
    const result = evaluateTab(
      tabWith(unanswerable, { indeterminatePolicy: "fail" }),
      evalLibrary,
    );
    expect(ids(result.matched)).not.toContain(IDS.obscure);
    // The definite high scorers still match either way.
    expect(ids(result.matched)).toContain(IDS.portal2);
  });
});

describe("evaluateTab — sort, cap and ordering", () => {
  const everything = group("all", []);

  it("applies limit AFTER sorting, not before", () => {
    // "3 most recently played" only means anything if the cap comes last.
    const result = evaluateTab(
      tabWith(everything, {
        sort: [{ field: "lastPlayed", dir: "desc" }],
        limit: 3,
      }),
      evalLibrary,
    );
    expect(ids(result.matched)).toEqual([
      IDS.stardew, // 2026-07-20
      IDS.portal2, // 2026-07-01
      IDS.mario64, // 2026-06-15
    ]);
  });

  it("reports total and cappedOut against the pre-cap count", () => {
    const result = evaluateTab(
      tabWith(everything, { limit: 4 }),
      evalLibrary,
    );
    expect(result.total).toBe(LIBRARY.length);
    expect(result.matched).toHaveLength(4);
    expect(result.cappedOut).toBe(LIBRARY.length - 4);
  });

  it("treats limit 0 as an empty tab rather than uncapped", () => {
    const result = evaluateTab(tabWith(everything, { limit: 0 }), evalLibrary);
    expect(result.matched).toHaveLength(0);
    expect(result.total).toBe(LIBRARY.length);
    expect(result.cappedOut).toBe(LIBRARY.length);
  });

  it("wraps ungrouped results in one synthetic group carrying the tab label", () => {
    const result = evaluateTab(
      tabWith(everything, { label: "Everything" }),
      evalLibrary,
    );
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.label).toBe("Everything");
    expect(result.groups[0]!.games).toHaveLength(LIBRARY.length);
  });
});

describe("evaluateTab — trace", () => {
  const root = group("all", [
    { id: "inst", kind: "installed" },
    { id: "big", kind: "sizeOnDisk", bytes: { min: 10 * 1024 ** 3 } },
  ]);

  it("is not populated unless requested", () => {
    const result = evaluateTab(tabWith(root), evalLibrary);
    expect(result.leafMasks).toBeUndefined();
    // Counts stay at their zero-initialised values on the untraced path.
    expect(result.trace.passed).toBe(0);
  });

  it("tallies passed/failed/indeterminate per node", () => {
    const result = evaluateTab(tabWith(root), evalLibrary, { trace: true });
    const [instNode, bigNode] = result.trace.children!;

    const installedCount = LIBRARY.filter((g) => g.installed).length;
    expect(instNode!.passed).toBe(installedCount);
    expect(instNode!.failed).toBe(LIBRARY.length - installedCount);
    expect(instNode!.indeterminate).toBe(0);

    // Unknown sizes are "couldn't check", not "too small".
    const unknownSize = LIBRARY.filter((g) => g.sizeOnDisk === -1).length;
    expect(bigNode!.indeterminate).toBe(unknownSize);
  });

  it("computes withoutThis as the parent count with that child removed", () => {
    const result = evaluateTab(tabWith(root), evalLibrary, { trace: true });
    const [instNode, bigNode] = result.trace.children!;

    // Removing `installed` leaves only the size rule.
    const sizeOnly = evaluateTab(
      tabWith(group("all", [root.children[1]!])),
      evalLibrary,
    );
    expect(instNode!.withoutThis).toBe(sizeOnly.total);

    // Removing the size rule leaves only `installed`.
    const instOnly = evaluateTab(
      tabWith(group("all", [root.children[0]!])),
      evalLibrary,
    );
    expect(bigNode!.withoutThis).toBe(instOnly.total);

    // The root's withoutThis is the whole library.
    expect(result.trace.withoutThis).toBe(LIBRARY.length);
  });

  it("emits one leaf mask per leaf, aligned to the input array order", () => {
    const result = evaluateTab(tabWith(root), evalLibrary, { trace: true });
    expect([...result.leafMasks!.keys()].sort()).toEqual(["big", "inst"]);

    const instMask = result.leafMasks!.get("inst")!;
    expect(instMask).toHaveLength(evalLibrary.length);
    for (let i = 0; i < evalLibrary.length; i++) {
      expect(instMask[i] === 1).toBe(evalLibrary[i]!.meta.installed);
    }
  });

  it("fills leaf masks even where the traced walk short-circuited", () => {
    // Under `all`, a failing first child means later children are never
    // reached by the combinator's short-circuit. A mask with holes there
    // would make contradiction detection report false positives, so the
    // mask pass must evaluate every leaf standalone.
    const shortCircuit = group("all", [
      { id: "never", kind: "title", match: "contains", value: "zzzznope" },
      { id: "inst", kind: "installed" },
    ]);
    const result = evaluateTab(tabWith(shortCircuit), evalLibrary, {
      trace: true,
    });
    expect(result.matched).toHaveLength(0);

    const instMask = result.leafMasks!.get("inst")!;
    const marked = instMask.reduce<number>((n, b) => n + b, 0);
    expect(marked).toBe(LIBRARY.filter((g) => g.installed).length);
  });
});

describe("evaluateTab — blockedFacts", () => {
  it("reports the resolver's reason verbatim, with the affected rule ids", () => {
    const withFacts = buildEvalGames(
      LIBRARY,
      {
        protonTier: new Map(
          LIBRARY.map((g) => [
            g.appId,
            { state: "unavailable", reason: "The ProtonDB plugin is disabled." } as const,
          ]),
        ),
      },
    );
    const root = group("all", [
      { id: "proton", kind: "protonTier", tiers: ["platinum"] },
    ]);

    const result = evaluateTab(tabWith(root), withFacts);
    expect(result.blockedFacts).toEqual([
      {
        fact: "protonTier",
        reason: "The ProtonDB plugin is disabled.",
        ruleIds: ["proton"],
      },
    ]);
    // And, crucially, the tab is NOT empty — the default policy passes
    // rules it couldn't check, so a disabled plugin degrades rather than
    // silently wiping the tab.
    expect(result.matched).toHaveLength(LIBRARY.length);
  });

  it("is empty when no fact-backed rule is present", () => {
    const result = evaluateTab(
      tabWith(group("all", [{ id: "a", kind: "installed" }])),
      evalLibrary,
    );
    expect(result.blockedFacts).toEqual([]);
  });
});

describe("countMatches", () => {
  it("agrees with evaluateTab's pre-cap total", () => {
    const root = group("any", [
      { id: "a", kind: "installed" },
      { id: "b", kind: "collection", collectionIds: ["favorite"], mode: "anyOf" },
    ]);
    const tab = tabWith(root);
    expect(countMatches(tab, evalLibrary)).toBe(
      evaluateTab(tab, evalLibrary).total,
    );
  });

  it("ignores the cap, since the palette wants the true match count", () => {
    const tab = tabWith(group("all", []), { limit: 2 });
    expect(countMatches(tab, evalLibrary)).toBe(LIBRARY.length);
  });
});
