/**
 * Route-module dispatch types for the loader's HTTP surface.
 *
 * The loader's `fetch` callback in `index.ts` originally inlined
 * every route block against a single closure capturing every service
 * the loader exposes (plugin RPC, steam-grid, user-config, plugin
 * static assets, inject bundles, …). Issue #87 / audit A-001
 * decomposes that monolith into per-route modules dispatched through
 * a single ordered list.
 *
 * Each route exports a `RouteHandler`: a `match` predicate plus an
 * async `handle` that takes the parsed URL, the request, and a
 * `RouteContext` carrying every service the routes consume.
 *
 * **Decomposition rules:**
 * - The auth gate (`/api/*` → `validateRequest`) stays in `index.ts`.
 *   It's cross-cutting and runs before dispatch.
 * - CORS preflight (`OPTIONS`) stays in `index.ts` for the same
 *   reason.
 * - WebSocket upgrade (`/ws`) is a route module, but its `handle`
 *   returns `undefined` after calling `server.upgrade(...)` because
 *   Bun expects the fetch callback to short-circuit there.
 * - Routes that need to short-circuit (WS upgrade) can return
 *   `Response | undefined`; everything else returns `Response`.
 *
 * The unblocked future-work is P1 (plugin process isolation) — the
 * `rpc` route module becomes the single dispatch surface where in-
 * process plugin imports are swapped for child-process IPC.
 */

import type { BunPlugin } from "bun";
import type { InjectBundles } from "../inject-builder";
import type { createRpcHandler } from "../rpc-handler";

/** Minimal shape the WebSocket clients implement (matches Bun's
 *  `ws.send`). Local to the loader; we don't import the full Bun
 *  `ServerWebSocket` here to keep the route modules unit-testable
 *  without booting `Bun.serve`. */
export interface WsClient {
  send(data: string): void;
}

/** Plugin meta + instance + permission-scoped fetch. Matches the
 *  loader's internal plugin map; the route modules treat each entry
 *  as opaque except for the dispatch-level fields. */
export interface LoadedPlugin {
  meta: {
    id: string;
    name: string;
    version: string;
    description?: string;
    author?: string;
  };
  instance: object;
  sandboxedFetch: typeof globalThis.fetch;
  hasApp: boolean;
}

/**
 * Shared services + state every route module needs. Constructed once
 * in `index.ts` inside `startServer()` and passed by reference to
 * every `handle()` call — routes never reach into closure-captured
 * state, so each module is unit-testable with a synthetic context.
 */
export interface RouteContext {
  // --- Server state ---
  readonly plugins: Map<string, LoadedPlugin>;
  readonly token: string;
  readonly wsClients: Set<WsClient>;
  readonly bundleCache: Map<string, string>;
  readonly injectBundles: InjectBundles;
  readonly pluginsDir: string;

  // --- Services ---
  readonly rpcHandler: ReturnType<typeof createRpcHandler>;
  readonly broadcastToPlugins: (
    method: string,
    args: unknown[],
  ) => Promise<number>;

  /**
   * (Re)apply the optional Steam main-menu "Loadout" entry (issue #169).
   * Backed by the CEF injector, which is constructed after this context —
   * so it's a capability closure rather than the injector object, and
   * returns a not-ready error until the injector exists. `mainMenu` is the
   * explicit desired state from the Settings toggle (avoids a config re-read
   * race); omit to fall back to persisted config.
   */
  readonly refreshOverlayButton: (
    mainMenu?: boolean,
  ) => Promise<{ ok: boolean; error?: string }>;

  // --- Build helpers ---
  /** Compile a plugin's app.tsx for the overlay — same Bun.build
   *  pipeline the server uses on hot-reload. */
  readonly compileTsx: (
    entrypoint: string,
  ) => Promise<{ code: string; ok: boolean }>;

  // --- Bun build plugins (re-exported so route modules don't
  //     duplicate the vendor/SDK global-rewrite logic). */
  readonly bunPlugins: BunPlugin[];
}

/**
 * A single route module. `match` runs first and is a pure predicate
 * over the parsed request — it MUST NOT consume the body, since
 * `handle` will. Keep `match` cheap (string compare on `pathname`
 * + optional `method` check); the loader iterates every registered
 * route on every request.
 *
 * `handle` returns `undefined` only in the WebSocket-upgrade case
 * where Bun's `server.upgrade(req, ...)` already wrote the response.
 * Every other route returns a `Response`.
 */
export interface RouteHandler {
  /** Stable identifier for logs / debugging. */
  readonly name: string;
  match(req: Request, url: URL): boolean;
  handle(
    req: Request,
    url: URL,
    ctx: RouteContext,
  ): Promise<Response | undefined>;
}
