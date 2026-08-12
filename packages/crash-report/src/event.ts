/**
 * Turning an `Error` into a Faro payload.
 *
 * Stack parsing covers both runtimes with one parser: Bun and CEF are both
 * V8-shaped ("    at fn (file:line:col)"), so the backend, the overlay's Bun
 * process and the webview all produce identical frame output.
 */

import type {
  CaptureContext,
  FaroException,
  FaroFrame,
  FaroMeta,
  FaroPayload,
  ProcessName,
} from "./types";

/**
 * Frames from the runtime or third-party code. Faro filters library frames out
 * of its own grouping, but we still need the distinction locally: our
 * fingerprint is computed over app frames only, and it is the layer Grafana
 * gives priority to.
 */
const VENDOR = /(?:^|\/)(?:node_modules|bun:|node:)/;

const AT_LINE = /^\s*at\s+(?:(?<fn>.*?)\s+\()?(?<file>.*?):(?<line>\d+):(?<col>\d+)\)?\s*$/;

/** A frame plus the local-only flag used for fingerprinting. Never serialised. */
export interface ParsedFrame extends FaroFrame {
  inApp: boolean;
}

/**
 * Parse a V8 stack string into frames.
 *
 * Order is **innermost-first** — the throw site is `frames[0]` — which is
 * V8's own print order and what Faro expects. Confirmed against upstream:
 * `getStackFramesFromError` builds its array with `lines.reduce(… acc.push …)`
 * over `error.stack.split('\n')` and never reverses, and its test asserts the
 * throw site at index 0.
 *
 * Worth stating because the opposite is also true somewhere: Sentry renders
 * oldest-first, so this function used to reverse. That reversal was correct
 * then and silently wrong after the move to Faro — it inverted every stack
 * trace on the wire, putting the process entry point where the failing frame
 * should be. Note `fingerprint()` in scrub.ts takes the *first* few frames
 * for the same reason; the two must agree.
 *
 * Lines that don't parse are skipped rather than guessed at — a malformed
 * frame is worse than a missing one.
 */
export function parseStack(stack: string | undefined): ParsedFrame[] {
  if (!stack) return [];
  const frames: ParsedFrame[] = [];
  for (const line of stack.split("\n")) {
    const m = AT_LINE.exec(line);
    if (!m?.groups) continue;
    const file = m.groups.file ?? "";
    // Strip the scheme CEF and Bun put on module paths so frames from the
    // two runtimes group together.
    const filename = file.replace(/^(?:file|views):\/\/+/, "/");
    const fn = m.groups.fn?.replace(/^(?:async|new)\s+/, "");
    frames.push({
      filename,
      // Faro types these as required strings.
      function: fn && fn.length > 0 ? fn : "?",
      lineno: Number(m.groups.line),
      colno: Number(m.groups.col),
      inApp: !VENDOR.test(filename),
    });
  }
  return frames;
}

/** Session ids are per-process and never persisted — see FaroMeta. */
export function newSessionId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export interface BuildEventInput {
  error: unknown;
  process: ProcessName;
  release?: string;
  environment?: string;
  sessionId?: string;
  context?: CaptureContext;
  /** Injected for tests. */
  now?: number;
}

/**
 * Coerce anything throwable into a type/value pair. Non-Errors reach here
 * often enough to matter — an `unhandledRejection` can carry any value.
 */
function describe(error: unknown): { type: string; value: string; stack?: string } {
  if (error instanceof Error) {
    return { type: error.name || "Error", value: error.message, stack: error.stack };
  }
  if (typeof error === "string") return { type: "Error", value: error };
  try {
    return { type: "Error", value: JSON.stringify(error) ?? String(error) };
  } catch {
    return { type: "Error", value: String(error) };
  }
}

export function buildMeta(input: BuildEventInput): FaroMeta {
  return {
    sdk: { name: "loadout-crash-report", version: input.release },
    app: {
      name: "loadout",
      version: input.release,
      environment: input.environment,
      // Which of the three processes produced this. Faro has no first-class
      // field for it and `namespace` is the closest fit; also duplicated into
      // the exception context so it is filterable either way.
      namespace: input.process,
    },
    os: { name: "linux" },
    session: {
      id: input.sessionId ?? newSessionId(),
      // Switch off Grafana Cloud's IP-derived geolocation from the client.
      overrides: { geoLocationTrackingEnabled: false },
    },
  };
}

export function buildEvent(input: BuildEventInput): FaroPayload {
  const { type, value, stack } = describe(input.error);
  const frames = parseStack(stack);

  const context: Record<string, string> = {
    process: input.process,
    ...(input.context?.tags ?? {}),
  };
  // Plugin attribution: tagged so third-party faults can be routed away from
  // the core crash feed rather than reading as loadout bugs.
  if (input.context?.pluginId) {
    context.plugin_id = input.context.pluginId;
    context.fault_origin = "plugin";
  } else {
    context.fault_origin = "core";
  }

  const exception: FaroException = {
    timestamp: new Date(input.now ?? Date.now()).toISOString(),
    type,
    value,
    fatal: input.context?.level === "fatal",
    stacktrace: { frames: frames.map(stripLocal) },
    context,
  };

  return { meta: buildMeta(input), exceptions: [exception] };
}

/** Drop the local-only `inApp` flag; it is not part of the wire format. */
function stripLocal(frame: ParsedFrame): FaroFrame {
  const { inApp: _inApp, ...wire } = frame;
  return wire;
}
