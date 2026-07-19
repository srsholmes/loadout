import { describe, it, expect } from "bun:test";
import type { GameInfo } from "@loadout/types";
import type { Filter, Tab } from "./types";
import {
  gameMatchesFilter,
  gameMatchesTab,
  filterTabGames,
  sortGames,
  titleMatches,
  isTabVisible,
} from "./filters";

// ── Fixtures ─────────────────────────────────────────────────────────

const GB = 1024 * 1024 * 1024;

function game(over: Partial<GameInfo> = {}): GameInfo {
  return {
    appId: "1",
    name: "Test Game",
    sizeOnDisk: 0,
    headerUrl: "",
    capsuleUrl: "",
    localHeaderUrl: "",
    localCapsuleUrl: "",
    source: "steam",
    tags: [],
    ...over,
  };
}

const hades = game({
  appId: "1145360",
  name: "Hades",
  source: "steam",
  tags: ["favorite", "Roguelike"],
  sizeOnDisk: 15 * GB,
});
const zelda = game({
  appId: "9001",
  name: "The Legend of Zelda: Tears of the Kingdom",
  source: "shortcut",
  tags: ["Nintendo Switch - Yuzu", "Emulation"],
  sizeOnDisk: 0,
});
const doom = game({
  appId: "379720",
  name: "DOOM",
  source: "steam",
  tags: ["Shooter"],
  sizeOnDisk: 80 * GB,
});

function tab(over: Partial<Tab> = {}): Tab {
  return {
    id: "t",
    name: "Tab",
    filters: [],
    filtersMode: "and",
    sort: "alpha",
    autoHide: false,
    position: 0,
    hidden: false,
    ...over,
  };
}

function f(over: Partial<Filter> & Pick<Filter, "type" | "params">): Filter {
  return { id: "f", ...over } as Filter;
}

// ── titleMatches ─────────────────────────────────────────────────────

describe("titleMatches", () => {
  it("empty pattern matches everything", () => {
    expect(titleMatches("Anything", "")).toBe(true);
  });
  it("regex is case-insensitive", () => {
    expect(titleMatches("Hades", "^hade")).toBe(true);
  });
  it("falls back to substring on an invalid regex", () => {
    // Unbalanced paren is not a valid RegExp — must not throw.
    expect(titleMatches("Portal (2011)", "(2011")).toBe(true);
    expect(titleMatches("Portal", "(2011")).toBe(false);
  });
});

// ── Individual filter types ──────────────────────────────────────────

describe("gameMatchesFilter", () => {
  it("collection OR matches any listed tag", () => {
    const filter = f({ type: "collection", params: { collections: ["Roguelike", "RPG"], mode: "or" } });
    expect(gameMatchesFilter(hades, filter)).toBe(true);
    expect(gameMatchesFilter(doom, filter)).toBe(false);
  });

  it("collection AND requires every listed tag", () => {
    const filter = f({ type: "collection", params: { collections: ["favorite", "Roguelike"], mode: "and" } });
    expect(gameMatchesFilter(hades, filter)).toBe(true);
    const missingOne = f({ type: "collection", params: { collections: ["favorite", "RPG"], mode: "and" } });
    expect(gameMatchesFilter(hades, missingOne)).toBe(false);
  });

  it("platform steam / nonSteam / emulator-tag", () => {
    expect(gameMatchesFilter(hades, f({ type: "platform", params: { platform: "steam" } }))).toBe(true);
    expect(gameMatchesFilter(zelda, f({ type: "platform", params: { platform: "nonSteam" } }))).toBe(true);
    expect(gameMatchesFilter(zelda, f({ type: "platform", params: { platform: "Nintendo Switch - Yuzu" } }))).toBe(true);
    expect(gameMatchesFilter(hades, f({ type: "platform", params: { platform: "nonSteam" } }))).toBe(false);
  });

  it("size above / below in GB", () => {
    expect(gameMatchesFilter(doom, f({ type: "size", params: { gb: 50, comparison: "above" } }))).toBe(true);
    expect(gameMatchesFilter(hades, f({ type: "size", params: { gb: 50, comparison: "above" } }))).toBe(false);
    expect(gameMatchesFilter(hades, f({ type: "size", params: { gb: 50, comparison: "below" } }))).toBe(true);
  });

  it("whitelist / blacklist by appId", () => {
    expect(gameMatchesFilter(hades, f({ type: "whitelist", params: { appIds: ["1145360"] } }))).toBe(true);
    expect(gameMatchesFilter(doom, f({ type: "whitelist", params: { appIds: ["1145360"] } }))).toBe(false);
    expect(gameMatchesFilter(doom, f({ type: "blacklist", params: { appIds: ["1145360"] } }))).toBe(true);
    expect(gameMatchesFilter(hades, f({ type: "blacklist", params: { appIds: ["1145360"] } }))).toBe(false);
  });

  it("inverted negates the result", () => {
    const steam = f({ type: "platform", inverted: true, params: { platform: "steam" } });
    expect(gameMatchesFilter(hades, steam)).toBe(false);
    expect(gameMatchesFilter(zelda, steam)).toBe(true);
  });
});

// ── Merge (nested boolean logic) ─────────────────────────────────────

describe("merge filter", () => {
  it("nests an OR group inside a top-level AND tab", () => {
    // (Steam) AND (Roguelike OR Shooter)
    const merge = f({
      type: "merge",
      params: {
        mode: "or",
        filters: [
          f({ type: "collection", params: { collections: ["Roguelike"], mode: "or" } }),
          f({ type: "collection", params: { collections: ["Shooter"], mode: "or" } }),
        ],
      },
    });
    const t = tab({
      filtersMode: "and",
      filters: [f({ type: "platform", params: { platform: "steam" } }), merge],
    });
    expect(gameMatchesTab(hades, t)).toBe(true); // steam + roguelike
    expect(gameMatchesTab(doom, t)).toBe(true); // steam + shooter
    expect(gameMatchesTab(zelda, t)).toBe(false); // not steam
  });

  it("inverted merge negates the whole group", () => {
    const merge = f({
      type: "merge",
      inverted: true,
      params: { mode: "or", filters: [f({ type: "collection", params: { collections: ["Roguelike"], mode: "or" } })] },
    });
    expect(gameMatchesFilter(hades, merge)).toBe(false);
    expect(gameMatchesFilter(doom, merge)).toBe(true);
  });

  it("empty merge does not constrain", () => {
    const merge = f({ type: "merge", params: { mode: "and", filters: [] } });
    expect(gameMatchesFilter(zelda, merge)).toBe(true);
  });
});

// ── Tab-level combine ────────────────────────────────────────────────

describe("gameMatchesTab", () => {
  it("empty filter set passes every game", () => {
    const all = tab({ filters: [] });
    expect(filterTabGames([hades, zelda, doom], all)).toHaveLength(3);
  });

  it("OR mode passes a game matching any filter", () => {
    const t = tab({
      filtersMode: "or",
      filters: [
        f({ type: "collection", params: { collections: ["Roguelike"], mode: "or" } }),
        f({ type: "platform", params: { platform: "nonSteam" } }),
      ],
    });
    expect(filterTabGames([hades, zelda, doom], t).map((g) => g.appId)).toEqual(["1145360", "9001"]);
  });
});

// ── Sorting ──────────────────────────────────────────────────────────

describe("sortGames", () => {
  it("alpha is case-insensitive", () => {
    expect(sortGames([doom, hades], "alpha").map((g) => g.name)).toEqual(["DOOM", "Hades"]);
  });
  it("sizeDesc / sizeAsc order by bytes", () => {
    expect(sortGames([hades, doom], "sizeDesc").map((g) => g.appId)).toEqual(["379720", "1145360"]);
    expect(sortGames([doom, hades], "sizeAsc").map((g) => g.appId)).toEqual(["1145360", "379720"]);
  });
  it("manual honours an explicit appId order, unranked last", () => {
    const out = sortGames([hades, doom, zelda], "manual", { manualOrder: ["9001", "379720"] });
    expect(out.map((g) => g.appId)).toEqual(["9001", "379720", "1145360"]);
  });
  it("recent orders by recency, unplayed last", () => {
    const out = sortGames([hades, doom, zelda], "recent", { recentAppIds: ["379720", "9001"] });
    expect(out.map((g) => g.appId)).toEqual(["379720", "9001", "1145360"]);
  });
  it("never mutates the input", () => {
    const input = [doom, hades];
    sortGames(input, "alpha");
    expect(input.map((g) => g.appId)).toEqual(["379720", "1145360"]);
  });
});

// ── Visibility ───────────────────────────────────────────────────────

describe("isTabVisible", () => {
  it("user-hidden tabs are always hidden", () => {
    expect(isTabVisible(tab({ hidden: true }), 5)).toBe(false);
  });
  it("auto-hide drops out only when empty", () => {
    expect(isTabVisible(tab({ autoHide: true }), 0)).toBe(false);
    expect(isTabVisible(tab({ autoHide: true }), 3)).toBe(true);
  });
  it("normal tabs stay visible even when empty", () => {
    expect(isTabVisible(tab(), 0)).toBe(true);
  });
});
