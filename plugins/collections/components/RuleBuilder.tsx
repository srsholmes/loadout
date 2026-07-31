/**
 * The rule builder.
 *
 * Design axiom, from the plan: *the builder never shows you a number you
 * didn't ask for, and never hides the number that matters.* Every rule row
 * carries its own count, the header carries the collection's, each group carries
 * both of its combinator outcomes, and the palette carries what each
 * candidate would produce before you add it.
 *
 * All of those come from **one** traced evaluation per draft plus a handful
 * of cheap `countMatches` passes. Evaluation is local and allocation-free, so
 * this is affordable on every keystroke — which is precisely what makes the
 * design possible at all. TabMaster cannot do it: its data layer is
 * synchronous and its counts require a save.
 *
 * Editing happens on a **draft** collection. Nothing reaches storage until Save, so
 * Cancel is a real escape and an experiment costs nothing.
 */

import { useCallback, useDeferredValue, useMemo, useRef, useState } from "react";
import { Button, Text } from "@loadout/ui";
import { RuleGroupNode, TotalBadge, type CombinatorCounts, type RuleTreeContext } from "./RuleGroupNode";
import { BuilderPage } from "./BuilderPage";
import { RuleEditorPage } from "./RuleEditorPage";
import { RulePalette, type PricedCandidate } from "./RulePalette";
import type { RuleRowAction } from "./RuleNodeRow";
import type { RuleNodeTrace } from "../lib/evaluate";
import { countMatches, evaluateCollection } from "../lib/evaluate";
import { diagnoseCollection } from "../lib/diagnose";
import { ruleCandidate } from "../lib/rule-params";
import type { ParamOption } from "../lib/rule-params";
import { RULE_KINDS, factUnavailableReason, requiredFacts } from "../lib/rules";
import {
  asRoot,
  duplicateRule,
  fitsWithinDepth,
  findParent,
  insertRule,
  moveRule,
  removeRule,
  replaceRule,
  setCombinator,
  toggleInvert,
  treeDepth,
  unwrapGroup,
  wrapInGroup,
} from "../lib/rule-tree";
import { summarizeCollection } from "../lib/summarize";
import type { EvalGame, FactKey, GroupRule, Rule, ManagedCollection } from "../lib/types";

/**
 * `whitelist` and `blacklist` carry no `invert` — inverting a whitelist *is* a
 * blacklist — so the union has no common property to read.
 */
function isInverted(rule: Rule): boolean {
  return "invert" in rule && rule.invert === true;
}

export interface RuleBuilderProps {
  collection: ManagedCollection;
  games: readonly EvalGame[];
  onSave: (collection: ManagedCollection) => void;
  onCancel: () => void;
  pickerOptions?: {
    game?: readonly ParamOption[];
    collection?: readonly ParamOption[];
  };
  /**
   * Facts a resolver can actually supply. Empty until Phase 5 lands the
   * resolvers, which is why fact-backed rules are labelled rather than priced.
   */
  availableFacts?: ReadonlySet<FactKey>;
  /** Injected for deterministic date defaults and tests. */
  now?: number;
}

const NO_FACTS: ReadonlySet<FactKey> = new Set();

/** Flatten a trace to a lookup, so a row can find its own counts by id. */
function indexTrace(node: RuleNodeTrace, into: Map<string, RuleNodeTrace>): Map<string, RuleNodeTrace> {
  into.set(node.nodeId, node);
  for (const child of node.children ?? []) indexTrace(child, into);
  return into;
}

/** Every group in the tree, so both combinator outcomes can be priced. */
function collectGroups(rule: Rule, into: GroupRule[] = []): GroupRule[] {
  if (rule.kind !== "group") return into;
  into.push(rule);
  for (const child of rule.children) collectGroups(child, into);
  return into;
}

export function RuleBuilder({
  collection,
  games,
  onSave,
  onCancel,
  pickerOptions,
  availableFacts = NO_FACTS,
  now,
}: RuleBuilderProps) {
  const [draft, setDraft] = useState<ManagedCollection>(collection);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  /** Group the palette will insert into, or null when it's closed. */
  const [paletteParent, setPaletteParent] = useState<string | null>(null);
  /** Back was pressed with unsaved edits, and is asking before discarding. */
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  /**
   * A ref, not state, and that is the whole point.
   *
   * `cloneWithNewIds` calls this once per node, so duplicating a group calls
   * it several times inside one handler. Read from state, every one of those
   * calls saw the same pre-render value and only *queued* an increment — so a
   * duplicated group came back with every rule sharing one id. React then
   * warned about duplicate keys, editing one copy hit an arbitrary sibling,
   * and the trace map collided so the copies showed each other's counts.
   */
  const idCounter = useRef(0);

  const newId = useCallback(() => {
    // Monotonic within an editing session and prefixed by the tab, so ids stay
    // stable and readable in an exported config.
    idCounter.current += 1;
    return `${draft.id}-r${Date.now().toString(36)}-${idCounter.current}`;
  }, [draft.id]);

  const setRoot = useCallback((next: Rule) => {
    setDraft((current) => ({
      ...current,
      root: asRoot({ candidate: next, fallback: current.root }),
    }));
  }, []);

  // ── Pricing ────────────────────────────────────────────────────────

  const result = useMemo(
    () => evaluateCollection(draft, games, { trace: true, now }),
    [draft, games, now],
  );

  const traceById = useMemo(
    () => indexTrace(result.trace, new Map()),
    [result],
  );

  /**
   * Both outcomes for every group. Each is one filter pass over the library,
   * and there are only ever a handful of groups, so this is far cheaper than
   * it looks — and it is what makes the AND/OR mistake unmakeable.
   */
  const groupCounts = useMemo(() => {
    const out = new Map<string, CombinatorCounts>();
    for (const group of collectGroups(draft.root)) {
      const price = (combinator: "all" | "any") =>
        countMatches(
          {
            root: asRoot({
              candidate: setCombinator({ root: draft.root, id: group.id, combinator }),
              fallback: draft.root,
            }),
            indeterminatePolicy: draft.indeterminatePolicy,
          },
          games,
        );
      out.set(group.id, { all: price("all"), any: price("any") });
    }
    return out;
  }, [draft.root, draft.indeterminatePolicy, games]);

  const diagnosis = useMemo(
    () =>
      diagnoseCollection(draft, result, {
        librarySize: games.length,
        flippedCombinatorCount:
          groupCounts.get(draft.root.id)?.[
            draft.root.combinator === "all" ? "any" : "all"
          ] ?? 0,
      }),
    [draft, result, games.length, groupCounts],
  );

  /** Count the collection would show with `rule` swapped in — used by the editor. */
  const countFor = useCallback(
    (rule: Rule) =>
      countMatches(
        {
          root: asRoot({
            candidate: replaceRule({ root: draft.root, id: rule.id, next: rule }),
            fallback: draft.root,
          }),
          indeterminatePolicy: draft.indeterminatePolicy,
        },
        games,
      ),
    [draft.root, draft.indeterminatePolicy, games],
  );

  // The palette prices ~32 candidates. Deferring keeps the tree interactive
  // while that settles — the counts arrive a frame late, which nobody notices,
  // instead of blocking the frame, which everybody does.
  const deferredRoot = useDeferredValue(draft.root);
  const candidates: PricedCandidate[] = useMemo(() => {
    if (paletteParent === null) return [];
    return RULE_KINDS.map((kind) => {
      const candidate = ruleCandidate({
        kind,
        id: "__candidate",
        now: Math.floor((now ?? Date.now()) / 1000),
      });

      // A rule reading a fact nothing resolves evaluates to `indeterminate`,
      // which the default "pass" policy turns into the whole library. Pricing
      // it would claim "no change" for a rule that cannot be checked at all.
      const missing = [...requiredFacts(candidate.rule)].find(
        (fact) => !availableFacts.has(fact),
      );
      if (missing) {
        return { ...candidate, unavailable: factUnavailableReason(missing) };
      }

      if (candidate.needsInput) return candidate;
      const withCandidate = insertRule({
        root: deferredRoot,
        parentId: paletteParent,
        rule: candidate.rule,
      });
      return {
        ...candidate,
        total: countMatches(
          {
            root: asRoot({ candidate: withCandidate, fallback: draft.root }),
            indeterminatePolicy: draft.indeterminatePolicy,
          },
          games,
        ),
      };
    });
  }, [paletteParent, deferredRoot, draft.root, draft.indeterminatePolicy, games, now, availableFacts]);

  // ── Actions ────────────────────────────────────────────────────────

  const actionsFor = useCallback(
    (rule: Rule): RuleRowAction[] => {
      const parent = findParent(draft.root, rule.id);
      const at = parent?.children.findIndex((c) => c.id === rule.id) ?? -1;
      const invertible = rule.kind !== "whitelist" && rule.kind !== "blacklist";

      const close = () => setMenuOpenId(null);
      const apply = (next: Rule) => {
        setRoot(next);
        close();
      };

      return [
        {
          id: "edit",
          label: "Edit",
          run: () => {
            setEditing(rule);
            close();
          },
          available: rule.kind !== "group",
        },
        {
          id: "invert",
          label: isInverted(rule) ? "Stop inverting" : "Invert",
          run: () => apply(toggleInvert({ root: draft.root, id: rule.id })),
          available: invertible,
        },
        {
          id: "wrap",
          label: "Wrap in group",
          run: () =>
            apply(wrapInGroup({ root: draft.root, id: rule.id, groupId: newId() })),
          // Wrapping adds a level, so it needs room for this subtree plus one.
          available:
            parent !== null &&
            fitsWithinDepth({
              root: draft.root,
              parentId: parent.id,
              height: treeDepth(rule) + 1,
            }),
        },
        {
          id: "unwrap",
          label: "Ungroup",
          run: () => apply(unwrapGroup({ root: draft.root, id: rule.id })),
          available: rule.kind === "group",
        },
        {
          id: "up",
          label: "Move up",
          run: () => apply(moveRule({ root: draft.root, id: rule.id, delta: -1 })),
          available: at > 0,
        },
        {
          id: "down",
          label: "Move down",
          run: () => apply(moveRule({ root: draft.root, id: rule.id, delta: 1 })),
          available: parent !== null && at < parent.children.length - 1,
        },
        {
          id: "duplicate",
          label: "Duplicate",
          run: () => apply(duplicateRule({ root: draft.root, id: rule.id, newId })),
          available: parent !== null,
        },
        {
          id: "delete",
          label: "Delete",
          run: () =>
            apply(
              asRoot({
                candidate: removeRule(draft.root, rule.id),
                fallback: draft.root,
              }),
            ),
        },
      ];
    },
    [draft.root, newId, setRoot],
  );

  const ctx: RuleTreeContext = {
    traceById,
    groupCounts,
    menuOpenId,
    onToggleMenu: (id) => setMenuOpenId((open) => (open === id ? null : id)),
    onEdit: (rule) => setEditing(rule),
    onSetCombinator: (id, combinator) =>
      setRoot(setCombinator({ root: draft.root, id, combinator })),
    onAddInside: (groupId) => setPaletteParent(groupId),
    actionsFor,
  };

  // ── Render ─────────────────────────────────────────────────────────

  // Back now lives in the shell topbar, which B and Escape also route to, so
  // it is a great deal easier to hit than the old body button — and it throws
  // away every rule you just built. Ask once, and only when there is something
  // to lose.
  const dirty = JSON.stringify(draft) !== JSON.stringify(collection);

  // One page at a time. The palette and the editor replace the tree rather
  // than floating over it — see `BuilderPage` for why a modal is wrong here.
  if (paletteParent !== null) {
    return (
      <BuilderPage
        // The collection's name stays in the header for every step of the
        // build, so the page you are on always says which collection it is
        // editing — the palette and the tree look much alike otherwise.
        title={draft.label}
        description="Add a rule — each option shows what the collection would then hold."
        onBack={() => setPaletteParent(null)}
      >
        <RulePalette
          candidates={candidates}
          currentTotal={result.total}
          onCancel={() => setPaletteParent(null)}
          onPick={(candidate) => {
            const parentId = paletteParent;
            if (parentId === null) return;
            const rule = { ...candidate.rule, id: newId() } as Rule;
            setRoot(insertRule({ root: draft.root, parentId, rule }));
            setPaletteParent(null);
            // A rule that needs a value opens straight into its editor, so it
            // never sits in the tree in an unusable state.
            if (candidate.needsInput) setEditing(rule);
          }}
        />
      </BuilderPage>
    );
  }

  if (editing) {
    return (
      <RuleEditorPage
        rule={editing}
        countFor={countFor}
        pickerOptions={pickerOptions}
        onCancel={() => setEditing(null)}
        onSave={(next) => {
          setRoot(replaceRule({ root: draft.root, id: next.id, next }));
          setEditing(null);
        }}
      />
    );
  }

  return (
    <BuilderPage
      title={draft.label}
      description={summarizeCollection(draft)}
      onBack={() => (dirty ? setConfirmingDiscard(true) : onCancel())}
      backLabel={dirty ? "Discard changes" : "Back"}
      footer={
        <div className="flex items-center gap-2">
          <TotalBadge total={result.total} />
          <Button variant="primary" onClick={() => onSave(draft)}>
            Save
          </Button>
        </div>
      }
    >
      {confirmingDiscard ? (
        <div className="flex flex-wrap items-center gap-2">
          <Text variant="secondary">Leave without saving? The rules you added are lost.</Text>
          <Button variant="neutral" onClick={() => setConfirmingDiscard(false)}>
            Keep editing
          </Button>
          <Button variant="danger" onClick={onCancel}>
            Discard
          </Button>
        </div>
      ) : null}

      {diagnosis.kind !== "ok" ? (
        <Text variant="secondary">{diagnosis.message}</Text>
      ) : null}

      <ul className="flex flex-col gap-2">
        <RuleGroupNode rule={draft.root} depth={1} ctx={ctx} isRoot />
      </ul>
    </BuilderPage>
  );
}
