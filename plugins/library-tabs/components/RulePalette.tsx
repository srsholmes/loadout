/**
 * The rule picker, with each candidate priced before you add it.
 *
 * For every rule kind, the palette evaluates the tab *as if* that rule were
 * already added at its defaults, and shows the resulting total. Two things
 * fall out of that:
 *
 * - You never add a rule and discover afterwards that it emptied the tab.
 * - You learn the shape of your own library while browsing. "Deck Verified →
 *   0 games" tells you something true and useful before you commit to it.
 *
 * Zero-match candidates stay listed rather than being hidden — dimmed, with
 * the count, sorted last within their category. Hiding them would answer the
 * question by making it unaskable.
 *
 * Cost: ~32 candidates × one filter pass. The parent defers the work so
 * typing in the search box stays responsive.
 */

import { useMemo, useState } from "react";
import { Text, TextInput, useFocusable } from "@loadout/ui";
import type { RuleCandidate } from "../lib/rule-params";
import type { RuleCategory } from "../lib/rules";

/** A candidate plus what it would do to the current tab. */
export interface PricedCandidate extends RuleCandidate {
  /**
   * Total the tab would show with this rule added, or `undefined` when the
   * rule cannot be priced — because it needs a value, or because its data
   * source is unavailable.
   */
  total?: number;
  /**
   * Set when the rule reads a fact nothing can currently resolve. Shown
   * instead of a count: an unresolvable fact is `indeterminate`, and under
   * the default `"pass"` policy that prices as *the whole library*, which
   * would read as "adding this changes nothing" — the opposite of the truth.
   */
  unavailable?: string;
}

export interface RulePaletteProps {
  candidates: readonly PricedCandidate[];
  /** Current tab total, so a candidate's effect reads as a delta. */
  currentTotal: number;
  onPick: (candidate: PricedCandidate) => void;
  onCancel: () => void;
}

const CATEGORY_LABEL: Record<RuleCategory, string> = {
  library: "Library",
  play: "How you play",
  catalogue: "Catalogue",
  compatibility: "Compatibility",
  social: "Friends",
  storage: "Storage",
  structure: "Structure",
};

const CATEGORY_ORDER: RuleCategory[] = [
  "library",
  "play",
  "catalogue",
  "compatibility",
  "storage",
  "social",
  "structure",
];

export function RulePalette({
  candidates,
  currentTotal,
  onPick,
  onCancel,
}: RulePaletteProps) {
  const [query, setQuery] = useState("");

  const grouped = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching = needle
      ? candidates.filter(
          (c) =>
            c.label.toLowerCase().includes(needle) ||
            c.description.toLowerCase().includes(needle),
        )
      : candidates;

    const byCategory = new Map<RuleCategory, PricedCandidate[]>();
    for (const candidate of matching) {
      const bucket = byCategory.get(candidate.category) ?? [];
      bucket.push(candidate);
      byCategory.set(candidate.category, bucket);
    }

    // Within a category: things that match something first, then things
    // needing input, then the zero-match ones — each alphabetical.
    for (const bucket of byCategory.values()) {
      bucket.sort((a, b) => {
        const rank = (c: PricedCandidate) =>
          c.unavailable ? 3 : c.total === undefined ? 1 : c.total === 0 ? 2 : 0;
        return rank(a) - rank(b) || a.label.localeCompare(b.label);
      });
    }

    return CATEGORY_ORDER.filter((c) => byCategory.has(c)).map((category) => ({
      category,
      items: byCategory.get(category) ?? [],
    }));
  }, [candidates, query]);

  return (
    <div className="flex flex-col gap-3">
      <TextInput
        value={query}
        onChange={setQuery}
        placeholder="Search rules…"
        autoFocus
      />

      {grouped.length === 0 ? (
        <Text variant="secondary">No rule matches “{query}”.</Text>
      ) : null}

      {grouped.map(({ category, items }) => (
        <section key={category} className="flex flex-col gap-2">
          <Text variant="secondary">{CATEGORY_LABEL[category]}</Text>
          <ul className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
            {items.map((candidate) => (
              <li key={candidate.kind}>
                <CandidateCard
                  candidate={candidate}
                  currentTotal={currentTotal}
                  onPick={() => onPick(candidate)}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={onCancel}
          className={[
            "min-h-[44px] rounded-lg border border-base-300 bg-base-200 px-4",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
          ].join(" ")}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function CandidateCard({
  candidate,
  currentTotal,
  onPick,
}: {
  candidate: PricedCandidate;
  currentTotal: number;
  onPick: () => void;
}) {
  const { ref, focused } = useFocusable({ onEnterPress: onPick });
  const zero = candidate.total === 0 || candidate.unavailable !== undefined;

  const consequence = (() => {
    if (candidate.unavailable) return candidate.unavailable;
    if (candidate.needsInput) return "Needs a value";
    if (candidate.total === undefined) return "";
    if (candidate.total === currentTotal) return `→ ${candidate.total} games (no change)`;
    return `→ ${candidate.total} ${candidate.total === 1 ? "game" : "games"}`;
  })();

  return (
    <button
      ref={ref as React.Ref<HTMLButtonElement>}
      type="button"
      onClick={onPick}
      className={[
        "flex w-full min-h-[44px] flex-col items-start gap-1 rounded-lg border p-3 text-left",
        "border-base-300 bg-base-100 transition-colors hover:border-primary",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        // Dimmed, never hidden: "0 games" is information.
        zero ? "opacity-50" : "",
        focused ? "ring-2 ring-primary" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span className="flex w-full items-baseline justify-between gap-2">
        <span className="font-semibold text-base-content">{candidate.label}</span>
        <span
          className={[
            "shrink-0 text-xs",
            zero ? "text-base-content/50" : "text-base-content/70",
          ].join(" ")}
        >
          {consequence}
        </span>
      </span>
      <span className="text-xs text-base-content/60">{candidate.description}</span>
    </button>
  );
}
