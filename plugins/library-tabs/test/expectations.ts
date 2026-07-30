/**
 * What every rule and every tab is expected to do against a real library — and,
 * where it currently does nothing, an admission with an expiry date.
 *
 * **This table is a ratchet.** `known-broken` asserts a rule is *still*
 * degenerate. The day a provider fixes it, the test goes red and whoever fixed
 * it must delete the entry. Entries can only ever shrink, and the list of them
 * is a machine-checked TODO for the metadata work.
 *
 * The distinction that matters:
 *
 * - `constant` and `blocked` are **legitimate**. A library where nothing is
 *   family-shared genuinely has a constant rule; a fact with no resolver
 *   genuinely cannot be evaluated. Both are fine *provided the UI says so*.
 * - `known-broken` is **not** legitimate. It means we ship a rule the user can
 *   pick that cannot work, and we have not yet fixed it.
 *
 * The `satisfies` clause at the bottom makes adding a 33rd rule kind a compile
 * error until its expectation is declared.
 */

import type { MetadataProviderId } from "@loadout/types";
import type { FactKey, RuleKind } from "../lib/types";

export type Expectation =
  /**
   * The healthy case: the rule splits the library. `indeterminate` must be zero
   * and both sides must be at least `minSide` of the corpus — so "1 game out of
   * 2001" does not count as discriminating.
   */
  | { verdict: "discriminating"; minSide?: number }
  /** Provably constant on this corpus, and that is a true fact about it. */
  | { verdict: "constant"; value: boolean; because: string }
  /** The data source cannot answer at all, and the UI must be able to say so. */
  | { verdict: "blocked"; source: MetadataProviderId | FactKey; because: string }
  /** Broken today. Asserted to still be broken, so a fix forces this entry out. */
  | {
      verdict: "known-broken";
      because: string;
      /** What has to land for this to go green. */
      fixedBy: string;
      /** ISO date; a `known-broken` past its sunset fails outright. */
      sunset: string;
    };

/** Default floor for `discriminating` — 2% of the library on each side. */
export const DEFAULT_MIN_SIDE = 0.02;

/**
 * Every remaining `known-broken` entry is waiting on the same thing: the
 * appinfo provider (Phase 3), which reads `appcache/appinfo.vdf`. The appstore
 * provider has landed and its entries are gone.
 */
const SUNSET = "2027-01-31";

export const RULE_EXPECTATIONS = {
  // ── Working today ───────────────────────────────────────────────────
  source: { verdict: "discriminating" },
  collection: { verdict: "discriminating" },
  title: { verdict: "discriminating" },
  sizeOnDisk: { verdict: "discriminating", minSide: 0.01 },
  whitelist: { verdict: "discriminating", minSide: 0 },
  blacklist: { verdict: "discriminating", minSide: 0 },
  appKind: { verdict: "discriminating" },

  // ── Degenerate: adapt.ts hardcodes the field ────────────────────────
  installed: { verdict: "discriminating", minSide: 0.02 },
  // Everything in your Steam library collections is by definition owned, so a
  // constant `true` is the truth here rather than a gap. It would discriminate
  // on an account with family-shared or delisted entries.
  owned: {
    verdict: "constant",
    value: true,
    because: "every app reachable through collectionStore is owned by this account",
  },
  lastPlayed: { verdict: "discriminating", minSide: 0.02 },
  // Conditional, but real: populated only when the `playtime` plugin is
  // reachable, which covered 2.5% of the captured corpus. The floor is set to
  // that rather than the default 2%, so a capture taken with the plugin
  // disabled fails loudly instead of quietly passing on nothing.
  playtime: { verdict: "discriminating", minSide: 0.02 },
  deckCompat: { verdict: "discriminating", minSide: 0.02 },
  steamOsCompat: { verdict: "discriminating", minSide: 0.02 },
  reviewScore: { verdict: "discriminating", minSide: 0.02 },
  metacritic: { verdict: "discriminating", minSide: 0.02 },
  releaseDate: { verdict: "discriminating", minSide: 0.02 },
  purchaseDate: { verdict: "discriminating", minSide: 0.02 },
  storeTags: { verdict: "discriminating", minSide: 0.02 },
  genres: {
    verdict: "known-broken",
    because: "adapt.ts hardcodes []",
    fixedBy: "the appinfo provider (Phase 3)",
    sunset: SUNSET,
  },
  developer: {
    verdict: "known-broken",
    because: "adapt.ts hardcodes []",
    fixedBy: "the appinfo provider (Phase 3)",
    sunset: SUNSET,
  },
  publisher: {
    verdict: "known-broken",
    because: "adapt.ts hardcodes []",
    fixedBy: "the appinfo provider (Phase 3)",
    sunset: SUNSET,
  },
  feature: {
    verdict: "known-broken",
    because: "adapt.ts hardcodes emptyFeatures() — all twelve flags false",
    fixedBy: "the appinfo provider (Phase 3)",
    sunset: SUNSET,
  },
  comingSoon: {
    verdict: "constant",
    value: false,
    because: "BIsUnreleased() is false for every app in this library — nothing pre-release",
  },
  familyShared: {
    verdict: "constant",
    value: false,
    because: "BIsBorrowed() is false for every app — nothing shared from a Steam Family",
  },
  streamable: { verdict: "discriminating" },
  installFolder: {
    verdict: "known-broken",
    because:
      "adapt.ts hardcodes installPath:null, so the predicate returns a definite " +
      "false for every game. Worse, installPath is in no provider's ownsFields, " +
      "so nothing disables or annotates the rule",
    fixedBy: "the manifest provider recording the library path",
    sunset: SUNSET,
  },

  // ── Fact-backed, no resolver registered ─────────────────────────────
  achievements: {
    verdict: "blocked",
    source: "achievements",
    because: "no resolver; buildEvalGames is called with an empty facts bag",
  },
  hltbMain: {
    verdict: "blocked",
    source: "hltbMain",
    because: "needs a cross-plugin call to the How Long To Beat plugin (Phase 5)",
  },
  protonTier: {
    verdict: "blocked",
    source: "protonTier",
    because: "needs a cross-plugin call to the ProtonDB Badges plugin (Phase 5)",
  },
  onSdCard: {
    verdict: "blocked",
    source: "onSdCard",
    because: "derived from installPath, which no provider supplies",
  },
  friendsPlaying: {
    verdict: "blocked",
    source: "friendsPlaying",
    because: "needs Steam friends data (Phase 5)",
  },
  friendsOwn: {
    verdict: "blocked",
    source: "friendsOwn",
    because: "needs Steam friends data (Phase 5)",
  },
} satisfies Record<Exclude<RuleKind, "group">, Expectation>;

// ── Tabs ───────────────────────────────────────────────────────────────

export type TabExpectation =
  | { verdict: "non-empty"; minGames: number }
  /** Empty because a data source is missing. Must also declare `needs`. */
  | { verdict: "empty-until"; blockedBy: string; because: string }
  /** Empty and that is a true statement about this library. */
  | { verdict: "legitimately-empty"; because: string }
  /**
   * Degenerate the *other* way: it matches the entire library, so it filters
   * nothing. An excluding tab whose excluded values never occur looks like it
   * works — it shows games — while doing no work at all, which is why counting
   * "is it non-empty" would miss it entirely.
   */
  | { verdict: "matches-everything"; blockedBy: string; because: string };

export const TAB_EXPECTATIONS: Record<string, TabExpectation> = {
  // Builtins
  all: { verdict: "non-empty", minGames: 1 },
  installed: { verdict: "non-empty", minGames: 1 },
  "non-steam": { verdict: "non-empty", minGames: 1 },
  recent: { verdict: "non-empty", minGames: 1 },
  "never-played": { verdict: "non-empty", minGames: 1 },

  // Templates
  blank: { verdict: "non-empty", minGames: 1 },
  "space-hogs": { verdict: "non-empty", minGames: 1 },
  emulation: { verdict: "non-empty", minGames: 1 },
  backlog: { verdict: "non-empty", minGames: 1 },
  "pick-up-again": { verdict: "non-empty", minGames: 1 },
  "deck-verified": { verdict: "non-empty", minGames: 1 },
  "recently-added": {
    verdict: "legitimately-empty",
    because:
      "purchasedAt is populated for 13% of the corpus, but the suite pins a " +
      "fixed clock and no purchase falls inside its last-30-days window",
  },
  "hidden-gems": { verdict: "non-empty", minGames: 1 },
  "couch-coop": {
    verdict: "empty-until",
    blockedBy: "features",
    because: "every feature flag is false",
  },
  declutter: { verdict: "non-empty", minGames: 1 },
  "short-games": {
    verdict: "empty-until",
    blockedBy: "hltbMain",
    because: "fact-backed with no resolver",
  },
  "friends-playing": {
    verdict: "empty-until",
    blockedBy: "friendsPlaying",
    because: "fact-backed with no resolver",
  },
};
