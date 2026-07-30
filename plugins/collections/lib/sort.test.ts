import { describe, expect, it } from "bun:test";
import { sortGames } from "./sort";
import type { SortSpec } from "./types";
import { IDS, LIBRARY, game, ids } from "../test/fixtures/library";

function sorted(specs: SortSpec[], opts?: Parameters<typeof sortGames>[2]): string[] {
  return ids(sortGames(LIBRARY, specs, opts));
}

describe("sortGames — purity", () => {
  it("does not mutate its input", () => {
    const before = ids(LIBRARY);
    sortGames(LIBRARY, [{ field: "playtimeMinutes", dir: "desc" }]);
    expect(ids(LIBRARY)).toEqual(before);
  });
});

describe("sortGames — text fields", () => {
  it("sorts by sortAs, case-insensitively", () => {
    // "stardew valley" is lower-case in the fixture precisely to catch a
    // naive codepoint sort that would file it after every capitalised title.
    const result = sorted([{ field: "sortAs", dir: "asc" }]);
    expect(result.indexOf(IDS.stardew)).toBeGreaterThan(result.indexOf(IDS.portal2));
    expect(result.indexOf(IDS.stardew)).toBeLessThan(result.indexOf(IDS.mario64));
  });

  it("reverses cleanly", () => {
    const asc = sorted([{ field: "sortAs", dir: "asc" }]);
    const desc = sorted([{ field: "sortAs", dir: "desc" }]);
    expect(desc).toEqual([...asc].reverse());
  });

  it("prefers sortAs over name when they differ", () => {
    const withSortAs = [
      game({ appId: "1", name: "The Witcher 3", sortAs: "Witcher 3" }),
      game({ appId: "2", name: "Uncharted" }),
    ];
    // Under `name`, "The Witcher 3" files under T and comes first.
    expect(ids(sortGames(withSortAs, [{ field: "name", dir: "asc" }]))).toEqual(["1", "2"]);
    // Under `sortAs`, Steam's leading-article strip files it under W, so
    // it lands after Uncharted — which is where players look for it.
    expect(ids(sortGames(withSortAs, [{ field: "sortAs", dir: "asc" }]))).toEqual(["2", "1"]);
  });

  it("falls back to name when sortAs is empty", () => {
    const g = [game({ appId: "1", name: "Alpha", sortAs: "" }), game({ appId: "2", name: "Beta" })];
    expect(ids(sortGames(g, [{ field: "sortAs", dir: "asc" }]))).toEqual(["1", "2"]);
  });

  it("sorts numerically within text, so 'Portal 2' follows 'Portal'", () => {
    const g = [
      game({ appId: "10", name: "Portal 10" }),
      game({ appId: "2", name: "Portal 2" }),
    ];
    expect(ids(sortGames(g, [{ field: "sortAs", dir: "asc" }]))).toEqual(["2", "10"]);
  });
});

describe("sortGames — unknown values sort last in BOTH directions", () => {
  // Sorting "most played first" must not open with a wall of games whose
  // playtime we simply failed to read.
  const unknownPlaytime = [IDS.obscure, IDS.soundtrack];

  it("descending", () => {
    const result = sorted([{ field: "playtimeMinutes", dir: "desc" }]);
    const tail = result.slice(-2);
    expect(tail.sort()).toEqual([...unknownPlaytime].sort());
  });

  it("ascending", () => {
    const result = sorted([{ field: "playtimeMinutes", dir: "asc" }]);
    const tail = result.slice(-2);
    expect(tail.sort()).toEqual([...unknownPlaytime].sort());
  });

  it("puts unknown release dates last too", () => {
    const asc = sorted([{ field: "releaseDate", dir: "asc" }]);
    // The fixture has four games with no release date.
    const noDate = LIBRARY.filter((g) => g.releaseDate === -1).map((g) => g.appId);
    expect(asc.slice(-noDate.length).sort()).toEqual([...noDate].sort());
  });
});

describe("sortGames — numeric and enum fields", () => {
  it("orders playtime descending", () => {
    const result = sorted([{ field: "playtimeMinutes", dir: "desc" }]);
    expect(result.slice(0, 3)).toEqual([IDS.stardew, IDS.eldenRing, IDS.portal2]);
  });

  it("orders deckCompat worst-to-best ascending, so desc puts Verified first", () => {
    const desc = sortGames(LIBRARY, [{ field: "deckCompat", dir: "desc" }]);
    expect(desc[0]!.deckCompat).toBe("verified");
    // `unknown` uses the -1 sentinel, so it lands last either way.
    expect(desc.at(-1)!.deckCompat).toBe("unknown");
  });

  it("orders sizeOnDisk descending with the shortcut's 0 treated as real", () => {
    const desc = sorted([{ field: "sizeOnDisk", dir: "desc" }]);
    expect(desc[0]).toBe(IDS.cyberpunk); // 70 GB
    // The shortcut reports 0 bytes, a real value, so it sorts before the
    // unknowns but after everything with a size.
    expect(desc.indexOf(IDS.mario64)).toBeLessThan(desc.indexOf(IDS.obscure));
  });
});

describe("sortGames — multi-key tiebreaks", () => {
  it("uses later specs to break ties in earlier ones", () => {
    const g = [
      game({ appId: "c", name: "C", playtimeMinutes: 100 }),
      game({ appId: "a", name: "A", playtimeMinutes: 100 }),
      game({ appId: "b", name: "B", playtimeMinutes: 200 }),
    ];
    expect(
      ids(sortGames(g, [
        { field: "playtimeMinutes", dir: "desc" },
        { field: "sortAs", dir: "asc" },
      ])),
    ).toEqual(["b", "a", "c"]);
  });

  it("always breaks the final tie on appId, for a total order", () => {
    // Without this, a re-render could reshuffle equal-valued games — which
    // on a library where 400 titles all have playtime 0 looks like the grid
    // flickering.
    const g = [
      game({ appId: "z", name: "Same", playtimeMinutes: 0 }),
      game({ appId: "a", name: "Same", playtimeMinutes: 0 }),
      game({ appId: "m", name: "Same", playtimeMinutes: 0 }),
    ];
    const once = ids(sortGames(g, [{ field: "playtimeMinutes", dir: "desc" }]));
    const twice = ids(sortGames([...g].reverse(), [{ field: "playtimeMinutes", dir: "desc" }]));
    expect(once).toEqual(["a", "m", "z"]);
    expect(twice).toEqual(once);
  });
});

describe("sortGames — random", () => {
  it("is stable for a given seed", () => {
    const a = sorted([{ field: "random", dir: "asc" }], { seed: 7 });
    const b = sorted([{ field: "random", dir: "asc" }], { seed: 7 });
    expect(a).toEqual(b);
  });

  it("differs across seeds", () => {
    const a = sorted([{ field: "random", dir: "asc" }], { seed: 1 });
    const b = sorted([{ field: "random", dir: "asc" }], { seed: 99 });
    expect(a).not.toEqual(b);
  });

  it("is a permutation of the input, not a filter", () => {
    const a = sorted([{ field: "random", dir: "asc" }], { seed: 3 });
    expect([...a].sort()).toEqual([...ids(LIBRARY)].sort());
  });
});

describe("sortGames — manual", () => {
  const specs: SortSpec[] = [{ field: "manual", dir: "asc" }];

  it("follows the given order", () => {
    const order = [IDS.stardew, IDS.portal2, IDS.celeste];
    const result = sorted(specs, { manualOrder: order });
    expect(result.slice(0, 3)).toEqual(order);
  });

  it("appends unplaced games after every placed one, in incoming order", () => {
    // Adding a game to the library must not scatter it into the middle of
    // a hand-built list.
    const order = [IDS.stardew, IDS.portal2];
    const result = sorted(specs, { manualOrder: order });
    expect(result.slice(0, 2)).toEqual(order);
    const rest = result.slice(2);
    expect(rest).not.toContain(IDS.stardew);
    expect(rest).toHaveLength(LIBRARY.length - 2);
  });

  it("is a no-op when no manual order is supplied", () => {
    // Falls through to the appId tiebreak rather than throwing.
    const result = sorted(specs);
    expect([...result].sort()).toEqual([...ids(LIBRARY)].sort());
  });

  it("ignores ids in the manual order that are not in the library", () => {
    const result = sorted(specs, { manualOrder: ["nope", IDS.portal2] });
    expect(result[0]).toBe(IDS.portal2);
  });
});

describe("sortGames — no specs", () => {
  it("still returns a deterministic total order", () => {
    const result = sorted([]);
    expect(result).toEqual([...ids(LIBRARY)].sort());
  });
});
