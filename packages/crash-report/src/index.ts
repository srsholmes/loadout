/**
 * @loadout/crash-report — opt-in crash reporting, via Grafana Faro.
 *
 * Callsites see exactly two things: `initCrashReporting` once at startup and
 * `captureError` / `captureFatalSync` on the crash paths. Everything
 * protocol-specific is behind this boundary, which is what kept the move from
 * Sentry to Faro down to two files.
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
import { buildEvent, newSessionId } from "./event";
import { decide, parseState } from "./rate-limit";
import { fingerprint, scrubEvent } from "./scrub";
import { parseCollector, sendEvent, type Collector } from "./transport";
import { spoolEvent, takeSpooled } from "./spool";
import type { CaptureContext, ConsentState, FaroPayload, ProcessName } from "./types";

export type { CaptureContext, ConsentState, ProcessName, FaroPayload, FaroException, FaroMeta, FaroFrame } from "./types";
export { CRASH_REPORTING_KEY, parseConsent, readConsentSync, isGranted } from "./consent";
export { scrubEvent, scrubString, fingerprint } from "./scrub";
export { parseStack, buildEvent, buildMeta, newSessionId } from "./event";
export { parseCollector, buildBody } from "./transport";
export { decide, parseState, DEFAULT_LIMITS } from "./rate-limit";
export { spoolEvent, takeSpooled, MAX_SPOOL_FILES, MAX_SPOOL_AGE_MS, MAX_SPOOL_ATTEMPTS } from "./spool";

/** Where the rate limiter keeps its counters. Abstracted so the webview,
 *  which has no filesystem, can back it with localStorage instead. */
export interface StateStore {
  read(): string | null;
  write(value: string): void;
}

/**
 * Hand back ownership of anything we create under the user's home.
 *
 * The root backend and the user-level overlay share `$HOME`, so whichever
 * runs first creates the state directory — and the backend always wins, since
 * it starts at multi-user.target while the overlay waits for
 * graphical-session.target. Left root-owned, every subsequent write from the
 * overlay fails EACCES and is swallowed, leaving it with no spool and no
 * cross-restart rate limiting at all.
 *
 * Per-process *filenames* do not fix this; the shared parent directory is the
 * problem. The backend passes `chownToTarget` here, the same hook
 * `user-config.ts` already uses for `~/.config/loadout`.
 */
export type ChownHook = (path: string) => void;

export function fileStateStore(path: string, chown?: ChownHook): StateStore {
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
        const dir = join(path, "..");
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, value, "utf8");
        chown?.(dir);
        chown?.(path);
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
  /** Product version — becomes `meta.app.version`. */
  release?: string;
  /** Defaults to "development" for dev builds, else "production". */
  environment?: string;
  /**
   * Faro collector URL, e.g.
   * `https://faro-collector-<region>.grafana.net/collect/<app-key>`.
   *
   * Resolution order: this option, then `$LOADOUT_CRASH_COLLECTOR`, then none.
   * With no collector, reporting is inert — the intended state until an app is
   * provisioned, and what makes dogfooding safe by default.
   */
  collectorUrl?: string;
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
  /**
   * Hand ownership of created files back to the desktop user. The root
   * backend must pass this; see {@link ChownHook}.
   */
  chown?: ChownHook;
  /**
   * Override `os.homedir()`. Exists so tests can exercise the *real* default
   * consent supplier — the one that reads config.json — against a temporary
   * home, instead of every test injecting its own `readConsent` and leaving
   * the shipped default uncovered.
   */
  homeOverride?: string;
}

interface Runtime {
  process: ProcessName;
  release?: string;
  environment: string;
  collector: Collector | null;
  readConsent: () => ConsentState;
  store: StateStore;
  now: () => number;
  fetchImpl?: typeof fetch;
  /** Resolved once at init; scrubbed out of every outgoing string. */
  hostname?: string;
  username?: string;
  spoolDir: string;
  chown?: ChownHook;
  /**
   * Regenerated on every process start and never persisted, so it groups
   * events within one run without correlating across restarts.
   */
  sessionId: string;
}

let rt: Runtime | null = null;
let explicitConsent: ConsentState;

/**
 * Wire up reporting. Safe to call in any process, including with no collector
 * configured — that just makes every later `captureError` a no-op.
 */
export function initCrashReporting(opts: InitOptions): void {
  const env = typeof process !== "undefined" ? process.env : {};
  const home = opts.homeOverride ?? safeHomedir();
  const collector = parseCollector(opts.collectorUrl ?? env.LOADOUT_CRASH_COLLECTOR);
  const isDev = !opts.release || opts.release === "dev";

  rt = {
    process: opts.process,
    release: opts.release,
    environment: opts.environment ?? (isDev ? "development" : "production"),
    collector,
    readConsent:
      opts.readConsent ??
      (opts.process === "webview"
        ? () => explicitConsent
        : () => readConsentSync(env, home)),
    store:
      opts.stateStore ??
      fileStateStore(defaultStatePath(env, home, opts.process), opts.chown),
    now: opts.now ?? Date.now,
    fetchImpl: opts.fetchImpl,
    hostname: opts.hostname ?? safeHostname(),
    username: opts.username ?? basename(home),
    spoolDir: opts.spoolDir ?? defaultSpoolDir(env, home, opts.process),
    chown: opts.chown,
    sessionId: newSessionId(),
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
  return !!rt && !!rt.collector && isGranted(rt.readConsent());
}

/**
 * Capture an error. Returns whether it was accepted by the server, so crash
 * handlers that are about to exit can await it; everywhere else, ignore it.
 *
 * Resolves false — never rejects — for every failure mode: no consent, no
 * collector, rate-limited, network down, server angry.
 */
/**
 * Shared front half of every capture: consent gate, build, scrub, rate limit.
 *
 * Returns the scrubbed event when it may be sent, or null. Both the async and
 * the fatal path go through here, so scrubbing cannot be bypassed by adding a
 * new entry point — a property the tests assert against the transmitted bytes.
 */
function prepare(r: Runtime, error: unknown, context?: CaptureContext): FaroPayload | null {
  // Re-checked on every capture, not cached: revoking consent has to take
  // effect immediately, not at next restart.
  if (!isGranted(r.readConsent())) return null;

  const event = scrubEvent(
    buildEvent({
      error,
      process: r.process,
      release: r.release,
      environment: r.environment,
      sessionId: r.sessionId,
      context,
      now: r.now(),
    }),
    { hostname: r.hostname, username: r.username },
  );

  // Computed after scrubbing, so it is identical across machines hitting the
  // same bug. Serves double duty: the local dedup key below, and
  // `FaroException.fingerprint` on the wire — the top layer of Grafana's error
  // grouping, which takes priority over its own stack normalisation. Without
  // it, one bug on N devices can read as N issues.
  const fp = fingerprint(event);
  for (const ex of event.exceptions) ex.fingerprint = fp;

  const now = r.now();
  // Re-read from the store rather than caching in memory. A cached copy goes
  // stale against any other writer and, more importantly, survives across the
  // very restarts a crash loop produces — which is when the counters matter.
  const state = parseState(r.store.read(), now);
  const verdict = decide(state, now, fp, undefined);
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
  if (!r || !r.collector) return false;
  try {
    const event = prepare(r, error, context);
    if (!event) return false;
    return await sendEvent(event, r.collector, { fetchImpl: r.fetchImpl });
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
  if (!r || !r.collector) return false;
  try {
    const event = prepare(r, error, { ...context, level: context?.level ?? "fatal" });
    if (!event) return false;
    return spoolEvent(r.spoolDir, event, r.now(), 0, r.chown);
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
  if (!r || !r.collector) return 0;
  try {
    if (!isGranted(r.readConsent())) {
      // Consent withdrawn since these were written — discard, don't send.
      takeSpooled(r.spoolDir, r.now());
      return 0;
    }
    const entries = takeSpooled(r.spoolDir, r.now());
    let sent = 0;
    for (const { event, attempts } of entries) {
      const ok = await sendEvent(event, r.collector, { fetchImpl: r.fetchImpl });
      if (ok) {
        sent++;
      } else {
        // Put it back. `takeSpooled` unlinks on read, so without this a drain
        // that runs while the device is offline would destroy every queued
        // report — the precise situation the spool exists for. The attempt
        // counter stops a permanently-unsendable event retrying forever.
        spoolEvent(r.spoolDir, event, r.now(), attempts + 1, r.chown);
      }
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
