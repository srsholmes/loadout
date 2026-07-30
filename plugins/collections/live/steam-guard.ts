/**
 * Preconditions for the live suite — the tests that talk to a real, running
 * Steam rather than a fixture.
 *
 * These specs are named `*.live.spec.ts`, which is invisible to CI by
 * construction: `bun test` only collects `*.test.*` / `*.spec.*`, and the two
 * CI scripts filter on the substrings `test.ts` and `spec.tsx`. `.live.spec.ts`
 * contains neither, so `bun run test` can never pick it up. `bun run test:live`
 * filters on `.live.spec.ts` and picks up nothing else.
 *
 * **`requireSteam` throws rather than skipping.** A live suite that silently
 * skips when its dependency is missing reports green forever and rots — which
 * is precisely how 545 passing unit tests failed to notice that 22 of this
 * plugin's 32 rules had no data behind them. `test:live` is only ever run
 * deliberately, on hardware, so "Steam isn't running" is a failure. The one
 * escape hatch is `LOADOUT_LIVE_ALLOW_SKIP=1`, for checking the suite still
 * compiles on a machine with no Steam.
 */

import { findSharedJsTab } from "@loadout/steam-cdp";
import { open, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Set to `1` to allow the live suite to no-op instead of failing. */
const ALLOW_SKIP = "LOADOUT_LIVE_ALLOW_SKIP";

export class SteamUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `${detail}\n\n` +
        "The live suite needs Steam running with its CEF debug port open.\n" +
        `Set ${ALLOW_SKIP}=1 to let the suite no-op instead.`,
    );
    this.name = "SteamUnavailableError";
  }
}

/** True when the caller asked for a no-op run on a machine without Steam. */
export function skipAllowed(): boolean {
  return process.env[ALLOW_SKIP] === "1";
}

/**
 * Assert Steam is reachable over CDP. Returns the SharedJSContext tab so the
 * caller doesn't have to look it up twice.
 */
export async function requireSteam(): Promise<{ webSocketDebuggerUrl: string }> {
  // Running under the UI preload replaces `fetch` with a DOM-scoped one that
  // blocks the cross-origin request to Steam's debug port, and the resulting
  // "no tab found" is thoroughly misleading. `bun run test:ui` never collects
  // this file, but an ad-hoc `bun test plugins/collections` (a *directory*
  // filter, broader than CI's substring one) does.
  if (typeof (globalThis as { document?: unknown }).document !== "undefined") {
    throw new SteamUnavailableError(
      "This spec is running with the happy-dom preload, whose fetch cannot " +
        "reach Steam's debug port.\nRun the live suite on its own: bun run test:live",
    );
  }

  let tab: Awaited<ReturnType<typeof findSharedJsTab>>;
  try {
    tab = await findSharedJsTab();
  } catch (err) {
    throw new SteamUnavailableError(
      `Couldn't reach Steam's debug port: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!tab) {
    throw new SteamUnavailableError("No SharedJSContext tab found.");
  }
  return tab;
}

// ── Cross-file lock ────────────────────────────────────────────────────

/**
 * `withSteamClient` serialises CDP sessions through an in-process promise
 * chain, because concurrent sessions crash `steamwebhelper`. `--isolate` gives
 * every spec file its own global, so that chain does **not** span files — two
 * live specs running at once would each think they were alone.
 *
 * `--max-concurrency=1` is the first line of defence; this advisory lock is the
 * second, and also protects against a stray `bun test` in another terminal.
 */
const LOCK_PATH = join(
  process.env.XDG_RUNTIME_DIR ?? tmpdir(),
  "loadout-live-test.lock",
);

/** Milliseconds between attempts, and how long before a lock is presumed dead. */
const RETRY_MS = 250;
const STALE_MS = 5 * 60_000;

async function lockIsStale(): Promise<boolean> {
  try {
    const raw = await readFile(LOCK_PATH, "utf8");
    const { pid, at } = JSON.parse(raw) as { pid: number; at: number };
    if (Date.now() - at > STALE_MS) return true;
    // `kill(pid, 0)` throws when the process is gone — the cheapest liveness
    // probe there is, and it needs no permissions for our own processes.
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  } catch {
    // Unreadable or malformed: treat as stale rather than deadlocking forever.
    return true;
  }
}

/**
 * Take the live-test lock. Returns a release function; always call it from
 * `afterAll` so a failing assertion doesn't strand the lock.
 */
export async function acquireLiveLock(timeoutMs = 60_000): Promise<() => Promise<void>> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      // `wx` is the atomic create-or-fail that makes this a lock at all.
      const handle = await open(LOCK_PATH, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      await handle.close();
      return async () => {
        await rm(LOCK_PATH, { force: true });
      };
    } catch {
      if (await lockIsStale()) {
        await rm(LOCK_PATH, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for ${LOCK_PATH}. Another live-test run is in ` +
            "progress; if you're sure it isn't, delete that file.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
}

// ── Tier C: the write gate ─────────────────────────────────────────────

/** Set to `1` to allow the live suite to write to the user's Steam. */
const ALLOW_WRITES = "LOADOUT_LIVE_WRITES";

/**
 * The prefix every collection this suite creates must carry.
 *
 * `zzz-` so it sorts to the bottom of the user's collection list if a run is
 * ever interrupted between create and cleanup, and so it is obviously not
 * theirs at a glance. The random suffix is per-run: two interrupted runs must
 * not produce the same name, or the second would adopt the first's leftovers
 * and the cleanup assertion would pass while a real collection stayed behind.
 */
export const LIVE_TEST_PREFIX = "zzz-loadout-livetest-";

/**
 * Assert the operator has opted into writes.
 *
 * Read the destructive-risk register in the plan before setting this. It
 * creates and deletes real Steam collections on the account that is signed in,
 * and Steam Cloud will sync them to every other machine before cleanup runs.
 */
export function requireWrites(): void {
  if (process.env[ALLOW_WRITES] === "1") return;
  throw new Error(
    "This spec writes to your real Steam collections.\n" +
      `Set ${ALLOW_WRITES}=1 (or run: bun run test:live:write) to allow it.`,
  );
}

/** A per-run collection name that cannot collide with anything real. */
export function liveTestCollectionName(suffix: string): string {
  const hex = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
  return `${LIVE_TEST_PREFIX}${hex}-${suffix}`;
}
