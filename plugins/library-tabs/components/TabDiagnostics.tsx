/**
 * The smart empty state.
 *
 * This component is the visible payoff of the whole traced-evaluation design.
 * TabMaster's answer to an empty tab is an empty grid — its issue tracker has
 * users asking "why is my tab empty?" and going unanswered. Here the tab
 * explains itself and offers the repair as a button.
 *
 * All the thinking happens in `lib/diagnose.ts`; this is presentation plus a
 * row of one-tap fixes. Each fix is a pure `Tab -> Tab`, so applying one is
 * `setDraft(fix.apply(draft))` and nothing here needs to know what it does.
 */

import { Alert, Button, Text, useFocusable } from "@loadout/ui";
import type { Diagnosis, Fix } from "../lib/diagnose";

export interface TabDiagnosticsProps {
  diagnosis: Diagnosis;
  /** Applies a fix to the tab and persists it. */
  onApplyFix: (fix: Fix) => void;
  /** Opens the rule editor, offered as a fallback on every diagnosis. */
  onEdit?: () => void;
  /** Suppresses the edit affordance for tabs whose rules aren't editable. */
  editable?: boolean;
}

function FixButton({ fix, onApply }: { fix: Fix; onApply: () => void }) {
  const { ref, focused } = useFocusable({ onEnterPress: onApply });
  return (
    <div ref={ref} className={focused ? "rounded-lg ring-2 ring-primary/60" : undefined}>
      <Button variant="primary" onClick={onApply}>
        {fix.label}
      </Button>
    </div>
  );
}

/** Headline per diagnosis kind. The detail sentence comes from `message`. */
function headline(diagnosis: Diagnosis): string {
  switch (diagnosis.kind) {
    case "ok":
      return "";
    case "empty-library":
      return "No games found";
    case "blocked-facts":
      return "Some rules couldn't be checked";
    case "contradiction":
      return "These rules contradict each other";
    case "single-culprit":
      return "One rule is excluding everything";
    case "combinator":
      return "No game matches every rule";
    case "over-capped":
      return "The limit is hiding matches";
    case "genuinely-empty":
      return "Nothing matches";
  }
}

/**
 * `over-capped` is informational — the tab is working, just truncated — so it
 * gets a quieter treatment than the states where the tab is empty.
 */
function variant(diagnosis: Diagnosis): "info" | "warning" {
  return diagnosis.kind === "over-capped" ? "info" : "warning";
}

export function TabDiagnostics({
  diagnosis,
  onApplyFix,
  onEdit,
  editable = true,
}: TabDiagnosticsProps) {
  if (diagnosis.kind === "ok") return null;

  const fixes = "fixes" in diagnosis ? diagnosis.fixes : [];

  return (
    <div className="flex flex-col gap-3 py-6">
      <Alert variant={variant(diagnosis)} title={headline(diagnosis)}>
        {/* The diagnosis message is written for a player and, in the
            blocked-facts case, quotes the data source's own reason
            verbatim. Render it as-is. */}
        <Text variant="secondary">{diagnosis.message}</Text>
      </Alert>

      {fixes.length > 0 || (editable && onEdit) ? (
        <div className="flex flex-wrap items-center gap-2">
          {fixes.map((fix, i) => (
            <FixButton key={`${fix.label}-${i}`} fix={fix} onApply={() => onApplyFix(fix)} />
          ))}
          {editable && onEdit ? (
            <Button variant="neutral" onClick={onEdit}>
              Edit rules
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
