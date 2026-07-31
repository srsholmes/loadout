/**
 * One-document cache for a whole library's worth of fact rows.
 *
 * ## Why one aggregate document, not a file per game
 *
 * `@loadout/external-cache` keys entries by SHA-1 of the key, which makes a
 * point read cheap and an *enumeration* impossible — there is no
 * `keys()` / `entries()` API, by design. But the question a sweep has to
 * answer on every start is "which of my 2000 rows are stale, and in what
 * order", which is a whole-corpus question. Per-app files would mean 2000
 * point reads to plan one sweep.
 *
 * So breadth data lives in a single document: ~2000 rows is ~80 KB, one
 * atomic read at start and one atomic write per committed batch. Per-app
 * files remain the right shape for *depth* data (every achievement of one
 * game, fetched only for games the user actually opened) — that stays on
 * plain `cache.get`/`set`.
 *
 * ## Identity
 *
 * The document carries an `identity` string and any mismatch is treated as
 * an empty cache. For achievements that is the Steam id: switching accounts
 * on a shared device must not silently mix two people's progress into one
 * ranking. It is a cheap, total invalidation for the class of bug that is
 * otherwise very hard to notice.
 */

import type { ExternalCache } from "@loadout/external-cache";

import type { FactRow } from "./types";

/** On-disk shape. Versioned via the cache key, not a field. */
interface FactDoc<V> {
  identity: string;
  rows: Record<string, FactRow<V>>;
}

export interface FactStoreSnapshot<V> {
  /** `false` when the stored document belonged to a different identity (or
   *  there was none) — the caller is starting from cold. */
  matched: boolean;
  rows: Map<string, FactRow<V>>;
}

export interface FactStore<V = unknown> {
  /** Read the rows for the configured identity. A missing, corrupt or
   *  foreign-identity document all read as empty. */
  load(): Promise<FactStoreSnapshot<V>>;
  /** Merge `updates` over the current rows and persist. Returns the merged
   *  map so a caller can keep using it without re-reading. */
  commit(updates: ReadonlyMap<string, FactRow<V>>): Promise<Map<string, FactRow<V>>>;
  /** Drop rows whose appId is not in `keep` and persist. Returns the number
   *  removed. Used when the library shrinks (uninstall, sharing revoked). */
  prune(keep: ReadonlySet<string>): Promise<number>;
  /** Delete the document entirely. */
  clear(): Promise<void>;
}

export interface CreateFactStoreOptions {
  /**
   * TTL of the *document*, in seconds. Long by default (1 year): per-row
   * freshness is decided by each row's `at` against a
   * {@link StalenessPolicy}, so an expiry here would throw away good rows
   * for no reason. It exists only so an abandoned plugin's cache is
   * eventually swept by `clearExpired()`.
   */
  ttlSec?: number;
}

const ONE_YEAR_SEC = 365 * 24 * 60 * 60;

/**
 * Create a store over one cache key.
 *
 * Keeps an in-memory copy so a 40-batch sweep pays one disk read rather
 * than 40. The copy is seeded on first `load()` and updated by `commit`, so
 * it can never drift from what was written — every mutation goes through
 * here.
 */
export function createFactStore<V = unknown>(
  cache: ExternalCache,
  key: string,
  identity: string,
  opts: CreateFactStoreOptions = {},
): FactStore<V> {
  const ttlSec = opts.ttlSec ?? ONE_YEAR_SEC;

  /** Authoritative in-memory rows once loaded; `null` until first read. */
  let memo: Map<string, FactRow<V>> | null = null;

  async function readDoc(): Promise<FactStoreSnapshot<V>> {
    if (memo) return { matched: true, rows: new Map(memo) };

    let doc: FactDoc<V> | undefined;
    try {
      doc = await cache.get<FactDoc<V>>(key);
    } catch {
      // A corrupt or unreadable document is a cache miss, not an error —
      // the whole point of this data is that it can be re-fetched.
      doc = undefined;
    }

    const usable =
      !!doc && doc.identity === identity && !!doc.rows && typeof doc.rows === "object";

    memo = new Map<string, FactRow<V>>();
    if (usable) {
      for (const [appId, row] of Object.entries(doc!.rows)) {
        // Defend against a hand-edited or truncated file: a row without a
        // numeric `at` has no usable staleness and is worse than absent.
        if (row && typeof row.at === "number" && Number.isFinite(row.at)) {
          memo.set(appId, row);
        }
      }
    }
    return { matched: usable, rows: new Map(memo) };
  }

  async function writeDoc(rows: Map<string, FactRow<V>>): Promise<void> {
    const doc: FactDoc<V> = { identity, rows: Object.fromEntries(rows) };
    await cache.set(key, doc, { ttlSec });
  }

  return {
    load: readDoc,

    async commit(updates) {
      if (!memo) await readDoc();
      const rows = memo!;
      for (const [appId, row] of updates) rows.set(appId, row);
      await writeDoc(rows);
      return new Map(rows);
    },

    async prune(keep) {
      if (!memo) await readDoc();
      const rows = memo!;
      let removed = 0;
      for (const appId of [...rows.keys()]) {
        if (!keep.has(appId)) {
          rows.delete(appId);
          removed++;
        }
      }
      if (removed > 0) await writeDoc(rows);
      return removed;
    },

    async clear() {
      memo = new Map();
      await cache.delete(key);
    },
  };
}
