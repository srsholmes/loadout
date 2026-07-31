/**
 * Pure structural edits on a rule tree.
 *
 * Every operation the builder offers — add, edit, invert, reorder, wrap,
 * duplicate, delete — is a `Rule -> Rule` function here rather than state
 * mutation inside a component. Two reasons:
 *
 * 1. The builder's whole premise is that you can see the consequence of an
 *    edit *before* committing it. That requires producing the edited tree
 *    without touching the saved one, so the caller can evaluate a candidate
 *    (`evaluateTab({...tab, root: candidate})`) and throw it away.
 * 2. `diagnose.ts` already expresses its one-tap repairs as pure
 *    `Tab -> Tab` fixes. Sharing the same primitives keeps a fix and the
 *    equivalent manual edit from drifting apart.
 *
 * Ids are supplied by the caller via `newId`, never generated here — `iso`
 * code cannot reach `node:crypto`, and injected ids keep tests deterministic.
 */

import type { GroupRule, Rule } from "./types";

/**
 * Maximum nesting, counting the root group as level 1. Beyond this a tree
 * stops being readable on a 1280×800 handheld screen at a 20px indent step,
 * and TabMaster's own merge-group confusion is the evidence that deep nesting
 * is not where the value is.
 */
export const MAX_RULE_DEPTH = 4;

// ── Queries ────────────────────────────────────────────────────────────

/** The rule with this id, anywhere in the tree. */
export function findRule(root: Rule, id: string): Rule | null {
  if (root.id === id) return root;
  if (root.kind !== "group") return null;
  for (const child of root.children) {
    const hit = findRule(child, id);
    if (hit) return hit;
  }
  return null;
}

/** The group directly containing `id`, or null for the root / an absent id. */
export function findParent(root: Rule, id: string): GroupRule | null {
  if (root.kind !== "group") return null;
  for (const child of root.children) {
    if (child.id === id) return root;
    const hit = findParent(child, id);
    if (hit) return hit;
  }
  return null;
}

/**
 * Levels from the root down to `id` inclusive, so the root itself is 1.
 * Returns 0 when the id is not in the tree.
 */
export function ruleDepth(root: Rule, id: string): number {
  if (root.id === id) return 1;
  if (root.kind !== "group") return 0;
  for (const child of root.children) {
    const found = ruleDepth(child, id);
    if (found > 0) return found + 1;
  }
  return 0;
}

/** Deepest level in this subtree, counting the subtree's own root as 1. */
export function treeDepth(rule: Rule): number {
  if (rule.kind !== "group" || rule.children.length === 0) return 1;
  return 1 + Math.max(...rule.children.map(treeDepth));
}

/**
 * Whether a subtree of height `height` can be placed inside `parentId`
 * without breaking `MAX_RULE_DEPTH`. Checked before offering "Wrap in group"
 * or a paste, so the affordance is absent rather than failing on use.
 */
export function fitsWithinDepth(args: {
  root: Rule;
  parentId: string;
  height?: number;
}): boolean {
  const { root, parentId, height = 1 } = args;
  const depth = ruleDepth(root, parentId);
  if (depth === 0) return false;
  return depth + height <= MAX_RULE_DEPTH;
}

// ── Edits ──────────────────────────────────────────────────────────────

/**
 * Remove a rule by id, anywhere in the tree. Returns null when the removed
 * rule *is* the given root, which the caller must handle — a tab always needs
 * a root group.
 */
export function removeRule(rule: Rule, targetId: string): Rule | null {
  if (rule.id === targetId) return null;
  if (rule.kind !== "group") return rule;
  const children = rule.children
    .map((c) => removeRule(c, targetId))
    .filter((c): c is Rule => c !== null);
  return { ...rule, children };
}

/** Swap the rule at `id` for `next`, keeping everything around it. */
export function replaceRule(args: { root: Rule; id: string; next: Rule }): Rule {
  const { root, id, next } = args;
  if (root.id === id) return next;
  if (root.kind !== "group") return root;
  return {
    ...root,
    children: root.children.map((c) => replaceRule({ root: c, id, next })),
  };
}

/**
 * Add `rule` to the children of `parentId`. `index` defaults to the end,
 * which is where a newly-picked rule belongs — appearing next to the palette
 * button the user just pressed.
 */
export function insertRule(args: {
  root: Rule;
  parentId: string;
  rule: Rule;
  index?: number;
}): Rule {
  const { root, parentId, rule, index } = args;
  if (root.kind !== "group") return root;
  if (root.id === parentId) {
    const children = [...root.children];
    children.splice(index ?? children.length, 0, rule);
    return { ...root, children };
  }
  return {
    ...root,
    children: root.children.map((c) => insertRule({ ...args, root: c })),
  };
}

/**
 * Shift a rule among its siblings. `delta` is -1 for up, +1 for down; a move
 * that would leave the sibling list is a no-op rather than an error, so the
 * caller can bind it to a button that is simply inert at the ends.
 *
 * Reordering is always available this way. Drag-to-reorder is an addition, not
 * the only path — dragging is unusable with a gamepad, which is the primary
 * input here.
 */
export function moveRule(args: { root: Rule; id: string; delta: number }): Rule {
  const { root, id, delta } = args;
  if (root.kind !== "group") return root;

  const at = root.children.findIndex((c) => c.id === id);
  if (at !== -1) {
    const to = at + delta;
    if (to < 0 || to >= root.children.length) return root;
    const children = [...root.children];
    const [moved] = children.splice(at, 1);
    if (!moved) return root;
    children.splice(to, 0, moved);
    return { ...root, children };
  }

  return {
    ...root,
    children: root.children.map((c) => moveRule({ ...args, root: c })),
  };
}

/**
 * Put a rule inside a new group in its own position, so a flat list can grow
 * an "any of these" branch without rebuilding it. The new group inherits the
 * opposite combinator of its parent, because wrapping is nearly always done to
 * express the *other* relationship — wrapping inside an `all` to get an `any`
 * is the reason the affordance exists.
 */
export function wrapInGroup(args: {
  root: Rule;
  id: string;
  groupId: string;
  combinator?: "all" | "any";
}): Rule {
  const { root, id, groupId, combinator } = args;
  const target = findRule(root, id);
  if (!target || target.id === root.id) return root;

  const parent = findParent(root, id);
  const inherited: "all" | "any" =
    combinator ?? (parent?.combinator === "all" ? "any" : "all");

  const group: GroupRule = {
    id: groupId,
    kind: "group",
    combinator: inherited,
    children: [target],
  };
  return replaceRule({ root, id, next: group });
}

/**
 * Copy a rule in beside itself. A duplicated group needs fresh ids all the way
 * down, or the two copies share node identity and every trace count, invert
 * toggle and edit applies to both.
 */
export function duplicateRule(args: {
  root: Rule;
  id: string;
  newId: () => string;
}): Rule {
  const { root, id, newId } = args;
  const target = findRule(root, id);
  const parent = findParent(root, id);
  if (!target || !parent) return root;

  const at = parent.children.findIndex((c) => c.id === id);
  return insertRule({
    root,
    parentId: parent.id,
    rule: cloneWithNewIds({ rule: target, newId }),
    index: at + 1,
  });
}

/** Deep copy with every id reissued. */
export function cloneWithNewIds(args: {
  rule: Rule;
  newId: () => string;
}): Rule {
  const { rule, newId } = args;
  if (rule.kind !== "group") return { ...rule, id: newId() };
  return {
    ...rule,
    id: newId(),
    children: rule.children.map((c) => cloneWithNewIds({ rule: c, newId })),
  };
}

/**
 * Flip a rule's `invert`. Not offered for `whitelist`/`blacklist`: inverting a
 * whitelist *is* a blacklist, and exposing both spellings of one idea is how a
 * builder starts confusing people.
 */
export function toggleInvert(args: { root: Rule; id: string }): Rule {
  const { root, id } = args;
  const target = findRule(root, id);
  if (!target || target.kind === "whitelist" || target.kind === "blacklist") {
    return root;
  }
  return replaceRule({
    root,
    id,
    next: { ...target, invert: !target.invert },
  });
}

/** Set a group's combinator. Ignored for non-group ids. */
export function setCombinator(args: {
  root: Rule;
  id: string;
  combinator: "all" | "any";
}): Rule {
  const { root, id, combinator } = args;
  const target = findRule(root, id);
  if (!target || target.kind !== "group") return root;
  return replaceRule({ root, id, next: { ...target, combinator } });
}

/**
 * Drop a group but keep its children, splicing them into its place.
 *
 * The escape hatch for a wrap the user regrets. Without it the only way out is
 * deleting the group, which silently takes every rule inside it — the kind of
 * destructive-by-omission behaviour this builder is meant to avoid.
 */
export function unwrapGroup(args: { root: Rule; id: string }): Rule {
  const { root, id } = args;
  if (root.kind !== "group" || root.id === id) return root;

  const at = root.children.findIndex((c) => c.id === id);
  if (at !== -1) {
    const group = root.children[at];
    if (!group || group.kind !== "group") return root;
    const children = [...root.children];
    children.splice(at, 1, ...group.children);
    return { ...root, children };
  }

  return {
    ...root,
    children: root.children.map((c) => unwrapGroup({ root: c, id })),
  };
}

/** Coerce a possibly-non-group result back to the root group a Tab requires. */
export function asRoot(args: { candidate: Rule | null; fallback: GroupRule }): GroupRule {
  const { candidate, fallback } = args;
  if (candidate === null || candidate.kind !== "group") {
    return { ...fallback, children: [] };
  }
  return candidate;
}
