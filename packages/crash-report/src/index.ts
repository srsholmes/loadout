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

import { join } from "node:path";
import { homedir, hostname } from "node:os";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { isGranted, readConsentSync } from "./consent";
import { buildEvent } from "./event";
import { decide, parseState, type RateLimitState } from "./rate-limit";
import { fingerprint, scrubEvent } from "./scrub";
import { parseDsn, sendEvent, type Dsn } from "./transport";
import type { CaptureContext, ConsentState, ProcessName } from "./types";

export type { CaptureContext, ConsentState, ProcessName, SentryEvent } from "./types";
export { CRASH_REPORTING_KEY, parseConsent, readConsentSync, isGranted } from "./consent";
export { scrubEvent, scrubString, fingerprint } from "./scrub";
export { parseStack, buildEvent } from "./event";
export { parseDsn, buildEnvelope } from "./transport";
export { decide, parseState, DEFAULT_LIMITS } from "./rate-limit";

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

function defaultStatePath(env: Record<string, string | undefined>, home: string): string {
  const xdg = env.XDG_STATE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(home, ".local", "state");
  return join(base, "loadout", "crash-report.json");
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
  state: RateLimitState | null;
  /** Resolved once at init; scrubbed out of every outgoing string. */
  hostname?: string;
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
    store: opts.stateStore ?? fileStateStore(defaultStatePath(env, home)),
    now: opts.now ?? Date.now,
    fetchImpl: opts.fetchImpl,
    state: null,
    hostname: opts.hostname ?? safeHostname(),
  };
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
export async function captureError(
  error: unknown,
  context?: CaptureContext,
): Promise<boolean> {
  const r = rt;
  if (!r || !r.dsn) return false;
  // Re-checked on every capture, not cached: revoking consent has to take
  // effect immediately, not at next restart.
  if (!isGranted(r.readConsent())) return false;

  try {
    const event = scrubEvent(
      buildEvent({
        error,
        process: r.process,
        release: r.release,
        environment: r.environment,
        context,
        now: r.now(),
      }),
      { hostname: r.hostname },
    );

    const now = r.now();
    if (r.state === null) r.state = parseState(r.store.read(), now);
    const verdict = decide(r.state, now, fingerprint(event), undefined);
    // Persist in both branches — the windows may have rolled forward even
    // when the event is dropped, and pinning them would leak quota.
    r.state = verdict.state;
    r.store.write(JSON.stringify(verdict.state));
    if (!verdict.allow) return false;

    return await sendEvent(event, r.dsn, {
      clientName: `loadout/${r.release ?? "dev"}`,
      fetchImpl: r.fetchImpl,
    });
  } catch {
    // Reporting a crash must never cause one.
    return false;
  }
}

/** Fire-and-forget wrapper for paths that can't await. */
export function captureErrorSync(error: unknown, context?: CaptureContext): void {
  void captureError(error, context).catch(() => {});
}

/** Test seam: drop all module state. */
export function resetForTests(): void {
  rt = null;
  explicitConsent = undefined;
}
