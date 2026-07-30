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

import { Button, useFocusable } from "@loadout/ui";
import type { Diagnosis, Fix } from "../lib/diagnose";

/**
 * A soft tinted panel rather than daisyUI's solid `alert-<variant>`.
 *
 * The solid warning alert is a bright yellow fill, and its body inherited
 * `Text variant="secondary"` — light grey text meant for the dark base
 * surface. Light-grey-on-bright-yellow is close to unreadable, and a
 * saturated fill is far too loud for a message that appears every time a tab
 * happens to be empty.
 *
 * So: a 12% tint of the semantic colour over the normal background, a 32%
 * border, and ordinary `base-content` text — the same treatment the shell
 * gives its plugin-crash panel. Colour still carries the meaning; it just
 * stops shouting, and the text sits on a dark surface where it belongs.
 *
 * Written as inline `color-mix` on the theme tokens rather than Tailwind
 * classes, so it holds across all five themes and cannot silently no-op the
 * way a plugin-only utility class does (see README).
 */
function tintedSurface(token: "warning" | "info"): React.CSSProperties {
  return {
    background: `color-mix(in oklab, var(--color-${token}) 12%, transparent)`,
    border: `1px solid color-mix(in oklab, var(--color-${token}) 32%, transparent)`,
  };
}

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

  // Every fix is a `Tab -> Tab` that the caller persists, and the most common
  // one is "remove the rule that is excluding everything". On a builtin tab —
  // whose root is documented as not editable — that silently guts a shipped
  // tab, and the damage outlives whatever made it empty. It is exactly how the
  // Recently played and Never played builtins on a real device ended up with
  // no rules at all while their data source was missing.
  const fixes = editable && "fixes" in diagnosis ? diagnosis.fixes : [];

  const token = variant(diagnosis);

  return (
    <div className="flex flex-col gap-3 py-6">
      <div
        role="alert"
        className="flex gap-3 rounded-lg p-3"
        style={tintedSurface(token)}
      >
        {/* A slim colour stripe carries the semantics that the old solid fill
            used to, at a fraction of the visual weight. */}
        <span
          aria-hidden="true"
          className="w-1 shrink-0 rounded-full"
          style={{ background: `var(--color-${token})` }}
        />
        <div className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-base-content">
            {headline(diagnosis)}
          </span>
          {/* The message is written for a player and, in the blocked-facts
              case, quotes the data source's own reason verbatim. Render as-is,
              in ordinary body text on the ordinary background. */}
          <span className="text-sm text-base-content/70">
            {diagnosis.message}
          </span>
        </div>
      </div>

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
