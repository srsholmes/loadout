/**
 * Edit one rule's parameters, with its match count updating as you type.
 *
 * The live count is the point: you are changing a number, and the number is
 * on the same screen. Editing runs against a draft, so Cancel genuinely
 * reverts — an editor that commits as you type has no way back out of a
 * mistake.
 */

import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Text, Toggle } from "@loadout/ui";
import { BuilderPage } from "./BuilderPage";
import { ParamEditor } from "./ParamEditors";
import type { ParamOption } from "../lib/rule-params";
import { paramSpecs } from "../lib/rule-params";
import { isRuleComplete, ruleDef } from "../lib/rules";
import { summarizeRule } from "../lib/summarize";
import type { Rule } from "../lib/types";

export interface RuleEditorPageProps {
  /** Rule being edited, or null when the sheet is closed. */
  rule: Rule | null;
  onCancel: () => void;
  onSave: (next: Rule) => void;
  /**
   * Live count for a candidate rule. The builder supplies this because only
   * it knows the surrounding tab and library.
   */
  countFor: (rule: Rule) => number;
  /** Options for `picker` params, keyed by source. */
  pickerOptions?: {
    game?: readonly ParamOption[];
    collection?: readonly ParamOption[];
  };
}

export function RuleEditorPage({
  rule,
  onCancel,
  onSave,
  countFor,
  pickerOptions,
}: RuleEditorPageProps) {
  const [draft, setDraft] = useState<Rule | null>(rule);

  // Re-seed whenever a different rule is opened. Keyed on id rather than the
  // object so a re-render of the parent doesn't discard in-progress edits.
  useEffect(() => setDraft(rule), [rule?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const specs = draft ? paramSpecs(draft.kind) : [];
  const complete = draft ? isRuleComplete(draft) : false;
  const count = useMemo(
    () => (draft && complete ? countFor(draft) : null),
    [draft, complete, countFor],
  );

  if (!rule || !draft) return null;

  const def = draft.kind === "group" ? null : ruleDef(draft.kind);
  const patch = (key: string, value: unknown) =>
    setDraft({ ...draft, [key]: value } as Rule);

  return (
    <BuilderPage
      title={def?.label ?? "Group"}
      description={def?.description}
      onBack={onCancel}
      backLabel="Cancel"
      footer={
        <>
          <Button variant="neutral" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!complete}
            onClick={() => onSave(draft)}
          >
            Save rule
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3 rounded-lg bg-base-200 p-3">
          <Text variant="secondary">
            {complete ? summarizeRule(draft) : "Fill this in to see what it matches"}
          </Text>
          {count !== null ? (
            <Badge variant={count === 0 ? "neutral" : "primary"}>
              {count} {count === 1 ? "game" : "games"}
            </Badge>
          ) : null}
        </div>

        {specs.map((spec) => (
          <ParamEditor
            key={spec.key}
            spec={spec}
            value={(draft as unknown as Record<string, unknown>)[spec.key]}
            onChange={(value) => patch(spec.key, value)}
            pickerOptions={
              spec.control === "picker"
                ? (pickerOptions?.[spec.source] ?? [])
                : undefined
            }
          />
        ))}

        {specs.length === 0 ? (
          <Text variant="secondary">
            This rule has nothing to configure — it either applies or it
            doesn&apos;t.
          </Text>
        ) : null}

        {def?.invertible ? (
          <label className="flex items-center gap-2">
            <Toggle
              // `whitelist`/`blacklist` carry no `invert`, but `def.invertible`
              // is already false for those, so this branch never renders there.
              checked={"invert" in draft && draft.invert === true}
              onChange={(checked) => patch("invert", checked)}
            />
            <span className="text-sm text-base-content/80">
              Invert — match games this rule does <em>not</em> select
            </span>
          </label>
        ) : null}

        {count === 0 && complete ? (
          <p className="text-xs text-warning">
            Nothing in your library matches this rule on its own. Saving it
            will empty the collection unless the group uses ANY.
          </p>
        ) : null}
      </div>
    </BuilderPage>
  );
}
