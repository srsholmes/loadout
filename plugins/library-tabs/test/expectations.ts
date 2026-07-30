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

/** Everything below is fixed by the same piece of work. */
const APPSTORE_PROVIDER = "the appstore CDP provider (Phase 2)";
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
  installed: {
    verdict: "known-broken",
    because:
      "adapt.ts hardcodes installed:true — game-library only scans appmanifest " +
      "files, so an uninstalled game is not merely marked uninstalled, it is absent",
    fixedBy: APPSTORE_PROVIDER,
    sunset: SUNSET,
  },
  owned: {
    verdict: "known-broken",
    because:
      "adapt.ts hardcodes owned:true. Measured on device: 2346 owned vs 60 " +
      "installed, so ~2280 owned games are invisible to the plugin entirely",
    fixedBy: APPSTORE_PROVIDER,
    sunset: SUNSET,
  },
  lastPlayed: {
    verdict: "known-broken",
    because:
      "AdaptOptions.lastPlayed has no producer — backend.getSnapshot never " +
      "passes it, so every record is -1. This is why the Recently played and " +
      "Never played builtins are permanently empty",
    fixedBy: APPSTORE_PROVIDER,
    sunset: SUNSET,
  },
  // Conditional, but real: populated only when the `playtime` plugin is
  // reachable, which covered 2.5% of the captured corpus. The floor is set to
  // that rather than the default 2%, so a capture taken with the plugin
  // disabled fails loudly instead of quietly passing on nothing.
  playtime: { verdict: "discriminating", minSide: 0.02 },
  deckCompat: {
    verdict: "known-broken",
    because: 'adapt.ts hardcodes "unknown" for every game',
    fixedBy: APPSTORE_PROVIDER,
    sunset: SUNSET,
  },
  steamOsCompat: {
    verdict: "known-broken",
    because: 'adapt.ts hardcodes "unknown" for every game',
    fixedBy: APPSTORE_PROVIDER,
    sunset: SUNSET,
  },
  reviewScore: {
    verdict: "known-broken",
    because: "adapt.ts hardcodes -1",
    fixedBy: APPSTORE_PROVIDER,
    sunset: SUNSET,
  },
  metacritic: {
    verdict: "known-broken",
    because: "adapt.ts hardcodes -1; needs the appinfo provider (Phase 3)",
    fixedBy: "the appinfo provider (Phase 3)",
    sunset: SUNSET,
  },
  releaseDate: {
    verdict: "known-broken",
    because: "adapt.ts hardcodes -1; use GetCanonicalReleaseDate() over either rt_* field",
    fixedBy: APPSTORE_PROVIDER,
    sunset: SUNSET,
  },
  purchaseDate: {
    verdict: "known-broken",
    because: "adapt.ts hardcodes -1",
    fixedBy: APPSTORE_PROVIDER,
    sunset: SUNSET,
  },
  storeTags: {
    verdict: "known-broken",
    because:
      "adapt.ts hardcodes []. Steam returns numeric tag ids, so the provider " +
      "also needs GetLocalizationForStoreTag to make them nameable",
    fixedBy: APPSTORE_PROVIDER,
    sunset: SUNSET,
  },
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
    verdict: "known-broken",
    because: "adapt.ts hardcodes false; BIsUnreleased() is available on the overview",
    fixedBy: APPSTORE_PROVIDER,
    sunset: SUNSET,
  },
  familyShared: {
    verdict: "known-broken",
    because: "adapt.ts hardcodes false; BIsBorrowed() is available on the overview",
    fixedBy: APPSTORE_PROVIDER,
    sunset: SUNSET,
  },
  streamable: {
    verdict: "known-broken",
    because: "adapt.ts hardcodes false; per_client_data carries other-client install state",
    fixedBy: APPSTORE_PROVIDER,
    sunset: SUNSET,
  },
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
  recent: {
    verdict: "empty-until",
    blockedBy: "lastPlayed",
    because: "lastPlayed is -1 for every record, so no game can be recently played",
  },
  "never-played": {
    verdict: "empty-until",
    blockedBy: "lastPlayed",
    because:
      "neverPlayedOnly needs lastPlayed === 0 (provably never); every record is " +
      "-1 (unknown), which correctly does not match",
  },

  // Templates
  blank: { verdict: "non-empty", minGames: 1 },
  "space-hogs": { verdict: "non-empty", minGames: 1 },
  emulation: { verdict: "non-empty", minGames: 1 },
  backlog: {
    verdict: "empty-until",
    blockedBy: "lastPlayed",
    because: "same lastPlayed gap as never-played",
  },
  "pick-up-again": {
    verdict: "empty-until",
    blockedBy: "lastPlayed",
    because: "needs both lastPlayed and playtime",
  },
  "deck-verified": {
    verdict: "empty-until",
    blockedBy: "deckCompat",
    because: 'deckCompat is "unknown" for every record',
  },
  "recently-added": {
    verdict: "empty-until",
    blockedBy: "purchasedAt",
    because: "purchasedAt is -1 for every record",
  },
  "hidden-gems": {
    verdict: "empty-until",
    blockedBy: "reviewPercentage",
    because: "reviewPercentage is -1 for every record",
  },
  "couch-coop": {
    verdict: "empty-until",
    blockedBy: "features",
    because: "every feature flag is false",
  },
  declutter: {
    verdict: "matches-everything",
    blockedBy: "kind",
    because:
      'adapt.ts only ever produces kind "game" or "shortcut", so a tab that ' +
      "excludes demos, soundtracks, tools, videos and DLC excludes nothing. It " +
      "shows the whole library and looks like it is working",
  },
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
