/**
 * Turning an `Error` into a Sentry event.
 *
 * Stack parsing covers both runtimes we care about with one parser: Bun and
 * CEF are both V8-shaped ("    at fn (file:line:col)"), so the backend, the
 * overlay's Bun process, and the webview all produce the same frame format.
 */

import type { CaptureContext, Frame, ProcessName, SentryEvent } from "./types";

/** Frames we mark `in_app: false` so Sentry greys them out and grouping ignores them. */
const VENDOR = /(?:^|\/)(?:node_modules|bun:|node:)/;

const AT_LINE = /^\s*at\s+(?:(?<fn>.*?)\s+\()?(?<file>.*?):(?<line>\d+):(?<col>\d+)\)?\s*$/;

/**
 * Parse a V8 stack string into Sentry frames.
 *
 * Sentry renders frames oldest-first, the reverse of how V8 prints them, so
 * the result is reversed. Lines that don't parse are skipped rather than
 * guessed at — a malformed frame is worse than a missing one.
 */
export function parseStack(stack: string | undefined): Frame[] {
  if (!stack) return [];
  const frames: Frame[] = [];
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
      function: fn && fn.length > 0 ? fn : undefined,
      lineno: Number(m.groups.line),
      colno: Number(m.groups.col),
      in_app: !VENDOR.test(filename),
    });
  }
  return frames.reverse();
}

/** 32 lowercase hex chars, per the Sentry protocol. */
export function newEventId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export interface BuildEventInput {
  error: unknown;
  process: ProcessName;
  release?: string;
  environment?: string;
  context?: CaptureContext;
  /** Injected for tests. */
  now?: number;
  eventId?: string;
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

export function buildEvent(input: BuildEventInput): SentryEvent {
  const { type, value, stack } = describe(input.error);
  const tags: Record<string, string> = {
    process: input.process,
    ...(input.context?.tags ?? {}),
  };
  // Plugin attribution: tagged so third-party faults can be routed away from
  // the core crash feed rather than reading as loadout bugs.
  if (input.context?.pluginId) {
    tags.plugin_id = input.context.pluginId;
    tags.fault_origin = "plugin";
  } else {
    tags.fault_origin = "core";
  }

  return {
    event_id: input.eventId ?? newEventId(),
    timestamp: (input.now ?? Date.now()) / 1000,
    platform: input.process === "webview" ? "javascript" : "node",
    level: input.context?.level ?? "error",
    release: input.release,
    environment: input.environment,
    logger: input.process,
    tags,
    contexts: {
      // Deliberately minimal. No hostname, no user, no device serial.
      os: { name: "linux" },
      runtime: { name: input.process === "webview" ? "cef" : "bun" },
    },
    exception: {
      values: [{ type, value, stacktrace: { frames: parseStack(stack) } }],
    },
  };
}
