/**
 * Why is this tab empty, and what one tap fixes it?
 *
 * This module is the reason the whole engine carries a trace. TabMaster's
 * equivalent of an empty state is an empty grid — its own issue tracker has
 * users asking "why is my tab empty?" and going unanswered, and the two
 * documented cases are exactly the ones diagnosed here: an AND that should
 * have been an OR, and a rule pair that can never both hold (`streamable
 * true` + `installed false`). Its maintainer conceded in #333 that the
 * builder is the weak spot.
 *
 * Every diagnosis carries `Fix`es, and every `Fix` is a pure `ManagedCollection → ManagedCollection`.
 * That makes them trivially testable and makes the UI a one-liner:
 * `<Button onClick={() => setDraft(fix.apply(draft))}>{fix.label}</Button>`.
 *
 * The contradiction detector is worth calling out: it finds conflicting
 * rules **empirically**, by intersecting the per-leaf bitmasks the evaluator
 * produced, rather than consulting a table of combinations someone thought
 * of in advance. Any two rules that provably cannot co-occur in *this user's
 * library* are caught, including ones we never anticipated.
 *
 * Isomorphic: pure, no I/O.
 */

import type { EvalResult, RuleNodeTrace } from "./evaluate";
import type { FactKey, GroupRule, Rule, ManagedCollection } from "./types";
import { leafRules } from "./rules";
import { paramSpecs } from "./rule-params";
import { asRoot, removeRule } from "./rule-tree";
import { summarizeRule } from "./summarize";

/** A one-tap repair. `apply` must be pure and must not mutate its input. */
export interface Fix {
  label: string;
  apply: (tab: ManagedCollection) => ManagedCollection;
}

export type Diagnosis =
  | { kind: "ok" }
  | { kind: "empty-library"; message: string; fixes: Fix[] }
  | { kind: "blocked-facts"; facts: FactKey[]; message: string; fixes: Fix[] }
  | {
      kind: "contradiction";
      ruleIds: [string, string];
      message: string;
      fixes: Fix[];
    }
  | {
      kind: "single-culprit";
      ruleId: string;
      wouldMatch: number;
      message: string;
      fixes: Fix[];
    }
  | { kind: "combinator"; anyWouldMatch: number; message: string; fixes: Fix[] }
  | { kind: "over-capped"; limit: number; total: number; message: string; fixes: Fix[] }
  | { kind: "genuinely-empty"; message: string; fixes: Fix[] };

// ── Pure tab transforms used by the fixes ──────────────────────────────

function withRoot(tab: ManagedCollection, root: GroupRule): ManagedCollection {
  return { ...tab, root };
}

function fixRemoveRule(ruleId: string, label: string): Fix {
  return {
    label,
    apply: (tab) =>
      // Removing the root itself would leave no tree; `asRoot` falls back to an
      // empty group, which matches everything — a sane, recoverable state.
      withRoot(
        tab,
        asRoot({ candidate: removeRule(tab.root, ruleId), fallback: tab.root }),
      ),
  };
}

/** Flip the root combinator. */
function fixSwitchCombinator(to: "all" | "any", count: number): Fix {
  return {
    label: `Switch to ${to === "any" ? "ANY" : "ALL"} (${count} game${count === 1 ? "" : "s"})`,
    apply: (tab) => withRoot(tab, { ...tab.root, combinator: to }),
  };
}

const FIX_IGNORE_UNCHECKED: Fix = {
  label: "Include games we couldn't check",
  apply: (tab) => ({ ...tab, indeterminatePolicy: "pass" }),
};

const FIX_EXCLUDE_UNCHECKED: Fix = {
  label: "Exclude games we couldn't check",
  apply: (tab) => ({ ...tab, indeterminatePolicy: "fail" }),
};

const FIX_REMOVE_LIMIT: Fix = {
  label: "Remove the limit",
  apply: (tab) => ({ ...tab, limit: null }),
};

// ── Detectors ──────────────────────────────────────────────────────────

/**
 * Find two leaves under the *root* group whose pass-sets are disjoint.
 *
 * Only meaningful when the root combines with `all` — under `any`, disjoint
 * rules are the normal and intended case. We also require both leaves to
 * match something on their own, since a rule that matches nothing at all is
 * better reported as a single culprit.
 */
function findContradiction(
  tab: ManagedCollection,
  result: EvalResult,
): [Rule, Rule] | null {
  if (tab.root.combinator !== "all") return null;
  const masks = result.leafMasks;
  if (!masks) return null;

  // Only direct children that are leaves; a nested group's internals may
  // legitimately conflict with a sibling without the tab being broken.
  const leaves = tab.root.children.filter((c) => c.kind !== "group");
  for (let i = 0; i < leaves.length; i++) {
    const a = leaves[i]!;
    const maskA = masks.get(a.id);
    if (!maskA) continue;
    const countA = maskA.reduce<number>((n, b) => n + b, 0);
    if (countA === 0) continue;

    for (let j = i + 1; j < leaves.length; j++) {
      const b = leaves[j]!;
      const maskB = masks.get(b.id);
      if (!maskB) continue;
      const countB = maskB.reduce<number>((n, x) => n + x, 0);
      if (countB === 0) continue;

      let overlap = 0;
      for (let k = 0; k < maskA.length; k++) {
        if (maskA[k] === 1 && maskB[k] === 1) {
          overlap++;
          break;
        }
      }
      if (overlap === 0) return [a, b];
    }
  }
  return null;
}

/**
 * Exactly one direct child of the root whose removal takes the tab from
 * nothing to something. Reads straight off `withoutThis`.
 */
function findSingleCulprit(
  tab: ManagedCollection,
  result: EvalResult,
): { rule: Rule; trace: RuleNodeTrace } | null {
  const children = result.trace.children;
  // Two or more, deliberately. With a single rule, removing it always yields
  // the whole library, so "remove X and 4356 games match" is trivially true
  // and tells the user nothing — the genuinely-empty wording is the honest
  // one there.
  if (!children || children.length < 2) return null;

  const candidates = children
    .map((t, i) => ({ trace: t, rule: tab.root.children[i]! }))
    .filter((c) => c.trace.withoutThis > 0);

  return candidates.length === 1 ? candidates[0]! : null;
}

export interface DiagnoseContext {
  /** Total games in the library, before any rule ran. */
  librarySize: number;
  /**
   * Whether that library can be believed.
   *
   * `librarySize` alone cannot tell a small library from a half-read one:
   * Steam's own read degrades to *some* games — the installed ones — long
   * before it has the owned set, so a thin snapshot arrives non-empty and
   * every diagnosis below becomes a confident claim about somebody's library
   * built on a partial read of it. Defaults to `true` for callers that have no
   * way of knowing; the ones that do should pass it.
   */
  libraryLoaded?: boolean;
  /**
   * Match count the tab would have with the root combinator flipped.
   * Supplied by the caller because computing it needs another evaluation
   * pass, and only the editor needs it.
   */
  flippedCombinatorCount?: number;
}

/**
 * Explain an empty (or truncated) tab, most actionable cause first.
 *
 * Order matters. A blocked data source outranks a rule-logic problem
 * because the user can't fix their rules if the inputs are missing, and a
 * contradiction outranks a single culprit because naming both conflicting
 * rules is more useful than naming one of them arbitrarily.
 */
export function diagnoseCollection(
  tab: ManagedCollection,
  result: EvalResult,
  ctx: DiagnoseContext,
): Diagnosis {
  // A tab that is showing games needs no explanation — except when the cap
  // is hiding most of them, which surprises people, and except when a rule
  // couldn't be checked at all.
  //
  // That second exception is the important one: `indeterminate` resolves to a
  // match under the default policy, so a rule reading a fact no resolver
  // supplies passes *every* game. The collection looks healthy, quietly
  // contains the whole library, and gets mirrored into Steam that way. Exiting
  // here on "it has matches" is what hid it.
  if (result.matched.length > 0 && result.blockedFacts.length === 0) {
    if (
      tab.limit !== null &&
      result.cappedOut > 0 &&
      result.cappedOut > result.matched.length
    ) {
      return {
        kind: "over-capped",
        limit: tab.limit,
        total: result.total,
        message: `Showing ${result.matched.length} of ${result.total} matches — the limit is hiding ${result.cappedOut}`,
        fixes: [FIX_REMOVE_LIMIT],
      };
    }
    return { kind: "ok" };
  }

  // 1. Nothing to filter, or nothing we can trust. Both outrank every rule
  //    diagnosis below: those all read "your rules are wrong", and saying that
  //    about a library we haven't finished reading sends people editing rules
  //    that were fine.
  if (ctx.librarySize === 0 || ctx.libraryLoaded === false) {
    return {
      kind: "empty-library",
      message:
        ctx.librarySize === 0
          ? "Your library hasn't been scanned yet"
          : "Still reading your library — counts and warnings arrive with it",
      fixes: [],
    };
  }

  // 2. A limit of 0 (or the whole set capped away) before blaming the rules.
  if (tab.limit !== null && tab.limit <= 0 && result.total > 0) {
    return {
      kind: "over-capped",
      limit: tab.limit,
      total: result.total,
      message: `${result.total} game${result.total === 1 ? "" : "s"} match, but the limit is set to ${tab.limit}`,
      fixes: [FIX_REMOVE_LIMIT],
    };
  }

  // 3. Missing inputs. The user can't reason about rules whose data never
  //    arrived, so this outranks every logic diagnosis.
  if (result.blockedFacts.length > 0) {
    const reasons = result.blockedFacts.map((b) => b.reason);
    const ruleCount = new Set(result.blockedFacts.flatMap((b) => b.ruleIds)).size;
    return {
      kind: "blocked-facts",
      facts: result.blockedFacts.map((b) => b.fact),
      message:
        `${ruleCount} rule${ruleCount === 1 ? "" : "s"} couldn't be checked: ` +
        // The resolver's own sentence, verbatim — it knows why.
        reasons.join(" ") +
        (result.matched.length > 0 && tab.indeterminatePolicy !== "fail"
          ? ` Until that data arrives ${ruleCount === 1 ? "it matches" : "they match"} everything, so this is wider than it looks.`
          : ""),
      fixes:
        tab.indeterminatePolicy === "fail"
          ? [FIX_IGNORE_UNCHECKED]
          : [FIX_EXCLUDE_UNCHECKED],
    };
  }

  // 4. Two rules that can never both hold.
  const contradiction = findContradiction(tab, result);
  if (contradiction) {
    const [a, b] = contradiction;
    return {
      kind: "contradiction",
      ruleIds: [a.id, b.id],
      message: `"${summarizeRule(a)}" and "${summarizeRule(b)}" can never both be true for the same game`,
      fixes: [
        fixRemoveRule(a.id, `Remove "${summarizeRule(a)}"`),
        fixRemoveRule(b.id, `Remove "${summarizeRule(b)}"`),
        ...(ctx.flippedCombinatorCount !== undefined &&
        ctx.flippedCombinatorCount > 0
          ? [fixSwitchCombinator("any", ctx.flippedCombinatorCount)]
          : []),
      ],
    };
  }

  // 5. One rule is doing all the excluding.
  const culprit = findSingleCulprit(tab, result);
  if (culprit) {
    const summary = summarizeRule(culprit.rule);
    return {
      kind: "single-culprit",
      ruleId: culprit.rule.id,
      wouldMatch: culprit.trace.withoutThis,
      message: `Remove "${summary}" and ${culprit.trace.withoutThis} game${culprit.trace.withoutThis === 1 ? "" : "s"} match`,
      fixes: [fixRemoveRule(culprit.rule.id, `Remove "${summary}"`)],
    };
  }

  // 6. ALL where ANY was meant. The single most common TabMaster mistake.
  if (
    tab.root.combinator === "all" &&
    ctx.flippedCombinatorCount !== undefined &&
    ctx.flippedCombinatorCount > 0
  ) {
    return {
      kind: "combinator",
      anyWouldMatch: ctx.flippedCombinatorCount,
      message: `No game matches all of these rules, but ${ctx.flippedCombinatorCount} match at least one`,
      fixes: [fixSwitchCombinator("any", ctx.flippedCombinatorCount)],
    };
  }

  // 7. The rules are fine; the library just doesn't contain such a game.
  //
  // Only suggest widening when there is something to widen. A tab whose one
  // rule is `familyShared` has no range anywhere in the tree, and telling its
  // owner to widen one sends them looking for a control that isn't there.
  // No rule variant has a `range` property — ranges are named `minutes`,
  // `bytes`, `percent`, `score`, `hours`, `epochSec`. Testing for one meant
  // only the three date kinds were recognised and every other range rule was
  // told to remove itself when widening a bound was the actual fix. The
  // registry already knows which params are ranges.
  const hasRange = leafRules(tab.root).some((r) =>
    paramSpecs(r.kind).some((spec) => spec.control === "range"),
  );
  return {
    kind: "genuinely-empty",
    message: hasRange
      ? "These rules are valid — no game in your library matches. Try widening a range"
      : "These rules are valid — no game in your library matches. Try removing a rule",
    fixes: leafRules(tab.root).length > 0
      ? [fixRemoveRule(leafRules(tab.root).at(-1)!.id, "Remove the last rule")]
      : [],
  };
}
