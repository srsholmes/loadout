/**
 * The subset of the Sentry event protocol loadout actually sends.
 *
 * These types are deliberately narrow. We speak the Sentry wire format
 * by hand rather than pulling in an SDK, because the promise we make to
 * users in PRIVACY.md is "this is exactly what leaves your machine" —
 * and that promise is only checkable if every transmitted field is
 * spelled out in our own source. An SDK that auto-captures console
 * output, fetch breadcrumbs, and request headers cannot make that
 * promise honestly.
 *
 * The format is still Sentry's, so any Sentry-protocol backend works:
 * sentry.io, a self-hosted Sentry, or GlitchTip. Switching is a DSN
 * change, not a rewrite.
 */

/** Which loadout process a report came from. */
export type ProcessName = "backend" | "overlay-bun" | "webview";

/** Consent is tri-state: `undefined` means "not asked yet". */
export type ConsentState = "granted" | "denied" | undefined;

/** A single stack frame, Sentry's field names. */
export interface Frame {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  /** false for runtime/library frames, so Sentry greys them out. */
  in_app?: boolean;
}

export interface ExceptionValue {
  type: string;
  value: string;
  stacktrace?: { frames: Frame[] };
}

/**
 * A Sentry event. Note what is absent and stays absent:
 *   - `user` — never populated, so no id/email/ip_address.
 *   - `server_name` — the hostname. SDKs send this by default; Linux
 *     hostnames are frequently personal ("simons-deck"), so we never set it.
 *   - `breadcrumbs` — no console or network capture.
 *   - `request` — no URLs, headers, or cookies.
 */
export interface SentryEvent {
  event_id: string;
  timestamp: number;
  platform: "javascript" | "node";
  level: "error" | "fatal";
  release?: string;
  environment?: string;
  logger?: string;
  tags?: Record<string, string>;
  contexts?: Record<string, Record<string, unknown>>;
  exception?: { values: ExceptionValue[] };
  message?: { formatted: string };
}

/** Context attached at the callsite. */
export interface CaptureContext {
  /** Set when the fault is attributable to a plugin rather than core. */
  pluginId?: string;
  /** Extra low-cardinality tags. Values are scrubbed like everything else. */
  tags?: Record<string, string>;
  /** fatal = the process is going down. */
  level?: "error" | "fatal";
}
