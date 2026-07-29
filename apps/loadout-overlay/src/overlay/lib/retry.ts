/**
 * Retry policy shared by the overlay's network calls.
 *
 * Why this exists: the overlay had three hand-rolled retry loops that had
 * drifted apart (initBackend, usePlugins' fetchWithRetry, and the plugin
 * bundle fetch), each re-deriving backoff and "is this worth retrying".
 *
 * They serve two genuinely different shapes, both expressed here:
 *
 *  - **Bounded ladder** (`fixedDelays`): a fixed list of waits, then give up
 *    and surface the error. For work where failing is a real outcome the
 *    caller must handle — a plugin bundle that never arrives renders a
 *    placeholder.
 *  - **Unbounded backoff** (`exponentialDelays`): retry forever. For startup
 *    gates where there is no meaningful failure path — the session token
 *    MUST eventually be acquired or the overlay is useless.
 */

/** A non-2xx HTTP response, carrying the status so retry policies can decide
 *  structurally instead of sniffing an error message. */
export class HttpError extends Error {
  readonly status: number;

  constructor({ status, message }: { status: number; message: string }) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/** ms to wait before the attempt after `attempt`, or null to stop retrying. */
export type DelayPolicy = (attempt: number) => number | null;

/** Bounded: wait each listed delay in turn, then give up.
 *
 *  Deliberately no `?? fallback` on the index — under noUncheckedIndexedAccess
 *  an out-of-range read is a type error, so an off-by-one fails the build
 *  instead of silently substituting a different ladder. */
export function fixedDelays(delays: readonly number[]): DelayPolicy {
  return (attempt) => {
    const delay = delays[attempt];
    return delay === undefined ? null : delay;
  };
}

/** Unbounded: exponential backoff, capped. Never returns null — the caller
 *  is expected to be a startup gate with no failure path, or to stop via
 *  `shouldContinue`. */
export function exponentialDelays({
  base = 1000,
  cap = 10000,
}: { base?: number; cap?: number } = {}): DelayPolicy {
  return (attempt) => Math.min(base * 2 ** attempt, cap);
}

/** Default: retry anything except a non-retriable HTTP status. A 4xx is a
 *  real answer — the resource is gone or we're unauthorized — and asking
 *  again just repeats it. 408 (timeout) and 429 (rate limit) are the
 *  conventional exceptions and are retriable. */
export function isRetriableError(err: unknown): boolean {
  if (!(err instanceof HttpError)) return true; // network layer
  if (err.status === 408 || err.status === 429) return true;
  return err.status >= 500;
}

export interface RetryOptions<T> {
  /** Prefix for retry logs, e.g. "[bundle] battery-tracker". */
  label: string;
  /** One attempt. Throw to signal failure; `attempt` is 0-based. */
  run: (attempt: number) => Promise<T>;
  delays: DelayPolicy;
  /** Defaults to `isRetriableError`. */
  isRetriable?: (err: unknown) => boolean;
  /** Checked before each attempt and after each wait, so a caller whose
   *  lifetime ended (an unmounted React effect) stops without firing another
   *  request. Returning false rejects with the last error, or a cancellation
   *  error if nothing has failed yet. */
  shouldContinue?: () => boolean;
}

/**
 * Run `run` until it succeeds, the delay policy gives up, the error is not
 * retriable, or `shouldContinue` goes false.
 *
 * Note this is a wall-clock budget, not simply "N chances": a request killed
 * by a socket-pool flush fails instantly, so each attempt's exposure is only
 * as long as the request itself. What matters is that the ladder spans the
 * window in which the disruption is happening.
 */
export async function retryAsync<T>({
  label,
  run,
  delays,
  isRetriable = isRetriableError,
  shouldContinue,
}: RetryOptions<T>): Promise<T> {
  let lastErr: unknown;
  let hasFailed = false;

  for (let attempt = 0; ; attempt++) {
    if (shouldContinue && !shouldContinue()) {
      throw hasFailed ? lastErr : new Error(`${label}: cancelled`);
    }

    try {
      return await run(attempt);
    } catch (err) {
      lastErr = err;
      hasFailed = true;
      if (!isRetriable(err)) throw err;
    }

    const delay = delays(attempt);
    if (delay === null) throw lastErr;

    console.warn(
      `${label}: attempt ${attempt + 1} failed (${lastErr instanceof Error ? lastErr.message : String(lastErr)}), retrying in ${delay}ms`,
    );
    await new Promise((r) => setTimeout(r, delay));
  }
}

/** Fetch a URL and read it as text, turning a non-2xx into an HttpError so
 *  the retry policy can classify it. Cache-busts per call so a retry is never
 *  served the failed response out of the HTTP cache. */
export async function fetchTextNoCache({
  url,
  what,
  headers,
}: {
  url: string;
  /** Named in the error, e.g. "battery-tracker bundle". */
  what: string;
  headers?: HeadersInit;
}): Promise<string> {
  const busted = `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`;
  const res = await fetch(busted, headers ? { headers } : undefined);
  if (!res.ok) {
    throw new HttpError({
      status: res.status,
      message: `HTTP ${res.status} loading ${what}`,
    });
  }
  // Retried by the caller on purpose: a body dying mid-stream is the shape a
  // socket-pool flush takes when it lands after the headers arrived.
  return await res.text();
}
