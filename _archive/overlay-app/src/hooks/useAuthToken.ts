/**
 * Shared auth token utilities for the overlay app.
 *
 * The server injects `window.__LOADOUT_TOKEN__` into the overlay HTML.
 * All /api/* and WebSocket calls must include this token.
 */

export function getAuthToken(): string {
  return (window as any).__LOADOUT_TOKEN__ || "";
}

export function authHeaders(): HeadersInit {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function wsUrlWithToken(path: string): string {
  const token = getAuthToken();
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${path}?token=${encodeURIComponent(token)}`;
}
