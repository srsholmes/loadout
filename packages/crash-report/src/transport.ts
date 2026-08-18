/**
 * The wire. A Faro report is one HTTPS POST of a JSON body, which is why
 * loadout speaks the protocol directly instead of taking an SDK dependency:
 * the whole transport is the function below, and every byte it sends is
 * visible in this file and in types.ts.
 *
 * Shape confirmed against `@grafana/faro-web-sdk`'s fetch transport:
 *
 *   POST <collector url>
 *   Content-Type: application/json
 *   x-api-key: <key>              (only when the collector requires one)
 *   x-faro-session-id: <id>
 *   body: {"meta":{…},"exceptions":[…]}
 *
 * The collector accepts 202. 429 means rate-limited — the caller backs off by
 * leaving the event spooled rather than retrying in a loop.
 *
 * Why this endpoint and not OTLP: Grafana Cloud's OTLP endpoint needs a real
 * bearer token, and Grafana's own docs advise against pushing to it directly
 * from an application. Loadout ships to strangers' devices, so the only
 * acceptable ingest is one designed for untrusted public clients — which is
 * exactly what the Faro collector is built for.
 */

import type { FaroPayload } from "./types";

/**
 * Capture `fetch` at module load, before any plugin can run.
 *
 * The loader hosts every plugin backend in-process and `sandboxed-fetch.ts`
 * swaps `globalThis.fetch` per call to enforce each plugin's network
 * allow-list. Resolving `fetch` at call time would mean crash reports leave
 * through whatever wrapper is installed at the moment of the crash. Note this
 * is a backstop only — the loader also passes the real fetch in explicitly,
 * because `plugin-manager` is imported before this module and would otherwise
 * have already replaced the global.
 */
const originalFetch: typeof fetch = globalThis.fetch.bind(globalThis);

export interface Collector {
  /** Full collector URL, e.g. https://faro-collector-<region>.grafana.net/collect/<app-key> */
  url: string;
  /** Optional; Grafana Cloud embeds the app key in the URL path instead. */
  apiKey?: string;
}

/**
 * Parse a collector endpoint.
 *
 * Accepts `https://host/collect/<app-key>` (Grafana Cloud) or any http(s) URL
 * for a self-hosted receiver. Returns null rather than throwing on anything
 * malformed — a bad endpoint must disable reporting, never crash the process
 * it is meant to be observing.
 */
export function parseCollector(raw: string | undefined | null): Collector | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname) return null;
    return { url: u.toString() };
  } catch {
    return null;
  }
}

/** The exact bytes POSTed. Separated so tests can assert on them directly. */
export function buildBody(payload: FaroPayload): string {
  return JSON.stringify(payload);
}

export interface SendOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * POST one payload. Resolves true on acceptance, false on anything else.
 *
 * Never throws and never blocks for long. This runs on the crash path and, in
 * the overlay, on a shutdown path with hard real-time obligations — the
 * overlay must SIGCONT Steam promptly or the whole machine looks frozen. A
 * hung report there would be a far worse bug than a lost report.
 */
export async function sendEvent(
  payload: FaroPayload,
  collector: Collector,
  opts: SendOptions = {},
): Promise<boolean> {
  const { timeoutMs = 3000, fetchImpl = originalFetch } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (collector.apiKey) headers["x-api-key"] = collector.apiKey;
    const sessionId = payload.meta.session?.id;
    if (sessionId) headers["x-faro-session-id"] = sessionId;

    const res = await fetchImpl(collector.url, {
      method: "POST",
      headers,
      body: buildBody(payload),
      signal: controller.signal,
      // No redirects: the destination is fixed and a redirect would mean
      // something has gone wrong with it.
      redirect: "error",
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
