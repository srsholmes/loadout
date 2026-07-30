/**
 * A representative rule of each kind, derived from the corpus rather than
 * hand-picked.
 *
 * Hand-picking breaks immediately: a probe hardcoded to `storeTag = "Roguelike"`
 * fails on a library that has no roguelikes, and the failure looks like a bug in
 * the rule engine rather than in the probe. Deriving from the corpus — the most
 * common tag, the median release date — means the same probe works on anyone's
 * library.
 *
 * Using the **median** for numeric kinds is what upgrades the non-degeneracy
 * assertion from a weak `passed > 0` to a real one: a median split should put
 * roughly half the library on each side, so a rule that manages 1 match out of
 * 2000 is caught by the `minSide` floor.
 */

import type { Corpus } from "./corpus-loader";
import type { Rule, RuleKind } from "../lib/types";

/** Placeholder for a numeric probe whose field has no populated values. */
const NO_DATA = 0;

function split(corpus: Corpus, field: Parameters<Corpus["splitPoint"]>[0]): number {
  return corpus.splitPoint(field) ?? NO_DATA;
}

function top(corpus: Corpus, field: Parameters<Corpus["topValue"]>[0]): string[] {
  const value = corpus.topValue(field);
  return value === null ? ["__no_value_in_corpus__"] : [value];
}

/**
 * Build a probe rule for a kind. `id` is fixed so trace lookups are predictable.
 *
 * Every branch produces a *complete* rule — `isRuleComplete` must be true — or
 * the evaluator returns `indeterminate` for being half-built and the test would
 * blame the data instead of the probe.
 */
export function probeFor(kind: Exclude<RuleKind, "group">, corpus: Corpus): Rule {
  const id = `probe-${kind}`;

  switch (kind) {
    // Flags — nothing to parameterise.
    case "installed":
    case "owned":
    case "comingSoon":
    case "familyShared":
    case "streamable":
    case "onSdCard":
      return { id, kind };

    case "source":
      return { id, kind, sources: ["steam"] };
    case "appKind":
      return { id, kind, kinds: ["game"] };
    case "collection":
      return { id, kind, collectionIds: top(corpus, "collections"), mode: "anyOf" };

    // "a" appears in the overwhelming majority of titles, so this splits on
    // something real rather than on an arbitrary franchise.
    case "title":
      return { id, kind, match: "contains", value: "a", caseSensitive: false };

    case "playtime":
      return { id, kind, minutes: { min: split(corpus, "playtimeMinutes") } };
    case "sizeOnDisk":
      return { id, kind, bytes: { min: split(corpus, "sizeOnDisk") } };
    case "lastPlayed":
      return { id, kind, epochSec: { min: split(corpus, "lastPlayed") } };
    case "releaseDate":
      return { id, kind, epochSec: { min: split(corpus, "releaseDate") } };
    case "purchaseDate":
      return { id, kind, epochSec: { min: split(corpus, "purchasedAt") } };
    case "reviewScore":
      return { id, kind, percent: { min: split(corpus, "reviewPercentage") } };
    case "metacritic":
      return { id, kind, score: { min: split(corpus, "metacritic") } };

    case "storeTags":
      return { id, kind, tags: top(corpus, "storeTags"), mode: "anyOf" };
    case "genres":
      return { id, kind, genres: top(corpus, "genres"), mode: "anyOf" };
    case "developer":
      return { id, kind, names: top(corpus, "developers") };
    case "publisher":
      return { id, kind, names: top(corpus, "publishers") };
    case "feature":
      return { id, kind, features: ["fullControllerSupport"], mode: "anyOf" };

    case "deckCompat":
      return { id, kind, categories: ["verified"] };
    case "steamOsCompat":
      return { id, kind, categories: ["compatible"] };
    case "protonTier":
      return { id, kind, tiers: ["gold"] };

    case "installFolder":
      return { id, kind, paths: ["/home/deck/.local/share/Steam"] };

    case "achievements":
      return { id, kind, percent: { min: 50 } };
    case "hltbMain":
      return { id, kind, hours: { max: 10 } };
    case "friendsPlaying":
      return { id, kind, minCount: 1 };
    case "friendsOwn":
      return { id, kind, steamIds: ["76561197960287930"], mode: "anyOf" };

    // Membership rules can only ever match what they name, so a half-corpus
    // slice is the honest probe — hence their `minSide: 0` expectation.
    case "whitelist":
    case "blacklist":
      return {
        id,
        kind,
        appIds: corpus.games.slice(0, Math.max(1, Math.floor(corpus.size / 2))).map((g) => g.appId),
      };
  }
}
