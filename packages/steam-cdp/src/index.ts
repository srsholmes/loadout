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
 *
 * Separately, `callSteamService` reaches Valve's *authenticated protobuf
 * services* from inside Steam's page (see `./services.ts`) — a much wider
 * surface than `window.SteamClient`, and the only way to answer questions
 * about games the user owns but hasn't installed.
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

export {
  buildCallExpression,
  callSteamService,
  chunkCacheKey,
  clearServiceModuleCache,
  findModuleIdInSource,
  resolveServiceModuleId,
  SteamServiceError,
  type CallServiceOptions,
  type ResolveOptions,
  type SteamServiceErrorCode,
  type SteamServiceSpec,
} from "./services";
