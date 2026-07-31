/**
 * Tier B — does each rule actually discriminate on a real library?
 *
 * The insight that makes this work: **assert on the trace, not the match list.**
 * For any rule over N games, `passed + failed + indeterminate === N`. A rule
 * with `indeterminate === N` matches *every* game under the default `"pass"`
 * policy while looking perfectly healthy from the outside — which is exactly
 * what all six fact-backed rules do today, silently. Counting matches would
 * never reveal it; counting verdicts reveals it immediately.
 *
 * Requires a captured corpus. Run `bun run capture:corpus` then
 * `bun run test:corpus`. Never runs in CI — see `corpus-loader.ts`.
 */

import { describe, expect, it } from "bun:test";
import { DEFAULT_MIN_SIDE, RULE_EXPECTATIONS, type Expectation } from "./expectations";
import { loadCorpus, type Corpus } from "./corpus-loader";
import { probeFor } from "./probes";
import { evaluateTab } from "../lib/evaluate";
import type { EvalResult } from "../lib/evaluate";
import { RULE_KINDS } from "../lib/rules";
import type { GroupRule, Rule, RuleKind, Tab } from "../lib/types";


/** A tab containing exactly one rule, so the root trace is that rule's trace. */
function singleRuleTab(rule: Rule): Tab {
  const root: GroupRule = { id: "root", kind: "group", combinator: "all", children: [rule] };
  return {
    id: "probe-tab",
    label: "Probe",
    visible: true,
    autoHide: false,
    root,
    sort: [{ field: "sortAs", dir: "asc" }],
    limit: null,
    group: { kind: "none" },
    display: { tileWidth: 150, showLabels: true, badges: [] },
    mirror: { enabled: false, collectionName: "" },
    // "fail" rather than the default "pass": under "pass" an all-indeterminate
    // rule matches everything and the match count looks healthy. We read the
    // trace either way, but this keeps `matched` honest for the message.
    indeterminatePolicy: "fail",
  };
}

interface Degeneracy {
  kind: RuleKind;
  passed: number;
  failed: number;
  indeterminate: number;
  size: number;
  blockedFacts: EvalResult["blockedFacts"];
}

function measure(kind: Exclude<RuleKind, "group">, corpus: Corpus): Degeneracy {
  const tab = singleRuleTab(probeFor(kind, corpus));
  const result = evaluateTab(tab, corpus.evalGames, { trace: true });
  const node = result.trace.children?.[0];
  if (!node) throw new Error(`no trace child for ${kind}`);
  return {
    kind,
    passed: node.passed,
    failed: node.failed,
    indeterminate: node.indeterminate,
    size: corpus.size,
    blockedFacts: result.blockedFacts,
  };
}

function describeMeasurement(m: Degeneracy): string {
  return `${m.kind}: passed=${m.passed} failed=${m.failed} indeterminate=${m.indeterminate} of ${m.size}`;
}

describe("rule non-degeneracy against a real library", () => {
  const corpus = loadCorpus();

  it("declares an expectation for every registered rule kind", () => {
    // Belt to the `satisfies` braces, in case the tsconfig include is reverted.
    expect(Object.keys(RULE_EXPECTATIONS).sort()).toEqual([...RULE_KINDS].sort());
  });

  it("accounts for every game in every rule's verdict tally", () => {
    for (const kind of RULE_KINDS) {
      const m = measure(kind, corpus);
      // The partition law. If this ever fails the evaluator is losing games,
      // which would invalidate every other assertion in this file.
      expect(m.passed + m.failed + m.indeterminate, describeMeasurement(m)).toBe(m.size);
    }
  });

  for (const kind of RULE_KINDS) {
    const expectation: Expectation = RULE_EXPECTATIONS[kind];

    it(`${kind} — ${expectation.verdict}`, () => {
      const m = measure(kind, corpus);
      const detail = describeMeasurement(m);

      switch (expectation.verdict) {
        case "discriminating": {
          const floor = Math.floor((expectation.minSide ?? DEFAULT_MIN_SIDE) * m.size);
          expect(m.indeterminate, `${detail} — should be decidable for every game`).toBe(0);
          expect(m.passed, `${detail} — matched too few to be a real filter`).toBeGreaterThanOrEqual(floor);
          expect(m.failed, `${detail} — excluded too few to be a real filter`).toBeGreaterThanOrEqual(floor);
          break;
        }

        case "constant": {
          expect(m.indeterminate, detail).toBe(0);
          const constantSide = expectation.value ? m.passed : m.failed;
          expect(constantSide, `${detail} — ${expectation.because}`).toBe(m.size);
          break;
        }

        case "blocked": {
          // The data source cannot answer for anyone.
          expect(m.indeterminate, `${detail} — ${expectation.because}`).toBe(m.size);
          break;
        }

        case "known-broken": {
          const floor = Math.floor(DEFAULT_MIN_SIDE * m.size);
          const discriminates =
            m.indeterminate === 0 && m.passed >= floor && m.failed >= floor;
          // Asserting it is STILL broken is what makes this a ratchet: fixing
          // the rule turns this red and forces the entry to be deleted.
          expect(
            discriminates,
            `${detail}\n\n` +
              `\`${kind}\` now discriminates — the reason it was marked known-broken is gone:\n` +
              `  ${expectation.because}\n` +
              `Fixed by: ${expectation.fixedBy}\n\n` +
              "DELETE its entry from test/expectations.ts and re-run.",
          ).toBe(false);
          expect(
            Date.now(),
            `\`${kind}\` is still known-broken past its ${expectation.sunset} sunset: ${expectation.because}`,
          ).toBeLessThan(Date.parse(expectation.sunset));
          break;
        }
      }
    });
  }
});

describe("blocked rules must be explainable to the user", () => {
  const corpus = loadCorpus();

  const blockedKinds = RULE_KINDS.filter(
    (kind) => RULE_EXPECTATIONS[kind].verdict === "blocked",
  );

  it("reports every unresolvable fact in blockedFacts, with a reason", () => {

    const silent: string[] = [];
    for (const kind of blockedKinds) {
      const m = measure(kind, corpus);
      const reported = m.blockedFacts.find((b) => b.ruleIds.includes(`probe-${kind}`));
      if (!reported || !reported.reason.trim()) silent.push(kind);
    }

    // This is the bug the plan predicted: `collectBlockedFacts` only reports a
    // fact when some game carries `{state:"unavailable"}`. With an empty facts
    // bag the fact is simply *absent*, `readFact` returns indeterminate, and
    // `blockedFacts` comes back empty — so `diagnoseTab` never reaches its
    // `blocked-facts` branch and the tab silently matches every game with no
    // explanation anywhere in the UI.
    expect(
      silent,
      "These rules cannot be evaluated and the user is told nothing:\n  " +
        silent.join("\n  ") +
        "\n\nEither buildEvalGames should materialise {state:'unavailable', reason}\n" +
        "for facts with no registered resolver, or collectBlockedFacts should treat\n" +
        "'required by a rule, absent from the bag' as blocked.",
    ).toEqual([]);
  });
});
