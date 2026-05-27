/**
 * Backend connection layer.
 *
 * Handles session token fetching (replaces server-side HTML injection)
 * and provides authenticated fetch/WebSocket helpers.
 */

import { BACKEND_URL, BACKEND_WS } from "./config";

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

/** Get the WebSocket URL with auth token. */
export function wsUrl(): string {
  const token = getAuthToken();
  return `${BACKEND_WS}/ws?token=${encodeURIComponent(token)}`;
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

export async function importPluginBundle(pluginId: string): Promise<Record<string, unknown>> {
  const cached = bundleCache.get(pluginId);
  if (cached) {
    console.log(`[bundle] cache hit: ${pluginId}`);
    return cached;
  }

  console.log(`[bundle] fetching: ${pluginId}`);
  const t0 = performance.now();
  const promise = (async () => {
    const url = `${pluginBundleUrl(pluginId)}?t=${Date.now()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} loading ${pluginId} bundle`);
    const text = await res.text();
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
