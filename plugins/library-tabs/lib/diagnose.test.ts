import { describe, expect, it } from "bun:test";
import { diagnoseTab, removeRule } from "./diagnose";
import { countMatches, evaluateTab } from "./evaluate";
import { buildEvalGames } from "./facts";
import type { GroupRule, Rule, Tab } from "./types";
import { LIBRARY } from "../test/fixtures/library";

const evalLibrary = buildEvalGames(LIBRARY);

/**
 * Build a tab from a child list. `combinator` is a separate parameter
 * rather than part of `overrides` on purpose: an earlier version let specs
 * pass a whole `root`, and spreading a partial GroupRule over the real one
 * silently clobbered `children` with `[]`.
 */
function tabWith(
  children: Rule[],
  overrides: Omit<Partial<Tab>, "root"> = {},
  combinator: "all" | "any" = "all",
): Tab {
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
    mirror: { enabled: false, collectionName: "Test" },
    indeterminatePolicy: "pass",
    ...overrides,
    root,
  };
}

/** Diagnose a tab the way the editor does — traced, with the flipped count. */
function diagnose(tab: Tab, games = evalLibrary) {
  const result = evaluateTab(tab, games, { trace: true });
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
  return diagnoseTab(tab, result, {
    librarySize: games.length,
    flippedCombinatorCount: flipped,
  });
}

describe("removeRule", () => {
  it("removes a top-level child", () => {
    const root: GroupRule = {
      id: "root",
      kind: "group",
      combinator: "all",
      children: [
        { id: "a", kind: "installed" },
        { id: "b", kind: "owned" },
      ],
    };
    const next = removeRule(root, "a") as GroupRule;
    expect(next.children.map((c) => c.id)).toEqual(["b"]);
  });

  it("removes a deeply nested child, leaving the structure intact", () => {
    const root: GroupRule = {
      id: "root",
      kind: "group",
      combinator: "all",
      children: [
        {
          id: "g2",
          kind: "group",
          combinator: "any",
          children: [
            { id: "a", kind: "installed" },
            { id: "b", kind: "owned" },
          ],
        },
      ],
    };
    const next = removeRule(root, "b") as GroupRule;
    const inner = next.children[0] as GroupRule;
    expect(inner.children.map((c) => c.id)).toEqual(["a"]);
  });

  it("returns null when asked to remove the node itself", () => {
    expect(removeRule({ id: "a", kind: "installed" }, "a")).toBeNull();
  });

  it("does not mutate its input", () => {
    const root: GroupRule = {
      id: "root",
      kind: "group",
      combinator: "all",
      children: [{ id: "a", kind: "installed" }],
    };
    removeRule(root, "a");
    expect(root.children).toHaveLength(1);
  });
});

describe("diagnoseTab — ok", () => {
  it("says nothing when the tab has games", () => {
    expect(diagnose(tabWith([{ id: "a", kind: "installed" }])).kind).toBe("ok");
  });

  it("stays ok when the cap hides only a minority", () => {
    // 10 games, limit 6 -> 4 hidden, fewer than shown. Not worth a banner.
    const d = diagnose(tabWith([], { limit: 6 }));
    expect(d.kind).toBe("ok");
  });
});

describe("diagnoseTab — empty-library", () => {
  it("blames the scan, not the rules, when there is nothing to filter", () => {
    const d = diagnose(tabWith([{ id: "a", kind: "installed" }]), []);
    expect(d.kind).toBe("empty-library");
    expect(d.kind === "empty-library" && d.message).toMatch(/hasn't been scanned/i);
  });
});

describe("diagnoseTab — over-capped", () => {
  it("reports a limit of 0 rather than blaming the rules", () => {
    const d = diagnose(tabWith([{ id: "a", kind: "installed" }], { limit: 0 }));
    expect(d.kind).toBe("over-capped");
    if (d.kind !== "over-capped") throw new Error("wrong kind");
    expect(d.message).toContain("limit is set to 0");
    // And the fix restores the games.
    const fixed = d.fixes[0]!.apply(tabWith([{ id: "a", kind: "installed" }], { limit: 0 }));
    expect(evaluateTab(fixed, evalLibrary).matched.length).toBeGreaterThan(0);
  });

  it("warns when the cap is hiding most of the matches", () => {
    const d = diagnose(tabWith([], { limit: 2 }));
    expect(d.kind).toBe("over-capped");
    if (d.kind !== "over-capped") throw new Error("wrong kind");
    expect(d.total).toBe(LIBRARY.length);
    expect(d.message).toContain("Showing 2 of 10");
  });
});

describe("diagnoseTab — blocked-facts", () => {
  const blocked = buildEvalGames(LIBRARY, {
    protonTier: new Map(
      LIBRARY.map((g) => [
        g.appId,
        { state: "unavailable", reason: "The ProtonDB plugin is disabled." } as const,
      ]),
    ),
  });

  it("quotes the resolver's reason verbatim and counts the affected rules", () => {
    const tab = tabWith(
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
    const tab = tabWith(
      [{ id: "p", kind: "protonTier", tiers: ["platinum"] }],
      { indeterminatePolicy: "fail" },
    );
    const d = diagnose(tab, blocked);
    if (d.kind !== "blocked-facts") throw new Error("wrong kind");
    const fix = d.fixes.find((f) => /include/i.test(f.label))!;
    const fixed = fix.apply(tab);
    expect(fixed.indeterminatePolicy).toBe("pass");
    expect(evaluateTab(fixed, blocked).matched).toHaveLength(LIBRARY.length);
  });

  it("outranks a rule-logic diagnosis, since inputs come first", () => {
    // A contradiction AND a blocked fact: report the blocked fact, because
    // the user cannot reason about rules whose data never arrived.
    const tab = tabWith(
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

describe("diagnoseTab — contradiction", () => {
  it("finds a conflicting pair empirically from the leaf masks", () => {
    // "installed" and "not owned" overlap only on the non-Steam shortcut,
    // so exclude shortcuts too and the pair becomes provably disjoint.
    // No table of known-bad combinations is consulted anywhere.
    const tab = tabWith([
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
    const tab = tabWith([
      { id: "steam", kind: "source", sources: ["steam"] },
      { id: "inst", kind: "installed" },
      { id: "unowned", kind: "owned", invert: true },
    ]);
    const d = diagnose(tab);
    if (d.kind !== "contradiction") throw new Error("wrong kind");
    expect(d.fixes.length).toBeGreaterThan(0);
    for (const fix of d.fixes) {
      const fixed = fix.apply(tab);
      expect(evaluateTab(fixed, evalLibrary).matched.length).toBeGreaterThan(0);
    }
  });

  it("does not fire under ANY, where disjoint rules are the normal case", () => {
    const anyTab = tabWith(
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

describe("diagnoseTab — single-culprit", () => {
  it("names the one rule whose removal restores matches", () => {
    // "installed" matches 6, "never released" matches 0 -> removing the
    // latter yields 6, removing the former yields 0. Exactly one candidate.
    const tab = tabWith([
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
    const tab = tabWith([
      { id: "inst", kind: "installed" },
      { id: "impossible", kind: "title", match: "contains", value: "zzzznope" },
    ]);
    const d = diagnose(tab);
    if (d.kind !== "single-culprit") throw new Error("wrong kind");
    expect(d.fixes).toHaveLength(1);
    expect(evaluateTab(d.fixes[0]!.apply(tab), evalLibrary).matched).toHaveLength(6);
  });

  it("declines to guess when two rules are each individually fatal", () => {
    // Both removals still leave zero, so no single rule is the culprit and
    // naming one arbitrarily would be misleading.
    const tab = tabWith([
      { id: "n1", kind: "title", match: "contains", value: "zzzznope" },
      { id: "n2", kind: "title", match: "contains", value: "yyyynope" },
    ]);
    const d = diagnose(tab);
    expect(d.kind).not.toBe("single-culprit");
  });
});

describe("diagnoseTab — combinator", () => {
  it("catches ALL-where-ANY-was-meant, the classic TabMaster mistake", () => {
    // Three collections no single game is in all of; each is populated.
    const tab = tabWith([
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
    expect(evaluateTab(fixed, evalLibrary).matched.length).toBeGreaterThan(0);
  });

  it("puts the resulting count in the fix label, so the outcome is visible", () => {
    const tab = tabWith([
      { id: "c1", kind: "collection", collectionIds: ["uc-backlog"], mode: "anyOf" },
      { id: "c2", kind: "collection", collectionIds: ["uc-finished"], mode: "anyOf" },
      { id: "c3", kind: "collection", collectionIds: ["uc-classics"], mode: "anyOf" },
    ]);
    const d = diagnose(tab);
    const anyFix = ("fixes" in d ? d.fixes : []).find((f) => /ANY/.test(f.label))!;
    expect(anyFix.label).toMatch(/Switch to ANY \(\d+ games?\)/);
  });
});

describe("diagnoseTab — genuinely-empty", () => {
  it("is the last resort, and says the rules are valid", () => {
    // A single rule nothing matches, with no sibling to blame and no
    // combinator to flip.
    const tab = tabWith([
      { id: "only", kind: "title", match: "contains", value: "zzzznope" },
    ]);
    const d = diagnose(tab);
    expect(d.kind).toBe("genuinely-empty");
    if (d.kind !== "genuinely-empty") throw new Error("wrong kind");
    expect(d.message).toMatch(/valid/i);
  });
});

describe("diagnoseTab — fixes are pure", () => {
  it("never mutates the tab they are given", () => {
    const tab = tabWith([
      { id: "inst", kind: "installed" },
      { id: "impossible", kind: "title", match: "contains", value: "zzzznope" },
    ]);
    const snapshot = JSON.stringify(tab);
    const d = diagnose(tab);
    for (const fix of "fixes" in d ? d.fixes : []) fix.apply(tab);
    expect(JSON.stringify(tab)).toBe(snapshot);
  });
});
