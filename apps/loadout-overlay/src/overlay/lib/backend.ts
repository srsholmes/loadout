/**
 * Backend connection layer.
 *
 * Handles session token fetching (replaces server-side HTML injection)
 * and provides authenticated fetch/WebSocket helpers.
 */

import { BACKEND_URL } from "./config";

let sessionToken: string | null = null;

/**
 * Fetch the session token from the Bun server.
 * Retries with exponential backoff until the server is reachable.
 */
export async function initBackend(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${BACKEND_URL}/api/token`);
      if (res.ok) {
        const data = await res.json();
        sessionToken = data.token;
        // Backward compat for ws-client.ts which reads from window
        window.__LOADOUT_TOKEN__ = sessionToken ?? undefined;
        console.log("[backend] Token acquired");
        return;
      }
    } catch {}
    const delay = Math.min(1000 * 2 ** attempt, 10000);
    console.warn(`[backend] Server not ready, retrying in ${delay}ms...`);
    await new Promise((r) => setTimeout(r, delay));
  }
}

/** Get the current auth token. */
export function getAuthToken(): string {
  return sessionToken || "";
}

/** Get headers with auth token for fetch calls. */
export function authHeaders(): HeadersInit {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Get the full URL for a backend API path. */
export function apiUrl(path: string): string {
  return `${BACKEND_URL}${path}`;
}

/** Get the URL for a plugin bundle. */
export function pluginBundleUrl(pluginId: string): string {
  return `${BACKEND_URL}/plugins/${pluginId}/app-bundle.js`;
}

/**
 * Load a plugin bundle as an ES module.
 *
 * The overlay's webview origin is `views://` (Electrobun) so a direct
 * import("http://localhost:33820/...") is cross-origin and blocked.
 * Instead, fetch the JS text and import a same-origin blob URL.
 *
 * Results are cached by plugin id because the PluginHost (body) and
 * PluginHeaderHost (topbar) both import the same bundle — without a
 * cache, every plugin navigation fetches and compiles the module
 * twice. That also lets the import-module graph grow unboundedly as
 * the user clicks through plugins; a single resolved promise per
 * plugin keeps the memory footprint bounded.
 *
 * The cache is process-lifetime: plugin bundle swaps (dev HMR, full
 * reinstall) land via a page reload, which drops the cache entirely.
 */
const bundleCache = new Map<string, Promise<Record<string, unknown>>>();

/** Backoff before each retry of a transient bundle fetch, in ms.
 *
 *  This is a ~4 s wall-clock budget, not "4 chances": a flushed request fails
 *  instantly, so each attempt is exposed for only a single-digit-ms loopback
 *  round trip. Surviving a flush needs a few ms of calm, which the first rung
 *  already buys. The later rungs are there because NetworkChangeNotifierLinux
 *  fires per netlink RTM_NEWADDR — v4 lease, v6 link-local, v6 SLAAC, and on a
 *  host bringing up both eth0 and wlan0 those can spread over seconds. Nobody
 *  is blocked on the outcome (a failure just renders a widget placeholder), so
 *  the extra rungs cost nothing on the success path.
 *
 *  Note the ladder does NOT key off backend reachability: the server is on
 *  loopback and answers with no network at all, so initBackend succeeding says
 *  nothing about whether an interface is about to come up and flush the pool. */
const BUNDLE_RETRY_DELAYS_MS = [150, 400, 1000, 2500];

/** Transient = worth retrying. A thrown fetch is a network-layer failure
 *  (ERR_NETWORK_CHANGED, connection reset, …) and 5xx is a server hiccup;
 *  both usually clear on the next attempt. A 4xx is a real answer — the
 *  plugin is gone or unauthorized — and retrying just repeats it. */
function isRetriableStatus(status: number): boolean {
  return status >= 500;
}

/** Fetch the bundle source, retrying transient failures.
 *
 *  Why this exists: the overlay fires every plugin's bundle fetch in
 *  parallel ~3 ms into page load. On a handheld that boots straight into
 *  gaming mode, Wi-Fi is often still associating at that moment — when the
 *  interface activates, Chromium's network-change notifier flushes the
 *  socket pool and every in-flight request dies with ERR_NETWORK_CHANGED
 *  (surfaced to JS as a bare `TypeError: Failed to fetch`). Whichever
 *  bundles had already landed were fine; the rest failed, and since nothing
 *  re-requested them, their widgets and icons stayed broken for the whole
 *  session — until someone restarted the overlay by hand. */
export async function fetchBundleSource({
  pluginId,
  delays = BUNDLE_RETRY_DELAYS_MS,
}: {
  pluginId: string;
  /** Overridable so tests don't pay the real backoff. */
  delays?: readonly number[];
}): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) {
      // No `?? fallback`: attempt is bounded by delays.length, so this index
      // is always in range. A fallback here would turn a future off-by-one
      // into a silently different ladder instead of a loud failure.
      const delay = delays[attempt - 1];
      console.warn(
        `[bundle] retry ${attempt}/${delays.length} for ${pluginId} in ${delay}ms (${lastErr instanceof Error ? lastErr.message : String(lastErr)})`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
    // Cache-bust per ATTEMPT, not per call: a retry must not be served the
    // failed response out of the HTTP cache.
    const url = `${pluginBundleUrl(pluginId)}?t=${Date.now()}`;

    // Each stage is caught separately so the non-retriable throw below sits
    // OUTSIDE any try that could swallow it. Sniffing the message to tell
    // "the 4xx I just threw" from "a network error" would make correctness
    // rest on a string prefix.
    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      lastErr = err; // network layer: ERR_NETWORK_CHANGED, conn reset, …
      continue;
    }

    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} loading ${pluginId} bundle`);
      if (!isRetriableStatus(res.status)) throw err;
      lastErr = err;
      continue;
    }

    try {
      // Retried on purpose: a body that dies mid-stream is the shape a flush
      // takes when it lands after the response headers arrived.
      return await res.text();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`failed to load ${pluginId} bundle: ${String(lastErr)}`);
}

export async function importPluginBundle(pluginId: string): Promise<Record<string, unknown>> {
  const cached = bundleCache.get(pluginId);
  if (cached) {
    console.log(`[bundle] cache hit: ${pluginId}`);
    return cached;
  }

  console.log(`[bundle] fetching: ${pluginId}`);
  const t0 = performance.now();
  const promise = (async () => {
    // Only the fetch is retried. A bundle that downloads but fails to
    // evaluate is a build error, not a blip — re-importing it would fail
    // identically, so that error propagates on the first attempt.
    const text = await fetchBundleSource({ pluginId });
    const blob = new Blob([text], { type: "application/javascript" });
    const blobUrl = URL.createObjectURL(blob);
    try {
      const mod = await import(/* @vite-ignore */ blobUrl);
      console.log(`[bundle] loaded: ${pluginId} (${(performance.now() - t0).toFixed(0)}ms, ${text.length}B, exports=${Object.keys(mod).join(",")})`);
      return mod;
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  })();

  // Drop a failed promise so the next attempt retries instead of
  // permanently serving the error.
  promise.catch((err) => {
    console.error(`[bundle] failed: ${pluginId}`, err);
    bundleCache.delete(pluginId);
  });
  bundleCache.set(pluginId, promise);
  return promise;
}
