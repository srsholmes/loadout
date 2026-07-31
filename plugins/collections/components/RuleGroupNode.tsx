/**
 * A group of rules, and the recursive body of the tree.
 *
 * **The combinator is a sentence with both outcomes visible.** The header
 * reads "Show a game when ALL of these are true", and directly under it sits
 * `ALL → 0 games · ANY → 340 games`. TabMaster's most-reported failure is an
 * AND that should have been an OR, discovered only after saving and finding
 * an empty tab. It is not possible to make that mistake unknowingly when both
 * answers are on screen at the same time — so the consequence line is the
 * feature, not the toggle.
 *
 * Nesting is shown, not implied: a 20px indent step per level plus a left
 * rule and a depth-tinted backplate on the header.
 */

import { Badge, useFocusable } from "@loadout/ui";
import { RuleNodeRow, type RuleRowAction } from "./RuleNodeRow";
import type { RuleNodeTrace } from "../lib/evaluate";
import { isRuleComplete } from "../lib/rules";
import type { GroupRule, Rule } from "../lib/types";
import { FocusButton } from "./Focusable";

/** Both outcomes for one group, so the header can show the road not taken. */
export interface CombinatorCounts {
  all: number;
  any: number;
}

export interface RuleTreeContext {
  traceById: ReadonlyMap<string, RuleNodeTrace>;
  groupCounts: ReadonlyMap<string, CombinatorCounts>;
  /** Menu currently expanded, if any. */
  menuOpenId: string | null;
  onToggleMenu: (id: string) => void;
  onEdit: (rule: Rule) => void;
  onSetCombinator: (id: string, combinator: "all" | "any") => void;
  onAddInside: (groupId: string) => void;
  /** Actions offered in a node's overflow menu. */
  actionsFor: (rule: Rule) => RuleRowAction[];
}

export interface RuleGroupNodeProps {
  rule: GroupRule;
  depth: number;
  ctx: RuleTreeContext;
  /** The root group is not removable and gets no overflow menu. */
  isRoot?: boolean;
}

function plural(n: number): string {
  return n === 1 ? "game" : "games";
}

export function RuleGroupNode({ rule, depth, ctx, isRoot = false }: RuleGroupNodeProps) {
  const counts = ctx.groupCounts.get(rule.id);
  const menuOpen = ctx.menuOpenId === rule.id;
  const actions = ctx.actionsFor(rule).filter((a) => a.available !== false);

  return (
    <li className="flex flex-col gap-2" style={{ marginLeft: depth > 1 ? 20 : 0 }}>
      <div
        className={[
          "flex flex-col gap-1 rounded-lg border border-base-300 p-3",
          // Depth tint, so which group you are inside is legible at a glance.
          depth > 1 ? "border-l-2 bg-base-300/40" : "bg-base-200",
        ].join(" ")}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-base-content/80">
            {rule.invert ? "Hide" : "Show"} a game when
          </span>
          <CombinatorChoice
            value={rule.combinator}
            onChange={(next) => ctx.onSetCombinator(rule.id, next)}
          />
          <span className="text-sm text-base-content/80">
            of these are true
          </span>

          <div className="ml-auto flex items-center gap-2">
            <FocusButton
              onClick={() => ctx.onAddInside(rule.id)}
              className={[
                "min-h-[44px] rounded-lg border border-base-300 bg-base-100 px-3 text-sm",
              ].join(" ")}
            >
              Add rule
            </FocusButton>
            {!isRoot ? (
              <FocusButton
                onClick={() => ctx.onToggleMenu(rule.id)}
                ariaLabel="Actions for group"
                ariaExpanded={menuOpen}
                className={[
                  "min-h-[44px] rounded-lg border border-base-300 bg-base-100 px-3",
                ].join(" ")}
              >
                ⋮
              </FocusButton>
            ) : null}
          </div>
        </div>

        {counts ? (
          <p className="text-xs text-base-content/60">
            <span
              className={rule.combinator === "all" ? "text-base-content" : undefined}
            >
              ALL → {counts.all} {plural(counts.all)}
            </span>
            <span aria-hidden="true"> · </span>
            <span
              className={rule.combinator === "any" ? "text-base-content" : undefined}
            >
              ANY → {counts.any} {plural(counts.any)}
            </span>
          </p>
        ) : null}

        {!isRoot && menuOpen ? (
          <ul className="flex flex-wrap gap-2">
            {actions.map((action) => (
              <li key={action.id}>
                <FocusButton
                  onClick={action.run}
                  className={[
                    "min-h-[44px] rounded-lg border border-base-300 bg-base-100 px-3 text-sm",
                  ].join(" ")}
                >
                  {action.label}
                </FocusButton>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {rule.children.length === 0 ? (
        <p className="pl-3 text-sm text-base-content/60">
          No rules yet — this group matches every game.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rule.children.map((child) =>
            child.kind === "group" ? (
              <RuleGroupNode
                key={child.id}
                rule={child}
                depth={depth + 1}
                ctx={ctx}
              />
            ) : (
              <RuleNodeRow
                key={child.id}
                rule={child}
                depth={depth + 1}
                passed={ctx.traceById.get(child.id)?.passed}
                indeterminate={ctx.traceById.get(child.id)?.indeterminate}
                complete={isRuleComplete(child)}
                onEdit={() => ctx.onEdit(child)}
                actions={ctx.actionsFor(child)}
                menuOpen={ctx.menuOpenId === child.id}
                onToggleMenu={() => ctx.onToggleMenu(child.id)}
              />
            ),
          )}
        </ul>
      )}
    </li>
  );
}

/**
 * ALL / ANY as a two-option radiogroup rather than a dropdown, so both
 * choices are visible and arrow keys operate it when docked.
 */
function CombinatorChoice({
  value,
  onChange,
}: {
  value: "all" | "any";
  onChange: (next: "all" | "any") => void;
}) {
  return (
    <span role="radiogroup" aria-label="Combinator" className="inline-flex gap-1">
      {(["all", "any"] as const).map((option) => (
        <CombinatorOption
          key={option}
          option={option}
          selected={value === option}
          onSelect={() => onChange(option)}
        />
      ))}
    </span>
  );
}

function CombinatorOption({
  option,
  selected,
  onSelect,
}: {
  option: "all" | "any";
  selected: boolean;
  onSelect: () => void;
}) {
  const { ref, focused } = useFocusable({ onEnterPress: onSelect });
  return (
    <button
      ref={ref as React.Ref<HTMLButtonElement>}
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={[
        "min-h-[44px] rounded-lg border px-3 text-sm uppercase",
        selected
          ? "border-primary bg-primary/20 text-base-content"
          : "border-base-300 bg-base-100 text-base-content/60",
        focused ? "ring-2 ring-primary/60" : "",
      ].join(" ")}
    >
      {option}
    </button>
  );
}

/** Convenience for the badge the builder shows beside a tab's total. */
export function TotalBadge({ total }: { total: number }) {
  return (
    <Badge variant={total === 0 ? "neutral" : "primary"}>
      {total} {plural(total)}
    </Badge>
  );
}
