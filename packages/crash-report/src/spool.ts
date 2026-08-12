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
import type { SentryEvent } from "./types";

/** Keep the directory small: a crash loop must not fill the user's disk. */
export const MAX_SPOOL_FILES = 20;
/** A three-week-old crash on a long-superseded version is noise. */
export const MAX_SPOOL_AGE_MS = 14 * 24 * 60 * 60 * 1000;

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
export function spoolEvent(dir: string, event: SentryEvent, now: number): boolean {
  try {
    mkdirSync(dir, { recursive: true });
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
    writeFileSync(
      join(dir, `${String(now).padStart(15, "0")}-${event.event_id}.json`),
      JSON.stringify(event),
      "utf8",
    );
    return true;
  } catch {
    return false;
  }
}

/** Read and remove every spooled event. Entries too old to be useful are dropped. */
export function takeSpooled(dir: string, now: number): SentryEvent[] {
  const out: SentryEvent[] = [];
  for (const name of spoolFiles(dir)) {
    const path = join(dir, name);
    try {
      const age = now - statSync(path).mtimeMs;
      const raw = readFileSync(path, "utf8");
      // Unlink before sending. A malformed or un-sendable entry that stayed
      // on disk would be retried on every start forever.
      unlinkSync(path);
      if (age > MAX_SPOOL_AGE_MS) continue;
      const parsed = JSON.parse(raw) as SentryEvent;
      if (parsed && typeof parsed.event_id === "string") out.push(parsed);
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
