/**
 * The subset of the Grafana Faro protocol loadout actually sends.
 *
 * These types are deliberately narrow and this file is the privacy contract:
 * the promise made in docs/privacy.md is "this is exactly what leaves your
 * machine", and that promise is only checkable if every transmitted field is
 * spelled out here. An SDK that auto-captures console output, fetch
 * breadcrumbs, page URLs and request headers cannot make that promise
 * honestly, which is why the wire format is emitted by hand.
 *
 * Shapes mirror `@grafana/faro-core` (`TransportBody`, `ExceptionEvent`,
 * `Meta`) so the payload is a valid Faro payload — it just carries far less
 * than the Web SDK would send. Anything Faro supports and we do not populate
 * is absent on purpose; see the notes on `FaroMeta`.
 */

/** Which loadout process a report came from. */
export type ProcessName = "backend" | "overlay-bun" | "webview";

/** Consent is tri-state: `undefined` means "not asked yet". */
export type ConsentState = "granted" | "denied" | undefined;

/**
 * A stack frame. Faro requires `filename` and `function` as strings, so
 * unknown values become "?" rather than being omitted.
 */
export interface FaroFrame {
  filename: string;
  function: string;
  lineno?: number;
  colno?: number;
}

/**
 * One exception.
 *
 * `fingerprint` is the interesting field: it is the top layer of Grafana's
 * error-grouping strategy, taking priority over its own stack-trace
 * normalisation. We compute it after scrubbing precisely so the same fault
 * from two different users collapses into one issue rather than N.
 */
export interface FaroException {
  timestamp: string;
  type: string;
  value: string;
  fatal?: boolean;
  fingerprint?: string;
  stacktrace?: { frames: FaroFrame[] };
  /** Low-cardinality string map. Values are scrubbed like everything else. */
  context?: Record<string, string>;
}

/**
 * Payload metadata.
 *
 * Note what is deliberately absent and must stay absent:
 *  - `user` — never populated, so no id, email, username or hash.
 *  - `app.installationId` — Faro supports a persistent install identifier.
 *    We do not send one; reports carry no cross-restart correlator.
 *  - `page` — no URLs.
 *  - `browser` — no user-agent, language, or viewport fingerprinting.
 *  - `device.*` beyond a coarse type — no serials, no manufacturer ids.
 *
 * `session.id` is regenerated on every process start and never persisted, so
 * it groups events within a single run and cannot correlate across restarts.
 * `session.overrides.geoLocationTrackingEnabled` is set to false to switch off
 * Grafana Cloud's IP-derived geolocation from the client side.
 */
export interface FaroMeta {
  sdk: { name: string; version?: string };
  app: { name: string; version?: string; environment?: string; namespace?: string };
  os: { name: string };
  session?: {
    id: string;
    overrides?: { geoLocationTrackingEnabled?: boolean };
  };
}

/** The exact JSON body POSTed to the Faro collector. */
export interface FaroPayload {
  meta: FaroMeta;
  exceptions: FaroException[];
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
