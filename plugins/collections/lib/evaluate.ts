/**
 * The evaluator: walk a tab's rule tree over the library, then sort, cap
 * and group the matches.
 *
 * ## Kleene three-valued logic
 *
 * Combination follows Kleene's strong logic, which is the standard answer
 * to "what does AND mean when one operand is unknown":
 *
 * ```
 *   all: any false → false;  else any indeterminate → indeterminate;  else true
 *   any: any true  → true;   else any indeterminate → indeterminate;  else false
 *   not: flips true/false, PRESERVES indeterminate
 * ```
 *
 * The short-circuits are the interesting part. `all` with one definite
 * `false` is `false` even if a sibling couldn't be checked — a game that
 * definitely isn't installed is excluded from "installed AND friends
 * playing" whether or not the friends data loaded. Symmetrically, `any`
 * with one definite `true` is `true`. So a cold or broken data source only
 * degrades results where it would actually have decided the outcome.
 *
 * ## The trace is the product
 *
 * `EvalResult.trace` is not diagnostics bolted on afterwards — it is why
 * this plugin can do things TabMaster can't. From one traced evaluation we
 * get: the per-rule match counts shown on every builder row, the
 * `ALL → 0 · ANY → 340` consequence line that makes the AND/OR mistake
 * unmakeable, the leave-one-out counts that let the empty state say
 * "remove this one rule and 214 games match", and the per-leaf bitmasks
 * that let us detect contradictory rule pairs empirically instead of from
 * a hardcoded table of known-bad combinations.
 *
 * Isomorphic: pure, no I/O. Safe in the CEF webview bundle.
 */

import type { GameMetadata } from "@loadout/types";
import type {
  EvalGame,
  FactKey,
  GroupRule,
  Rule,
  RuleKind,
  ManagedCollection,
  Verdict,
} from "./types";
import { evaluateLeaf, factUnavailableReason, leafRules, ruleDef } from "./rules";
import { sortGames } from "./sort";

export type { Verdict };

/** Combine child verdicts under `all`. See the module header. */
export function combineAll(verdicts: readonly Verdict[]): Verdict {
  // An empty `all` group is vacuously true — "every rule in an empty set
  // passes". This makes a brand-new tab show the whole library rather than
  // nothing, which is the right starting point for building one.
  let sawIndeterminate = false;
  for (const v of verdicts) {
    if (v === false) return false;
    if (v === "indeterminate") sawIndeterminate = true;
  }
  return sawIndeterminate ? "indeterminate" : true;
}

/** Combine child verdicts under `any`. See the module header. */
export function combineAny(verdicts: readonly Verdict[]): Verdict {
  // An empty `any` group is vacuously false — dual of `combineAll`. The
  // asymmetry is deliberate and specced; it is not an oversight.
  let sawIndeterminate = false;
  for (const v of verdicts) {
    if (v === true) return true;
    if (v === "indeterminate") sawIndeterminate = true;
  }
  return sawIndeterminate ? "indeterminate" : false;
}

/** Test one rule (leaf or group) against one game. */
export function evaluateRule(rule: Rule, game: EvalGame): Verdict {
  if (rule.kind !== "group") return evaluateLeaf(rule, game);

  const verdicts = rule.children.map((child) => evaluateRule(child, game));
  const combined =
    rule.combinator === "all" ? combineAll(verdicts) : combineAny(verdicts);
  if (combined === "indeterminate") return combined;
  return rule.invert === true ? !combined : combined;
}

/**
 * Resolve a verdict into a final include/exclude decision, applying the
 * tab's policy for rules that couldn't be answered.
 */
function decide(verdict: Verdict, policy: ManagedCollection["indeterminatePolicy"]): boolean {
  if (verdict !== "indeterminate") return verdict;
  return policy === "pass";
}

// ── Trace ──────────────────────────────────────────────────────────────

export interface RuleNodeTrace {
  nodeId: string;
  kind: RuleKind;
  /** Games for which this node returned `true`. */
  passed: number;
  /** Games for which it returned `false`. */
  failed: number;
  /** Games for which its data source couldn't answer. */
  indeterminate: number;
  /**
   * How many games the **parent group** would match if this child were
   * removed. On the root, equals the library size.
   *
   * This single number is what powers the one-tap empty-state fix: if
   * exactly one child's removal takes a group from 0 matches to 214, that
   * child is provably the culprit and we can say so by name.
   *
   * Only populated when `opts.trace` is set.
   */
  withoutThis: number;
  children?: RuleNodeTrace[];
}

export interface EvalResult {
  /** Final games: post-sort, post-cap. */
  matched: GameMetadata[];
  /** Match count **before** `limit` was applied. */
  total: number;
  /** How many matches the cap discarded (`total - matched.length`). */
  cappedOut: number;
  trace: RuleNodeTrace;
  /**
   * Async facts the tree needed but couldn't get, with the reason the
   * resolver gave and which rules were affected. Rendered verbatim by the
   * diagnostics — this is how "your tab is empty" becomes "Friends Playing
   * needs Steam running".
   */
  blockedFacts: Array<{ fact: FactKey; reason: string; ruleIds: string[] }>;
  /**
   * Per-leaf pass bitmaps, aligned to the *input* `games` array (1 = that
   * leaf passed for that game). Lets `diagnose.ts` find contradictory
   * rule pairs by intersecting masks, rather than maintaining a table of
   * combinations someone thought of in advance.
   *
   * Only populated when `opts.trace` is set — one byte per game per leaf.
   */
  leafMasks?: Map<string, Uint8Array>;
}

export interface EvaluateOptions {
  /**
   * Collect `trace` counts, `withoutThis` and `leafMasks`. Roughly triples
   * the cost, so it is `false` on the hot render path and `true` only while
   * the tab editor is open.
   */
  trace?: boolean;
  /** Epoch ms, injected so relative-date rules are testable. */
  now?: number;
  /** Seed for `random` sort order. */
  seed?: number;
}

/** Empty trace node, used for untraced runs and as an accumulator base. */
function emptyTrace(rule: Rule): RuleNodeTrace {
  return {
    nodeId: rule.id,
    kind: rule.kind,
    passed: 0,
    failed: 0,
    indeterminate: 0,
    withoutThis: 0,
    ...(rule.kind === "group"
      ? { children: rule.children.map(emptyTrace) }
      : {}),
  };
}

/** Tally one verdict into a trace node. */
function tally(node: RuleNodeTrace, verdict: Verdict): void {
  if (verdict === true) node.passed++;
  else if (verdict === false) node.failed++;
  else node.indeterminate++;
}

/**
 * Evaluate a node, filling `trace` as it goes and returning the verdict.
 * Kept separate from `evaluateRule` so the untraced path stays free of
 * bookkeeping.
 */
function evaluateTraced(
  rule: Rule,
  game: EvalGame,
  node: RuleNodeTrace,
): Verdict {
  if (rule.kind !== "group") {
    const v = evaluateLeaf(rule, game);
    tally(node, v);
    return v;
  }

  const verdicts = rule.children.map((child, i) =>
    evaluateTraced(child, game, node.children![i]!),
  );
  const combined =
    rule.combinator === "all" ? combineAll(verdicts) : combineAny(verdicts);
  const final =
    combined === "indeterminate"
      ? combined
      : rule.invert === true
        ? !combined
        : combined;
  tally(node, final);
  return final;
}

/**
 * Recompute, for every group node, how many games it would match with each
 * child omitted. Runs only under `trace`.
 *
 * Cost is O(games × leaves) on top of the base pass — acceptable because it
 * only runs while the editor is open, and it is the entire basis of the
 * "remove this rule" fix.
 */
function fillWithoutThis(
  rule: Rule,
  games: readonly EvalGame[],
  policy: ManagedCollection["indeterminatePolicy"],
  node: RuleNodeTrace,
): void {
  if (rule.kind !== "group" || rule.children.length === 0) return;

  for (let i = 0; i < rule.children.length; i++) {
    const remaining = rule.children.filter((_, j) => j !== i);
    const probe: GroupRule = { ...rule, children: remaining };
    let count = 0;
    for (const game of games) {
      if (decide(evaluateRule(probe, game), policy)) count++;
    }
    node.children![i]!.withoutThis = count;
  }

  for (let i = 0; i < rule.children.length; i++) {
    fillWithoutThis(rule.children[i]!, games, policy, node.children![i]!);
  }
}

/** Collect blocked facts by walking the tree and inspecting each game. */
function collectBlockedFacts(
  root: Rule,
  games: readonly EvalGame[],
): EvalResult["blockedFacts"] {
  // fact -> { reason, ruleIds }
  const byFact = new Map<FactKey, { reason: string; ruleIds: Set<string> }>();

  for (const leaf of leafRules(root)) {
    if (leaf.kind === "group") continue;
    const key = ruleDef(leaf.kind).factKey;
    if (!key) continue;

    // One unavailable reason is enough to report the fact as blocked; we
    // take the first concrete reason we find rather than scanning all
    // games, since resolvers fail wholesale, not per game.
    let reason: string | null = null;
    let answeredForAnyGame = false;
    for (const game of games) {
      const fact = game.facts[key];
      if (!fact) continue;
      // `missing` means the resolver ran and had nothing for *this* game, so
      // it is not evidence the source is alive. Counting it as such — which
      // "some game carries an entry" did once `missing` started being
      // materialised for every game — made a resolver that answered for
      // nobody look perfectly healthy, and its empty tab got diagnosed
      // "your rules are fine" instead of "this source has no data".
      if (fact.state === "missing") continue;
      answeredForAnyGame = true;
      if (fact.state === "unavailable") {
        reason = fact.reason;
        break;
      }
    }

    // A fact that NO game carries has no resolver behind it, which is every bit
    // as blocked as one that failed — and considerably more dangerous, because
    // nothing anywhere says so. `readFact` returns `indeterminate` for an absent
    // fact, and `ManagedCollection.indeterminatePolicy` defaults to `"pass"`, so such a rule
    // silently matches the entire library while the diagnostics stay quiet.
    // Reporting it is what lets `diagnoseCollection` reach its `blocked-facts` branch.
    if (!answeredForAnyGame && games.length > 0) {
      reason = factUnavailableReason(key);
    }

    if (reason === null) continue;
    const entry = byFact.get(key);
    if (entry) entry.ruleIds.add(leaf.id);
    else byFact.set(key, { reason, ruleIds: new Set([leaf.id]) });
  }

  return [...byFact.entries()].map(([fact, { reason, ruleIds }]) => ({
    fact,
    reason,
    ruleIds: [...ruleIds],
  }));
}

/**
 * Evaluate a whole tab: filter, sort, cap, group.
 *
 * Order matters and is fixed: **filter → sort → cap → group**. Capping
 * after sorting is what makes "my 30 most recently played" mean anything;
 * capping before would take an arbitrary 30. Grouping after capping means
 * sub-tab counts add up to the visible total rather than to some larger
 * hidden number.
 */
export function evaluateCollection(
  tab: ManagedCollection,
  games: readonly EvalGame[],
  opts: EvaluateOptions = {},
): EvalResult {
  const policy = tab.indeterminatePolicy;
  const wantTrace = opts.trace === true;
  const trace = emptyTrace(tab.root);

  const matchedGames: GameMetadata[] = [];
  const leaves = wantTrace ? leafRules(tab.root) : [];
  const leafMasks = wantTrace
    ? new Map(leaves.map((l) => [l.id, new Uint8Array(games.length)] as const))
    : undefined;

  for (let i = 0; i < games.length; i++) {
    const game = games[i]!;
    const verdict = wantTrace
      ? evaluateTraced(tab.root, game, trace)
      : evaluateRule(tab.root, game);

    if (leafMasks) {
      // Re-run each leaf standalone for the mask. The traced walk already
      // computed these, but short-circuiting means a leaf under a failing
      // `all` may never have been reached — and a mask with holes would
      // make contradiction detection report false positives.
      for (const leaf of leaves) {
        if (evaluateLeaf(leaf, game) === true) leafMasks.get(leaf.id)![i] = 1;
      }
    }

    if (decide(verdict, policy)) matchedGames.push(game.meta);
  }

  if (wantTrace) {
    trace.withoutThis = games.length;
    fillWithoutThis(tab.root, games, policy, trace);
  }

  const sorted = sortGames(matchedGames, tab.sort, {
    seed: opts.seed,
    manualOrder: tab.manualOrder,
  });

  const total = sorted.length;
  const capped =
    tab.limit !== null && tab.limit >= 0 ? sorted.slice(0, tab.limit) : sorted;

  return {
    matched: capped,
    total,
    cappedOut: total - capped.length,
    trace,
    blockedFacts: collectBlockedFacts(tab.root, games),
    ...(leafMasks ? { leafMasks } : {}),
  };
}

/**
 * Count matches for a tab without sorting, grouping or tracing. Used by the
 * rule palette, which needs ~30 counts per keystroke and cares only about
 * the number.
 */
/**
 * How many games the rules match, **before** `limit`.
 *
 * Deliberately uncapped: the builder prices candidates with this, and a
 * palette that said "→ 30 games" because a cap is set would be describing the
 * cap rather than the rule. The consequence is that any surface claiming to
 * show what the collection will *hold* must use {@link evaluateCollection},
 * which does apply the cap — the two numbers are different questions and this
 * one answers the rule's.
 */
export function countMatches(
  tab: Pick<ManagedCollection, "root" | "indeterminatePolicy">,
  games: readonly EvalGame[],
): number {
  let n = 0;
  for (const game of games) {
    if (decide(evaluateRule(tab.root, game), tab.indeterminatePolicy)) n++;
  }
  return n;
}
