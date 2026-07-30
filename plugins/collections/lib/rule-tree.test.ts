import { describe, expect, it } from "bun:test";
import {
  MAX_RULE_DEPTH,
  asRoot,
  cloneWithNewIds,
  duplicateRule,
  findParent,
  findRule,
  fitsWithinDepth,
  insertRule,
  moveRule,
  removeRule,
  replaceRule,
  ruleDepth,
  setCombinator,
  toggleInvert,
  treeDepth,
  unwrapGroup,
  wrapInGroup,
} from "./rule-tree";
import type { GroupRule, Rule } from "./types";

/** `all` group of the given children, id "root". */
function root(children: Rule[], combinator: "all" | "any" = "all"): GroupRule {
  return { id: "root", kind: "group", combinator, children };
}

function group(id: string, children: Rule[], combinator: "all" | "any" = "any"): GroupRule {
  return { id, kind: "group", combinator, children };
}

const installed: Rule = { id: "a", kind: "installed" };
const owned: Rule = { id: "b", kind: "owned" };

/** Deterministic id factory, so every assertion names an exact id. */
function ids(prefix = "n"): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

// ── Queries ────────────────────────────────────────────────────────────

describe("findRule", () => {
  it("finds the root itself", () => {
    const tree = root([installed]);
    expect(findRule(tree, "root")).toBe(tree);
  });

  it("finds a deeply nested rule", () => {
    const tree = root([group("g", [group("g2", [owned])])]);
    expect(findRule(tree, "b")).toEqual(owned);
  });

  it("returns null for an absent id", () => {
    expect(findRule(root([installed]), "nope")).toBeNull();
  });
});

describe("findParent", () => {
  it("returns the containing group", () => {
    const inner = group("g", [owned]);
    const tree = root([installed, inner]);
    expect(findParent(tree, "b")).toBe(inner);
  });

  it("returns null for the root, which has no parent", () => {
    expect(findParent(root([installed]), "root")).toBeNull();
  });
});

describe("ruleDepth / treeDepth", () => {
  it("counts the root as level 1", () => {
    expect(ruleDepth(root([installed]), "root")).toBe(1);
  });

  it("counts a child of the root as level 2", () => {
    expect(ruleDepth(root([installed]), "a")).toBe(2);
  });

  it("counts nesting all the way down", () => {
    const tree = root([group("g", [group("g2", [owned])])]);
    expect(ruleDepth(tree, "b")).toBe(4);
  });

  it("returns 0 for an id that is not in the tree", () => {
    expect(ruleDepth(root([installed]), "nope")).toBe(0);
  });

  it("treats a leaf and an empty group as height 1", () => {
    expect(treeDepth(installed)).toBe(1);
    expect(treeDepth(root([]))).toBe(1);
  });

  it("measures the deepest branch, not the first", () => {
    const tree = root([installed, group("g", [group("g2", [owned])])]);
    expect(treeDepth(tree)).toBe(4);
  });
});

describe("fitsWithinDepth", () => {
  it("allows a leaf at the depth limit's last level", () => {
    // root(1) > g(2) > g2(3), so a leaf at level 4 is the last legal slot.
    const tree = root([group("g", [group("g2", [])])]);
    expect(fitsWithinDepth({ root: tree, parentId: "g2" })).toBe(true);
  });

  it("refuses a leaf that would sit past the limit", () => {
    const tree = root([group("g", [group("g2", [group("g3", [])])])]);
    expect(fitsWithinDepth({ root: tree, parentId: "g3" })).toBe(false);
  });

  it("accounts for the height of what is being inserted", () => {
    const tree = root([group("g", [])]);
    // A 2-high subtree under g occupies levels 3 and 4 — the last that fit.
    expect(fitsWithinDepth({ root: tree, parentId: "g", height: 2 })).toBe(true);
    expect(fitsWithinDepth({ root: tree, parentId: "g", height: 3 })).toBe(false);
  });

  it("refuses an absent parent rather than defaulting to allowed", () => {
    expect(fitsWithinDepth({ root: root([]), parentId: "nope" })).toBe(false);
  });

  it("agrees with MAX_RULE_DEPTH", () => {
    expect(MAX_RULE_DEPTH).toBe(4);
  });
});

// ── removeRule (moved here with the implementation) ─────────────────────

describe("removeRule", () => {
  it("removes a top-level child", () => {
    const next = removeRule(root([installed, owned]), "a") as GroupRule;
    expect(next.children.map((c) => c.id)).toEqual(["b"]);
  });

  it("removes a deeply nested child, leaving the structure intact", () => {
    const tree = root([group("g2", [installed, owned])]);
    const next = removeRule(tree, "b") as GroupRule;
    const inner = next.children[0] as GroupRule;
    expect(inner.children.map((c) => c.id)).toEqual(["a"]);
  });

  it("returns null when asked to remove the node itself", () => {
    expect(removeRule(installed, "a")).toBeNull();
  });

  it("does not mutate its input", () => {
    const tree = root([installed]);
    removeRule(tree, "a");
    expect(tree.children).toHaveLength(1);
  });
});

// ── Edits ──────────────────────────────────────────────────────────────

describe("replaceRule", () => {
  it("swaps a nested rule in place", () => {
    const tree = root([group("g", [installed])]);
    const next = replaceRule({ root: tree, id: "a", next: owned }) as GroupRule;
    expect((next.children[0] as GroupRule).children[0]).toEqual(owned);
  });

  it("can replace the root", () => {
    expect(replaceRule({ root: root([]), id: "root", next: owned })).toEqual(owned);
  });

  it("does not mutate its input", () => {
    const tree = root([installed]);
    replaceRule({ root: tree, id: "a", next: owned });
    expect(tree.children[0]).toEqual(installed);
  });
});

describe("insertRule", () => {
  it("appends by default", () => {
    const next = insertRule({ root: root([installed]), parentId: "root", rule: owned }) as GroupRule;
    expect(next.children.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("honours an explicit index", () => {
    const next = insertRule({
      root: root([installed]),
      parentId: "root",
      rule: owned,
      index: 0,
    }) as GroupRule;
    expect(next.children.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("inserts into a nested group", () => {
    const tree = root([group("g", [])]);
    const next = insertRule({ root: tree, parentId: "g", rule: owned }) as GroupRule;
    expect((next.children[0] as GroupRule).children.map((c) => c.id)).toEqual(["b"]);
  });

  it("is a no-op for an absent parent", () => {
    const tree = root([installed]);
    const next = insertRule({ root: tree, parentId: "nope", rule: owned }) as GroupRule;
    expect(next.children.map((c) => c.id)).toEqual(["a"]);
  });
});

describe("moveRule", () => {
  const three = () =>
    root([installed, owned, { id: "c", kind: "comingSoon" } as Rule]);

  it("moves a rule up", () => {
    const next = moveRule({ root: three(), id: "b", delta: -1 }) as GroupRule;
    expect(next.children.map((c) => c.id)).toEqual(["b", "a", "c"]);
  });

  it("moves a rule down", () => {
    const next = moveRule({ root: three(), id: "b", delta: 1 }) as GroupRule;
    expect(next.children.map((c) => c.id)).toEqual(["a", "c", "b"]);
  });

  it("is inert at the top rather than throwing", () => {
    const next = moveRule({ root: three(), id: "a", delta: -1 }) as GroupRule;
    expect(next.children.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("is inert at the bottom rather than throwing", () => {
    const next = moveRule({ root: three(), id: "c", delta: 1 }) as GroupRule;
    expect(next.children.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("reorders within a nested group only", () => {
    const tree = root([group("g", [installed, owned])]);
    const next = moveRule({ root: tree, id: "b", delta: -1 }) as GroupRule;
    expect((next.children[0] as GroupRule).children.map((c) => c.id)).toEqual(["b", "a"]);
  });
});

describe("wrapInGroup", () => {
  it("wraps a rule and inherits the opposite combinator", () => {
    const tree = root([installed], "all");
    const next = wrapInGroup({ root: tree, id: "a", groupId: "g" }) as GroupRule;
    const wrapper = next.children[0] as GroupRule;
    expect(wrapper.kind).toBe("group");
    expect(wrapper.combinator).toBe("any");
    expect(wrapper.children).toEqual([installed]);
  });

  it("inherits `all` when wrapping inside an `any`", () => {
    const tree = root([installed], "any");
    const next = wrapInGroup({ root: tree, id: "a", groupId: "g" }) as GroupRule;
    expect((next.children[0] as GroupRule).combinator).toBe("all");
  });

  it("honours an explicit combinator", () => {
    const tree = root([installed], "all");
    const next = wrapInGroup({
      root: tree,
      id: "a",
      groupId: "g",
      combinator: "all",
    }) as GroupRule;
    expect((next.children[0] as GroupRule).combinator).toBe("all");
  });

  it("refuses to wrap the root, which must stay the tab's root", () => {
    const tree = root([installed]);
    expect(wrapInGroup({ root: tree, id: "root", groupId: "g" })).toBe(tree);
  });
});

describe("unwrapGroup", () => {
  it("splices a group's children into its place, preserving order", () => {
    const tree = root([installed, group("g", [owned, { id: "c", kind: "comingSoon" }])]);
    const next = unwrapGroup({ root: tree, id: "g" }) as GroupRule;
    expect(next.children.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps nothing when the group was empty", () => {
    const tree = root([installed, group("g", [])]);
    const next = unwrapGroup({ root: tree, id: "g" }) as GroupRule;
    expect(next.children.map((c) => c.id)).toEqual(["a"]);
  });

  it("unwraps a nested group", () => {
    const tree = root([group("g", [group("g2", [owned])])]);
    const next = unwrapGroup({ root: tree, id: "g2" }) as GroupRule;
    expect((next.children[0] as GroupRule).children.map((c) => c.id)).toEqual(["b"]);
  });

  it("refuses to unwrap the root", () => {
    const tree = root([installed]);
    expect(unwrapGroup({ root: tree, id: "root" })).toBe(tree);
  });

  it("is a no-op on a leaf id", () => {
    const tree = root([installed]);
    const next = unwrapGroup({ root: tree, id: "a" }) as GroupRule;
    expect(next.children.map((c) => c.id)).toEqual(["a"]);
  });
});

describe("cloneWithNewIds", () => {
  it("reissues a leaf's id and keeps its params", () => {
    const clone = cloneWithNewIds({
      rule: { id: "a", kind: "title", match: "contains", value: "halo" },
      newId: ids(),
    });
    expect(clone.id).toBe("n1");
    expect(clone).toMatchObject({ kind: "title", value: "halo" });
  });

  it("reissues every id in a subtree, sharing none with the original", () => {
    const original = group("g", [installed, group("g2", [owned])]);
    const clone = cloneWithNewIds({ rule: original, newId: ids() }) as GroupRule;

    const collect = (r: Rule): string[] =>
      r.kind === "group" ? [r.id, ...r.children.flatMap(collect)] : [r.id];
    const before = new Set(collect(original));
    const after = collect(clone);

    expect(after).toEqual(["n1", "n2", "n3", "n4"]);
    expect(after.some((id) => before.has(id))).toBe(false);
  });
});

describe("duplicateRule", () => {
  it("inserts the copy directly after the original", () => {
    const tree = root([installed, owned]);
    const next = duplicateRule({ root: tree, id: "a", newId: ids() }) as GroupRule;
    expect(next.children.map((c) => c.id)).toEqual(["a", "n1", "b"]);
  });

  it("gives a duplicated group independent ids throughout", () => {
    const tree = root([group("g", [installed])]);
    const next = duplicateRule({ root: tree, id: "g", newId: ids() }) as GroupRule;
    const copy = next.children[1] as GroupRule;
    expect(copy.id).toBe("n1");
    expect(copy.children[0]?.id).toBe("n2");
  });

  it("refuses to duplicate the root, which has no parent to hold the copy", () => {
    const tree = root([installed]);
    expect(duplicateRule({ root: tree, id: "root", newId: ids() })).toBe(tree);
  });
});

describe("toggleInvert", () => {
  it("sets invert on a rule that had none", () => {
    const next = toggleInvert({ root: root([installed]), id: "a" }) as GroupRule;
    expect(next.children[0]).toMatchObject({ invert: true });
  });

  it("clears invert that was set", () => {
    const tree = root([{ id: "a", kind: "installed", invert: true }]);
    const next = toggleInvert({ root: tree, id: "a" }) as GroupRule;
    expect(next.children[0]).toMatchObject({ invert: false });
  });

  it("can invert a group", () => {
    const tree = root([group("g", [installed])]);
    const next = toggleInvert({ root: tree, id: "g" }) as GroupRule;
    expect(next.children[0]).toMatchObject({ invert: true });
  });

  it("refuses whitelist and blacklist, where inverting is the other rule", () => {
    const white = root([{ id: "w", kind: "whitelist", appIds: ["1"] }]);
    const black = root([{ id: "k", kind: "blacklist", appIds: ["1"] }]);
    expect(toggleInvert({ root: white, id: "w" })).toBe(white);
    expect(toggleInvert({ root: black, id: "k" })).toBe(black);
  });
});

describe("setCombinator", () => {
  it("flips a group's combinator", () => {
    const tree = root([installed], "all");
    const next = setCombinator({ root: tree, id: "root", combinator: "any" }) as GroupRule;
    expect(next.combinator).toBe("any");
  });

  it("ignores a leaf id rather than corrupting it", () => {
    const tree = root([installed]);
    expect(setCombinator({ root: tree, id: "a", combinator: "any" })).toBe(tree);
  });
});

describe("asRoot", () => {
  it("passes a group through unchanged", () => {
    const tree = root([installed]);
    expect(asRoot({ candidate: tree, fallback: root([]) })).toBe(tree);
  });

  it("falls back to an empty group when the tree was removed entirely", () => {
    const fallback = root([installed], "any");
    const out = asRoot({ candidate: null, fallback });
    expect(out.children).toEqual([]);
    // The fallback keeps the combinator, so an accidental wipe is recoverable
    // without also silently switching AND to OR.
    expect(out.combinator).toBe("any");
  });

  it("falls back when a leaf was returned where a root was needed", () => {
    const out = asRoot({ candidate: installed, fallback: root([]) });
    expect(out.kind).toBe("group");
    expect(out.children).toEqual([]);
  });
});
