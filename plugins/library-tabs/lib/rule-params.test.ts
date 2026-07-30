import { describe, expect, it } from "bun:test";
import {
  type ParamSpec,
  defaultRule,
  paramSpecs,
  ruleCandidate,
} from "./rule-params";
import { RULE_KINDS, isRuleComplete, ruleDef } from "./rules";
import type { Rule, RuleKind } from "./types";

/** Fixed clock, so date-bearing defaults assert exact numbers. */
const NOW = 1_800_000_000;
const DAY = 86_400;

/**
 * Kinds whose parameters cannot be guessed — a collection id, a search
 * string, a developer name. These are *expected* to report `needsInput`, and
 * the palette shows that instead of a meaningless count.
 *
 * Listing them explicitly means adding a kind without a default is a test
 * failure that names the kind, rather than a silently-greyed palette entry.
 */
const NEEDS_INPUT: readonly RuleKind[] = [
  "collection",
  "title",
  "storeTags",
  "genres",
  "developer",
  "publisher",
  "installFolder",
  "whitelist",
  "blacklist",
  "friendsOwn",
  "protonTier",
];

describe("defaultRule", () => {
  it("carries the id and kind it was asked for", () => {
    const rule = defaultRule({ kind: "installed", id: "r1", now: NOW });
    expect(rule).toEqual({ id: "r1", kind: "installed" });
  });

  it("produces a complete rule for every kind that has a sensible default", () => {
    const incomplete = RULE_KINDS.filter(
      (kind) => !isRuleComplete(defaultRule({ kind, id: "r", now: NOW })),
    );
    expect([...incomplete].sort()).toEqual([...NEEDS_INPUT].sort());
  });

  it("leaves no range unbounded, since rules.ts treats that as incomplete", () => {
    const ranged: Array<[RuleKind, string]> = [
      ["playtime", "minutes"],
      ["sizeOnDisk", "bytes"],
      ["releaseDate", "epochSec"],
      ["purchaseDate", "epochSec"],
      ["reviewScore", "percent"],
      ["metacritic", "score"],
      ["achievements", "percent"],
      ["hltbMain", "hours"],
    ];
    for (const [kind, key] of ranged) {
      const rule = defaultRule({ kind, id: "r", now: NOW }) as unknown as Record<
        string,
        { min?: number; max?: number }
      >;
      const range = rule[key];
      expect(
        range?.min !== undefined || range?.max !== undefined,
        `${kind}.${key} must carry a bound`,
      ).toBe(true);
    }
  });

  it("derives date defaults from the injected clock, not the real one", () => {
    const release = defaultRule({ kind: "releaseDate", id: "r", now: NOW });
    const purchase = defaultRule({ kind: "purchaseDate", id: "r", now: NOW });
    expect(release).toMatchObject({ epochSec: { min: NOW - 5 * 365 * DAY } });
    expect(purchase).toMatchObject({ epochSec: { min: NOW - 365 * DAY } });
  });

  it("defaults lastPlayed to never-played, which no epochSec window expresses", () => {
    expect(defaultRule({ kind: "lastPlayed", id: "r", now: NOW })).toMatchObject({
      neverPlayedOnly: true,
      epochSec: {},
    });
  });

  it("gives set-valued rules an explicit anyOf, never an undefined mode", () => {
    for (const kind of ["collection", "storeTags", "genres", "feature", "friendsOwn"] as const) {
      const rule = defaultRule({ kind, id: "r", now: NOW }) as unknown as { mode?: string };
      expect(rule.mode, `${kind} must set a mode`).toBe("anyOf");
    }
  });

  it("builds an empty `all` group", () => {
    expect(defaultRule({ kind: "group", id: "g", now: NOW })).toEqual({
      id: "g",
      kind: "group",
      combinator: "all",
      children: [],
    });
  });

  it("produces a rule the evaluator's registry recognises for every kind", () => {
    for (const kind of RULE_KINDS) {
      const rule = defaultRule({ kind, id: "r", now: NOW });
      expect(rule.kind).toBe(kind);
      // Throws for an unregistered kind, which is the assertion.
      expect(ruleDef(kind).label.length).toBeGreaterThan(0);
    }
  });
});

describe("paramSpecs", () => {
  it("is empty for a flag rule that asserts on its own", () => {
    for (const kind of ["installed", "owned", "comingSoon", "familyShared", "streamable", "onSdCard"] as const) {
      expect(paramSpecs(kind)).toEqual([]);
    }
  });

  it("describes every parameter a rule kind actually carries", () => {
    // The editor can only edit what it is told about, so a param present on
    // the rule and absent from the descriptors is silently uneditable.
    const structural = new Set(["id", "kind", "invert"]);
    for (const kind of RULE_KINDS) {
      const rule = defaultRule({ kind, id: "r", now: NOW }) as unknown as Record<string, unknown>;
      const described = new Set(paramSpecs(kind).map((s) => s.key));
      const carried = Object.keys(rule).filter((k) => !structural.has(k));
      for (const key of carried) {
        expect(described.has(key), `${kind}.${key} has no ParamSpec`).toBe(true);
      }
    }
  });

  it("describes no parameter the rule does not carry", () => {
    for (const kind of RULE_KINDS) {
      const rule = defaultRule({ kind, id: "r", now: NOW }) as unknown as Record<string, unknown>;
      for (const spec of paramSpecs(kind)) {
        expect(spec.key in rule, `${kind} describes absent param ${spec.key}`).toBe(true);
      }
    }
  });

  it("gives every option-valued spec at least two options", () => {
    for (const kind of RULE_KINDS) {
      for (const spec of paramSpecs(kind)) {
        if (spec.control === "options" || spec.control === "choice") {
          expect(spec.options.length, `${kind}.${spec.key}`).toBeGreaterThan(1);
        }
      }
    }
  });

  it("labels every spec and every option", () => {
    const hasLabel = (spec: ParamSpec) => spec.label.trim().length > 0;
    for (const kind of RULE_KINDS) {
      for (const spec of paramSpecs(kind)) {
        expect(hasLabel(spec), `${kind}.${spec.key} needs a label`).toBe(true);
        if (spec.control === "options" || spec.control === "choice") {
          for (const opt of spec.options) {
            expect(opt.label.trim().length, `${kind}.${spec.key}.${opt.value}`).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it("spells the set mode as a consequence rather than anyOf/allOf", () => {
    const spec = paramSpecs("collection").find((s) => s.key === "mode");
    expect(spec?.control).toBe("choice");
    if (spec?.control !== "choice") throw new Error("mode must be a choice");
    expect(spec.options.map((o) => o.value)).toEqual(["anyOf", "allOf"]);
    // The user-facing text must not leak the internal spelling.
    for (const opt of spec.options) {
      expect(opt.label).not.toContain("anyOf");
      expect(opt.label).not.toContain("allOf");
    }
  });

  it("offers `contains` first for title, the safe default TabMaster lacks", () => {
    const spec = paramSpecs("title").find((s) => s.key === "match");
    if (spec?.control !== "choice") throw new Error("match must be a choice");
    expect(spec.options[0]?.value).toBe("contains");
  });
});

describe("ruleCandidate", () => {
  it("carries the palette's label, description and category from the registry", () => {
    const candidate = ruleCandidate({ kind: "installed", id: "r1", now: NOW });
    const def = ruleDef("installed");
    expect(candidate).toMatchObject({
      kind: "installed",
      label: def.label,
      description: def.description,
      category: def.category,
      needsInput: false,
    });
  });

  it("reports needsInput for a rule whose value cannot be guessed", () => {
    expect(ruleCandidate({ kind: "collection", id: "r", now: NOW }).needsInput).toBe(true);
    expect(ruleCandidate({ kind: "title", id: "r", now: NOW }).needsInput).toBe(true);
  });

  it("derives needsInput from isRuleComplete rather than a second list", () => {
    // Guards the invariant directly: the two must never disagree.
    for (const kind of RULE_KINDS) {
      const candidate = ruleCandidate({ kind, id: "r", now: NOW });
      expect(candidate.needsInput, kind).toBe(!isRuleComplete(candidate.rule as Rule));
    }
  });

  it("hands back a rule carrying the id it was given, ready to insert", () => {
    expect(ruleCandidate({ kind: "playtime", id: "picked", now: NOW }).rule.id).toBe("picked");
  });
});
