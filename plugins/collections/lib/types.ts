/**
 * The data model for collections: rules, sorting, and what a collection is.
 *
 * Type-only by design — every runtime concern lives in a sibling module
 * (`rules.ts` for predicates, `evaluate.ts` for the tree walk, `sort.ts`).
 * Keeping this file declaration-only means both the overlay
 * bundle and the backend bundle can import it for free, and the spec gate
 * correctly treats it as having no runtime to test.
 *
 * ## Why three-valued logic
 *
 * A rule does not return `boolean`, it returns {@link Verdict} —
 * `true | false | "indeterminate"`. `"indeterminate"` means *this rule's
 * data source could not answer at all*: the HowLongToBeat plugin is
 * disabled, ProtonDB hasn't been fetched, Steam isn't running.
 *
 * TabMaster has no such state, so a cold achievement cache makes its
 * achievements filter return `false` and the games silently vanish — you
 * cannot tell a wrong rule from a missing data source. Here the tab's
 * {@link ManagedCollection.indeterminatePolicy} decides (defaulting to `"pass"`, so an
 * outage degrades a tab rather than emptying it), and the UI can always
 * name which rules it couldn't check and why.
 *
 * Note the deliberate boundary: *missing metadata for one game* — no known
 * release date, no Metacritic score — is **not** indeterminate. That is
 * endemic rather than exceptional, so it resolves to a definite `false`,
 * overridable per rule via {@link NumericRange.includeUnknown}.
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
   * Defaults to `false`, i.e. a game with no known value for this field
   * does not match.
   *
   * Missing metadata for an individual game is endemic — every real library
   * has hundreds of titles with no Metacritic score — so it resolves to a
   * definite `false` rather than to `"indeterminate"`. Reserve
   * `"indeterminate"` for a whole data source being unavailable; see
   * {@link ManagedCollection.indeterminatePolicy}.
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

// ── Steam collection mirror ────────────────────────────────────────────

/**
 * One tab's mirrored Steam collection.
 *
 * Identity comes from this ledger, never from a name prefix, so the
 * collections we create look native in Steam's own sidebar. The trade-off
 * is that we must be able to prove a collection is ours before touching it,
 * which is exactly what `collectionId` is for.
 */
export interface MirrorLedgerEntry {
  /** Our collection's id. */
  managedId: string;
  /** Steam's id for the collection we created for it. */
  steamCollectionId: string;
  steamName: string;
  /**
   * The exact app set we last wrote. This is the diff base, and it is what
   * separates "the rules now match different games" from "the user hand-edited
   * our collection in Steam" — the latter gets a warning rather than a silent
   * overwrite.
   */
  appIds: string[];
  lastSyncedAt: number;
}

export interface MirrorLedger {
  version: 1;
  entries: MirrorLedgerEntry[];
}

// ── Evaluation output ──────────────────────────────────────────────────

// ── Facts ──────────────────────────────────────────────────────────────

/**
 * One prefetched async fact for one game. The `unavailable` variant
 * carries a user-facing `reason` precisely so the empty-state diagnostics
 * can quote it — "Friends Playing needs Steam running" beats a silent zero.
 */
export type FactValue =
  | { state: "ok"; value: number | string | boolean | string[] }
  | { state: "loading" }
  /**
   * The resolver ran and simply has nothing for this game — no ProtonDB
   * report, no HowLongToBeat entry. Endemic, and a definite `false`.
   *
   * Distinct from `loading` (nobody has asked yet) and `unavailable` (the
   * whole source is down), both of which are `indeterminate`. Collapsing
   * this into `indeterminate` made every unanswered game *match* under the
   * default `"pass"` policy, silently and with no diagnostic.
   */
  | { state: "missing" }
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

// ── Tabs ───────────────────────────────────────────────────────────────

/** Which per-tile badge a collection shows. */
export type BadgeKind =
  | "deckCompat"
  | "playtime"
  | "size"
  | "protonTier"
  | "hltb"
  | "reviewScore"
  | "collection";

export interface CollectionDisplay {
  /** Minimum tile width in px, handed to `GameCardGrid.minTileWidth`. */
  tileWidth: number;
  showLabels: boolean;
  badges: BadgeKind[];
}

/**
 * A collection this plugin maintains — and the only kind that is persisted.
 *
 * There are two kinds at runtime. A **managed** collection is this: its
 * membership is computed from `root` and rewritten into Steam on every sync.
 * A **linked** collection already exists in Steam — EmuDeck's `srm-*` sets,
 * anything made by hand — and is read live rather than stored, because Steam
 * is its source of truth and copying it here would only create two things to
 * disagree with each other.
 *
 * Rules apply to managed collections only. Pointing rules at a collection
 * somebody else curated would replace their work on the first sync.
 */
export interface ManagedCollection {
  id: string;
  /**
   * Shown in the grid, and used verbatim as the Steam collection's name.
   * One name in one place: the previous model kept a separate
   * `mirror.collectionName`, so renaming a collection here silently failed to
   * rename it over there.
   */
  label: string;
  /** A `react-icons` export name, resolved through a whitelist map so a
   *  hand-edited config can't inject an arbitrary import. */
  icon?: string;
  root: GroupRule;
  /** Applied in order; later entries break ties in earlier ones. */
  sort: SortSpec[];
  /** appIds in display order, for `sort[0].field === "manual"`. */
  manualOrder?: string[];
  /** Keep at most this many games after sorting. `null` = uncapped. */
  limit: number | null;
  display: CollectionDisplay;
  /**
   * What to do with rules whose **data source** couldn't answer — a disabled
   * plugin, an unfetched cache, Steam not running. Defaults to `"pass"`, so an
   * outage degrades a collection rather than emptying it.
   *
   * This does *not* govern games with missing metadata; those resolve to a
   * definite `false` at the rule level. See {@link NumericRange.includeUnknown}.
   */
  indeterminatePolicy: "pass" | "fail";
}
