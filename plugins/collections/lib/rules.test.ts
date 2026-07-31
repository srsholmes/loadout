import { describe, expect, it } from "bun:test";
import {
  RULE_DEFS,
  RULE_KINDS,
  UNKNOWN,
  evaluateLeaf,
  isRuleComplete,
  leafRules,
  matchRange,
  matchSet,
  requiredFacts,
  ruleDef,
} from "./rules";
import { buildEvalGames } from "./facts";
import type { EvalGame, FactKey, FactValue, GroupRule, Rule } from "./types";
import { IDS, LIBRARY, game } from "../test/fixtures/library";

const evalLibrary = buildEvalGames(LIBRARY);

function one(appId: string): EvalGame {
  const found = evalLibrary.find((g) => g.meta.appId === appId);
  if (!found) throw new Error(`fixture missing ${appId}`);
  return found;
}

/** Every fixture appId for which `rule` returns exactly `true`. */
function matching(rule: Rule): string[] {
  return evalLibrary
    .filter((g) => evaluateLeaf(rule, g) === true)
    .map((g) => g.meta.appId);
}

/** Build a one-game EvalGame with a single prefetched fact attached. */
function withFact(key: FactKey, value: FactValue): EvalGame {
  return buildEvalGames([game({ appId: "x", name: "X" })], {
    [key]: new Map([["x", value]]),
  })[0]!;
}

describe("matchRange", () => {
  it("treats both bounds as inclusive", () => {
    expect(matchRange(60, { min: 60 })).toBe(true);
    expect(matchRange(59, { min: 60 })).toBe(false);
    expect(matchRange(60, { max: 60 })).toBe(true);
    expect(matchRange(61, { max: 60 })).toBe(false);
    expect(matchRange(60, { min: 60, max: 60 })).toBe(true);
  });

  it("treats an omitted bound as unbounded", () => {
    expect(matchRange(Number.MAX_SAFE_INTEGER, { min: 0 })).toBe(true);
    expect(matchRange(0, { max: 10 })).toBe(true);
    expect(matchRange(5, {})).toBe(true);
  });

  it("fails the unknown sentinel by default, rather than going indeterminate", () => {
    // Missing metadata for one game is endemic, not an outage. Routing it
    // through "indeterminate" (with the default pass policy) would make
    // "released before 2015" list games with no known date at all.
    expect(matchRange(UNKNOWN, { min: 0 })).toBe(false);
    expect(matchRange(UNKNOWN, { max: 100 })).toBe(false);
  });

  it("passes unknowns when includeUnknown is explicitly set", () => {
    expect(matchRange(UNKNOWN, { min: 50, includeUnknown: true })).toBe(true);
    expect(matchRange(UNKNOWN, { min: 50, includeUnknown: false })).toBe(false);
  });
});

describe("matchSet", () => {
  const haystack = new Set(["action", "puzzle", "co-op"]);

  it("returns indeterminate for an empty selection", () => {
    // A half-built rule is not an assertion about the library.
    expect(matchSet(haystack, [], "anyOf")).toBe("indeterminate");
    expect(matchSet(haystack, [], "allOf")).toBe("indeterminate");
  });

  it("anyOf is a union", () => {
    expect(matchSet(haystack, ["Puzzle"], "anyOf")).toBe(true);
    expect(matchSet(haystack, ["Racing", "Puzzle"], "anyOf")).toBe(true);
    expect(matchSet(haystack, ["Racing"], "anyOf")).toBe(false);
  });

  it("allOf is an intersection", () => {
    expect(matchSet(haystack, ["Action", "Puzzle"], "allOf")).toBe(true);
    expect(matchSet(haystack, ["Action", "Racing"], "allOf")).toBe(false);
  });

  it("folds case on the needles", () => {
    expect(matchSet(haystack, ["ACTION"], "anyOf")).toBe(true);
  });
});

describe("registry integrity", () => {
  it("has an entry for every rule kind except the structural group", () => {
    expect(RULE_KINDS).not.toContain("group");
    for (const kind of RULE_KINDS) {
      const def = ruleDef(kind);
      expect(def.kind).toBe(kind);
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
    }
  });

  it("keys each def under its own kind", () => {
    for (const [key, def] of Object.entries(RULE_DEFS)) {
      expect(def.kind).toBe(key);
    }
  });

  it("marks exactly the fact-backed kinds with a factKey", () => {
    const withFactKey = RULE_KINDS.filter((k) => ruleDef(k).factKey !== undefined);
    expect(withFactKey.sort()).toEqual([
      "achievements",
      "friendsOwn",
      "friendsPlaying",
      "hltbMain",
      "onSdCard",
      "protonTier",
    ]);
  });

  it("does not offer invert on the explicit membership lists", () => {
    // An inverted whitelist IS a blacklist; shipping both spellings of one
    // idea is a confusion source.
    expect(ruleDef("whitelist").invertible).toBe(false);
    expect(ruleDef("blacklist").invertible).toBe(false);
  });
});

describe("library-state rules", () => {
  it("installed", () => {
    expect(matching({ id: "a", kind: "installed" })).toEqual([
      IDS.portal2,
      IDS.cyberpunk,
      IDS.mario64,
      IDS.demo,
      IDS.soundtrack,
      IDS.stardew,
    ]);
  });

  it("installed, inverted, is the complement", () => {
    const yes = matching({ id: "a", kind: "installed" });
    const no = matching({ id: "a", kind: "installed", invert: true });
    expect(yes.length + no.length).toBe(LIBRARY.length);
    expect(yes.filter((id) => no.includes(id))).toEqual([]);
  });

  it("owned excludes the non-Steam shortcut", () => {
    expect(matching({ id: "a", kind: "owned" })).not.toContain(IDS.mario64);
  });

  it("source separates Steam from shortcuts", () => {
    expect(matching({ id: "a", kind: "source", sources: ["shortcut"] })).toEqual([
      IDS.mario64,
    ]);
  });

  it("appKind picks out demos and soundtracks", () => {
    expect(matching({ id: "a", kind: "appKind", kinds: ["demo"] })).toEqual([
      IDS.demo,
    ]);
    expect(matching({ id: "a", kind: "appKind", kinds: ["music"] })).toEqual([
      IDS.soundtrack,
    ]);
  });

  it("collection anyOf matches membership in any listed collection", () => {
    expect(
      matching({
        id: "a",
        kind: "collection",
        collectionIds: ["favorite"],
        mode: "anyOf",
      }),
    ).toEqual([IDS.portal2, IDS.celeste, IDS.eldenRing, IDS.stardew]);
  });

  it("collection allOf requires every listed collection", () => {
    expect(
      matching({
        id: "a",
        kind: "collection",
        collectionIds: ["favorite", "uc-classics"],
        mode: "allOf",
      }),
    ).toEqual([IDS.portal2, IDS.stardew]);
  });

  it("comingSoon, familyShared and streamable are simple flags", () => {
    expect(matching({ id: "a", kind: "comingSoon" })).toEqual([IDS.silksong]);
    expect(matching({ id: "a", kind: "familyShared" })).toEqual([IDS.eldenRing]);
    expect(matching({ id: "a", kind: "streamable" })).toEqual([IDS.eldenRing]);
  });
});

describe("title rule", () => {
  it("contains is case-insensitive by default", () => {
    expect(
      matching({ id: "a", kind: "title", match: "contains", value: "STARDEW" }),
    ).toEqual([IDS.stardew]);
  });

  it("honours caseSensitive", () => {
    expect(
      matching({
        id: "a",
        kind: "title",
        match: "contains",
        value: "STARDEW",
        caseSensitive: true,
      }),
    ).toEqual([]);
  });

  it("startsWith anchors at the beginning", () => {
    expect(
      matching({ id: "a", kind: "title", match: "startsWith", value: "portal" }),
    ).toEqual([IDS.portal2]);
    expect(
      matching({ id: "a", kind: "title", match: "startsWith", value: "2" }),
    ).toEqual([]);
  });

  it("supports regex", () => {
    expect(
      matching({ id: "a", kind: "title", match: "regex", value: "^Cyberpunk.*Soundtrack$" }),
    ).toEqual([IDS.soundtrack]);
  });

  it("returns indeterminate for an invalid regex instead of throwing", () => {
    // A half-typed regex is the normal state of a regex field; it must not
    // take down the render path.
    const rule: Rule = { id: "a", kind: "title", match: "regex", value: "[unclosed" };
    expect(() => evaluateLeaf(rule, one(IDS.portal2))).not.toThrow();
    expect(evaluateLeaf(rule, one(IDS.portal2))).toBe("indeterminate");
  });

  it("returns indeterminate for a blank value", () => {
    expect(
      evaluateLeaf({ id: "a", kind: "title", match: "contains", value: "   " }, one(IDS.portal2)),
    ).toBe("indeterminate");
  });
});

describe("lastPlayed rule", () => {
  it("distinguishes provably-never (0) from unknown (-1)", () => {
    const neverOnly: Rule = {
      id: "a",
      kind: "lastPlayed",
      epochSec: {},
      neverPlayedOnly: true,
    };
    // Cyberpunk, the demo and Silksong have lastPlayed 0. The obscure
    // indie and the soundtrack have -1 and must NOT be claimed as "never
    // played" — we simply don't know.
    expect(matching(neverOnly)).toEqual([IDS.cyberpunk, IDS.demo, IDS.silksong]);
    // An unknown last-played time is not evidence of never having played,
    // so it must not match a tab that asserts "never played".
    expect(evaluateLeaf(neverOnly, one(IDS.obscure))).toBe(false);
    expect(evaluateLeaf(neverOnly, one(IDS.soundtrack))).toBe(false);
  });

  it("excludes never-played games from a date window", () => {
    // A game never launched doesn't fall inside "played since 2020",
    // and it isn't unknown either — it's a definite no.
    const since2020: Rule = {
      id: "a",
      kind: "lastPlayed",
      epochSec: { min: 1577836800 },
    };
    expect(evaluateLeaf(since2020, one(IDS.cyberpunk))).toBe(false);
    expect(evaluateLeaf(since2020, one(IDS.stardew))).toBe(true);
  });
});

describe("numeric rules", () => {
  it("playtime treats 0 as a real value, not unknown", () => {
    const zeroOnly: Rule = { id: "a", kind: "playtime", minutes: { max: 0 } };
    expect(matching(zeroOnly)).toEqual([IDS.cyberpunk, IDS.demo, IDS.silksong]);
    expect(evaluateLeaf(zeroOnly, one(IDS.obscure))).toBe(false);
  });

  it("sizeOnDisk reports unknown sizes as indeterminate", () => {
    const big: Rule = { id: "a", kind: "sizeOnDisk", bytes: { min: 10 * 1024 ** 3 } };
    expect(matching(big)).toEqual([IDS.portal2, IDS.cyberpunk]);
    expect(evaluateLeaf(big, one(IDS.celeste))).toBe(false);
  });

  it("reviewScore and metacritic filter on their own scales", () => {
    expect(matching({ id: "a", kind: "reviewScore", percent: { min: 95 } })).toEqual([
      IDS.portal2,
      IDS.celeste,
      IDS.stardew,
    ]);
    expect(matching({ id: "a", kind: "metacritic", score: { min: 95 } })).toEqual([
      IDS.portal2,
      IDS.eldenRing,
    ]);
  });
});

describe("compatibility rules", () => {
  it("deckCompat matches the listed categories", () => {
    expect(
      matching({ id: "a", kind: "deckCompat", categories: ["verified"] }),
    ).toEqual([IDS.portal2, IDS.celeste, IDS.eldenRing, IDS.stardew]);
  });

  it("deckCompat can select Unknown explicitly", () => {
    // "Unknown" is a real, selectable category here, not a hole. Users
    // genuinely want a "needs testing" tab.
    const unknown = matching({ id: "a", kind: "deckCompat", categories: ["unknown"] });
    expect(unknown).toContain(IDS.obscure);
    expect(unknown).toContain(IDS.silksong);
  });

  it("steamOsCompat is independent of deckCompat", () => {
    expect(
      matching({ id: "a", kind: "steamOsCompat", categories: ["compatible"] }),
    ).toEqual([IDS.portal2, IDS.cyberpunk, IDS.stardew]);
  });
});

describe("storage rules", () => {
  it("installFolder matches a path prefix", () => {
    expect(
      matching({ id: "a", kind: "installFolder", paths: ["/run/media/mmcblk0p1"] }),
    ).toEqual([IDS.cyberpunk, IDS.stardew]);
  });

  it("installFolder is a definite no for games with no known path", () => {
    // An uninstalled game genuinely is not in any folder.
    expect(
      evaluateLeaf(
        { id: "a", kind: "installFolder", paths: ["/anywhere"] },
        one(IDS.celeste),
      ),
    ).toBe(false);
  });

  it("onSdCard reads its prefetched fact", () => {
    expect(
      evaluateLeaf({ id: "a", kind: "onSdCard" }, withFact("onSdCard", { state: "ok", value: true })),
    ).toBe(true);
    expect(
      evaluateLeaf({ id: "a", kind: "onSdCard" }, withFact("onSdCard", { state: "ok", value: false })),
    ).toBe(false);
  });
});

describe("fact-backed rules degrade to indeterminate, never to false", () => {
  it("treats a never-prefetched fact as loading", () => {
    // The first render of a tab necessarily precedes every resolver.
    expect(
      evaluateLeaf(
        { id: "a", kind: "protonTier", tiers: ["platinum"] },
        one(IDS.portal2),
      ),
    ).toBe("indeterminate");
  });

  it("treats an explicitly loading fact as indeterminate", () => {
    expect(
      evaluateLeaf(
        { id: "a", kind: "hltbMain", hours: { max: 10 } },
        withFact("hltbMain", { state: "loading" }),
      ),
    ).toBe("indeterminate");
  });

  it("treats an unavailable fact as indeterminate", () => {
    // This is the bug class that made TabMaster's tabs mysteriously empty:
    // a cold cache returned `false` and the games just vanished.
    expect(
      evaluateLeaf(
        { id: "a", kind: "achievements", percent: { min: 50 } },
        withFact("achievements", {
          state: "unavailable",
          reason: "Steam isn't running.",
        }),
      ),
    ).toBe("indeterminate");
  });

  it("matches a resolved protonTier case-insensitively", () => {
    expect(
      evaluateLeaf(
        { id: "a", kind: "protonTier", tiers: ["Platinum"] },
        withFact("protonTier", { state: "ok", value: "platinum" }),
      ),
    ).toBe(true);
  });

  it("returns indeterminate for a non-numeric value where a number is needed", () => {
    expect(
      evaluateLeaf(
        { id: "a", kind: "hltbMain", hours: { max: 10 } },
        withFact("hltbMain", { state: "ok", value: "not a number" }),
      ),
    ).toBe("indeterminate");
  });
});

describe("membership rules", () => {
  it("whitelist includes only the listed ids", () => {
    expect(
      matching({ id: "a", kind: "whitelist", appIds: [IDS.portal2, IDS.celeste] }),
    ).toEqual([IDS.portal2, IDS.celeste]);
  });

  it("blacklist is the complement of its list", () => {
    const result = matching({ id: "a", kind: "blacklist", appIds: [IDS.portal2] });
    expect(result).toHaveLength(LIBRARY.length - 1);
    expect(result).not.toContain(IDS.portal2);
  });
});

describe("evaluateLeaf", () => {
  it("refuses group rules — that is evaluate.ts's job", () => {
    const grp: GroupRule = { id: "g", kind: "group", combinator: "all", children: [] };
    expect(() => evaluateLeaf(grp, one(IDS.portal2))).toThrow(
      /group rules are handled by evaluate/i,
    );
  });
});

describe("isRuleComplete", () => {
  it("rejects empty selections and blank text", () => {
    expect(isRuleComplete({ id: "a", kind: "collection", collectionIds: [], mode: "anyOf" })).toBe(false);
    expect(isRuleComplete({ id: "a", kind: "title", match: "contains", value: "" })).toBe(false);
    expect(isRuleComplete({ id: "a", kind: "playtime", minutes: {} })).toBe(false);
  });

  it("accepts a fully specified rule", () => {
    expect(isRuleComplete({ id: "a", kind: "installed" })).toBe(true);
    expect(isRuleComplete({ id: "a", kind: "playtime", minutes: { min: 1 } })).toBe(true);
  });

  it("treats an empty group as incomplete and recurses into children", () => {
    expect(isRuleComplete({ id: "g", kind: "group", combinator: "all", children: [] })).toBe(false);
    expect(
      isRuleComplete({
        id: "g",
        kind: "group",
        combinator: "all",
        children: [{ id: "a", kind: "title", match: "contains", value: "" }],
      }),
    ).toBe(false);
    expect(
      isRuleComplete({
        id: "g",
        kind: "group",
        combinator: "all",
        children: [{ id: "a", kind: "installed" }],
      }),
    ).toBe(true);
  });
});

describe("requiredFacts", () => {
  it("is empty for a tree with no fact-backed rules", () => {
    expect([...requiredFacts({ id: "a", kind: "installed" })]).toEqual([]);
  });

  it("walks nested groups and dedupes", () => {
    const tree: GroupRule = {
      id: "g",
      kind: "group",
      combinator: "all",
      children: [
        { id: "p1", kind: "protonTier", tiers: ["gold"] },
        {
          id: "g2",
          kind: "group",
          combinator: "any",
          children: [
            { id: "p2", kind: "protonTier", tiers: ["platinum"] },
            { id: "h", kind: "hltbMain", hours: { max: 10 } },
          ],
        },
      ],
    };
    expect([...requiredFacts(tree)].sort()).toEqual(["hltbMain", "protonTier"]);
  });
});

describe("leafRules", () => {
  it("flattens depth-first, left to right", () => {
    const tree: GroupRule = {
      id: "g",
      kind: "group",
      combinator: "all",
      children: [
        { id: "a", kind: "installed" },
        {
          id: "g2",
          kind: "group",
          combinator: "any",
          children: [
            { id: "b", kind: "owned" },
            { id: "c", kind: "comingSoon" },
          ],
        },
        { id: "d", kind: "streamable" },
      ],
    };
    expect(leafRules(tree).map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("includeUnknown on a fact-backed range", () => {
  const withFact = (state: "ok" | "missing", value = 100) =>
    buildEvalGames([LIBRARY[0]!], {
      hltbMain: new Map([[LIBRARY[0]!.appId, state === "ok" ? { state, value } : { state }]]),
    })[0]!;

  it("excludes a game the source has nothing for, by default", () => {
    const rule = { kind: "hltbMain", id: "r", hours: { max: 300 } } as const;
    expect(evaluateLeaf(rule as never, withFact("missing"))).toBe(false);
  });

  it("includes it when the rule asks for unknowns", () => {
    // The toggle is rendered for every range rule, fact-backed included. It
    // was live and inert on all of them.
    const rule = { kind: "hltbMain", id: "r", hours: { max: 300, includeUnknown: true } } as const;
    expect(evaluateLeaf(rule as never, withFact("missing"))).toBe(true);
  });

  it("still applies the range when the source did answer", () => {
    const rule = { kind: "hltbMain", id: "r", hours: { max: 50, includeUnknown: true } } as const;
    expect(evaluateLeaf(rule as never, withFact("ok", 100))).toBe(false);
  });
});
