/**
 * One leaf rule in the tree.
 *
 * The row's job is to answer "what does this rule do, and what is it costing
 * me?" without being opened. So it carries the plain-English summary from
 * `summarize.ts` and its own match count — and the count is the point.
 * TabMaster shows no number until you save, which is how a tab silently
 * becomes empty.
 *
 * Every action is reachable from the overflow menu as well as any pointer
 * affordance, because reordering by drag is unusable with a gamepad and the
 * gamepad is the primary input here.
 */

import { Badge, useFocusable } from "@loadout/ui";
import { summarizeRule } from "../lib/summarize";
import { ruleDef } from "../lib/rules";
import type { Rule } from "../lib/types";

export interface RuleRowAction {
  id: string;
  label: string;
  run: () => void;
  /** Omitted from the menu when false — a depth limit, or an end-of-list move. */
  available?: boolean;
}

export interface RuleNodeRowProps {
  rule: Rule;
  /** Games this rule matches on its own, from the evaluator's trace. */
  passed?: number;
  /** Games whose data source couldn't answer. Rendered only when non-zero. */
  indeterminate?: number;
  depth: number;
  /** Opens the parameter editor. */
  onEdit: () => void;
  actions: RuleRowAction[];
  /** Menu is open for this row (the parent owns which). */
  menuOpen: boolean;
  onToggleMenu: () => void;
  /** False when the rule has no value yet, e.g. a collection rule with none picked. */
  complete: boolean;
}

export function RuleNodeRow({
  rule,
  passed,
  indeterminate = 0,
  depth,
  onEdit,
  actions,
  menuOpen,
  onToggleMenu,
  complete,
}: RuleNodeRowProps) {
  const { ref, focused } = useFocusable({ onEnterPress: onEdit });
  const label = rule.kind === "group" ? "Group" : ruleDef(rule.kind).label;
  const usable = actions.filter((a) => a.available !== false);

  return (
    <li
      className="flex flex-col gap-1"
      // 20px per level, plus a rule down the left edge, so nesting is visible
      // rather than inferred from wording.
      style={{ marginLeft: depth > 1 ? 20 : 0 }}
    >
      <div
        className={[
          "flex items-center gap-2 rounded-lg border px-3 py-1 min-h-[44px]",
          depth > 1 ? "border-l-2" : "",
          complete ? "bg-base-200 border-base-300" : "bg-warning/10 border-warning/40",
          focused ? "ring-2 ring-primary/60" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <button
          ref={ref as React.Ref<HTMLButtonElement>}
          type="button"
          onClick={onEdit}
          className={[
            "flex flex-1 flex-col items-start gap-0.5 text-left",
            " rounded",
          ].join(" ")}
        >
          <span className="text-xs uppercase tracking-wide text-base-content/50">
            {label}
          </span>
          <span className="text-sm text-base-content">
            {complete ? summarizeRule(rule) : `${label} — needs a value`}
          </span>
        </button>

        {indeterminate > 0 ? (
          <Badge variant="neutral">{indeterminate} unknown</Badge>
        ) : null}
        {passed !== undefined && complete ? (
          <Badge variant={passed === 0 ? "neutral" : "primary"}>{passed}</Badge>
        ) : null}

        <button
          type="button"
          onClick={onToggleMenu}
          aria-label={`Actions for ${label}`}
          aria-expanded={menuOpen}
          className={[
            "shrink-0 rounded-lg border border-base-300 bg-base-100 px-3 min-h-[44px]",
            "text-base-content/70 hover:text-base-content",
          ].join(" ")}
        >
          ⋮
        </button>
      </div>

      {menuOpen ? (
        <ul className="flex flex-wrap gap-2 pl-3">
          {usable.map((action) => (
            <li key={action.id}>
              <button
                type="button"
                onClick={action.run}
                className={[
                  "min-h-[44px] rounded-lg border border-base-300 bg-base-100 px-3 text-sm",
                  "text-base-content/80 hover:text-base-content",
                ].join(" ")}
              >
                {action.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
