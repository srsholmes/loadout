/**
 * Data model for the Game Tabs plugin — the persisted shape written to
 * `~/.config/loadout/plugins/game-tabs.json` and the polymorphic filter
 * tree tabs are built from.
 *
 * Type-only module: no runtime, no spec required. The filter/backlog
 * behaviour lives in `filters.ts` / `backlog.ts` (each with a sibling
 * `.test.ts`).
 */

/**
 * Filter kinds v1 can back with the data `__core:game-library` actually
 * provides (name / source / tags / sizeOnDisk). The union is left open
 * for future data-hungry kinds (playtime, lastPlayed, releaseDate) so
 * the editor and evaluator can grow without a schema migration.
 */
export type FilterType =
  | "collection"
  | "regex"
  | "platform"
  | "size"
  | "whitelist"
  | "blacklist"
  | "merge";

/** "match any of the listed values" vs "match all of them". */
export type MatchMode = "and" | "or";

/** Above / below a numeric threshold. */
export type Comparison = "above" | "below";

export interface CollectionParams {
  /** Collection ids / tag strings from `GameInfo.tags`. */
  collections: string[];
  /** `or` = game has any of them; `and` = game has all of them. */
  mode: MatchMode;
}

export interface RegexParams {
  /** Matched against the game title. Treated as a substring when it is
   *  not a valid RegExp (see `filters.ts`). */
  pattern: string;
}

export interface PlatformParams {
  /**
   * `"steam"` → Steam apps, `"nonSteam"` → shortcuts of any kind, or a
   * specific emulator/shortcut tag string (e.g. "Nintendo Switch - Eden")
   * to scope to one platform.
   */
  platform: "steam" | "nonSteam" | string;
}

export interface SizeParams {
  /** Threshold in gigabytes. */
  gb: number;
  comparison: Comparison;
}

export interface ListParams {
  /** Explicit `GameInfo.appId` values. */
  appIds: string[];
}

export interface MergeParams {
  mode: MatchMode;
  filters: Filter[];
}

/**
 * A single filter node. `params` is narrowed by `type` at the callsites
 * in `filters.ts`; kept as a discriminated union so the editor can build
 * and validate each kind independently.
 */
export type Filter =
  | { id: string; type: "collection"; inverted?: boolean; params: CollectionParams }
  | { id: string; type: "regex"; inverted?: boolean; params: RegexParams }
  | { id: string; type: "platform"; inverted?: boolean; params: PlatformParams }
  | { id: string; type: "size"; inverted?: boolean; params: SizeParams }
  | { id: string; type: "whitelist"; inverted?: boolean; params: ListParams }
  | { id: string; type: "blacklist"; inverted?: boolean; params: ListParams }
  | { id: string; type: "merge"; inverted?: boolean; params: MergeParams };

export type SortMode = "alpha" | "sizeDesc" | "sizeAsc" | "recent" | "manual";

export interface Tab {
  id: string;
  name: string;
  /** Filter set. Empty = every game passes ("All Games"). */
  filters: Filter[];
  /** How the top-level filters combine. */
  filtersMode: MatchMode;
  sort: SortMode;
  /** Hide the tab from the strip while its filter set yields no games. */
  autoHide: boolean;
  /** Position in the tab strip (ascending). */
  position: number;
  /** User-hidden (distinct from auto-hide). */
  hidden: boolean;
}

export type BacklogStatus = "toPlay" | "playing" | "beaten" | "dropped";

export interface BacklogEntry {
  /** `GameInfo.appId`. */
  appId: string;
  status: BacklogStatus;
  /** Manual ordering within the backlog (ascending). */
  order: number;
  /** Epoch ms the game was added; passed in by the caller (backends have
   *  a clock; pure helpers never mint one). */
  addedAt: number;
  note?: string;
}

export interface GameTabsData {
  version: 1;
  tabs: Tab[];
  backlog: BacklogEntry[];
}
