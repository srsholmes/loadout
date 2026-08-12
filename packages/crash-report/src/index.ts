/**
 * @loadout/crash-report — opt-in crash reporting.
 *
 * Callsites see exactly two things: `initCrashReporting` once at startup and
 * `captureError` on the crash paths. Everything Sentry-specific is behind
 * this boundary, which is what keeps the backend choice reversible — moving
 * from Sentry SaaS to a self-hosted GlitchTip is a DSN change and nothing else.
 *
 * Design rules, in priority order:
 *   1. Never send without consent. Fail-closed everywhere; see consent.ts.
 *   2. Never crash, hang, or slow down the process being observed.
 *   3. Never send a field that isn't spelled out in types.ts + scrub.ts.
 */

import { join, basename } from "node:path";
import { homedir, hostname } from "node:os";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { isGranted, readConsentSync } from "./consent";
import { buildEvent } from "./event";
import { decide, parseState } from "./rate-limit";
import { fingerprint, scrubEvent } from "./scrub";
import { parseDsn, sendEvent, type Dsn } from "./transport";
import { spoolEvent, takeSpooled } from "./spool";
import type { CaptureContext, ConsentState, ProcessName, SentryEvent } from "./types";

export type { CaptureContext, ConsentState, ProcessName, SentryEvent } from "./types";
export { CRASH_REPORTING_KEY, parseConsent, readConsentSync, isGranted } from "./consent";
export { scrubEvent, scrubString, fingerprint } from "./scrub";
export { parseStack, buildEvent } from "./event";
export { parseDsn, buildEnvelope } from "./transport";
export { decide, parseState, DEFAULT_LIMITS } from "./rate-limit";
export { spoolEvent, takeSpooled, MAX_SPOOL_FILES, MAX_SPOOL_AGE_MS } from "./spool";

/** Where the rate limiter keeps its counters. Abstracted so the webview,
 *  which has no filesystem, can back it with localStorage instead. */
export interface StateStore {
  read(): string | null;
  write(value: string): void;
}

export function fileStateStore(path: string): StateStore {
  return {
    read() {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    write(value) {
      try {
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, value, "utf8");
      } catch {
        // A read-only or full disk must not break the app. Losing the
        // counters degrades us to per-process limiting, not to no limiting:
        // the in-memory copy still holds for this process's lifetime.
      }
    },
  };
}

export function memoryStateStore(): StateStore {
  let v: string | null = null;
  return { read: () => v, write: (value) => { v = value; } };
}

function stateDir(env: Record<string, string | undefined>, home: string): string {
  const xdg = env.XDG_STATE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(home, ".local", "state");
  return join(base, "loadout");
}

/**
 * Rate-limit state is per-process, and that is not cosmetic.
 *
 * The backend runs as **root** and the overlay as the **user**, but both
 * resolve paths under the same `$HOME`. A single shared file means root
 * creates it first, the user process then fails every write with EACCES —
 * silently, since the store swallows errors — and the overlay ends up with no
 * persistent rate limiting at all. That is precisely the crash-loop
 * protection this module exists to provide. Separate files also stop the two
 * processes clobbering each other's counters.
 */
function defaultStatePath(
  env: Record<string, string | undefined>,
  home: string,
  proc: ProcessName,
): string {
  return join(stateDir(env, home), `crash-report-${proc}.json`);
}

function defaultSpoolDir(
  env: Record<string, string | undefined>,
  home: string,
  proc: ProcessName,
): string {
  return join(stateDir(env, home), `crash-spool-${proc}`);
}

export interface InitOptions {
  process: ProcessName;
  /** Product version — becomes the Sentry release. */
  release?: string;
  /** Defaults to "development" for dev builds, else "production". */
  environment?: string;
  /**
   * DSN. Resolution order: this option, then `$LOADOUT_CRASH_DSN`, then none.
   * With no DSN, reporting is inert — which is the intended state until a
   * project is provisioned, and what makes dogfooding safe by default.
   */
  dsn?: string;
  /**
   * Consent supplier. Node processes default to reading `config.json` on
   * every capture so a revocation takes effect immediately. The webview has
   * no filesystem and supplies its value via `setConsent`.
   */
  readConsent?: () => ConsentState;
  stateStore?: StateStore;
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** Override the machine hostname to scrub. Defaults to `os.hostname()`. */
  hostname?: string;
  /** Override the account name to scrub. Defaults to `basename(homedir())`. */
  username?: string;
  /** Directory holding events written by fatal handlers. */
  spoolDir?: string;
  /** Set false in tests to stop init touching the real spool. */
  drainOnInit?: boolean;
}

interface Runtime {
  process: ProcessName;
  release?: string;
  environment: string;
  dsn: Dsn | null;
  readConsent: () => ConsentState;
  store: StateStore;
  now: () => number;
  fetchImpl?: typeof fetch;
  /** Resolved once at init; scrubbed out of every outgoing string. */
  hostname?: string;
  username?: string;
  spoolDir: string;
}

let rt: Runtime | null = null;
let explicitConsent: ConsentState;

/**
 * Wire up reporting. Safe to call in any process, including with no DSN —
 * that just makes every later `captureError` a no-op.
 */
export function initCrashReporting(opts: InitOptions): void {
  const env = typeof process !== "undefined" ? process.env : {};
  const home = safeHomedir();
  const dsn = parseDsn(opts.dsn ?? env.LOADOUT_CRASH_DSN);
  const isDev = !opts.release || opts.release === "dev";

  rt = {
    process: opts.process,
    release: opts.release,
    environment: opts.environment ?? (isDev ? "development" : "production"),
    dsn,
    readConsent:
      opts.readConsent ??
      (opts.process === "webview"
        ? () => explicitConsent
        : () => readConsentSync(env, home)),
    store: opts.stateStore ?? fileStateStore(defaultStatePath(env, home, opts.process)),
    now: opts.now ?? Date.now,
    fetchImpl: opts.fetchImpl,
    hostname: opts.hostname ?? safeHostname(),
    username: opts.username ?? basename(home),
    spoolDir: opts.spoolDir ?? defaultSpoolDir(env, home, opts.process),
  };

  // Ship anything a previous run died holding. Best-effort and detached: a
  // slow or failed drain must never delay startup.
  if (opts.drainOnInit !== false) void drainSpool();
}

function safeHostname(): string | undefined {
  try {
    return hostname();
  } catch {
    return undefined;
  }
}

function safeHomedir(): string {
  try {
    return homedir();
  } catch {
    return "/";
  }
}

/**
 * Set consent explicitly. The webview calls this when the user answers the
 * prompt or flips the Settings toggle; node processes read from disk and
 * don't need it.
 */
export function setConsent(state: ConsentState): void {
  explicitConsent = state;
}

/** Whether a capture right now would actually send. Useful in tests and UI. */
export function isEnabled(): boolean {
  return !!rt && !!rt.dsn && isGranted(rt.readConsent());
}

/**
 * Capture an error. Returns whether it was accepted by the server, so crash
 * handlers that are about to exit can await it; everywhere else, ignore it.
 *
 * Resolves false — never rejects — for every failure mode: no consent, no
 * DSN, rate-limited, network down, server angry.
 */
/**
 * Shared front half of every capture: consent gate, build, scrub, rate limit.
 *
 * Returns the scrubbed event when it may be sent, or null. Both the async and
 * the fatal path go through here, so scrubbing cannot be bypassed by adding a
 * new entry point — a property the tests assert against the transmitted bytes.
 */
function prepare(r: Runtime, error: unknown, context?: CaptureContext): SentryEvent | null {
  // Re-checked on every capture, not cached: revoking consent has to take
  // effect immediately, not at next restart.
  if (!isGranted(r.readConsent())) return null;

  const event = scrubEvent(
    buildEvent({
      error,
      process: r.process,
      release: r.release,
      environment: r.environment,
      context,
      now: r.now(),
    }),
    { hostname: r.hostname, username: r.username },
  );

  const now = r.now();
  // Re-read from the store rather than caching in memory. A cached copy goes
  // stale against any other writer and, more importantly, survives across the
  // very restarts a crash loop produces — which is when the counters matter.
  const state = parseState(r.store.read(), now);
  const verdict = decide(state, now, fingerprint(event), undefined);
  // Persist in both branches — the windows may have rolled forward even
  // when the event is dropped, and pinning them would leak quota.
  r.store.write(JSON.stringify(verdict.state));
  return verdict.allow ? event : null;
}

export async function captureError(
  error: unknown,
  context?: CaptureContext,
): Promise<boolean> {
  const r = rt;
  if (!r || !r.dsn) return false;
  try {
    const event = prepare(r, error, context);
    if (!event) return false;
    return await sendEvent(event, r.dsn, {
      clientName: `loadout/${r.release ?? "dev"}`,
      fetchImpl: r.fetchImpl,
    });
  } catch {
    // Reporting a crash must never cause one.
    return false;
  }
}

/** Fire-and-forget wrapper for non-fatal paths that can't await. */
export function captureErrorSync(error: unknown, context?: CaptureContext): void {
  void captureError(error, context).catch(() => {});
}

/**
 * Capture on a path where the process is about to die. Synchronous, no network.
 *
 * Use this wherever the process will not survive to the next tick. Two such
 * places exist today and neither can be fixed by awaiting:
 *
 *  - The overlay's `uncaughtException`: Electrobun registers its own listener
 *    when `electrobun/bun` is imported, and it calls a native `forceExit(1)`.
 *  - The management-loop `.catch`, which calls `process.exit(1)` immediately
 *    and must, because it owes Steam a prompt SIGCONT.
 *
 * An async send in either place is started and then killed mid-flight, which
 * is exactly what a reviewer found: the report never arrives. Writing the
 * already-scrubbed event to disk lands before the process dies, and the next
 * start drains it. Returns whether it was spooled.
 */
export function captureFatalSync(error: unknown, context?: CaptureContext): boolean {
  const r = rt;
  if (!r || !r.dsn) return false;
  try {
    const event = prepare(r, error, { ...context, level: context?.level ?? "fatal" });
    if (!event) return false;
    return spoolEvent(r.spoolDir, event, r.now());
  } catch {
    return false;
  }
}

/**
 * Send anything a previous run spooled. Called automatically at init.
 *
 * Consent is re-checked here, not just at write time: a user who spooled a
 * crash and then withdrew consent before the next start must not have it sent.
 */
export async function drainSpool(): Promise<number> {
  const r = rt;
  if (!r || !r.dsn) return 0;
  try {
    if (!isGranted(r.readConsent())) {
      // Consent withdrawn since these were written — discard, don't send.
      takeSpooled(r.spoolDir, r.now());
      return 0;
    }
    const events = takeSpooled(r.spoolDir, r.now());
    let sent = 0;
    for (const event of events) {
      const ok = await sendEvent(event, r.dsn, {
        clientName: `loadout/${r.release ?? "dev"}`,
        fetchImpl: r.fetchImpl,
      });
      if (ok) sent++;
    }
    return sent;
  } catch {
    return 0;
  }
}

/** Test seam: drop all module state. */
export function resetForTests(): void {
  rt = null;
  explicitConsent = undefined;
}
