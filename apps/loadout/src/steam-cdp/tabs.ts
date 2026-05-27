/**
 * Lightweight CEF tab discovery for Steam's debug port.
 *
 * `@loadout/injector` has a more sophisticated discovery flow with
 * retry / timeout — used at boot when waiting for Steam to come up. This
 * module offers the *one-shot* variant: fetch the tab list once, find the
 * SharedJSContext tab, return it. Consumers that need to hold a CDP
 * connection open for the whole session should prefer the injector helpers;
 * consumers that connect → evaluate → close per call (typical for plugin
 * RPC calls) should prefer these.
 */

export interface CEFTab {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
  type: string;
}

/**
 * Tab titles Steam uses for the SharedJSContext (the tab where
 * `window.SteamClient` and the SteamUI React tree live).
 *
 * Steam has used several titles across versions / branches; we accept
 * the union and resolve to the first match. The trademarked variant
 * is the canonical name in current desktop Steam.
 */
export const SHARED_JS_CONTEXT_TITLES: ReadonlySet<string> = new Set([
  "SharedJSContext",
  "Steam Shared Context presented by Valve™",
  "Steam",
  "SP",
]);

/**
 * URL fragments that confirm a tab is in the GamepadUI / Big Picture
 * runtime (where SharedJSContext-styled tabs actually expose
 * `window.SteamClient`). Used as a tiebreaker when multiple tabs share
 * the title `"Steam"`.
 */
const SHARED_JS_CONTEXT_URL_HINTS: ReadonlyArray<string> = [
  "https://steamloopback.host/routes/",
  "https://steamloopback.host/index.html",
];

export function isSharedJSContextTab(tab: CEFTab): boolean {
  if (!SHARED_JS_CONTEXT_TITLES.has(tab.title)) return false;
  return SHARED_JS_CONTEXT_URL_HINTS.some((hint) => tab.url.includes(hint));
}

export interface FindTabOptions {
  /** Steam's CEF debug port. Defaults to `8080`. */
  debugPort?: number;
  /** Abort the underlying fetch after this many ms. Defaults to `5000`.
   *  Was 2000 originally; bumped after observing /json timing out >2s
   *  during Steam game-state transitions (e.g. when the previous
   *  non-Steam shortcut just exited and Steam is mid-cleanup). */
  timeoutMs?: number;
}

/**
 * Fetch the live CEF tab list from `localhost:<debugPort>/json`.
 * Throws on network failure / timeout / non-200 response — the caller
 * decides how to handle (typically: fall back to a non-CDP code path).
 */
export async function listCefTabs(
  opts: FindTabOptions = {},
): Promise<CEFTab[]> {
  const debugPort = opts.debugPort ?? 8080;
  const timeoutMs = opts.timeoutMs ?? 5000;

  const res = await fetch(`http://localhost:${debugPort}/json`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`CEF /json returned status ${res.status}`);
  }
  return (await res.json()) as CEFTab[];
}

/**
 * Find the SharedJSContext tab. Returns `null` if no matching tab is
 * present (Steam not running, debug port not reachable, or running an
 * unfamiliar UI variant) — does NOT throw, since the typical caller
 * wants to fall back rather than abort.
 */
export async function findSharedJsTab(
  opts: FindTabOptions = {},
): Promise<CEFTab | null> {
  try {
    const tabs = await listCefTabs(opts);
    return tabs.find(isSharedJSContextTab) ?? null;
  } catch {
    return null;
  }
}
