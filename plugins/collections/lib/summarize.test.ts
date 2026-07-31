import { describe, expect, it } from "bun:test";
import {
  featureLabel,
  formatBytes,
  formatDate,
  formatMinutes,
  joinList,
  ruleLabel,
  summarizeRule,
  summarizeSort,
  summarizeCollection,
} from "./summarize";
import { RULE_KINDS } from "./rules";
import type { GroupRule, Rule, RuleKind, ManagedCollection } from "./types";
import { epoch } from "../test/fixtures/library";

/** One fully-specified rule per kind, for the exhaustive sweeps below. */
const SAMPLES: { [K in Exclude<RuleKind, "group">]: Extract<Rule, { kind: K }> } = {
  installed: { id: "a", kind: "installed" },
  owned: { id: "a", kind: "owned" },
  source: { id: "a", kind: "source", sources: ["shortcut"] },
  appKind: { id: "a", kind: "appKind", kinds: ["demo"] },
  collection: { id: "a", kind: "collection", collectionIds: ["favorite"], mode: "anyOf" },
  comingSoon: { id: "a", kind: "comingSoon" },
  familyShared: { id: "a", kind: "familyShared" },
  streamable: { id: "a", kind: "streamable" },
  title: { id: "a", kind: "title", match: "contains", value: "portal" },
  playtime: { id: "a", kind: "playtime", minutes: { min: 60 } },
  lastPlayed: { id: "a", kind: "lastPlayed", epochSec: { min: epoch("2024-01-01") } },
  achievements: { id: "a", kind: "achievements", percent: { min: 50 } },
  hltbMain: { id: "a", kind: "hltbMain", hours: { max: 10 } },
  releaseDate: { id: "a", kind: "releaseDate", epochSec: { max: epoch("2015-01-01") } },
  purchaseDate: { id: "a", kind: "purchaseDate", epochSec: { min: epoch("2026-01-01") } },
  reviewScore: { id: "a", kind: "reviewScore", percent: { min: 90 } },
  metacritic: { id: "a", kind: "metacritic", score: { min: 80 } },
  storeTags: { id: "a", kind: "storeTags", tags: ["Roguelike"], mode: "anyOf" },
  genres: { id: "a", kind: "genres", genres: ["RPG"], mode: "anyOf" },
  developer: { id: "a", kind: "developer", names: ["Valve"] },
  publisher: { id: "a", kind: "publisher", names: ["Valve"] },
  feature: { id: "a", kind: "feature", features: ["coop"], mode: "anyOf" },
  deckCompat: { id: "a", kind: "deckCompat", categories: ["verified"] },
  steamOsCompat: { id: "a", kind: "steamOsCompat", categories: ["compatible"] },
  protonTier: { id: "a", kind: "protonTier", tiers: ["platinum"] },
  sizeOnDisk: { id: "a", kind: "sizeOnDisk", bytes: { min: 20 * 1024 ** 3 } },
  installFolder: { id: "a", kind: "installFolder", paths: ["/run/media/mmcblk0p1"] },
  onSdCard: { id: "a", kind: "onSdCard" },
  friendsPlaying: { id: "a", kind: "friendsPlaying", minCount: 1 },
  friendsOwn: { id: "a", kind: "friendsOwn", steamIds: ["123"], mode: "anyOf" },
  whitelist: { id: "a", kind: "whitelist", appIds: ["620"] },
  blacklist: { id: "a", kind: "blacklist", appIds: ["620"] },
};

/** The same rules, but with every optional parameter left empty. */
const EMPTY_SAMPLES: Rule[] = [
  { id: "a", kind: "source", sources: [] },
  { id: "a", kind: "appKind", kinds: [] },
  { id: "a", kind: "collection", collectionIds: [], mode: "anyOf" },
  { id: "a", kind: "title", match: "contains", value: "" },
  { id: "a", kind: "title", match: "regex", value: "" },
  { id: "a", kind: "title", match: "startsWith", value: "" },
  { id: "a", kind: "playtime", minutes: {} },
  { id: "a", kind: "lastPlayed", epochSec: {} },
  { id: "a", kind: "releaseDate", epochSec: {} },
  { id: "a", kind: "purchaseDate", epochSec: {} },
  { id: "a", kind: "sizeOnDisk", bytes: {} },
  { id: "a", kind: "reviewScore", percent: {} },
  { id: "a", kind: "metacritic", score: {} },
  { id: "a", kind: "achievements", percent: {} },
  { id: "a", kind: "hltbMain", hours: {} },
  { id: "a", kind: "deckCompat", categories: [] },
  { id: "a", kind: "steamOsCompat", categories: [] },
  { id: "a", kind: "protonTier", tiers: [] },
  { id: "a", kind: "storeTags", tags: [], mode: "anyOf" },
  { id: "a", kind: "genres", genres: [], mode: "anyOf" },
  { id: "a", kind: "developer", names: [] },
  { id: "a", kind: "publisher", names: [] },
  { id: "a", kind: "feature", features: [], mode: "anyOf" },
  { id: "a", kind: "installFolder", paths: [] },
  { id: "a", kind: "friendsOwn", steamIds: [], mode: "anyOf" },
  { id: "a", kind: "whitelist", appIds: [] },
  { id: "a", kind: "blacklist", appIds: [] },
  { id: "a", kind: "group", combinator: "all", children: [] },
];

function collectionWith(root: GroupRule, overrides: Partial<ManagedCollection> = {}): ManagedCollection {
  return {
    id: "t",
    label: "Test",
    root,
    sort: [{ field: "sortAs", dir: "asc" }],
    limit: null,
    display: { tileWidth: 150, showLabels: true, badges: [] },
    mirror: { enabled: false, steamName: "Test" },
    indeterminatePolicy: "pass",
    ...overrides,
  };
}

describe("formatBytes", () => {
  it("uses MB below a gigabyte", () => {
    expect(formatBytes(500 * 1024 ** 2)).toBe("500 MB");
    // 500 MB must not render as "0.5 GB" — that reads as a rounding error.
    expect(formatBytes(500 * 1024 ** 2)).not.toContain("GB");
  });

  it("uses whole GB when exact, one decimal otherwise", () => {
    expect(formatBytes(20 * 1024 ** 3)).toBe("20 GB");
    expect(formatBytes(1.5 * 1024 ** 3)).toBe("1.5 GB");
  });

  it("reports the unknown sentinel as unknown", () => {
    expect(formatBytes(-1)).toBe("unknown");
  });
});

describe("formatMinutes", () => {
  it("uses minutes below an hour, with correct pluralisation", () => {
    expect(formatMinutes(1)).toBe("1 minute");
    expect(formatMinutes(45)).toBe("45 minutes");
  });

  it("switches to hours at 60", () => {
    expect(formatMinutes(60)).toBe("1 hour");
    expect(formatMinutes(90)).toBe("1.5 hours");
    expect(formatMinutes(12000)).toBe("200 hours");
  });

  it("reports the unknown sentinel as unknown", () => {
    expect(formatMinutes(-1)).toBe("unknown");
  });
});

describe("formatDate", () => {
  it("renders a stable, locale-independent date", () => {
    expect(formatDate(epoch("2011-04-19"))).toBe("19 Apr 2011");
  });

  it("reports the unknown sentinel as unknown", () => {
    expect(formatDate(-1)).toBe("unknown");
  });
});

describe("joinList", () => {
  it("reads like a person wrote it", () => {
    expect(joinList([])).toBe("nothing");
    expect(joinList(["A"])).toBe("A");
    expect(joinList(["A", "B"])).toBe("A or B");
    expect(joinList(["A", "B", "C"])).toBe("A, B or C");
    expect(joinList(["A", "B"], "and")).toBe("A and B");
  });
});

describe("summarizeRule — output hygiene", () => {
  it("never emits undefined, NaN or [object Object] for a complete rule", () => {
    for (const kind of RULE_KINDS) {
      const text = summarizeRule(SAMPLES[kind]);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain("undefined");
      expect(text).not.toContain("NaN");
      expect(text).not.toContain("[object Object]");
    }
  });

  it("never emits undefined, NaN or [object Object] for an EMPTY rule", () => {
    // A half-built rule is the normal state of the builder; it must read as
    // a prompt, not as broken text.
    for (const rule of EMPTY_SAMPLES) {
      const text = summarizeRule(rule);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain("undefined");
      expect(text).not.toContain("NaN");
      expect(text).not.toContain("[object Object]");
    }
  });

  it("has no trailing full stop — these are labels, not prose", () => {
    for (const kind of RULE_KINDS) {
      expect(summarizeRule(SAMPLES[kind]).endsWith(".")).toBe(false);
    }
  });

  it("covers every rule kind, so a new kind fails loudly here", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...RULE_KINDS].sort());
  });
});

describe("summarizeRule — wording", () => {
  it("reads naturally for common rules", () => {
    expect(summarizeRule(SAMPLES.installed)).toBe("is installed");
    expect(summarizeRule(SAMPLES.playtime)).toBe("played for 1 hour or more");
    expect(summarizeRule(SAMPLES.sizeOnDisk)).toBe("takes up 20 GB or more");
    expect(summarizeRule(SAMPLES.title)).toBe('title contains "portal"');
    expect(summarizeRule(SAMPLES.deckCompat)).toBe("is Deck Verified");
    expect(summarizeRule(SAMPLES.feature)).toBe("supports co-op");
  });

  it("renders a two-sided range as 'between'", () => {
    expect(
      summarizeRule({ id: "a", kind: "playtime", minutes: { min: 60, max: 600 } }),
    ).toBe("played for between 1 hour and 10 hours");
  });

  it("flags includeUnknown so the choice is visible in the row", () => {
    expect(
      summarizeRule({
        id: "a",
        kind: "metacritic",
        score: { min: 80, includeUnknown: true },
      }),
    ).toBe("Metacritic 80 or more (or unknown)");
  });

  it("special-cases neverPlayedOnly rather than describing a range", () => {
    expect(
      summarizeRule({ id: "a", kind: "lastPlayed", epochSec: {}, neverPlayedOnly: true }),
    ).toBe("has never been played");
  });

  it("notes case sensitivity only when it is on", () => {
    expect(summarizeRule(SAMPLES.title)).not.toContain("case-sensitive");
    expect(
      summarizeRule({ ...SAMPLES.title, caseSensitive: true }),
    ).toContain("(case-sensitive)");
  });

  it("uses the set mode's conjunction", () => {
    expect(
      summarizeRule({ id: "a", kind: "genres", genres: ["RPG", "Action"], mode: "anyOf" }),
    ).toBe("is RPG or Action");
    expect(
      summarizeRule({ id: "a", kind: "genres", genres: ["RPG", "Action"], mode: "allOf" }),
    ).toBe("is RPG and Action");
  });

  it("counts rather than lists for long id sets", () => {
    // Listing 40 appIds would make the row unreadable.
    expect(
      summarizeRule({ id: "a", kind: "whitelist", appIds: ["1", "2", "3"] }),
    ).toBe("is one of 3 chosen games");
  });
});

describe("summarizeRule — inversion is folded into the wording", () => {
  it('negates "is …" as "is not …"', () => {
    // TabMaster appends "(inverted)", forcing the reader to negate a
    // sentence they just parsed.
    expect(summarizeRule({ ...SAMPLES.installed, invert: true })).toBe(
      "is not installed",
    );
    expect(summarizeRule({ ...SAMPLES.deckCompat, invert: true })).toBe(
      "is not Deck Verified",
    );
  });

  it('negates "has …", "can …", "supports …" and "title …" idiomatically', () => {
    expect(
      summarizeRule({ ...SAMPLES.friendsPlaying, invert: true } as Rule),
    ).toBe("does not have a friend playing right now");
    expect(summarizeRule({ ...SAMPLES.streamable, invert: true })).toBe(
      "cannot be streamed from another PC",
    );
    expect(summarizeRule({ ...SAMPLES.feature, invert: true })).toBe(
      "does not support co-op",
    );
    expect(summarizeRule({ ...SAMPLES.title, invert: true })).toBe(
      'title does not contain "portal"',
    );
  });

  it("de-conjugates every title verb, not just 'contains'", () => {
    // "does not" takes the infinitive; a naive prefix swap yields
    // "title does not contains".
    expect(
      summarizeRule({ id: "a", kind: "title", match: "startsWith", value: "The", invert: true }),
    ).toBe('title does not start with "The"');
    expect(
      summarizeRule({ id: "a", kind: "title", match: "regex", value: "^A", invert: true }),
    ).toBe('title does not match "^A"');
  });

  it("never leaves a bare (inverted) marker", () => {
    // The samples don't carry `invert`, so guarding on `"invert" in rule` made
    // the body unreachable and the whole check vacuous — every kind could have
    // appended "(inverted)" and this still passed. Invert is applied here
    // instead, and only the three kinds that genuinely have no inverted form
    // are skipped.
    const NO_INVERT = new Set(["group", "whitelist", "blacklist"]);
    let checked = 0;
    for (const kind of RULE_KINDS) {
      if (NO_INVERT.has(kind)) continue;
      const text = summarizeRule({ ...SAMPLES[kind], invert: true } as Rule);
      expect(text.toLowerCase()).not.toContain("inverted");
      checked += 1;
    }
    // A loop that silently stops running is how this got missed the first time.
    expect(checked).toBe(RULE_KINDS.filter((k) => !NO_INVERT.has(k)).length);
    expect(checked).toBeGreaterThan(0);
  });
});

describe("summarizeRule — groups", () => {
  it("renders a nested group as a readable parenthesised clause", () => {
    const nested: GroupRule = {
      id: "g",
      kind: "group",
      combinator: "any",
      children: [SAMPLES.installed, SAMPLES.owned],
    };
    expect(summarizeRule(nested)).toBe("(is installed or is in your library)");
  });

  it("uses 'and' for all, 'or' for any", () => {
    const children = [SAMPLES.installed, SAMPLES.comingSoon];
    expect(
      summarizeRule({ id: "g", kind: "group", combinator: "all", children }),
    ).toContain(" and ");
    expect(
      summarizeRule({ id: "g", kind: "group", combinator: "any", children }),
    ).toContain(" or ");
  });

  it("describes an empty group rather than rendering ()", () => {
    expect(
      summarizeRule({ id: "g", kind: "group", combinator: "all", children: [] }),
    ).toBe("an empty group");
  });

  it("nests to depth 3 without producing garbage", () => {
    const deep: GroupRule = {
      id: "g1",
      kind: "group",
      combinator: "all",
      children: [
        SAMPLES.installed,
        {
          id: "g2",
          kind: "group",
          combinator: "any",
          children: [
            SAMPLES.owned,
            { id: "g3", kind: "group", combinator: "all", children: [SAMPLES.comingSoon] },
          ],
        },
      ],
    };
    const text = summarizeRule(deep);
    expect(text).toBe(
      "(is installed and (is in your library or (is coming soon)))",
    );
  });
});

describe("ruleLabel", () => {
  it("uses the registry label for leaves and 'Group' for groups", () => {
    expect(ruleLabel(SAMPLES.installed)).toBe("Installed");
    expect(ruleLabel(SAMPLES.hltbMain)).toBe("How long to beat");
    expect(
      ruleLabel({ id: "g", kind: "group", combinator: "all", children: [] }),
    ).toBe("Group");
  });
});

describe("featureLabel", () => {
  it("maps every feature key to prose", () => {
    expect(featureLabel("cloudSaves")).toBe("Steam Cloud");
    expect(featureLabel("fullControllerSupport")).toBe("full controller support");
  });
});

describe("summarizeSort", () => {
  it("names the field and direction", () => {
    expect(summarizeSort([{ field: "playtimeMinutes", dir: "desc" }])).toBe(
      "time played descending",
    );
  });

  it("chains multiple keys with 'then'", () => {
    expect(
      summarizeSort([
        { field: "deckCompat", dir: "desc" },
        { field: "sortAs", dir: "asc" },
      ]),
    ).toBe("Deck rating descending, then name ascending");
  });

  it("omits direction for random and manual, where it is meaningless", () => {
    expect(summarizeSort([{ field: "random", dir: "asc" }])).toBe("random");
    expect(summarizeSort([{ field: "manual", dir: "asc" }])).toBe("your order");
  });

  it("handles no sort at all", () => {
    expect(summarizeSort([])).toBe("unsorted");
  });
});


describe("summarizeCollection", () => {
  it("reads as one sentence", () => {
    const tab = collectionWith({
      id: "root",
      kind: "group",
      combinator: "all",
      children: [
        SAMPLES.installed,
        { id: "b", kind: "lastPlayed", epochSec: {}, neverPlayedOnly: true },
      ],
    });
    expect(summarizeCollection(tab)).toBe(
      "Show a game when is installed and has never been played, sorted by name ascending",
    );
  });

  it("says 'every game' for an empty rule tree rather than an empty clause", () => {
    const tab = collectionWith({ id: "root", kind: "group", combinator: "all", children: [] });
    expect(summarizeCollection(tab)).toBe("Show every game, sorted by name ascending");
  });

  it("reads an inverted root as 'unless'", () => {
    const tab = collectionWith({
      id: "root",
      kind: "group",
      combinator: "all",
      children: [SAMPLES.installed],
      invert: true,
    });
    expect(summarizeCollection(tab)).toContain("Show a game unless is installed");
  });

  it("mentions the limit when set", () => {
    // Grouping is gone — Steam collections are flat — so the sentence now
    // carries rules, sort and cap only.
    const summary = summarizeCollection(
      collectionWith(
        { kind: "group", id: "g", combinator: "all", children: [{ id: "a", kind: "installed" }] },
        { limit: 30 },
      ),
    );
    expect(summary).toContain("first 30");
  });
});
