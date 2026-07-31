/**
 * What a rule's parameters *are*, and what a new one starts as.
 *
 * Two jobs, kept together because they answer the same question from
 * opposite ends:
 *
 * - `defaultRule` — the rule you get when you pick a kind from the palette.
 * - `paramSpecs` — a description of that kind's editable fields, which
 *   `ParamEditors.tsx` renders generically.
 *
 * **Why descriptors rather than 30 hand-written editors.** There are 32 rule
 * kinds and eight distinct shapes of input between them. Hand-writing an
 * editor per kind guarantees they drift: one forgets a 44px hit target,
 * another forgets `:focus-visible`, a third makes its own decision about
 * whether an empty selection means "all" or "none". A descriptor makes the
 * *data* per-kind and the *behaviour* shared, so the docked-mouse and gamepad
 * contracts are implemented once.
 *
 * **Every default is complete where a sensible default exists.** `rules.ts`
 * treats an unbounded range as *incomplete* — not yet an assertion — so a
 * range rule ships with a real bound rather than `{}`. That matters for the
 * palette, which prices each candidate at its defaults: a rule that cannot
 * be priced has nothing useful to show. Where no default can be guessed (a
 * collection id, a search string) `needsInput` is true and the palette says
 * so instead of showing a meaningless count.
 */

import { GAME_FEATURE_KEYS } from "@loadout/types";
import type { GameFeatures } from "@loadout/types";
import { isRuleComplete, ruleDef } from "./rules";
import { featureLabel } from "./summarize";
import type { Rule, RuleKind, SetMode } from "./types";

/** Seconds in a day — the unit every date default is expressed in. */
const DAY = 86_400;
const GIB = 1024 ** 3;

// ── Descriptors ────────────────────────────────────────────────────────

export interface ParamOption {
  value: string;
  label: string;
  /** Shown under the label where the option's meaning isn't self-evident. */
  hint?: string;
}

/**
 * How a range's numbers should be typed and displayed. The editor needs this
 * to put "2h 30m" in front of a playtime and a date picker in front of a
 * release date, from one shared control.
 */
export type RangeUnit = "minutes" | "hours" | "bytes" | "date" | "percent" | "count";

export type ParamSpec =
  /** A `NumericRange` — min and max, either side optional. */
  | { key: string; control: "range"; label: string; unit: RangeUnit; helper?: string }
  /** Pick any number of fixed options. */
  | { key: string; control: "options"; label: string; options: ParamOption[]; helper?: string }
  /** Pick exactly one fixed option. */
  | { key: string; control: "choice"; label: string; options: ParamOption[]; helper?: string }
  /** Free text. */
  | { key: string; control: "text"; label: string; placeholder?: string; helper?: string }
  /** A boolean. */
  | { key: string; control: "toggle"; label: string; helper?: string }
  /** A single integer. */
  | { key: string; control: "number"; label: string; min?: number; max?: number; helper?: string }
  /** A list of free-text values the user types, e.g. developer names. */
  | { key: string; control: "tokens"; label: string; placeholder?: string; helper?: string }
  /** A list chosen from the user's library or collections. */
  | { key: string; control: "picker"; label: string; source: "game" | "collection"; helper?: string };

/** `anyOf` vs `allOf`, spelled as a consequence rather than a term of art. */
const MODE_SPEC = (noun: string): ParamSpec => ({
  key: "mode",
  control: "choice",
  label: "Match",
  options: [
    { value: "anyOf", label: `Any of these ${noun}`, hint: "Broader — matches more games" },
    { value: "allOf", label: `All of these ${noun}`, hint: "Narrower — matches fewer games" },
  ],
});

function optionsOf(values: readonly string[], label: (v: string) => string): ParamOption[] {
  return values.map((value) => ({ value, label: label(value) }));
}

const TITLE_CASE = (v: string): string => v.charAt(0).toUpperCase() + v.slice(1);

const FEATURE_OPTIONS: ParamOption[] = (GAME_FEATURE_KEYS as readonly (keyof GameFeatures)[]).map(
  (key) => ({ value: key, label: TITLE_CASE(featureLabel(key)) }),
);

/** Per-kind parameter descriptors. Kinds absent from this map take no input. */
const SPECS: Partial<Record<RuleKind, ParamSpec[]>> = {
  source: [
    {
      key: "sources",
      control: "options",
      label: "Store",
      options: [
        { value: "steam", label: "Steam" },
        { value: "shortcut", label: "Non-Steam", hint: "Shortcuts you added yourself" },
      ],
    },
  ],
  appKind: [
    {
      key: "kinds",
      control: "options",
      label: "Type",
      options: [
        { value: "game", label: "Game" },
        { value: "demo", label: "Demo" },
        { value: "dlc", label: "DLC" },
        { value: "tool", label: "Tool" },
        { value: "application", label: "Application" },
        { value: "music", label: "Soundtrack" },
        { value: "video", label: "Video" },
        { value: "series", label: "Series" },
        { value: "mod", label: "Mod" },
        { value: "config", label: "Config" },
        { value: "beta", label: "Beta" },
        { value: "shortcut", label: "Shortcut" },
        // ROMs were 1878 of 2295 apps on the development device, so leaving
        // this out meant no rule could name the largest kind in the library,
        // and "Shortcut" does not catch them.
        { value: "rom", label: "ROM" },
        { value: "unknown", label: "Unknown" },
      ],
    },
  ],
  collection: [
    { key: "collectionIds", control: "picker", label: "Collections", source: "collection" },
    MODE_SPEC("collections"),
  ],
  title: [
    {
      key: "match",
      control: "choice",
      label: "How to match",
      options: [
        { value: "contains", label: "Contains", hint: "A plain substring — usually what you want" },
        { value: "startsWith", label: "Starts with" },
        { value: "regex", label: "Regular expression", hint: "An invalid pattern can't be checked, so it won't narrow the tab" },
      ],
    },
    { key: "value", control: "text", label: "Text", placeholder: "e.g. Halo" },
    { key: "caseSensitive", control: "toggle", label: "Case sensitive" },
  ],
  playtime: [{ key: "minutes", control: "range", label: "Time played", unit: "minutes" }],
  sizeOnDisk: [{ key: "bytes", control: "range", label: "Size on disk", unit: "bytes" }],
  releaseDate: [{ key: "epochSec", control: "range", label: "Released", unit: "date" }],
  purchaseDate: [{ key: "epochSec", control: "range", label: "Bought", unit: "date" }],
  lastPlayed: [
    {
      key: "neverPlayedOnly",
      control: "toggle",
      label: "Never played only",
      helper: "Games Steam has recorded zero launches for. Games with no known history are excluded.",
    },
    { key: "epochSec", control: "range", label: "Last played", unit: "date" },
  ],
  reviewScore: [{ key: "percent", control: "range", label: "Positive reviews", unit: "percent" }],
  metacritic: [{ key: "score", control: "range", label: "Metacritic", unit: "percent" }],
  storeTags: [
    { key: "tags", control: "tokens", label: "Tags", placeholder: "e.g. Roguelike" },
    MODE_SPEC("tags"),
  ],
  genres: [
    { key: "genres", control: "tokens", label: "Genres", placeholder: "e.g. Strategy" },
    MODE_SPEC("genres"),
  ],
  developer: [{ key: "names", control: "tokens", label: "Developers", placeholder: "e.g. Valve" }],
  publisher: [{ key: "names", control: "tokens", label: "Publishers", placeholder: "e.g. Sega" }],
  feature: [
    { key: "features", control: "options", label: "Features", options: FEATURE_OPTIONS },
    MODE_SPEC("features"),
  ],
  deckCompat: [
    {
      key: "categories",
      control: "options",
      label: "Deck compatibility",
      options: optionsOf(["verified", "playable", "unsupported", "unknown"], TITLE_CASE),
    },
  ],
  steamOsCompat: [
    {
      key: "categories",
      control: "options",
      label: "SteamOS compatibility",
      options: optionsOf(["compatible", "unsupported", "unknown"], TITLE_CASE),
    },
  ],
  installFolder: [
    {
      key: "paths",
      control: "tokens",
      label: "Install folders",
      placeholder: "e.g. /run/media/mmcblk0p1",
      helper: "Matches a game whose install path starts with any of these.",
    },
  ],
  whitelist: [
    {
      key: "appIds",
      control: "picker",
      label: "Always include",
      source: "game",
      helper:
        "Adds these games to what this group matches. Under ALL they must " +
        "still satisfy the other rules — put them in their own ANY group to " +
        "include them outright.",
    },
  ],
  blacklist: [
    {
      key: "appIds",
      control: "picker",
      label: "Never include",
      source: "game",
      helper:
        "Excludes these games. Under ALL that beats the other rules; under " +
        "ANY another rule can still let them back in.",
    },
  ],
  friendsPlaying: [
    { key: "minCount", control: "number", label: "At least this many friends", min: 1 },
  ],
  friendsOwn: [
    { key: "steamIds", control: "tokens", label: "Friends", placeholder: "Steam ID" },
    MODE_SPEC("friends"),
  ],
  achievements: [{ key: "percent", control: "range", label: "Achievements earned", unit: "percent" }],
  hltbMain: [{ key: "hours", control: "range", label: "Hours to beat", unit: "hours" }],
  protonTier: [
    {
      key: "tiers",
      control: "tokens",
      label: "ProtonDB tiers",
      placeholder: "e.g. gold",
      helper: "Tier names come from the ProtonDB Badges plugin.",
    },
  ],
};

/**
 * The editable fields of a rule kind, in the order they should be rendered.
 * Empty for kinds that assert something on their own — `installed`, `owned`
 * and the other flags have nothing to configure.
 */
export function paramSpecs(kind: RuleKind): readonly ParamSpec[] {
  return SPECS[kind] ?? [];
}

// ── Defaults ───────────────────────────────────────────────────────────

/**
 * Per-kind starting parameters. `now` is passed in rather than read from the
 * clock so date defaults are deterministic under test — the same discipline
 * `evaluateTab` already uses.
 */
function defaultParams(kind: RuleKind, now: number): Record<string, unknown> {
  const anyOf: SetMode = "anyOf";
  switch (kind) {
    case "group":
      return { combinator: "all", children: [] };

    // Enum sets: default to the option people reach for, so the rule is
    // immediately priceable in the palette.
    case "source":
      return { sources: ["steam"] };
    case "appKind":
      return { kinds: ["game"] };
    case "deckCompat":
      return { categories: ["verified"] };
    case "steamOsCompat":
      return { categories: ["compatible"] };
    case "feature":
      // A handheld-first default: controller support is the feature that
      // actually decides whether a game is worth opening here.
      return { features: ["fullControllerSupport"], mode: anyOf };

    case "title":
      // `caseSensitive` is explicitly false rather than omitted: the editor's
      // toggle then reads a defined value, and the saved config says what it
      // means instead of relying on a reader's default.
      return { match: "contains", value: "", caseSensitive: false };

    // Ranges. An unbounded range is incomplete per `rules.ts`, so each carries
    // a real bound expressing the intent the rule is usually added for.
    case "playtime":
      return { minutes: { max: 120 } };
    case "sizeOnDisk":
      return { bytes: { min: 10 * GIB } };
    case "releaseDate":
      return { epochSec: { min: now - 5 * 365 * DAY } };
    case "purchaseDate":
      return { epochSec: { min: now - 365 * DAY } };
    case "lastPlayed":
      // The reason this rule gets added far more often than any window over
      // `epochSec`, and unambiguous where a range is not.
      return { epochSec: {}, neverPlayedOnly: true };
    case "reviewScore":
      return { percent: { min: 80 } };
    case "metacritic":
      return { score: { min: 80 } };
    case "achievements":
      return { percent: { min: 50 } };
    case "hltbMain":
      return { hours: { max: 10 } };
    case "friendsPlaying":
      return { minCount: 1 };

    // Sets of user-supplied values. Nothing can be guessed, so these are
    // deliberately empty and report `needsInput`.
    case "collection":
      return { collectionIds: [], mode: anyOf };
    case "storeTags":
      return { tags: [], mode: anyOf };
    case "genres":
      return { genres: [], mode: anyOf };
    case "friendsOwn":
      return { steamIds: [], mode: anyOf };
    case "developer":
    case "publisher":
      return { names: [] };
    case "installFolder":
      return { paths: [] };
    case "protonTier":
      return { tiers: [] };
    case "whitelist":
    case "blacklist":
      return { appIds: [] };

    // Flags — nothing to configure.
    default:
      return {};
  }
}

/** A new rule of this kind, ready to insert. */
export function defaultRule(args: { kind: RuleKind; id: string; now: number }): Rule {
  const { kind, id, now } = args;
  return { id, kind, ...defaultParams(kind, now) } as Rule;
}

/**
 * A candidate for the palette: the rule that would be added, plus whether it
 * can be priced yet.
 *
 * `needsInput` is derived from `isRuleComplete` rather than hardcoded, so a
 * kind whose defaults change cannot fall out of step with how the palette
 * presents it.
 */
export interface RuleCandidate {
  kind: Exclude<RuleKind, "group">;
  label: string;
  description: string;
  category: ReturnType<typeof ruleDef>["category"];
  rule: Rule;
  /** True when the defaults leave the rule unable to assert anything. */
  needsInput: boolean;
}

export function ruleCandidate(args: {
  kind: Exclude<RuleKind, "group">;
  id: string;
  now: number;
}): RuleCandidate {
  const { kind, id, now } = args;
  const def = ruleDef(kind);
  const rule = defaultRule({ kind, id, now });
  return {
    kind,
    label: def.label,
    description: def.description,
    category: def.category,
    rule,
    needsInput: !isRuleComplete(rule),
  };
}
