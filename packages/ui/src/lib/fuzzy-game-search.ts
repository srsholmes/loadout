/**
 * Shared fuzzy-search helper for the picker plugins (SGDB, HLTB,
 * ProtonDB Badges, LSFG-VK). Backed by fuzzysort, with three
 * weighted keys per game:
 *
 *   - `name` (highest weight): the canonical game title. A match
 *     here ranks the game above any collection-only match, so
 *     typing "Mario" surfaces Mario games before games tagged with
 *     a Mario-named collection.
 *   - `tagsRaw`: original collection labels from `shortcuts.vdf` /
 *     Steam user-collections — "Nintendo 64", "Sega Mega Drive".
 *   - `tagsFriendly`: the alias-shortened form ("N64", "Genesis").
 *     Including both means the user can type either form and hit
 *     the same tiles.
 *
 * The helper accepts an array shaped like game-browser's `GameInfo`
 * (`appId`, `name`, optional `tags`) and returns a filtered+sorted
 * subset. An empty query string is the identity function (no
 * search, no re-ordering).
 */
import fuzzysort from "fuzzysort";
import { friendlyCollectionName } from "../collection-aliases";

/** Minimal shape fuzzy-search needs. Any picker entry that matches
 *  this superset can be passed in directly. */
export interface FuzzyGameLike {
  appId: string;
  name: string;
  tags?: string[];
}

/**
 * Internal cached prep state: fuzzysort's `prepare()` builds a
 * lookup-optimized representation of each string. We memoize the
 * prepared keys per game by stringifying its `appId + name + tags`,
 * because picker libraries are stable across renders and re-running
 * `prepare()` every keystroke is wasted work on a 2000-game list.
 */
type Prepared = ReturnType<typeof fuzzysort.prepare>;
interface CachedEntry<T> {
  game: T;
  name: Prepared;
  tagsRaw: Prepared[];
  tagsFriendly: Prepared[];
}

const prepCache = new WeakMap<object, CachedEntry<FuzzyGameLike>>();

function getEntry<T extends FuzzyGameLike>(game: T): CachedEntry<T> {
  // WeakMap keys must be objects — `game` is the GameInfo reference.
  const cached = prepCache.get(game);
  if (cached) return cached as CachedEntry<T>;
  const tags = game.tags ?? [];
  const entry: CachedEntry<T> = {
    game,
    name: fuzzysort.prepare(game.name),
    tagsRaw: tags.map((t) => fuzzysort.prepare(t)),
    tagsFriendly: tags
      .map((t) => friendlyCollectionName(t))
      // Skip when the friendly form equals the raw one — fuzzysort
      // already covers it, no point double-scoring.
      .filter((friendly, i) => friendly !== tags[i])
      .map((t) => fuzzysort.prepare(t)),
  };
  prepCache.set(game, entry as CachedEntry<FuzzyGameLike>);
  return entry;
}

/**
 * Filter + rank `games` by fuzzy-matching `query` against name and
 * collection tags. Empty query = pass-through. The returned array
 * is freshly allocated; callers can safely sort or splice it.
 *
 * Ranking: best-of-key per game, but the name match gets a generous
 * additive bonus so a name hit always beats a collection-only hit.
 * fuzzysort scores are negative (best = 0); we add 1000 to "name"
 * matches to push them up the list.
 */
export function fuzzySearchGames<T extends FuzzyGameLike>(
  games: T[],
  query: string,
): T[] {
  const q = query.trim();
  if (q.length === 0) return games.slice();

  const scored: Array<{ game: T; score: number }> = [];

  for (const game of games) {
    const entry = getEntry(game);

    const nameHit = fuzzysort.single(q, entry.name);
    let best = -Infinity;
    if (nameHit) {
      // fuzzysort scores: 0 is perfect; deeper negatives are worse.
      // The +1000 ranks any name hit above any tag-only hit.
      best = nameHit.score + 1000;
    }
    for (const tag of entry.tagsRaw) {
      const hit = fuzzysort.single(q, tag);
      if (hit && hit.score > best) best = hit.score;
    }
    for (const tag of entry.tagsFriendly) {
      const hit = fuzzysort.single(q, tag);
      if (hit && hit.score > best) best = hit.score;
    }

    if (best > -Infinity) scored.push({ game, score: best });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.game);
}
