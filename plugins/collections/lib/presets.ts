/**
 * Preset collections — one-tap starting points.
 *
 * The gallery exists for two reasons, and the second is the load-bearing one:
 *
 * 1. An empty rule tree matches the whole library, so "New" on its own hands
 *    you a collection of everything and leaves the interesting part as
 *    homework. A preset is the difference between a builder and a result.
 * 2. **Typing on a handheld is expensive.** Naming a collection means opening
 *    the on-screen keyboard and picking out letters with a thumbstick. Every
 *    preset arrives named, so the whole flow is two presses.
 *
 * Each preset declares the metadata it reads. A preset whose data is missing
 * matches nothing, and a collection that is silently empty reads as a broken
 * plugin rather than as absent data — so the gallery greys it out and says
 * which source is missing instead of offering it.
 *
 * Measured against a real 2501-game library before choosing which to ship:
 * play history and Deck compatibility cover everything, size covers 2084,
 * review scores 420, Metacritic 230, store tags 412 — while genres, app kind
 * and streamability came back empty on this device, so nothing here depends on
 * them. `hltbMain` is the one exception: it needs the HowLongToBeat plugin, is
 * declared as such, and greys out honestly when that is off.
 *
 * Isomorphic: pure, no I/O.
 */

import type { FactKey, GroupRule, ManagedCollection, Rule, SortSpec } from "./types";

/** Deterministic rule ids, so a preset builds the same tree every time. */
function rid(id: string, n: number): string {
  return `${id}-r${n}`;
}

const BY_NAME: SortSpec[] = [{ field: "sortAs", dir: "asc" }];
const RECENT_FIRST: SortSpec[] = [{ field: "lastPlayed", dir: "desc" }];
const BIGGEST_FIRST: SortSpec[] = [{ field: "sizeOnDisk", dir: "desc" }];
const BEST_FIRST: SortSpec[] = [{ field: "reviewPercentage", dir: "desc" }];

const DAY = 86_400;

export interface CollectionPreset {
  /** Stable key — also the seed for the collection's id. */
  id: string;
  /** The collection's name, and what Steam will show. */
  label: string;
  /** One line under the label in the gallery. */
  description: string;
  /**
   * Metadata this preset reads. Anything listed here that the library cannot
   * answer greys the preset out, rather than handing over a collection that
   * can only ever be empty.
   */
  needs: MetadataNeed[];
  build: (id: string) => ManagedCollection;
}

/**
 * What a preset depends on, in terms a user can act on.
 *
 * Deliberately coarser than {@link FactKey}: `playHistory` covers both
 * playtime and last-played because they arrive from the same source, and
 * telling someone "playtime is available but last-played isn't" describes our
 * plumbing rather than their library.
 */
export type MetadataNeed =
  | "playHistory"
  | "sizeOnDisk"
  | "reviewScore"
  | "metacritic"
  | "deckCompat"
  | "purchaseDate"
  | "storeTags"
  | "hltb";

/** What each need is called when a preset has to explain itself. */
export const NEED_LABELS: Record<MetadataNeed, string> = {
  playHistory: "play history",
  sizeOnDisk: "install sizes",
  reviewScore: "Steam review scores",
  metacritic: "Metacritic scores",
  deckCompat: "Deck compatibility",
  purchaseDate: "purchase dates",
  storeTags: "store tags",
  hltb: "HowLongToBeat times",
};

function make(
  id: string,
  label: string,
  children: Rule[],
  overrides: Partial<ManagedCollection> = {},
): ManagedCollection {
  const root: GroupRule = { id: `${id}-root`, kind: "group", combinator: "all", children };
  return {
    id,
    label,
    root,
    sort: BY_NAME,
    limit: null,
    display: { tileWidth: 150, showLabels: true, badges: [] },
    indeterminatePolicy: "pass",
    ...overrides,
  };
}

/**
 * The gallery, in the order it is shown.
 *
 * Ordered by how often the collection is the answer to "what should I play?"
 * rather than alphabetically: the play-history ones lead because they are the
 * ones a library this size actually needs, and the housekeeping ones (size,
 * store) come last.
 *
 * `now` is a parameter rather than a clock read, so a preset builds the same
 * tree in a spec as on a device. Relative dates are resolved to an absolute
 * bound at creation time and are editable afterwards — a collection called
 * "played this month" that silently re-scopes itself every month is a
 * different collection each time you look at it.
 */
export function presets(now: number = Math.floor(Date.now() / 1000)): CollectionPreset[] {
  return [
    {
      id: "recently-played",
      label: "Recently played",
      description: "Anything you've had open in the last month",
      needs: ["playHistory"],
      build: (id) =>
        make(id, "Recently played", [
          { id: rid(id, 1), kind: "lastPlayed", epochSec: { min: now - 30 * DAY } },
        ], { sort: RECENT_FIRST }),
    },
    {
      id: "dive-back-in",
      label: "Dive back in",
      description: "You put real hours in, but not for three months",
      needs: ["playHistory"],
      build: (id) =>
        make(id, "Dive back in", [
          { id: rid(id, 1), kind: "playtime", minutes: { min: 60 } },
          { id: rid(id, 2), kind: "lastPlayed", epochSec: { min: 1, max: now - 90 * DAY } },
        ], { sort: RECENT_FIRST }),
    },
    {
      id: "barely-started",
      label: "Barely started",
      description: "Opened once, 20 minutes or less — did they deserve longer?",
      needs: ["playHistory"],
      build: (id) =>
        // `min: 1` matters: without it every never-played game qualifies, and
        // the collection stops being about games you gave up on.
        make(id, "Barely started", [
          { id: rid(id, 1), kind: "playtime", minutes: { min: 1, max: 20 } },
        ], { sort: RECENT_FIRST }),
    },
    {
      id: "backlog",
      label: "Installed but unplayed",
      description: "Taking up space and waiting on you — your actual backlog",
      needs: ["playHistory"],
      build: (id) =>
        make(id, "Backlog", [
          { id: rid(id, 1), kind: "installed" },
          { id: rid(id, 2), kind: "lastPlayed", epochSec: {}, neverPlayedOnly: true },
        ]),
    },
    {
      id: "never-played",
      label: "Never played",
      description: "Everything you own and have never once started",
      needs: ["playHistory"],
      build: (id) =>
        make(id, "Never played", [
          { id: rid(id, 1), kind: "lastPlayed", epochSec: {}, neverPlayedOnly: true },
        ]),
    },
    {
      id: "most-played",
      label: "Most played",
      description: "The ones you keep coming back to — 10 hours or more",
      needs: ["playHistory"],
      build: (id) =>
        make(id, "Most played", [
          { id: rid(id, 1), kind: "playtime", minutes: { min: 600 } },
        ], { sort: [{ field: "playtimeMinutes", dir: "desc" }] }),
    },
    {
      id: "hidden-gems",
      label: "Hidden gems",
      description: "Reviewed at 90% or better, and you've barely touched them",
      needs: ["reviewScore", "playHistory"],
      build: (id) =>
        make(id, "Hidden gems", [
          { id: rid(id, 1), kind: "reviewScore", percent: { min: 90 } },
          { id: rid(id, 2), kind: "playtime", minutes: { max: 30 } },
        ], { sort: BEST_FIRST }),
    },
    {
      id: "critically-acclaimed",
      label: "Critically acclaimed",
      description: "Metacritic 85 and above",
      needs: ["metacritic"],
      build: (id) =>
        make(id, "Critically acclaimed", [
          { id: rid(id, 1), kind: "metacritic", score: { min: 85 } },
          // Sorted by the Steam score rather than by Metacritic: the rule
          // filters on Metacritic, but only 230 games here carry one, and
          // `sortAs` for the rest would scatter them arbitrarily.
        ], { sort: BEST_FIRST }),
    },
    {
      id: "short-games",
      label: "Short games",
      description: "Under 10 hours to beat, for when you don't want a commitment",
      needs: ["hltb"],
      build: (id) =>
        make(id, "Short games", [
          { id: rid(id, 1), kind: "hltbMain", hours: { max: 10 } },
        ]),
    },
    {
      id: "deck-verified",
      label: "Deck Verified",
      description: "Games Valve has verified for this hardware",
      needs: ["deckCompat"],
      build: (id) =>
        make(id, "Deck Verified", [
          { id: rid(id, 1), kind: "deckCompat", categories: ["verified"] },
        ]),
    },
    {
      id: "recently-added",
      label: "Recently added",
      description: "Everything that arrived in your library this month",
      needs: ["purchaseDate"],
      // Sorted by release date rather than purchase date: `SortField` has no
      // `purchasedAt`, and newest-released is the closest honest proxy for
      // "what just arrived".
      build: (id) =>
        make(id, "Recently added", [
          { id: rid(id, 1), kind: "purchaseDate", epochSec: { min: now - 30 * DAY } },
        ], { sort: [{ field: "releaseDate", dir: "desc" }] }),
    },
    {
      id: "space-hogs",
      label: "Space hogs",
      description: "Installed and 20 GB or more — start here when you're short on space",
      needs: ["sizeOnDisk"],
      build: (id) =>
        make(id, "Space hogs", [
          { id: rid(id, 1), kind: "installed" },
          { id: rid(id, 2), kind: "sizeOnDisk", bytes: { min: 20 * 1024 ** 3 } },
        ], { sort: BIGGEST_FIRST }),
    },
    {
      id: "installed",
      label: "Installed",
      description: "What's actually on this device right now",
      needs: [],
      build: (id) => make(id, "Installed", [{ id: rid(id, 1), kind: "installed" }]),
    },
    {
      id: "emulated",
      label: "Emulated & non-Steam",
      description: "ROMs and shortcuts added to Steam by EmuDeck and friends",
      needs: [],
      build: (id) =>
        make(id, "Emulated", [{ id: rid(id, 1), kind: "source", sources: ["shortcut"] }]),
    },
    {
      id: "steam-only",
      label: "Steam games only",
      description: "Hides the shortcuts, leaving what you bought on Steam",
      needs: [],
      build: (id) =>
        make(id, "Steam games", [{ id: rid(id, 1), kind: "source", sources: ["steam"] }]),
    },
    {
      id: "couch-coop",
      label: "Couch co-op",
      description: "Local multiplayer with full controller support",
      needs: [],
      build: (id) =>
        make(id, "Couch co-op", [
          {
            id: rid(id, 1),
            kind: "feature",
            features: ["coop", "fullControllerSupport"],
            mode: "allOf",
          },
        ]),
    },
  ];
}

/**
 * Which needs the library can actually answer.
 *
 * A need counts as met when *some* game has the value — not all. Every real
 * library has hundreds of titles with no Metacritic score, so requiring full
 * coverage would grey out a preset that works perfectly well on the 230 games
 * that do have one.
 */
export function metadataNeedsMet(
  games: readonly GameFacts[],
  availableFacts: ReadonlySet<FactKey> = new Set(),
): Set<MetadataNeed> {
  const met = new Set<MetadataNeed>();
  const some = (pred: (g: GameFacts) => boolean) => games.some(pred);

  // -1 is the "unknown" sentinel; 0 for last-played means "never", which is a
  // real answer and proves the source is present.
  if (some((g) => (g.playtimeMinutes ?? -1) >= 0 || (g.lastPlayed ?? -1) >= 0)) {
    met.add("playHistory");
  }
  if (some((g) => (g.sizeOnDisk ?? -1) > 0)) met.add("sizeOnDisk");
  if (some((g) => (g.reviewPercentage ?? -1) >= 0)) met.add("reviewScore");
  if (some((g) => (g.metacritic ?? -1) >= 0)) met.add("metacritic");
  // `deckCompat` is non-nullable and the no-AppStore fallback hard-codes
  // "unknown", so a presence test was true even on a library that knows
  // nothing — and "Deck Verified" was offered, priced, and came back empty.
  // Every other need here tests a sentinel; this one has to test the value.
  if (some((g) => typeof g.deckCompat === "string" && g.deckCompat !== "unknown")) {
    met.add("deckCompat");
  }
  if (some((g) => (g.purchasedAt ?? -1) > 0)) met.add("purchaseDate");
  if (some((g) => (g.storeTags ?? []).length > 0)) met.add("storeTags");
  if (availableFacts.has("hltbMain")) met.add("hltb");

  return met;
}

/** The fields {@link metadataNeedsMet} reads — a structural subset of the metadata. */
export interface GameFacts {
  playtimeMinutes?: number;
  lastPlayed?: number;
  sizeOnDisk?: number | null;
  reviewPercentage?: number;
  metacritic?: number;
  deckCompat?: string | null;
  purchasedAt?: number;
  storeTags?: readonly string[];
}

/** Needs a preset declares that the library cannot answer. */
export function unmetNeeds(
  preset: CollectionPreset,
  met: ReadonlySet<MetadataNeed>,
): MetadataNeed[] {
  return preset.needs.filter((n) => !met.has(n));
}
