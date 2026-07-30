/**
 * The data model for library-tabs: rules, sorting, grouping, tabs.
 *
 * Type-only by design — every runtime concern lives in a sibling module
 * (`rules.ts` for predicates, `evaluate.ts` for the tree walk, `sort.ts`,
 * `group.ts`). Keeping this file declaration-only means both the overlay
 * bundle and the backend bundle can import it for free, and the spec gate
 * correctly treats it as having no runtime to test.
 *
 * ## Why three-valued logic
 *
 * A rule does not return `boolean`, it returns
 * {@link import("./evaluate").Verdict} — `true | false | "indeterminate"`.
 * `"indeterminate"` means "this rule's data source could not answer",
 * which is a genuinely different thing from "no". TabMaster conflates
 * them: its achievements filter returns `false` when Steam's achievement
 * cache is cold, and its release-date filter returns `false` for any game
 * with no known date. The result is tabs that are mysteriously empty with
 * no way to tell a wrong rule from a missing data source. Here, the tab's
 * {@link Tab.indeterminatePolicy} decides what to do, and the UI can
 * always say *which* rules it couldn't check and why.
 */

import type {
  AppKind,
  DeckCompat,
  GameFeatures,
  GameMetadata,
  GameSource,
  SteamOsCompat,
} from "@loadout/types";

/**
 * The result of testing one rule against one game.
 *
 * `"indeterminate"` is not an error state — it is the honest answer when a
 * rule's data source hasn't loaded, isn't reachable, or never knew. See
 * the module header for why this matters.
 */
export type Verdict = true | false | "indeterminate";

/**
 * An inclusive numeric window. `undefined` on either side means unbounded,
 * so `{ min: 60 }` reads "60 or more".
 */
export interface NumericRange {
  /** Inclusive lower bound. */
  min?: number;
  /** Inclusive upper bound. */
  max?: number;
  /**
   * When `true`, records holding the `-1` unknown sentinel **pass**.
   * Defaults to `false`, and it is deliberately explicit rather than
   * inferred: "released before 2015" silently swallowing every game with
   * an unknown release date is exactly the bug class we are here to kill.
   * With the default, unknowns yield `"indeterminate"` and the UI reports
   * how many games it couldn't check.
   */
  includeUnknown?: boolean;
}

/**
 * How a multi-select set rule combines its selections.
 * - `anyOf` — the game matches at least one selected value (union).
 * - `allOf` — the game matches every selected value (intersection).
 */
export type SetMode = "anyOf" | "allOf";

/**
 * Facts that cannot be answered from a {@link import("@loadout/types").GameMetadata}
 * record alone because they need network I/O or another plugin.
 *
 * These are *not* resolved during evaluation. They are batch-prefetched
 * and materialised onto `EvalGame.facts` before a synchronous pass — see
 * `facts.ts`. That indirection is the whole reason this plugin can offer
 * filters TabMaster had to refuse: its `FilterFunction` signature is
 * `(params, app) => boolean`, with nowhere to await.
 */
export type FactKey =
  | "friendsPlaying"
  | "friendsOwn"
  | "achievements"
  | "hltbMain"
  | "protonTier"
  | "onSdCard";

/**
 * One node in a tab's rule tree.
 *
 * Every variant carries a stable `id` (used as a React key, as the
 * addressing scheme for edits, and as the key into
 * `EvalResult.leafMasks`), and every variant except the explicit
 * membership lists carries optional `invert`.
 *
 * On `invert` vs. a parameter: only rules whose negation is genuinely
 * ambiguous get an `invert` flag. `whitelist`/`blacklist` do not, because
 * an inverted whitelist *is* a blacklist and offering both spellings of
 * one idea is a confusion source (TabMaster ships both, plus a hidden
 * stale `inverted: true` when you switch a rule's type — its issue #277).
 */
export type Rule =
  // ── Structure ────────────────────────────────────────────────────────
  | {
      id: string;
      kind: "group";
      combinator: "all" | "any";
      invert?: boolean;
      children: Rule[];
    }
  // ── Library state ────────────────────────────────────────────────────
  | { id: string; kind: "installed"; invert?: boolean }
  | { id: string; kind: "owned"; invert?: boolean }
  | { id: string; kind: "source"; invert?: boolean; sources: GameSource[] }
  | { id: string; kind: "appKind"; invert?: boolean; kinds: AppKind[] }
  | {
      id: string;
      kind: "collection";
      invert?: boolean;
      collectionIds: string[];
      mode: SetMode;
    }
  // ── Text ─────────────────────────────────────────────────────────────
  | {
      id: string;
      kind: "title";
      invert?: boolean;
      /** `contains` is the default — a plain substring, which is what
       *  people actually want. `regex` is available for power users and
       *  yields `"indeterminate"` (never throws) on an invalid pattern. */
      match: "contains" | "startsWith" | "regex";
      value: string;
      caseSensitive?: boolean;
    }
  // ── Numeric ──────────────────────────────────────────────────────────
  | { id: string; kind: "playtime"; invert?: boolean; minutes: NumericRange }
  | { id: string; kind: "sizeOnDisk"; invert?: boolean; bytes: NumericRange }
  | { id: string; kind: "releaseDate"; invert?: boolean; epochSec: NumericRange }
  | {
      id: string;
      kind: "purchaseDate";
      invert?: boolean;
      epochSec: NumericRange;
    }
  | {
      id: string;
      kind: "lastPlayed";
      invert?: boolean;
      epochSec: NumericRange;
      /** Shortcut for the common intent, and unambiguous where a range
       *  is not: `lastPlayed === 0` means *provably* never played, which
       *  no `epochSec` window can express without also catching unknowns. */
      neverPlayedOnly?: boolean;
    }
  | { id: string; kind: "reviewScore"; invert?: boolean; percent: NumericRange }
  | { id: string; kind: "metacritic"; invert?: boolean; score: NumericRange }
  // ── Compatibility ────────────────────────────────────────────────────
  | { id: string; kind: "deckCompat"; invert?: boolean; categories: DeckCompat[] }
  | {
      id: string;
      kind: "steamOsCompat";
      invert?: boolean;
      categories: SteamOsCompat[];
    }
  // ── Catalogue metadata ───────────────────────────────────────────────
  | { id: string; kind: "storeTags"; invert?: boolean; tags: string[]; mode: SetMode }
  | { id: string; kind: "genres"; invert?: boolean; genres: string[]; mode: SetMode }
  | { id: string; kind: "developer"; invert?: boolean; names: string[] }
  | { id: string; kind: "publisher"; invert?: boolean; names: string[] }
  | {
      id: string;
      kind: "feature";
      invert?: boolean;
      features: (keyof GameFeatures)[];
      mode: SetMode;
    }
  // ── Flags ────────────────────────────────────────────────────────────
  | { id: string; kind: "comingSoon"; invert?: boolean }
  | { id: string; kind: "familyShared"; invert?: boolean }
  | { id: string; kind: "streamable"; invert?: boolean }
  | { id: string; kind: "installFolder"; invert?: boolean; paths: string[] }
  // ── Explicit membership. Deliberately not invertible (see above). ─────
  | { id: string; kind: "whitelist"; appIds: string[] }
  | { id: string; kind: "blacklist"; appIds: string[] }
  // ── Async-fact rules. Identical in shape; they differ only in that
  //    `requiredFacts()` reports a FactKey for them. ──────────────────
  | { id: string; kind: "friendsPlaying"; invert?: boolean; minCount: number }
  | {
      id: string;
      kind: "friendsOwn";
      invert?: boolean;
      steamIds: string[];
      mode: SetMode;
    }
  | { id: string; kind: "achievements"; invert?: boolean; percent: NumericRange }
  | { id: string; kind: "hltbMain"; invert?: boolean; hours: NumericRange }
  | { id: string; kind: "protonTier"; invert?: boolean; tiers: string[] }
  | { id: string; kind: "onSdCard"; invert?: boolean };

export type RuleKind = Rule["kind"];
export type GroupRule = Extract<Rule, { kind: "group" }>;

/** Narrow a rule to a specific kind — saves a cast at every call site. */
export type RuleOfKind<K extends RuleKind> = Extract<Rule, { kind: K }>;

// ── Evaluation output ──────────────────────────────────────────────────

/** One rendered group of matches — a sub-tab, or a titled grid section. */
export interface EvalGroupResult {
  id: string;
  label: string;
  games: GameMetadata[];
}

/**
 * Decides whether a rule matches a game, with the tab's
 * {@link Tab.indeterminatePolicy} already folded in.
 *
 * Passed *into* `group.ts` rather than imported from `evaluate.ts`, so the
 * two modules don't form an import cycle. `evaluate.ts` owns rule
 * semantics; `group.ts` owns partitioning and only needs a yes/no.
 */
export type RuleMatcher = (rule: Rule, game: EvalGame) => boolean;

// ── Facts ──────────────────────────────────────────────────────────────

/**
 * One prefetched async fact for one game. The `unavailable` variant
 * carries a user-facing `reason` precisely so the empty-state diagnostics
 * can quote it — "Friends Playing needs Steam running" beats a silent zero.
 */
export type FactValue =
  | { state: "ok"; value: number | string | boolean | string[] }
  | { state: "loading" }
  | { state: "unavailable"; reason: string };

/**
 * A game with everything the evaluator needs, precomputed.
 *
 * Built **once per snapshot** by `buildEvalGames`, never per rule. The
 * `norm` sets exist so set-membership predicates are O(1) lookups with no
 * allocation in the inner loop — with ~2000 games × ~8 leaf rules being
 * re-evaluated on every keystroke in the builder, per-call `.includes()`
 * over arrays or repeated `.toLowerCase()` is the difference between a
 * live match count and a janky one.
 */
export interface EvalGame {
  meta: GameMetadata;
  norm: {
    nameLower: string;
    collectionSet: ReadonlySet<string>;
    storeTagSet: ReadonlySet<string>;
    genreSet: ReadonlySet<string>;
    developerSet: ReadonlySet<string>;
    publisherSet: ReadonlySet<string>;
  };
  facts: Partial<Record<FactKey, FactValue>>;
}

// ── Sorting ────────────────────────────────────────────────────────────

export type SortField =
  | "sortAs"
  | "name"
  | "lastPlayed"
  | "playtimeMinutes"
  | "sizeOnDisk"
  | "releaseDate"
  | "reviewPercentage"
  | "deckCompat"
  | "random"
  | "manual";

export interface SortSpec {
  field: SortField;
  dir: "asc" | "desc";
}

// ── Grouping (sub-tabs) ────────────────────────────────────────────────

/** Fields a tab can auto-group by. */
export type GroupFieldKey =
  | "collection"
  | "genre"
  | "appKind"
  | "deckCompat"
  | "developer"
  | "firstLetter"
  | "releaseYear"
  | "source";

/**
 * How a tab splits its matches into sub-groups. `{ kind: "rules" }` is
 * the manual variant — arbitrary named sub-tabs, each with its own rule
 * tree. That is the single most-requested TabMaster feature (asked at
 * least five times upstream and declined every time on the grounds that
 * its synchronous pre-filter architecture couldn't afford it).
 */
export type GroupSpec =
  | { kind: "none" }
  | {
      kind: "field";
      field: GroupFieldKey;
      sortGroups: "alpha" | "countDesc";
      /** Collapse everything past this many groups into `otherLabel`. */
      maxGroups?: number;
      /** `null` drops the residual group entirely instead of showing it. */
      otherLabel: string | null;
    }
  | {
      kind: "rules";
      groups: Array<{ id: string; label: string; rule: Rule }>;
      /** Label for matches that fell into no group. `null` drops them. */
      residualLabel: string | null;
    };

// ── Tabs ───────────────────────────────────────────────────────────────

/**
 * Tabs we ship. These are hideable and reorderable but their rule trees
 * are not editable — duplicate one to get an editable copy. Mirrors how
 * Steam's own default tabs behave, so the plugin "feels like it has
 * always been part of SteamOS".
 */
export type BuiltinTabId =
  | "all"
  | "installed"
  | "non-steam"
  | "recent"
  | "never-played";

/** Which per-tile badge a tab shows. */
export type BadgeKind =
  | "deckCompat"
  | "playtime"
  | "size"
  | "protonTier"
  | "hltb"
  | "reviewScore"
  | "collection";

export interface TabDisplay {
  /** Minimum tile width in px, handed to `GameCardGrid.minTileWidth`. */
  tileWidth: number;
  showLabels: boolean;
  badges: BadgeKind[];
}

export interface Tab {
  id: string;
  label: string;
  /** A `react-icons` export name, resolved through a whitelist map so a
   *  hand-edited config can't inject an arbitrary import. */
  icon?: string;
  /**
   * `false` = "concealed": the tab still exists, still evaluates, still
   * mirrors — it just isn't in the strip. Distinct from
   * {@link autoHide}, which is conditional on being empty.
   */
  visible: boolean;
  /**
   * Drop the tab from the strip when it evaluates to zero games. Unlike
   * hiding it by hand, this preserves the tab's position for when it
   * fills up again.
   */
  autoHide: boolean;
  /** Set on tabs we ship — hideable, not deletable, `root` not editable. */
  builtin?: BuiltinTabId;
  root: GroupRule;
  /** Applied in order; later entries break ties in earlier ones. */
  sort: SortSpec[];
  /** appIds in display order, for `sort[0].field === "manual"`. */
  manualOrder?: string[];
  /**
   * Keep at most this many games after sorting. `null` = uncapped.
   * ("A tab of my 30 most recent games" was requested upstream and never
   * even filed, because the architecture had nowhere to put it.)
   */
  limit: number | null;
  group: GroupSpec;
  display: TabDisplay;
  mirror: {
    enabled: boolean;
    /** The Steam collection name to mirror into. Defaults to `label`. */
    collectionName: string;
  };
  /**
   * What to do with rules whose data source couldn't answer. Defaults to
   * `"pass"` — a broken or cold data source must never silently empty a
   * tab. `"fail"` is available for users who would rather a tab under-
   * report than include a game it couldn't verify.
   */
  indeterminatePolicy: "pass" | "fail";
}
