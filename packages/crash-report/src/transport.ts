/**
 * The wire. A Sentry event is one HTTPS POST of a newline-delimited
 * "envelope", which is why loadout speaks the protocol directly instead of
 * taking an SDK dependency: the whole transport is the function below, and
 * every byte it sends is visible in this file.
 *
 * Works unchanged against sentry.io, self-hosted Sentry, or GlitchTip.
 */

import type { SentryEvent } from "./types";

/**
 * Capture `fetch` at module load, before any plugin can run.
 *
 * The loader hosts every plugin backend in-process and `sandboxed-fetch.ts`
 * swaps `globalThis.fetch` per call to enforce each plugin's network
 * allow-list. Resolving `fetch` at call time would mean crash reports leave
 * through whatever wrapper happens to be installed at the moment of the
 * crash — either intercepted by plugin code, or blocked by a deny-list that
 * was never meant to apply to us. Binding it here removes both.
 */
const originalFetch: typeof fetch = globalThis.fetch.bind(globalThis);

export interface Dsn {
  publicKey: string;
  host: string;
  projectId: string;
  protocol: string;
}

/**
 * Parse `https://<publicKey>@<host>/<projectId>`.
 *
 * Returns null rather than throwing on anything malformed — a bad DSN must
 * disable reporting, never crash the process it's meant to be observing.
 */
export function parseDsn(dsn: string | undefined | null): Dsn | null {
  if (!dsn) return null;
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\/+/, "");
    if (!u.username || !u.hostname || !projectId) return null;
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return {
      publicKey: u.username,
      host: u.host,
      projectId,
      protocol: u.protocol.replace(":", ""),
    };
  } catch {
    return null;
  }
}

export function envelopeUrl(dsn: Dsn): string {
  return `${dsn.protocol}://${dsn.host}/api/${dsn.projectId}/envelope/`;
}

/** Newline-delimited envelope: header, item header, item payload. */
export function buildEnvelope(event: SentryEvent, dsn: Dsn): string {
  const header = JSON.stringify({
    event_id: event.event_id,
    sent_at: new Date().toISOString(),
    // Echoing the DSN in the envelope header is what lets a relay route the
    // event without re-parsing the auth header.
    dsn: `${dsn.protocol}://${dsn.publicKey}@${dsn.host}/${dsn.projectId}`,
  });
  const body = JSON.stringify(event);
  // `length` is in bytes, not characters — a stack trace containing any
  // non-ASCII would otherwise produce a short count and a rejected envelope.
  const length = new TextEncoder().encode(body).length;
  const itemHeader = JSON.stringify({ type: "event", length, content_type: "application/json" });
  return `${header}\n${itemHeader}\n${body}\n`;
}

export interface SendOptions {
  timeoutMs?: number;
  clientName?: string;
  fetchImpl?: typeof fetch;
}

/**
 * POST one event. Resolves true on acceptance, false on anything else.
 *
 * Never throws and never blocks for long. This runs on the crash path and,
 * in the overlay, on a shutdown path that has hard real-time obligations —
 * the overlay must SIGCONT Steam promptly or the whole machine looks frozen.
 * A hung report there would be a far worse bug than a lost report.
 */
export async function sendEvent(
  event: SentryEvent,
  dsn: Dsn,
  opts: SendOptions = {},
): Promise<boolean> {
  const { timeoutMs = 3000, clientName = "loadout", fetchImpl = originalFetch } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(envelopeUrl(dsn), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": [
          "Sentry sentry_version=7",
          `sentry_client=${clientName}`,
          `sentry_key=${dsn.publicKey}`,
        ].join(", "),
      },
      body: buildEnvelope(event, dsn),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
