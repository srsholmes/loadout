import { describe, expect, it } from "bun:test";
import { groupGames } from "./group";
import { buildEvalGames } from "./facts";
import { evaluateRule } from "./evaluate";
import type { GroupFieldKey, GroupSpec, RuleMatcher } from "./types";
import { IDS, LIBRARY, game, ids } from "../test/fixtures/library";

/** The matcher `evaluateTab` supplies, with the default pass policy. */
const passMatcher: RuleMatcher = (rule, g) =>
  evaluateRule(rule, g) !== false;

/** Strict matcher — treats "couldn't check" as no. */
const failMatcher: RuleMatcher = (rule, g) => evaluateRule(rule, g) === true;

/**
 * The normalised games `evaluateTab` hands to `groupGames`. Passing these is
 * not optional: sub-tab rules are evaluated against them, and building them
 * locally from bare metadata is what once dropped every async fact and let the
 * first sub-group swallow the whole grid.
 */
const evalOf = (games: readonly { appId: string }[]) =>
  buildEvalGames(games as never);

function labels(groups: ReturnType<typeof groupGames>): string[] {
  return groups.map((g) => g.label);
}

describe("groupGames — none", () => {
  it("returns exactly one synthetic group carrying the tab label", () => {
    // Callers never branch on grouped-vs-not: they render `groups`, and a
    // single group renders as a plain grid.
    const out = groupGames(LIBRARY, { kind: "none" }, "My Tab", passMatcher, evalOf(LIBRARY));
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("all");
    expect(out[0]!.label).toBe("My Tab");
    expect(out[0]!.games).toHaveLength(LIBRARY.length);
  });

  it("copies rather than aliasing the input array", () => {
    const out = groupGames(LIBRARY, { kind: "none" }, "T", passMatcher, evalOf(LIBRARY));
    expect(out[0]!.games).not.toBe(LIBRARY);
  });
});

describe("groupGames — field, single-valued keys", () => {
  function byField(field: GroupFieldKey, extra: Partial<Extract<GroupSpec, { kind: "field" }>> = {}) {
    return groupGames(
      LIBRARY,
      { kind: "field", field, sortGroups: "alpha", otherLabel: "Other", ...extra },
      "T",
      passMatcher,
      evalOf(LIBRARY));
  }

  it("groups by source", () => {
    const out = byField("source");
    expect(labels(out)).toEqual(["shortcut", "steam"]);
    expect(ids(out.find((g) => g.label === "shortcut")!.games)).toEqual([IDS.mario64]);
  });

  it("groups by appKind", () => {
    const out = byField("appKind");
    expect(labels(out).sort()).toEqual(["demo", "game", "music", "shortcut"]);
  });

  it("groups by firstLetter, bucketing non-letters under #", () => {
    const g = [
      game({ appId: "1", name: "Alpha" }),
      game({ appId: "2", name: "7 Days to Die" }),
      game({ appId: "3", name: "!Obscure" }),
      game({ appId: "4", name: "apple" }),
    ];
    const out = groupGames(
      g,
      { kind: "field", field: "firstLetter", sortGroups: "alpha", otherLabel: null },
      "T",
      passMatcher,
      evalOf(g));
    expect(labels(out)).toEqual(["#", "A"]);
    expect(ids(out.find((x) => x.label === "#")!.games).sort()).toEqual(["2", "3"]);
    expect(ids(out.find((x) => x.label === "A")!.games).sort()).toEqual(["1", "4"]);
  });

  it("groups by releaseYear from the epoch value", () => {
    const out = byField("releaseYear");
    expect(labels(out)).toContain("2011"); // Portal 2
    expect(labels(out)).toContain("2016"); // Stardew
  });

  it("puts the Unknown bucket last regardless of ordering", () => {
    for (const sortGroups of ["alpha", "countDesc"] as const) {
      const out = byField("releaseYear", { sortGroups });
      expect(out.at(-1)!.label).toBe("Unknown");
    }
  });
});

describe("groupGames — field, multi-valued keys", () => {
  it("places a game under every one of its genres", () => {
    // Portal 2 is Action + Puzzle, so it legitimately appears twice.
    const out = groupGames(
      LIBRARY,
      { kind: "field", field: "genre", sortGroups: "alpha", otherLabel: null },
      "T",
      passMatcher,
      evalOf(LIBRARY));
    const action = out.find((g) => g.label === "Action")!;
    const puzzle = out.find((g) => g.label === "Puzzle")!;
    expect(ids(action.games)).toContain(IDS.portal2);
    expect(ids(puzzle.games)).toContain(IDS.portal2);
  });

  it("groups by collection, including the shortcut's emulation tags", () => {
    const out = groupGames(
      LIBRARY,
      { kind: "field", field: "collection", sortGroups: "countDesc", otherLabel: null },
      "T",
      passMatcher,
      evalOf(LIBRARY));
    expect(labels(out)).toContain("Nintendo 64");
    expect(labels(out)[0]).toBe("favorite"); // most populated
  });

  it("buckets games with no value under Unknown", () => {
    const out = groupGames(
      LIBRARY,
      { kind: "field", field: "genre", sortGroups: "alpha", otherLabel: null },
      "T",
      passMatcher,
      evalOf(LIBRARY));
    const unknown = out.find((g) => g.label === "Unknown")!;
    expect(ids(unknown.games)).toContain(IDS.mario64);
    expect(ids(unknown.games)).toContain(IDS.obscure);
  });
});

describe("groupGames — field ordering", () => {
  it("alpha sorts group labels case-insensitively and numerically", () => {
    const g = [
      game({ appId: "1", name: "A", developers: ["zeta"] }),
      game({ appId: "2", name: "B", developers: ["Alpha"] }),
    ];
    const out = groupGames(
      g,
      { kind: "field", field: "developer", sortGroups: "alpha", otherLabel: null },
      "T",
      passMatcher,
      evalOf(g));
    expect(labels(out)).toEqual(["Alpha", "zeta"]);
  });

  it("countDesc sorts by bucket size, breaking ties alphabetically", () => {
    const g = [
      game({ appId: "1", name: "A", developers: ["Big"] }),
      game({ appId: "2", name: "B", developers: ["Big"] }),
      game({ appId: "3", name: "C", developers: ["Zed"] }),
      game({ appId: "4", name: "D", developers: ["Ace"] }),
    ];
    const out = groupGames(
      g,
      { kind: "field", field: "developer", sortGroups: "countDesc", otherLabel: null },
      "T",
      passMatcher,
      evalOf(g));
    expect(labels(out)).toEqual(["Big", "Ace", "Zed"]);
  });
});

describe("groupGames — maxGroups", () => {
  const many = Array.from({ length: 6 }, (_, i) =>
    game({ appId: String(i), name: `G${i}`, developers: [`Dev${i}`] }),
  );

  it("collapses the tail into otherLabel", () => {
    const out = groupGames(
      many,
      {
        kind: "field",
        field: "developer",
        sortGroups: "alpha",
        maxGroups: 3,
        otherLabel: "Other",
      },
      "T",
      passMatcher,
      evalOf(many));
    expect(labels(out)).toEqual(["Dev0", "Dev1", "Dev2", "Other"]);
    expect(out.at(-1)!.games).toHaveLength(3);
  });

  it("drops the tail entirely when otherLabel is null", () => {
    const out = groupGames(
      many,
      {
        kind: "field",
        field: "developer",
        sortGroups: "alpha",
        maxGroups: 3,
        otherLabel: null,
      },
      "T",
      passMatcher,
      evalOf(many));
    expect(labels(out)).toEqual(["Dev0", "Dev1", "Dev2"]);
  });

  it("does not duplicate a game that fell into several collapsed buckets", () => {
    // A multi-valued field can put the same game in more than one tail
    // bucket; "Other" listing it twice would be a bug.
    const g = [
      game({ appId: "1", name: "A", genres: ["Keep"] }),
      game({ appId: "2", name: "B", genres: ["Tail1", "Tail2"] }),
    ];
    const out = groupGames(
      g,
      {
        kind: "field",
        field: "genre",
        sortGroups: "alpha",
        maxGroups: 1,
        otherLabel: "Other",
      },
      "T",
      passMatcher,
      evalOf(g));
    const other = out.find((x) => x.label === "Other")!;
    expect(ids(other.games)).toEqual(["2"]);
  });

  it("is a no-op when there are fewer groups than the cap", () => {
    const out = groupGames(
      many,
      { kind: "field", field: "developer", sortGroups: "alpha", maxGroups: 99, otherLabel: "Other" },
      "T",
      passMatcher,
      evalOf(many));
    expect(labels(out)).not.toContain("Other");
    expect(out).toHaveLength(6);
  });
});

describe("groupGames — rules (manual sub-tabs)", () => {
  const spec: GroupSpec = {
    kind: "rules",
    groups: [
      {
        id: "unplayed",
        label: "Unplayed",
        rule: { id: "r1", kind: "lastPlayed", epochSec: {}, neverPlayedOnly: true },
      },
      {
        id: "installed",
        label: "Installed",
        rule: { id: "r2", kind: "installed" },
      },
    ],
    residualLabel: "Everything else",
  };

  it("assigns each game to the FIRST matching group only", () => {
    // Overlapping rules behave like a `switch`, so sub-tab counts add up
    // to the visible total rather than double-counting.
    const out = groupGames(LIBRARY, spec, "T", failMatcher, evalOf(LIBRARY));
    const unplayed = out.find((g) => g.label === "Unplayed")!;
    const installed = out.find((g) => g.label === "Installed")!;

    // Cyberpunk is BOTH never-played and installed; it must appear only
    // under the earlier group.
    expect(ids(unplayed.games)).toContain(IDS.cyberpunk);
    expect(ids(installed.games)).not.toContain(IDS.cyberpunk);

    const total = out.reduce((n, g) => n + g.games.length, 0);
    expect(total).toBe(LIBRARY.length);
  });

  it("collects non-matching games under residualLabel", () => {
    const out = groupGames(LIBRARY, spec, "T", failMatcher, evalOf(LIBRARY));
    const rest = out.find((g) => g.label === "Everything else")!;
    expect(ids(rest.games)).toContain(IDS.celeste); // played, not installed
  });

  it("drops non-matching games when residualLabel is null", () => {
    const out = groupGames(LIBRARY, { ...spec, residualLabel: null }, "T", failMatcher, evalOf(LIBRARY));
    expect(labels(out)).toEqual(["Unplayed", "Installed"]);
    const total = out.reduce((n, g) => n + g.games.length, 0);
    expect(total).toBeLessThan(LIBRARY.length);
  });

  it("omits groups that ended up empty", () => {
    const out = groupGames(
      LIBRARY,
      {
        kind: "rules",
        groups: [
          {
            id: "none",
            label: "Never matches",
            rule: { id: "r", kind: "title", match: "contains", value: "zzzznope" },
          },
        ],
        residualLabel: null,
      },
      "T",
      failMatcher,
      evalOf(LIBRARY));
    expect(out).toEqual([]);
  });

  it("honours the injected matcher's indeterminate policy", () => {
    // A rule nothing can answer: under the permissive matcher every game
    // lands in the group; under the strict one, none do.
    const unanswerable: GroupSpec = {
      kind: "rules",
      groups: [
        {
          id: "g",
          label: "Unknowable",
          rule: { id: "r", kind: "protonTier", tiers: ["platinum"] },
        },
      ],
      residualLabel: null,
    };
    expect(
      groupGames(LIBRARY, unanswerable, "T", passMatcher, evalOf(LIBRARY))[0]!.games,
    ).toHaveLength(LIBRARY.length);
    expect(groupGames(LIBRARY, unanswerable, "T", failMatcher, evalOf(LIBRARY))).toEqual([]);
  });

  it("preserves the incoming sort order within each group", () => {
    // `games` arrives already sorted by evaluateTab; grouping must not
    // reshuffle it.
    const ordered = [
      game({ appId: "3", name: "C", installed: true }),
      game({ appId: "1", name: "A", installed: true }),
      game({ appId: "2", name: "B", installed: true }),
    ];
    const out = groupGames(
      ordered,
      {
        kind: "rules",
        groups: [{ id: "i", label: "Installed", rule: { id: "r", kind: "installed" } }],
        residualLabel: null,
      },
      "T",
      failMatcher,
      evalOf(ordered));
    expect(ids(out[0]!.games)).toEqual(["3", "1", "2"]);
  });
});

describe("groupGames — field mode preserves incoming order", () => {
  it("keeps bucket contents in the order they arrived", () => {
    const ordered = [
      game({ appId: "3", name: "C", genres: ["RPG"] }),
      game({ appId: "1", name: "A", genres: ["RPG"] }),
    ];
    const out = groupGames(
      ordered,
      { kind: "field", field: "genre", sortGroups: "alpha", otherLabel: null },
      "T",
      passMatcher,
      evalOf(ordered));
    expect(ids(out[0]!.games)).toEqual(["3", "1"]);
  });
});

describe("groupGames — buildEvalGames is used for rule groups", () => {
  it("normalises case so a differently-cased group rule still matches", () => {
    const g = [game({ appId: "1", name: "X", collections: ["Favorite"] })];
    const out = groupGames(
      g,
      {
        kind: "rules",
        groups: [
          {
            id: "fav",
            label: "Favourites",
            rule: { id: "r", kind: "collection", collectionIds: ["favorite"], mode: "anyOf" },
          },
        ],
        residualLabel: null,
      },
      "T",
      failMatcher,
      evalOf(g));
    expect(ids(out[0]!.games)).toEqual(["1"]);
    // Sanity: the normaliser is what made this work.
    expect(buildEvalGames(g)[0]!.norm.collectionSet.has("favorite")).toBe(true);
  });
});
