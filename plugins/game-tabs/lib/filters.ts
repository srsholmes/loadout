/**
 * Pure filter evaluation for Game Tabs. No React, no I/O — every function
 * here is a deterministic transform over `GameInfo`, so the whole filter
 * language is unit-testable in isolation (`filters.test.ts`).
 *
 * The frontend already holds the library (via `useBackend("__core:game-library")`)
 * and the tab definitions (via the plugin backend), so filtering runs
 * client-side and never needs the server-only scan package.
 */

import type { GameInfo } from "@loadout/types";
import type {
  Filter,
  MatchMode,
  SortMode,
  Tab,
} from "./types";

const BYTES_PER_GB = 1024 * 1024 * 1024;

/** Combine boolean results under an AND/OR mode. Empty list = no
 *  constraint (vacuously true) so an empty tab / empty merge never hides
 *  the whole library. */
function combine(results: boolean[], mode: MatchMode): boolean {
  if (results.length === 0) return true;
  return mode === "and" ? results.every(Boolean) : results.some(Boolean);
}

/** Case-insensitive title test. Interprets `pattern` as a RegExp; if it
 *  isn't a valid one, falls back to a plain substring match so a stray
 *  `(` never throws in the middle of a grid render. */
export function titleMatches(name: string, pattern: string): boolean {
  const p = pattern.trim();
  if (p === "") return true;
  try {
    return new RegExp(p, "i").test(name);
  } catch {
    return name.toLowerCase().includes(p.toLowerCase());
  }
}

/** Evaluate a single filter node against one game (before inversion). */
function evalFilter(game: GameInfo, filter: Filter): boolean {
  switch (filter.type) {
    case "collection": {
      const { collections, mode } = filter.params;
      if (collections.length === 0) return true;
      const has = (c: string) => game.tags.includes(c);
      return mode === "and" ? collections.every(has) : collections.some(has);
    }
    case "regex":
      return titleMatches(game.name, filter.params.pattern);
    case "platform": {
      const p = filter.params.platform;
      if (p === "steam") return game.source === "steam";
      if (p === "nonSteam") return game.source === "shortcut";
      // Otherwise treat it as a specific emulator/platform tag.
      return game.tags.includes(p);
    }
    case "size": {
      const gb = game.sizeOnDisk / BYTES_PER_GB;
      return filter.params.comparison === "above"
        ? gb > filter.params.gb
        : gb < filter.params.gb;
    }
    case "whitelist":
      return filter.params.appIds.includes(game.appId);
    case "blacklist":
      return !filter.params.appIds.includes(game.appId);
    case "merge":
      return combine(
        filter.params.filters.map((f) => gameMatchesFilter(game, f)),
        filter.params.mode,
      );
    default:
      // Unknown/future filter kind: don't constrain the library.
      return true;
  }
}

/** Evaluate a filter node, applying its `inverted` flag. */
export function gameMatchesFilter(game: GameInfo, filter: Filter): boolean {
  const result = evalFilter(game, filter);
  return filter.inverted ? !result : result;
}

/** Does a game belong in a tab? Empty filter set = every game passes. */
export function gameMatchesTab(game: GameInfo, tab: Tab): boolean {
  if (tab.filters.length === 0) return true;
  return combine(
    tab.filters.map((f) => gameMatchesFilter(game, f)),
    tab.filtersMode,
  );
}

/** All games that pass a tab's filters, in input order. */
export function filterTabGames(games: GameInfo[], tab: Tab): GameInfo[] {
  return games.filter((g) => gameMatchesTab(g, tab));
}

export interface SortOptions {
  /** Most-recent-first appId order, e.g. from game-detection sessions.
   *  Games not present sort after those that are. */
  recentAppIds?: string[];
  /** Explicit appId order for `manual` sort (typically a tab's whitelist).
   *  Games not present keep their relative input order, after listed ones. */
  manualOrder?: string[];
}

/** Sort a filtered game list by a tab's sort mode. Returns a new array;
 *  never mutates the input. Alphabetical is case-insensitive. */
export function sortGames(
  games: GameInfo[],
  sort: SortMode,
  opts: SortOptions = {},
): GameInfo[] {
  const out = games.slice();
  switch (sort) {
    case "alpha":
      out.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      );
      break;
    case "sizeDesc":
      out.sort((a, b) => b.sizeOnDisk - a.sizeOnDisk);
      break;
    case "sizeAsc":
      out.sort((a, b) => a.sizeOnDisk - b.sizeOnDisk);
      break;
    case "recent": {
      const rank = indexRank(opts.recentAppIds ?? []);
      out.sort((a, b) => rank(a.appId) - rank(b.appId));
      break;
    }
    case "manual": {
      const rank = indexRank(opts.manualOrder ?? []);
      // Stable: equal ranks keep input order via index tiebreak.
      out.sort((a, b) => rank(a.appId) - rank(b.appId));
      break;
    }
  }
  return out;
}

/** Build a ranker that maps an appId to its index in `order`, or a large
 *  sentinel when absent (so unranked items sort to the end). */
function indexRank(order: string[]): (appId: string) => number {
  const map = new Map<string, number>();
  order.forEach((id, i) => {
    if (!map.has(id)) map.set(id, i);
  });
  return (appId: string) => map.get(appId) ?? Number.MAX_SAFE_INTEGER;
}

/** Whether a tab should be shown in the strip given how many games it
 *  currently matches. User-hidden tabs are always out; auto-hide tabs
 *  drop out only when empty. */
export function isTabVisible(tab: Tab, matchCount: number): boolean {
  if (tab.hidden) return false;
  if (tab.autoHide && matchCount === 0) return false;
  return true;
}
