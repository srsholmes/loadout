/**
 * Tier B — do the tabs a user is actually offered contain anything?
 *
 * A rule that can't discriminate is a latent problem; a *tab* that is always
 * empty is one the user will click on their first day. Two of the five builtins
 * and several templates are in that state today, and worse, some of them are
 * not even greyed out — they look ready and produce nothing.
 *
 * Beyond counting, three structural assertions that no count would catch:
 * a tab that cannot work must say so, its `needs` must actually resolve to a
 * user-facing reason, and it must not sit visible-and-empty in the strip.
 *
 * Requires a captured corpus — see `corpus-loader.ts`.
 */

import { describe, expect, it } from "bun:test";
import { TAB_EXPECTATIONS, type TabExpectation } from "./expectations";
import { loadCorpus } from "./corpus-loader";
import { evaluateTab } from "../lib/evaluate";
import { BUILTIN_TAB_IDS, builtinTabs, templates } from "../lib/templates";
import type { Tab } from "../lib/types";


/** Every tab a user can end up with: the builtins plus one per template. */
function allTabs(now: number): Array<{ id: string; tab: Tab; needs: string[] }> {
  const builtins = builtinTabs().map((tab) => ({ id: tab.id, tab, needs: [] as string[] }));
  const fromTemplates = templates(now).map((template) => ({
    id: template.id,
    tab: template.build(template.id),
    needs: (template.needs ?? []) as string[],
  }));
  return [...builtins, ...fromTemplates];
}

// Fixed clock so relative-date templates ("bought in the last 30 days") are
// evaluated against a stable point rather than drifting with the wall clock.
const NOW = 1_800_000_000;

describe("tab non-degeneracy against a real library", () => {
  const corpus = loadCorpus();
  const tabs = allTabs(NOW);

  it("declares an expectation for every builtin and template", () => {
    const declared = Object.keys(TAB_EXPECTATIONS).sort();
    const actual = tabs.map((t) => t.id).sort();
    expect(declared).toEqual(actual);
  });

  for (const { id, tab } of allTabs(NOW)) {
    const expectation: TabExpectation | undefined = TAB_EXPECTATIONS[id];

    it(`${id} — ${expectation?.verdict ?? "UNDECLARED"}`, () => {
      if (!corpus || !expectation) return;
      // "fail" not "pass": under the default policy an all-indeterminate tab
      // reports the whole library as matching, which would mask exactly the
      // tabs this file exists to catch.
      const result = evaluateTab(
        { ...tab, indeterminatePolicy: "fail" },
        corpus.evalGames,
        { now: NOW },
      );
      const detail = `${id}: ${result.total} of ${corpus.size}`;

      switch (expectation.verdict) {
        case "non-empty":
          expect(result.total, `${detail} — a tab the user is offered must contain something`)
            .toBeGreaterThanOrEqual(expectation.minGames);
          break;

        case "empty-until":
          expect(
            result.total,
            `${detail} — ${id} is no longer empty, so "${expectation.blockedBy}" landed.\n` +
              `  ${expectation.because}\n` +
              "Update its entry in test/expectations.ts to non-empty.",
          ).toBe(0);
          break;

        case "legitimately-empty":
          expect(result.total, `${detail} — ${expectation.because}`).toBe(0);
          break;

        case "matches-everything":
          expect(
            result.total,
            `${detail} — ${id} no longer matches the whole library, so ` +
              `"${expectation.blockedBy}" landed.\n  ${expectation.because}\n` +
              "Update its entry in test/expectations.ts to non-empty.",
          ).toBe(corpus.size);
          break;
      }
    });
  }
});

describe("a tab that cannot work must say so", () => {
  const tabs = allTabs(NOW);

  it("declares `needs` for every template that is blocked on missing data", () => {
    const silent = tabs
      .filter(({ id, needs }) => {
        const expectation = TAB_EXPECTATIONS[id];
        if (!expectation || expectation.verdict !== "empty-until") return false;
        // Builtins have no `needs` mechanism at all, which is its own gap —
        // covered by the visible-and-empty assertion below.
        if ((BUILTIN_TAB_IDS as readonly string[]).includes(id)) return false;
        return needs.length === 0;
      })
      .map(({ id }) => id);

    expect(
      silent,
      "These templates are guaranteed empty but declare no `needs`, so " +
        "`blockedReason` in app.tsx never greys them out — the user picks a " +
        "template that looks ready and gets nothing:\n  " +
        silent.join("\n  "),
    ).toEqual([]);
  });

  it("never leaves a permanently-empty builtin visible in the strip", () => {
    // `autoHide` exists precisely so a tab that evaluates to nothing drops out
    // of the strip while keeping its position. A tab that can NEVER be
    // non-empty and does not auto-hide is dead weight in the UI.
    const stranded = tabs
      .filter(({ id, tab }) => {
        const expectation = TAB_EXPECTATIONS[id];
        return (
          expectation?.verdict === "empty-until" &&
          (BUILTIN_TAB_IDS as readonly string[]).includes(id) &&
          tab.visible &&
          !tab.autoHide
        );
      })
      .map(({ id }) => id);

    expect(
      stranded,
      "These builtin tabs can never contain anything with today's data, yet " +
        "sit visible in the strip with autoHide off:\n  " +
        stranded.join("\n  ") +
        "\n\nEither populate the field they need, or set autoHide so they " +
        "disappear until it lands.",
    ).toEqual([]);
  });
});
