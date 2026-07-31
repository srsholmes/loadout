/**
 * Rules → plain English.
 *
 * Every rule row in the builder shows a sentence, not a form. TabMaster
 * shows `FilterPreview` lines built from raw parameter values — "Release
 * Date: above 1420070400" — which is readable only if you already know what
 * you set. The difference matters most in the two places people actually
 * look: scanning a tab you built six months ago, and reading the diagnostic
 * that tells you which rule emptied it.
 *
 * Rules for output here:
 * - No trailing full stops. These are labels, not prose.
 * - Never emit `undefined`, `NaN` or `[object Object]`, even for a
 *   half-built rule — an incomplete rule reads as a prompt ("Title
 *   contains…") rather than as broken text.
 * - Units are chosen for the magnitude: 90 minutes reads "1.5 hours",
 *   500 MB reads "500 MB" not "0.49 GB".
 *
 * Isomorphic: pure, no I/O.
 */

import type { DeckCompat, GameFeatures, SteamOsCompat } from "@loadout/types";
import type {
  NumericRange,
  Rule,
  SetMode,
  SortSpec,
  ManagedCollection,
} from "./types";
import { ruleDef } from "./rules";

// ── Value formatters ───────────────────────────────────────────────────

/** Bytes → "70 GB" / "500 MB" / "1.5 GB". */
export function formatBytes(bytes: number): string {
  if (bytes < 0) return "unknown";
  const mb = bytes / 1024 ** 2;
  if (mb < 1024) return `${Math.round(mb)} MB`;
  const gb = mb / 1024;
  // One decimal only where it carries information.
  return `${gb % 1 === 0 ? gb : gb.toFixed(1)} GB`;
}

/** Minutes → "45 minutes" / "1.5 hours" / "200 hours". */
export function formatMinutes(minutes: number): string {
  if (minutes < 0) return "unknown";
  if (minutes < 60) return `${Math.round(minutes)} minute${minutes === 1 ? "" : "s"}`;
  const hours = minutes / 60;
  const rounded = hours % 1 === 0 ? hours : Number(hours.toFixed(1));
  return `${rounded} hour${rounded === 1 ? "" : "s"}`;
}

/** Epoch seconds → "19 Apr 2011". Locale-independent for stable specs. */
export function formatDate(epochSec: number): string {
  if (epochSec < 0) return "unknown";
  const d = new Date(epochSec * 1000);
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Render a range as a phrase, given a value formatter.
 * `{min: 60}` → "60 minutes or more"; `{min: 1, max: 5}` → "between 1 and 5".
 */
function rangePhrase(
  range: NumericRange,
  format: (n: number) => string,
): string {
  const hasMin = range.min !== undefined;
  const hasMax = range.max !== undefined;
  let phrase: string;
  if (hasMin && hasMax) {
    phrase = `between ${format(range.min!)} and ${format(range.max!)}`;
  } else if (hasMin) {
    phrase = `${format(range.min!)} or more`;
  } else if (hasMax) {
    phrase = `${format(range.max!)} or less`;
  } else {
    // A range with no bounds is a rule the user hasn't finished.
    return "any amount";
  }
  return range.includeUnknown === true ? `${phrase} (or unknown)` : phrase;
}

/** Join a list the way a person would: "A, B and C". */
export function joinList(items: readonly string[], conjunction = "or"): string {
  if (items.length === 0) return "nothing";
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items.at(-1)}`;
}

/** `anyOf`/`allOf` → the conjunction that reads correctly for it. */
function modeConjunction(mode: SetMode): string {
  return mode === "allOf" ? "and" : "or";
}

const DECK_COMPAT_LABEL: Record<DeckCompat, string> = {
  unknown: "Unknown",
  unsupported: "Unsupported",
  playable: "Playable",
  verified: "Verified",
};

const STEAMOS_COMPAT_LABEL: Record<SteamOsCompat, string> = {
  unknown: "Unknown",
  unsupported: "Unsupported",
  compatible: "Compatible",
};

const FEATURE_LABEL: Record<keyof GameFeatures, string> = {
  singlePlayer: "single-player",
  multiPlayer: "multiplayer",
  coop: "co-op",
  cloudSaves: "Steam Cloud",
  achievements: "achievements",
  tradingCards: "trading cards",
  workshop: "Steam Workshop",
  fullControllerSupport: "full controller support",
  partialControllerSupport: "partial controller support",
  remotePlayTogether: "Remote Play Together",
  vr: "VR",
  hdr: "HDR",
};

/** Human label for a feature key, falling back to the key itself. */
export function featureLabel(key: keyof GameFeatures): string {
  return FEATURE_LABEL[key] ?? key;
}

// ── Rule summaries ─────────────────────────────────────────────────────

/**
 * The body of a rule's sentence, without inversion applied.
 * Split out so `summarizeRule` can negate the whole phrase coherently.
 */
function ruleBody(rule: Rule): string {
  switch (rule.kind) {
    case "group": {
      if (rule.children.length === 0) return "an empty group";
      const joiner = rule.combinator === "all" ? "and" : "or";
      const parts = rule.children.map((c) => summarizeRule(c));
      return `(${parts.join(` ${joiner} `)})`;
    }

    case "installed":
      return "is installed";
    case "owned":
      return "is in your library";
    case "comingSoon":
      return "is coming soon";
    case "familyShared":
      return "is shared by a family member";
    case "streamable":
      return "can be streamed from another PC";
    case "onSdCard":
      return "is on an SD card";

    case "source": {
      const labels = rule.sources.map((s) =>
        s === "shortcut" ? "a non-Steam shortcut" : "a Steam game",
      );
      return rule.sources.length === 0
        ? "is from any store…"
        : `is ${joinList(labels)}`;
    }

    case "appKind":
      return rule.kinds.length === 0
        ? "is any type…"
        : `is a ${joinList(rule.kinds)}`;

    case "collection":
      return rule.collectionIds.length === 0
        ? "is in a collection…"
        : `is in ${joinList(rule.collectionIds, modeConjunction(rule.mode))}`;

    case "title": {
      if (rule.value.trim().length === 0) {
        return `title ${rule.match === "regex" ? "matches" : rule.match === "startsWith" ? "starts with" : "contains"}…`;
      }
      const verb =
        rule.match === "regex"
          ? "matches"
          : rule.match === "startsWith"
            ? "starts with"
            : "contains";
      const suffix = rule.caseSensitive === true ? " (case-sensitive)" : "";
      return `title ${verb} "${rule.value}"${suffix}`;
    }

    case "playtime":
      return `played for ${rangePhrase(rule.minutes, formatMinutes)}`;
    case "lastPlayed":
      if (rule.neverPlayedOnly === true) return "has never been played";
      return `last played ${rangePhrase(rule.epochSec, formatDate)}`;
    case "releaseDate":
      return `released ${rangePhrase(rule.epochSec, formatDate)}`;
    case "purchaseDate":
      return `added to your library ${rangePhrase(rule.epochSec, formatDate)}`;
    case "sizeOnDisk":
      return `takes up ${rangePhrase(rule.bytes, formatBytes)}`;
    case "reviewScore":
      return `Steam reviews ${rangePhrase(rule.percent, (n) => `${n}%`)}`;
    case "metacritic":
      return `Metacritic ${rangePhrase(rule.score, (n) => String(n))}`;
    case "achievements":
      return `achievements ${rangePhrase(rule.percent, (n) => `${n}%`)} complete`;
    case "hltbMain":
      return `takes ${rangePhrase(rule.hours, (n) => `${n} hour${n === 1 ? "" : "s"}`)} to beat`;

    case "deckCompat":
      return rule.categories.length === 0
        ? "has a Deck rating of…"
        : `is Deck ${joinList(rule.categories.map((c) => DECK_COMPAT_LABEL[c]))}`;
    case "steamOsCompat":
      return rule.categories.length === 0
        ? "has a SteamOS rating of…"
        : `is SteamOS ${joinList(rule.categories.map((c) => STEAMOS_COMPAT_LABEL[c]))}`;
    case "protonTier":
      return rule.tiers.length === 0
        ? "has a ProtonDB rating of…"
        : `is ProtonDB ${joinList(rule.tiers)}`;

    case "storeTags":
      return rule.tags.length === 0
        ? "is tagged…"
        : `is tagged ${joinList(rule.tags, modeConjunction(rule.mode))}`;
    case "genres":
      return rule.genres.length === 0
        ? "is in a genre…"
        : `is ${joinList(rule.genres, modeConjunction(rule.mode))}`;
    case "developer":
      return rule.names.length === 0
        ? "is by a developer…"
        : `is by ${joinList(rule.names)}`;
    case "publisher":
      return rule.names.length === 0
        ? "is published by…"
        : `is published by ${joinList(rule.names)}`;
    case "feature":
      return rule.features.length === 0
        ? "supports a feature…"
        : `supports ${joinList(rule.features.map(featureLabel), modeConjunction(rule.mode))}`;

    case "installFolder":
      return rule.paths.length === 0
        ? "is installed in…"
        : `is installed in ${joinList(rule.paths)}`;

    case "friendsPlaying":
      return rule.minCount <= 1
        ? "has a friend playing right now"
        : `has ${rule.minCount} or more friends playing right now`;
    case "friendsOwn":
      // The mode is the whole meaning — `.some` versus `.every` — and every
      // other set rule renders it. Dropping it made "any of these two friends"
      // and "both of these friends" read identically.
      return rule.steamIds.length === 0
        ? "is owned by a friend…"
        : rule.steamIds.length === 1
          ? "is owned by 1 specific friend"
          : `is owned by ${rule.mode === "allOf" ? "all" : "any"} of ${rule.steamIds.length} specific friends`;

    case "whitelist":
      return rule.appIds.length === 0
        ? "is one of these games…"
        : `is one of ${rule.appIds.length} chosen game${rule.appIds.length === 1 ? "" : "s"}`;
    case "blacklist":
      return rule.appIds.length === 0
        ? "is not one of these games…"
        : `is not one of ${rule.appIds.length} excluded game${rule.appIds.length === 1 ? "" : "s"}`;
  }
}

/**
 * Third-person → infinitive, for the `title` rule's verbs. Longest-first
 * iteration isn't needed since none of these is a prefix of another.
 */
const TITLE_VERB_INFINITIVE: Record<string, string> = {
  contains: "contain",
  "starts with": "start with",
  matches: "match",
};

/**
 * One line describing a rule, with inversion folded into the wording rather
 * than tacked on as "(inverted)".
 *
 * TabMaster appends "(inverted)" to its preview lines, which forces the
 * reader to mentally negate a sentence they just parsed — and leaves a
 * stale `inverted: true` invisible when you switch a rule's type (its issue
 * #277). Negating in the phrasing keeps the row readable at a glance.
 */
export function summarizeRule(rule: Rule): string {
  const body = ruleBody(rule);
  const inverted = "invert" in rule && rule.invert === true;
  if (!inverted) return body;

  // Prefer a natural negation where the phrasing allows one. Note that
  // "does not" takes the infinitive, so a third-person verb has to be
  // de-conjugated — otherwise we emit "title does not contains".
  if (body.startsWith("is not ")) return body.replace("is not ", "is ");
  if (body.startsWith("is ")) return `is not ${body.slice(3)}`;
  if (body.startsWith("has ")) return `does not have ${body.slice(4)}`;
  if (body.startsWith("can ")) return `cannot ${body.slice(4)}`;
  if (body.startsWith("takes ")) return `does not take ${body.slice(6)}`;
  if (body.startsWith("supports ")) return `does not support ${body.slice(9)}`;
  if (body.startsWith("title ")) {
    const rest = body.slice("title ".length);
    for (const [third, infinitive] of Object.entries(TITLE_VERB_INFINITIVE)) {
      if (rest.startsWith(third)) {
        return `title does not ${infinitive}${rest.slice(third.length)}`;
      }
    }
    return `title does not ${rest}`;
  }
  return `NOT ${body}`;
}

/** Short label for a rule row's leading chip — the registry's own label. */
export function ruleLabel(rule: Rule): string {
  return rule.kind === "group" ? "Group" : ruleDef(rule.kind).label;
}

// ── ManagedCollection summaries ──────────────────────────────────────────────────────

const SORT_FIELD_LABEL: Record<SortSpec["field"], string> = {
  sortAs: "name",
  name: "name",
  lastPlayed: "last played",
  playtimeMinutes: "time played",
  sizeOnDisk: "size",
  releaseDate: "release date",
  reviewPercentage: "review score",
  deckCompat: "Deck rating",
  random: "random",
  manual: "your order",
};

export function summarizeSort(specs: readonly SortSpec[]): string {
  if (specs.length === 0) return "unsorted";
  return specs
    .map((s) => {
      const label = SORT_FIELD_LABEL[s.field];
      if (s.field === "random" || s.field === "manual") return label;
      return `${label} ${s.dir === "asc" ? "ascending" : "descending"}`;
    })
    .join(", then ");
}

/**
 * A whole collection as one sentence, for the grid and the detail header.
 * e.g. `Show a game when (is installed and has never been played), sorted
 * by name ascending, first 30`.
 */
export function summarizeCollection(tab: ManagedCollection): string {
  const parts: string[] = [];

  const root = tab.root;
  if (root.children.length === 0) {
    parts.push("Show every game");
  } else {
    const joiner = root.combinator === "all" ? "and" : "or";
    const body = root.children.map(summarizeRule).join(` ${joiner} `);
    parts.push(
      root.invert === true
        ? `Show a game unless ${body}`
        : `Show a game when ${body}`,
    );
  }

  parts.push(`sorted by ${summarizeSort(tab.sort)}`);
  if (tab.limit !== null) parts.push(`first ${tab.limit}`);

  return parts.join(", ");
}
