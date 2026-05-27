/**
 * @loadout/steam-cdp — Chrome DevTools Protocol client + typed
 * wrappers around Steam's in-page JavaScript APIs.
 *
 * Two layers:
 *
 *   - Low-level `CDPClient` (and `CDPResponse`, `CDPEvent`): generic
 *     CDP WebSocket client. Useful for any CEF target, not just Steam.
 *   - High-level `SteamClient`: typed wrapper that auto-discovers
 *     Steam's SharedJSContext tab and exposes Steam's `window.SteamClient.*`
 *     namespaces (`apps`, …) as ergonomic Promise-returning methods.
 *
 * Plus tab discovery helpers (`findSharedJsTab`, `listCefTabs`,
 * `isSharedJSContextTab`, `SHARED_JS_CONTEXT_TITLES`) for callers that
 * want to manage their own CDP lifecycle.
 *
 * For the per-plugin "I need to call one Steam API once" pattern, prefer
 * `withSteamClient(fn)` — it lazy-connects, runs your callback, closes.
 */

export { CDPClient, type CDPResponse, type CDPEvent } from "./cdp-client";

export {
  SHARED_JS_CONTEXT_TITLES,
  isSharedJSContextTab,
  listCefTabs,
  findSharedJsTab,
  type CEFTab,
  type FindTabOptions,
} from "./tabs";

export {
  SteamClient,
  SteamClientUnreachableError,
  withSteamClient,
  type SteamClientOptions,
} from "./steam-client";
