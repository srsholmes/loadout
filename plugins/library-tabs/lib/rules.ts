/**
 * The rule registry: one entry per {@link RuleKind}, carrying its
 * human-facing metadata and its predicate.
 *
 * Single source of truth. The builder's rule palette, the plain-English
 * summariser, the fact-prefetcher and the evaluator all read from here, so
 * adding a rule kind means adding exactly one registry entry (plus a case
 * in `summarize.ts` for its parameters) rather than touching five files.
 *
 * Isomorphic: pure functions over {@link EvalGame}, no I/O, no `node:*`.
 *
 * ## Two kinds of "don't know", and why they differ
 *
 * There are two distinct failure modes here, and the whole design turns on
 * keeping them apart:
 *
 * 1. **Missing metadata for one game** — Steam never recorded a release
 *    date for this title, or it has no Metacritic score. This is *endemic*:
 *    every real library has hundreds of such gaps. Predicates treat it as a
 *    definite `false`, overridable per rule via `NumericRange.includeUnknown`.
 * 2. **A whole data source is unavailable** — the HowLongToBeat plugin is
 *    disabled, ProtonDB hasn't been fetched, Steam isn't running. This is
 *    *exceptional*. Predicates return `"indeterminate"`, and the tab's
 *    `indeterminatePolicy` (default `"pass"`) decides, so a dead source
 *    degrades a tab instead of emptying it.
 *
 * An earlier version routed both through `"indeterminate"`. That was wrong:
 * with the default pass policy, "released before 2015" would list every
 * game whose date we didn't know — including 2024 releases — and virtually
 * every builtin tab and template needed an explicit policy override to
 * behave sanely. Needing to override a default everywhere is the signal
 * that the default is wrong.
 *
 * So: `"indeterminate"` means *the source didn't answer at all*. `false`
 * means *the source answered no, or has nothing for this game*. Empty
 * selections also yield `"indeterminate"`, since a half-built rule is not
 * yet an assertion about anything.
 *
 * `lastPlayed` and `playtimeMinutes` carry a third state: `0` means
 * *provably* never played, which is a real answer and matches normally.
 */

import type { DeckCompat, GameFeatures, SteamOsCompat } from "@loadout/types";
import type {
  EvalGame,
  FactKey,
  NumericRange,
  Rule,
  RuleKind,
  RuleOfKind,
  SetMode,
  Verdict,
} from "./types";

/** The sentinel every numeric `GameMetadata` field uses for "unknown". */
export const UNKNOWN = -1;

// ── Predicate helpers ──────────────────────────────────────────────────

/**
 * Test a numeric value against an inclusive range, honouring the unknown
 * sentinel. Bounds are inclusive on both sides so the UI can say
 * "60 minutes or more" and mean it.
 */
export function matchRange(value: number, range: NumericRange): Verdict {
  // Missing metadata for one game is endemic, not exceptional — see the
  // module header. A definite `false` here (rather than "indeterminate")
  // keeps "released before 2015" from listing games with no known date.
  if (value === UNKNOWN) return range.includeUnknown === true;
  if (range.min !== undefined && value < range.min) return false;
  if (range.max !== undefined && value > range.max) return false;
  return true;
}

/**
 * Set membership with `anyOf` / `allOf` semantics.
 *
 * An empty selection returns `"indeterminate"` rather than a vacuous
 * `true`/`false`: a half-built rule is not an assertion about the library,
 * and treating "user hasn't picked a collection yet" as "matches nothing"
 * is what makes a builder feel broken while you're still typing in it.
 */
export function matchSet(
  haystack: ReadonlySet<string>,
  needles: readonly string[],
  mode: SetMode,
): Verdict {
  if (needles.length === 0) return "indeterminate";
  if (mode === "allOf") {
    for (const n of needles) if (!haystack.has(n.toLowerCase())) return false;
    return true;
  }
  for (const n of needles) if (haystack.has(n.toLowerCase())) return true;
  return false;
}

/** Membership in a small list of enum literals. Empty = indeterminate. */
function matchEnum<T extends string>(value: T, allowed: readonly T[]): Verdict {
  if (allowed.length === 0) return "indeterminate";
  return allowed.includes(value);
}

/**
 * Read a prefetched async fact. A fact that was never prefetched is
 * `loading`, not missing — the first render of a tab necessarily precedes
 * every resolver, and it must show games rather than an empty grid.
 */
function readFact(game: EvalGame, key: FactKey): Verdict | { value: unknown } {
  const fact = game.facts[key];
  if (!fact || fact.state === "loading") return "indeterminate";
  if (fact.state === "unavailable") return "indeterminate";
  return { value: fact.value };
}

function factNumber(game: EvalGame, key: FactKey, range: NumericRange): Verdict {
  const got = readFact(game, key);
  if (typeof got !== "object" || !("value" in got)) return got;
  const n = typeof got.value === "number" ? got.value : Number(got.value);
  if (!Number.isFinite(n)) return "indeterminate";
  return matchRange(n, range);
}

// ── Registry ───────────────────────────────────────────────────────────

/** Grouping used by the rule palette so ~30 kinds stay browsable. */
export type RuleCategory =
  | "library"
  | "play"
  | "catalogue"
  | "compatibility"
  | "social"
  | "storage"
  | "structure";

export interface RuleDef<K extends RuleKind = RuleKind> {
  kind: K;
  /** Shown in the palette and as the rule row's leading label. */
  label: string;
  category: RuleCategory;
  /** One line explaining what it selects. Shown under `label`. */
  description: string;
  /** Whether the builder offers an invert toggle for this kind. */
  invertible: boolean;
  /** Set when the predicate reads a prefetched async fact. */
  factKey?: FactKey;
  /**
   * `false` when the rule is incomplete and should not yet count as an
   * assertion (empty selection, blank text). The builder blocks saving on
   * these and the palette greys them.
   */
  isComplete: (rule: RuleOfKind<K>) => boolean;
  predicate: (rule: RuleOfKind<K>, game: EvalGame) => Verdict;
}

/**
 * Every non-structural rule kind. `group` is absent by design — it has no
 * predicate of its own; `evaluate.ts` owns tree combination.
 */
const DEFS: { [K in Exclude<RuleKind, "group">]: RuleDef<K> } = {
  // ── Library state ────────────────────────────────────────────────────
  installed: {
    kind: "installed",
    label: "Installed",
    category: "library",
    description: "Games currently installed on this device.",
    invertible: true,
    isComplete: () => true,
    predicate: (_r, g) => g.meta.installed,
  },
  owned: {
    kind: "owned",
    label: "Owned",
    category: "library",
    description: "Games in your Steam library, installed or not.",
    invertible: true,
    isComplete: () => true,
    predicate: (_r, g) => g.meta.owned,
  },
  source: {
    kind: "source",
    label: "Store",
    category: "library",
    description: "Steam games or non-Steam shortcuts.",
    invertible: false,
    isComplete: (r) => r.sources.length > 0,
    predicate: (r, g) => matchEnum(g.meta.source, r.sources),
  },
  appKind: {
    kind: "appKind",
    label: "Type",
    category: "library",
    description: "Games, demos, tools, soundtracks, and so on.",
    invertible: true,
    isComplete: (r) => r.kinds.length > 0,
    predicate: (r, g) => matchEnum(g.meta.kind, r.kinds),
  },
  collection: {
    kind: "collection",
    label: "Collection",
    category: "library",
    description: "Games in one of your Steam collections.",
    invertible: true,
    isComplete: (r) => r.collectionIds.length > 0,
    predicate: (r, g) => matchSet(g.norm.collectionSet, r.collectionIds, r.mode),
  },
  comingSoon: {
    kind: "comingSoon",
    label: "Coming soon",
    category: "library",
    description: "Announced but not yet released.",
    invertible: true,
    isComplete: () => true,
    predicate: (_r, g) => g.meta.comingSoon,
  },
  familyShared: {
    kind: "familyShared",
    label: "Family shared",
    category: "library",
    description: "Shared with you by a Steam Family member.",
    invertible: true,
    isComplete: () => true,
    predicate: (_r, g) => g.meta.familyShared,
  },
  streamable: {
    kind: "streamable",
    label: "Streamable",
    category: "library",
    description: "Installed on another of your computers, so it can be streamed.",
    invertible: true,
    isComplete: () => true,
    predicate: (_r, g) => g.meta.streamable,
  },

  // ── Text ─────────────────────────────────────────────────────────────
  title: {
    kind: "title",
    label: "Title",
    category: "library",
    description: "Match the game's name.",
    invertible: true,
    isComplete: (r) => r.value.trim().length > 0,
    predicate: (r, g) => {
      if (r.value.trim().length === 0) return "indeterminate";
      const sensitive = r.caseSensitive === true;
      const haystack = sensitive ? g.meta.name : g.norm.nameLower;
      const needle = sensitive ? r.value : r.value.toLowerCase();
      if (r.match === "contains") return haystack.includes(needle);
      if (r.match === "startsWith") return haystack.startsWith(needle);
      // A half-typed regex is the normal state of a regex field. Report it
      // as unanswerable rather than throwing out of the render path or
      // quietly matching nothing.
      try {
        return new RegExp(r.value, sensitive ? "" : "i").test(g.meta.name);
      } catch {
        return "indeterminate";
      }
    },
  },

  // ── Play history ─────────────────────────────────────────────────────
  playtime: {
    kind: "playtime",
    label: "Time played",
    category: "play",
    description: "How long you've played, in minutes.",
    invertible: false,
    isComplete: (r) => r.minutes.min !== undefined || r.minutes.max !== undefined,
    predicate: (r, g) => matchRange(g.meta.playtimeMinutes, r.minutes),
  },
  lastPlayed: {
    kind: "lastPlayed",
    label: "Last played",
    category: "play",
    description: "When you last launched it.",
    invertible: false,
    isComplete: (r) =>
      r.neverPlayedOnly === true ||
      r.epochSec.min !== undefined ||
      r.epochSec.max !== undefined,
    predicate: (r, g) => {
      const last = g.meta.lastPlayed;
      // `0` is a real answer from Steam ("never launched"), distinct from
      // `-1` ("we couldn't find out"). An unknown last-played time is not
      // evidence of never having played, so it must not match — this tab
      // asserts something positive about the game.
      if (r.neverPlayedOnly === true) return last === 0;
      if (last === 0) return false; // never played can't fall in a date window
      return matchRange(last, r.epochSec);
    },
  },
  achievements: {
    kind: "achievements",
    label: "Achievements",
    category: "play",
    description: "Percentage of achievements you've unlocked.",
    invertible: false,
    factKey: "achievements",
    isComplete: (r) => r.percent.min !== undefined || r.percent.max !== undefined,
    predicate: (r, g) => factNumber(g, "achievements", r.percent),
  },
  hltbMain: {
    kind: "hltbMain",
    label: "How long to beat",
    category: "play",
    description: "Main-story length in hours, from HowLongToBeat.",
    invertible: false,
    factKey: "hltbMain",
    isComplete: (r) => r.hours.min !== undefined || r.hours.max !== undefined,
    predicate: (r, g) => factNumber(g, "hltbMain", r.hours),
  },

  // ── Catalogue metadata ───────────────────────────────────────────────
  releaseDate: {
    kind: "releaseDate",
    label: "Release date",
    category: "catalogue",
    description: "When the game came out.",
    invertible: false,
    isComplete: (r) => r.epochSec.min !== undefined || r.epochSec.max !== undefined,
    predicate: (r, g) => matchRange(g.meta.releaseDate, r.epochSec),
  },
  purchaseDate: {
    kind: "purchaseDate",
    label: "Date added",
    category: "catalogue",
    description: "When it entered your library.",
    invertible: false,
    isComplete: (r) => r.epochSec.min !== undefined || r.epochSec.max !== undefined,
    predicate: (r, g) => matchRange(g.meta.purchasedAt, r.epochSec),
  },
  reviewScore: {
    kind: "reviewScore",
    label: "Steam review score",
    category: "catalogue",
    description: "Percentage of positive Steam reviews.",
    invertible: false,
    isComplete: (r) => r.percent.min !== undefined || r.percent.max !== undefined,
    predicate: (r, g) => matchRange(g.meta.reviewPercentage, r.percent),
  },
  metacritic: {
    kind: "metacritic",
    label: "Metacritic",
    category: "catalogue",
    description: "Metacritic critic score.",
    invertible: false,
    isComplete: (r) => r.score.min !== undefined || r.score.max !== undefined,
    predicate: (r, g) => matchRange(g.meta.metacritic, r.score),
  },
  storeTags: {
    kind: "storeTags",
    label: "Community tags",
    category: "catalogue",
    description: "Steam community tags like Roguelike or Metroidvania.",
    invertible: true,
    isComplete: (r) => r.tags.length > 0,
    predicate: (r, g) => matchSet(g.norm.storeTagSet, r.tags, r.mode),
  },
  genres: {
    kind: "genres",
    label: "Genre",
    category: "catalogue",
    description: "Steam's own genre classification.",
    invertible: true,
    isComplete: (r) => r.genres.length > 0,
    predicate: (r, g) => matchSet(g.norm.genreSet, r.genres, r.mode),
  },
  developer: {
    kind: "developer",
    label: "Developer",
    category: "catalogue",
    description: "Who made it.",
    invertible: true,
    isComplete: (r) => r.names.length > 0,
    predicate: (r, g) => matchSet(g.norm.developerSet, r.names, "anyOf"),
  },
  publisher: {
    kind: "publisher",
    label: "Publisher",
    category: "catalogue",
    description: "Who published it.",
    invertible: true,
    isComplete: (r) => r.names.length > 0,
    predicate: (r, g) => matchSet(g.norm.publisherSet, r.names, "anyOf"),
  },
  feature: {
    kind: "feature",
    label: "Steam features",
    category: "catalogue",
    description: "Cloud saves, controller support, co-op, and so on.",
    invertible: true,
    isComplete: (r) => r.features.length > 0,
    predicate: (r, g) => {
      if (r.features.length === 0) return "indeterminate";
      const has = (k: keyof GameFeatures) => g.meta.features[k] === true;
      return r.mode === "allOf" ? r.features.every(has) : r.features.some(has);
    },
  },

  // ── Compatibility ────────────────────────────────────────────────────
  deckCompat: {
    kind: "deckCompat",
    label: "Deck compatibility",
    category: "compatibility",
    description: "Verified, Playable, Unsupported or Unknown on Steam Deck.",
    invertible: true,
    isComplete: (r) => r.categories.length > 0,
    predicate: (r, g) => matchEnum<DeckCompat>(g.meta.deckCompat, r.categories),
  },
  steamOsCompat: {
    kind: "steamOsCompat",
    label: "SteamOS compatibility",
    category: "compatibility",
    description: "Compatible, Unsupported or Unknown on SteamOS.",
    invertible: true,
    isComplete: (r) => r.categories.length > 0,
    predicate: (r, g) => matchEnum<SteamOsCompat>(g.meta.steamOsCompat, r.categories),
  },
  protonTier: {
    kind: "protonTier",
    label: "ProtonDB rating",
    category: "compatibility",
    description: "Community Proton rating, from the ProtonDB plugin.",
    invertible: true,
    factKey: "protonTier",
    isComplete: (r) => r.tiers.length > 0,
    predicate: (r, g) => {
      if (r.tiers.length === 0) return "indeterminate";
      const got = readFact(g, "protonTier");
      if (typeof got !== "object" || !("value" in got)) return got;
      const tier = String(got.value).toLowerCase();
      return r.tiers.some((t) => t.toLowerCase() === tier);
    },
  },

  // ── Storage ──────────────────────────────────────────────────────────
  sizeOnDisk: {
    kind: "sizeOnDisk",
    label: "Size on disk",
    category: "storage",
    description: "Install size in bytes.",
    invertible: false,
    isComplete: (r) => r.bytes.min !== undefined || r.bytes.max !== undefined,
    predicate: (r, g) => matchRange(g.meta.sizeOnDisk, r.bytes),
  },
  installFolder: {
    kind: "installFolder",
    label: "Install folder",
    category: "storage",
    description: "Games installed under a particular Steam library folder.",
    invertible: true,
    isComplete: (r) => r.paths.length > 0,
    predicate: (r, g) => {
      if (r.paths.length === 0) return "indeterminate";
      // A game with no known install path isn't in any of the listed
      // folders as far as we can tell, and an uninstalled game genuinely
      // isn't. Both are a definite no.
      const path = g.meta.installPath;
      if (path === null) return false;
      return r.paths.some((p) => path.startsWith(p));
    },
  },
  onSdCard: {
    kind: "onSdCard",
    label: "On SD card",
    category: "storage",
    description: "Installed on a microSD card rather than internal storage.",
    invertible: true,
    factKey: "onSdCard",
    isComplete: () => true,
    predicate: (_r, g) => {
      const got = readFact(g, "onSdCard");
      if (typeof got !== "object" || !("value" in got)) return got;
      return got.value === true;
    },
  },

  // ── Social ───────────────────────────────────────────────────────────
  friendsPlaying: {
    kind: "friendsPlaying",
    label: "Friends playing now",
    category: "social",
    description: "How many friends are in the game right now.",
    invertible: false,
    factKey: "friendsPlaying",
    isComplete: (r) => r.minCount > 0,
    predicate: (r, g) => factNumber(g, "friendsPlaying", { min: r.minCount }),
  },
  friendsOwn: {
    kind: "friendsOwn",
    label: "Friends own",
    category: "social",
    description: "Games specific friends also own.",
    invertible: true,
    factKey: "friendsOwn",
    isComplete: (r) => r.steamIds.length > 0,
    predicate: (r, g) => {
      if (r.steamIds.length === 0) return "indeterminate";
      const got = readFact(g, "friendsOwn");
      if (typeof got !== "object" || !("value" in got)) return got;
      const owners = new Set(
        (Array.isArray(got.value) ? got.value : []).map((v) => String(v)),
      );
      return r.mode === "allOf"
        ? r.steamIds.every((id) => owners.has(id))
        : r.steamIds.some((id) => owners.has(id));
    },
  },

  // ── Explicit membership ──────────────────────────────────────────────
  whitelist: {
    kind: "whitelist",
    label: "Only these games",
    category: "structure",
    description: "A hand-picked list of games to include.",
    invertible: false,
    isComplete: (r) => r.appIds.length > 0,
    predicate: (r, g) => r.appIds.includes(g.meta.appId),
  },
  blacklist: {
    kind: "blacklist",
    label: "Except these games",
    category: "structure",
    description: "A hand-picked list of games to exclude.",
    invertible: false,
    isComplete: (r) => r.appIds.length > 0,
    predicate: (r, g) => !r.appIds.includes(g.meta.appId),
  },
};

export const RULE_DEFS: Readonly<typeof DEFS> = DEFS;

/** Every non-structural rule kind, in palette order. */
export const RULE_KINDS = Object.keys(DEFS) as Array<Exclude<RuleKind, "group">>;

export function ruleDef(kind: Exclude<RuleKind, "group">): RuleDef {
  return DEFS[kind] as RuleDef;
}

// ── Dispatch ───────────────────────────────────────────────────────────

/**
 * Run a single leaf rule. Applies `invert` afterwards.
 *
 * `invert` flips `true`/`false` but **preserves `"indeterminate"`**:
 * "not (couldn't check)" is still "couldn't check". Getting this wrong
 * would turn every unanswerable rule into a passing one the moment a user
 * ticked invert.
 *
 * Throws on `group` — that is `evaluate.ts`'s job, and reaching here with
 * one is a programming error rather than bad user data.
 */
export function evaluateLeaf(rule: Rule, game: EvalGame): Verdict {
  if (rule.kind === "group") {
    throw new Error("evaluateLeaf: group rules are handled by evaluate.ts");
  }
  const def = DEFS[rule.kind] as RuleDef;
  const verdict = def.predicate(rule as never, game);
  if (verdict === "indeterminate") return verdict;
  return "invert" in rule && rule.invert === true ? !verdict : verdict;
}

/** Whether a rule (and, for groups, all its descendants) is fully specified. */
export function isRuleComplete(rule: Rule): boolean {
  if (rule.kind === "group") {
    return rule.children.length > 0 && rule.children.every(isRuleComplete);
  }
  const def = DEFS[rule.kind] as RuleDef;
  return def.isComplete(rule as never);
}

/**
 * Every async fact the rule tree needs, deduped. Drives batch prefetching
 * so we fetch ProtonDB once for the whole library rather than once per
 * game per render.
 */
export function requiredFacts(rule: Rule): Set<FactKey> {
  const out = new Set<FactKey>();
  const walk = (r: Rule): void => {
    if (r.kind === "group") {
      for (const child of r.children) walk(child);
      return;
    }
    const key = (DEFS[r.kind] as RuleDef).factKey;
    if (key) out.add(key);
  };
  walk(rule);
  return out;
}

/** Flatten a tree to its leaf rules, depth-first, left to right. */
export function leafRules(rule: Rule): Rule[] {
  if (rule.kind !== "group") return [rule];
  return rule.children.flatMap(leafRules);
}
