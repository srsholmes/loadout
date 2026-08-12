/**
 * The spool — how a dying process reports its own death.
 *
 * A fatal handler cannot await a network request. Two independent facts in
 * this codebase make that concrete:
 *
 *  - Electrobun registers its own `uncaughtException` listener when
 *    `electrobun/bun` is imported, and that listener calls a native
 *    `forceExit(1)`. Anything we start asynchronously is killed mid-flight.
 *  - The overlay's management-loop `.catch` calls `process.exit(1)` on the
 *    same tick, and must keep doing so — it owes Steam a prompt SIGCONT.
 *
 * So the fatal path does no I/O over the network at all. It writes one
 * already-scrubbed event to disk synchronously, and the *next* successful
 * start drains the directory. This also makes offline the normal case rather
 * than an error case: handhelds are frequently suspended or off-network, and
 * a queued report simply waits.
 *
 * Everything written here has already been through `scrubEvent`. The spool
 * must never hold anything we would not have sent.
 */

import { join } from "node:path";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  statSync,
} from "node:fs";
import type { FaroPayload } from "./types";

/** Keep the directory small: a crash loop must not fill the user's disk. */
export const MAX_SPOOL_FILES = 20;
/** A three-week-old crash on a long-superseded version is noise. */
export const MAX_SPOOL_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * How many times a single event may fail to send before it is discarded.
 *
 * Needed because entries are unlinked when read, not when sent. Unlinking on
 * read is deliberate — an entry the server permanently rejects would otherwise
 * be retried on every start forever — but it means a failed send must put the
 * event back, or a drain that happens to run while the device is offline
 * destroys exactly the reports the spool exists to protect.
 */
export const MAX_SPOOL_ATTEMPTS = 5;

/**
 * Minimum gap between send attempts for one entry.
 *
 * Without this the retry budget is consumed per *process start*, not per
 * elapsed time — and the case that matters is precisely a crash loop while
 * offline. systemd restarts the overlay every 5s, each start drains, each
 * drain fails and burns an attempt, and five restarts later the reports are
 * discarded roughly twenty seconds after the crash that produced them. The
 * spool exists for exactly that scenario, so it must outlive it.
 *
 * Entries younger than this are left untouched on disk rather than read.
 */
export const RETRY_BACKOFF_MS = 5 * 60 * 1000;

export interface SpooledEntry {
  event: FaroPayload;
  attempts: number;
}

/** `<padded-timestamp>-a<attempts>-<event id>.json` — lexical order is chronological. */
const NAME = /^(\d+)-a(\d+)-(.+)\.json$/;

function spoolFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Write one scrubbed event to the spool, synchronously.
 *
 * Returns whether it landed. Never throws: a read-only or full disk must not
 * turn a crash we were trying to report into a second crash.
 */
export function spoolEvent(
  dir: string,
  event: FaroPayload,
  now: number,
  attempts = 0,
  chown?: (path: string) => void,
): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    // The root backend and the user overlay share $HOME; anything root
    // creates there must be handed back or the overlay can never write.
    chown?.(dir);
    const existing = spoolFiles(dir);
    // Oldest-first eviction. Filenames lead with the timestamp, so lexical
    // order is chronological order.
    for (const stale of existing.slice(0, Math.max(0, existing.length - MAX_SPOOL_FILES + 1))) {
      try {
        unlinkSync(join(dir, stale));
      } catch {
        // Another process may have drained it already.
      }
    }
    // Faro payloads carry no event id, so the filename gets a random suffix
    // purely to keep two crashes in the same millisecond from colliding.
    const unique = crypto.randomUUID().slice(0, 8);
    const path = join(dir, `${String(now).padStart(15, "0")}-a${attempts}-${unique}.json`);
    writeFileSync(path, JSON.stringify(event), "utf8");
    chown?.(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and remove every spooled event, with its prior attempt count.
 *
 * Entries too old, too often retried, or unparseable are dropped. The caller
 * MUST re-spool anything it fails to send (see `MAX_SPOOL_ATTEMPTS`).
 */
export function takeSpooled(dir: string, now: number): SpooledEntry[] {
  const out: SpooledEntry[] = [];
  for (const name of spoolFiles(dir)) {
    const path = join(dir, name);
    try {
      const attemptsSoFar = Number(NAME.exec(name)?.[2] ?? 0);
      const mtime = statSync(path).mtimeMs;
      // An entry that has already failed at least once waits out the backoff.
      // Leave it entirely alone — reading unlinks, and unlinking here is what
      // would let a restart loop chew through the retry budget in seconds.
      // Fresh entries (attempts 0) are always eligible, so a crash reported on
      // one start still ships on the next.
      if (attemptsSoFar > 0 && now - mtime < RETRY_BACKOFF_MS) continue;
      const age = now - mtime;
      const raw = readFileSync(path, "utf8");
      // Unlink before sending. A malformed or permanently-rejected entry left
      // on disk would be retried on every start forever.
      unlinkSync(path);
      if (age > MAX_SPOOL_AGE_MS) continue;
      if (attemptsSoFar >= MAX_SPOOL_ATTEMPTS) continue;
      const parsed = JSON.parse(raw) as FaroPayload;
      if (parsed && Array.isArray(parsed.exceptions)) {
        out.push({ event: parsed, attempts: attemptsSoFar });
      }
    } catch {
      try {
        unlinkSync(path);
      } catch {
        // Nothing more we can do; it will age out.
      }
    }
  }
  return out;
}
