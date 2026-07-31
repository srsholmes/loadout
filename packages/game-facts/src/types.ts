/**
 * The vocabulary for per-game facts that need I/O to answer.
 *
 * A "fact" is one datum about one game that cannot be read from local
 * metadata: achievement completion, HowLongToBeat time, ProtonDB tier,
 * whether a friend is playing it right now. Facts are resolved *outside*
 * whatever consumes them — batched over the library, cached, then handed
 * over as a plain map — so the consumer stays synchronous.
 *
 * ## Why the four-state {@link FactValue}
 *
 * A fact is not `T | undefined`. There are four genuinely different
 * answers, and collapsing any of them is the standard way this class of
 * feature lies to users:
 *
 *   - `ok`          — we asked and got an answer.
 *   - `loading`     — we have not asked yet. **Not** a failure, and not
 *                     zero. The first render of any view necessarily
 *                     precedes every resolver.
 *   - `missing`     — we asked, and this particular game has no answer.
 *                     No ProtonDB report; no achievements at all. Endemic,
 *                     not exceptional, and a *definite* no rather than an
 *                     unknown.
 *   - `unavailable` — the whole source is down, with a user-facing `reason`
 *                     so an empty state can quote it. "Friends Playing
 *                     needs Steam running" beats a silent zero.
 *
 * The `loading` / `missing` split is the load-bearing one, and it was paid
 * for in a real bug. `plugins/collections` originally had three states, and
 * folding per-game absence into the indeterminate bucket made every
 * unanswered game **match** under its default `"pass"` policy — silently,
 * with no diagnostic. Its `lib/types.ts:263` now carries the same four, and
 * `factNumber` (`lib/rules.ts:118`) routes `missing` through the range's
 * `includeUnknown` escape hatch.
 *
 * That plugin still declares `FactValue` locally, and the two declarations
 * are deliberately kept structurally identical: TypeScript is structural, so
 * a fact payload crosses the plugin RPC boundary with neither side importing
 * the other. The duplication is scheduled for removal — when collections
 * lands its resolver layer, its local declaration becomes a re-export from
 * here. It is not accidental.
 *
 * ## Why {@link FactResolver} is generic over its key
 *
 * A consumer's set of fact keys is its own vocabulary — library-tabs ties
 * `FactKey` to its `RuleKind` union, and hoisting that here would drag the
 * whole rule engine along. So the key is a type parameter defaulting to
 * `string`: producers that own a single fact ignore it, and a consumer with
 * a closed key union instantiates `FactResolver<FactKey>` with no change
 * to this package.
 */

/**
 * One resolved fact for one game.
 *
 * The `value` union is deliberately narrow — these cross an RPC boundary
 * as JSON, so no `Date`, no `bigint`, no nested objects. Timestamps travel
 * as unix-ms numbers and 64-bit ids as strings.
 */
export type FactValue =
  | { state: "ok"; value: number | string | boolean | string[] }
  | { state: "loading" }
  | { state: "missing" }
  | { state: "unavailable"; reason: string };

/** Narrow a {@link FactValue} to its `ok` variant. */
export function isOk(
  fact: FactValue | undefined,
): fact is { state: "ok"; value: number | string | boolean | string[] } {
  return fact?.state === "ok";
}

/**
 * Build a `missing` fact: the source answered, and this game has nothing.
 *
 * A helper rather than an inline literal so the choice is deliberate at the
 * call site. Reach for this over `{state:"ok", value:-1}` — an `ok` carrying
 * a sentinel claims we have a real measurement when we do not, and it
 * obliges every consumer to know the sentinel.
 */
export function missing(): FactValue {
  return { state: "missing" };
}

/**
 * Build an `unavailable` fact. A helper rather than an inline literal
 * because the `reason` is user-facing copy and every call site forgetting
 * it is a silently empty view.
 */
export function unavailable(reason: string): FactValue {
  return { state: "unavailable", reason };
}

/**
 * Build a map of the same `unavailable` fact for every appId.
 *
 * The shape a failing {@link FactResolver} returns: the contract is
 * "resolve, never reject", so a source that is wholesale unreachable
 * still has to answer for each appId it was asked about.
 */
export function allUnavailable(
  appIds: readonly string[],
  reason: string,
): Map<string, FactValue> {
  const out = new Map<string, FactValue>();
  for (const appId of appIds) out.set(appId, unavailable(reason));
  return out;
}

/**
 * A cached fact, with the timestamp that decides its staleness.
 *
 * `V` is the *stored* value, which is not necessarily a {@link FactValue}
 * — an achievement resolver stores `{unlocked, total}` and projects a
 * percentage on read. Keeping the stored shape open is what lets one
 * cache serve both a rich dashboard and a thin fact wire.
 */
export interface FactRow<V = unknown> {
  /** Unix ms of the last *successful* fetch. Never written on failure. */
  at: number;
  value: V;
}

/**
 * Resolves one fact for a batch of games.
 *
 * `resolve` **must not reject.** A source that is down returns
 * {@link allUnavailable} for the whole batch, because one dead source
 * must not abort a sweep that is also feeding five healthy ones.
 */
export interface FactResolver<K extends string = string> {
  key: K;
  /** Default freshness window. Resolvers with a value-dependent TTL
   *  should express that as a {@link StalenessPolicy} instead. */
  ttlSec: number;
  resolve(appIds: string[]): Promise<Map<string, FactValue>>;
}

/** What a sweep is doing right now. Drives the progress UI verbatim. */
export interface SweepProgress {
  status:
    | "idle"
    | "running"
    | "paused"
    | "backoff"
    | "done"
    | "cancelled"
    | "error";
  /** appIds with a fresh row — the honest numerator for "N of M scanned". */
  scanned: number;
  /** Size of the sweep universe. */
  total: number;
  /** Batches actually issued this sweep. Surfaced so a user worried about
   *  rate limits can *see* the cost rather than be reassured about it. */
  requests: number;
  /** ms since the current sweep started, 0 when idle. */
  elapsedMs: number;
  /** Present for `backoff` and `error` — user-facing, quote it directly. */
  reason?: string;
  /** Unix ms the backoff expires. Present only for `backoff`. */
  retryAt?: number;
}
