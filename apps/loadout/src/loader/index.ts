/**
 * Loadout Server
 *
 * Bun HTTP + WebSocket server that:
 * - Serves the overlay app (HTML + compiled JS)
 * - Compiles plugin app.tsx bundles on the fly
 * - Provides WebSocket RPC for plugin frontend ↔ backend communication
 * - Watches plugin files for hot reload during development
 */

import { join, sep } from "node:path";
import type { RpcEvent } from "@loadout/types";
import { resolveMethod } from "@loadout/types";
import { loadPlugins, withSandboxedFetch } from "./plugin-manager";
import { createRpcHandler } from "./rpc-handler";
import { log } from "./logger";
import { generateSessionToken, validateRequest } from "./auth";
import {
  GameDetectionService,
  GAME_DETECTION_SERVICE_ID,
} from "./services/game-detection";
import {
  buildInjectBundles,
  sdkGlobalPlugin,
  vendorGlobalsPlugin,
  type InjectBundles,
} from "./inject-builder";
import { SteamInjector } from "../injector";
import { dispatchRoute, type RouteContext } from "./routes";

// Global error handlers — prevent plugin crashes from killing the server.
// The real fix is process isolation (P1 TODO), but this keeps the server alive
// in production. In debug mode we let exceptions through so they surface in
// the log + crash the service (systemd restarts it), making real bugs
// observable instead of silently swallowed. Audit 2026-05 A-009.

/**
 * Decide whether the loader is running in debug mode. Two switches:
 *   - `LOADOUT_DEBUG=1` env var
 *   - `--debug` somewhere in argv
 *
 * Either one re-throws all uncaught exceptions so they surface in the log
 * and crash the service. In production (default) we keep the current
 * swallow-everything-but-OOM behaviour, because without P1 process
 * isolation a single misbehaving plugin would otherwise take the server
 * (and every other plugin) down.
 *
 * Exported for tests.
 */
export function isDebugMode(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): boolean {
  if (env.LOADOUT_DEBUG === "1") return true;
  if (argv.includes("--debug")) return true;
  return false;
}

/**
 * Pure decision: should this uncaught exception be re-thrown (= crash the
 * service) or swallowed (= keep the server alive)?
 *
 * Exported for tests so we don't have to drive the real `process.on`
 * handler through a child process.
 */
export function shouldRethrowUncaught(
  err: Error,
  debug: boolean = isDebugMode(),
): boolean {
  // OOM is always fatal — we can't recover and continuing would just
  // crash worse later. Re-throw regardless of debug mode.
  if (err.message?.includes("out of memory")) return true;
  // In debug mode, surface every uncaught exception. systemd will
  // restart us; the operator gets a real stack trace in the log.
  if (debug) return true;
  // Production: swallow and keep the server alive. Audit 2026-05 A-009
  // documents this is a known tradeoff until P1 process isolation lands.
  return false;
}

process.on("unhandledRejection", (reason) => {
  log.error(`Unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : reason}`);
});
process.on("uncaughtException", (err) => {
  log.error(`Uncaught exception: ${err.stack ?? err.message}`);
  if (shouldRethrowUncaught(err)) {
    throw err;
  }
});

/**
 * Hot-reload watcher predicate: returns true for filenames the plugin
 * watcher should ignore. Exported so the rule is unit-testable.
 *
 * Audit A-023: `.cache/` is written *during* a plugin build (Bun caches
 * compiled module graphs there). Without filtering it, the watcher
 * sees its own build output, fires another reload, which re-triggers a
 * rebuild — infinite rebuild loop. Also keeps `.build` (existing) and
 * `node_modules` ignored for the same self-write reason.
 */
export function shouldIgnoreReloadFilename(filename: string | null): boolean {
  if (!filename) return true;
  if (filename.startsWith(".build")) return true;
  if (filename.startsWith(".cache")) return true;
  if (filename.startsWith("node_modules")) return true;
  if (filename.includes(`${sep}.cache${sep}`) || filename.endsWith(`${sep}.cache`)) return true;
  if (filename.includes(`${sep}.build${sep}`) || filename.endsWith(`${sep}.build`)) return true;
  if (filename.includes(`${sep}node_modules${sep}`)) return true;
  return false;
}

export interface ServerOptions {
  /** HTTP port (default: 33820) */
  port?: number;
  /** Directory containing plugin folders (default: ./plugins) */
  pluginsDir?: string;
  /** Project root directory (default: cwd) */
  projectRoot?: string;
}

/** Standard response helpers */

// Audit A-028: previously this returned HTTP 200 even for `{error:...}`
// envelopes. Callers can now pass a status code so error envelopes return
// the appropriate 4xx/5xx; default stays 200 to keep success callsites
// unchanged. A sibling `jsonErrorResponse` covers the common 500 case.
// Exported for tests.
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json;charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export function jsonErrorResponse(data: unknown, status = 500): Response {
  return jsonResponse(data, status);
}

/** JS-response helper (exported for the A-001 route modules). */
export function jsResponse(code: string): Response {
  return new Response(code, {
    headers: {
      "Content-Type": "application/javascript;charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Compile a TypeScript/TSX file on the fly using Bun.build().
 * Shared deps (react, @loadout/ui) are resolved from globals
 * exposed by the overlay shell, so plugins don't need node_modules.
 */
async function compileTsx(
  entrypoint: string,
): Promise<{ code: string; ok: boolean }> {
  try {
    const result = await Bun.build({
      entrypoints: [entrypoint],
      plugins: [vendorGlobalsPlugin(), sdkGlobalPlugin()],
      target: "browser",
      format: "esm",
      minify: false,
      define: {
        "process.env.NODE_ENV": '"production"',
      },
    });

    if (result.success && result.outputs.length > 0) {
      const code = await result.outputs[0].text();
      return { code, ok: true };
    }

    const logs = result.logs.map(String).join("\n");
    log.error(`Build failed: ${entrypoint} — ${logs}`);
    return { code: `// Build failed:\n// ${logs}`, ok: false };
  } catch (err) {
    log.error(`Build error: ${entrypoint} — ${err}`);
    return { code: `// Build error: ${err}`, ok: false };
  }
}

interface WsClient {
  send(data: string): void;
}

export async function startServer(options: ServerOptions = {}) {
  const port = options.port ?? 33820;
  const projectRoot = options.projectRoot ?? process.cwd();
  const pluginsDir = options.pluginsDir ?? join(projectRoot, "plugins");

  // --- Session token for auth ---
  const token = generateSessionToken();
  log.info(`Session token: ${token}`);

  // --- WebSocket client tracking ---
  const wsClients = new Set<WsClient>();

  function broadcast(msg: RpcEvent) {
    const data = JSON.stringify(msg);
    for (const ws of wsClients) {
      try { ws.send(data); } catch { /* disconnected */ }
    }
  }

  // --- Load plugins ---
  log.info("Loading plugins...");
  log.info(`Plugins directory: ${pluginsDir}`);
  const plugins = await loadPlugins({ pluginsDir, broadcast });
  log.info(`Loaded ${plugins.size} plugin(s)`);

  // --- Build inject bundles for CEF injection ---
  let injectBundles: InjectBundles = { vendor: "", sdk: "", plugins: new Map() };
  try {
    injectBundles = await buildInjectBundles(pluginsDir, [...plugins.keys()]);
    log.info(`Built inject bundles: SDK + ${injectBundles.plugins.size} plugin(s)`);
  } catch (err) {
    log.error(`Failed to build inject bundles: ${err}`);
  }

  // --- Core services ---
  // Synthetic plugin entries for app-owned services. They share the same
  // RPC + __broadcast machinery as real plugins, so any plugin (or the
  // overlay UI) can `useBackend("__core:game-detection")` and any consumer
  // of `__broadcast handleGameLaunch` (i.e. game-session-monitor.ts in the
  // injector) reaches them without further wiring. They're registered AFTER
  // buildInjectBundles so we don't try to compile a non-existent
  // backend.ts for them.
  const gameDetection = new GameDetectionService();
  gameDetection.emit = ({ event, data }) => {
    broadcast({ type: "event", plugin: GAME_DETECTION_SERVICE_ID, event, data });
  };
  plugins.set(GAME_DETECTION_SERVICE_ID, {
    meta: {
      id: GAME_DETECTION_SERVICE_ID,
      name: "Game Detection",
      version: "0.0.0",
      description: "Core service: tracks the currently running Steam game.",
      author: "core",
    },
    instance: gameDetection,
    sandboxedFetch: globalThis.fetch,
    hasApp: false,
  });
  log.info(`Registered core service: ${GAME_DETECTION_SERVICE_ID}`);

  const rpcHandler = createRpcHandler(
    new Map(
      [...plugins].map(([id, p]) => [
        id,
        { instance: p.instance, sandboxedFetch: p.sandboxedFetch },
      ]),
    ),
  );

  // Fan a method call out to every plugin (including __core:* services) that
  // implements it. Used by the HTTP /api/rpc __broadcast handler AND by the
  // injector's in-process onGameLaunch/onGameExit hook (Steam's CEF blocks
  // fetch() to localhost, so the JS-side rpcCall is unreliable).
  async function broadcastToPlugins(
    method: string,
    args: unknown[],
  ): Promise<number> {
    let called = 0;
    for (const [id, p] of plugins) {
      const fn = resolveMethod({ instance: p.instance, name: method });
      if (fn) {
        called++;
        try {
          await withSandboxedFetch(p.sandboxedFetch, () => fn(...args));
        } catch (err) {
          log.error(`[broadcast] ${method} failed on plugin ${id}: ${err}`);
        }
      }
    }
    return called;
  }

  // --- Plugin bundle cache (compiled on demand for the overlay) ---
  const bundleCache = new Map<string, string>();

  // --- Route-module dispatch context (issue #87 / audit A-001).
  // Every service the inlined routes consume is bundled here so each
  // route module receives them by reference instead of reaching into
  // a fetch-closure capture. The fetch callback below tries
  // `dispatchRoute(req, url, ctx)` first; routes that match return
  // a Response, anything that falls through hits the inlined blocks
  // (currently every route) and ultimately the 404.
  const ctx: RouteContext = {
    plugins,
    token,
    wsClients,
    bundleCache,
    injectBundles,
    pluginsDir,
    rpcHandler,
    broadcastToPlugins,
    compileTsx,
    bunPlugins: [vendorGlobalsPlugin(), sdkGlobalPlugin()],
  };

  // --- HTTP Server ---
  // `WebSocketData` is opaque to us — we tag connections as `{ type: "rpc" }`
  // purely so `server.upgrade()` accepts the data slot.
  const server = Bun.serve<{ type: "rpc" }>({
    port,

    async fetch(req, server) {
      const url = new URL(req.url);

      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" },
        });
      }

      // --- WebSocket upgrade ---
      if (url.pathname === "/ws") {
        if (!validateRequest(req)) {
          return new Response("Unauthorized", { status: 401 });
        }
        const upgraded = server.upgrade(req, { data: { type: "rpc" } });
        if (!upgraded) return new Response("WebSocket upgrade failed", { status: 400 });
        return undefined as unknown as Response;
      }

      // --- Health check ---
      if (url.pathname === "/up") {
        return new Response("ok");
      }

      // --- API (all /api/* routes require authentication) ---

      if (url.pathname.startsWith("/api/") && !validateRequest(req)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: {
            "Content-Type": "application/json;charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      // --- Route-module dispatch (issue #87 / A-001). Every HTTP
      //     surface beyond /ws + /up lives in routes/<name>.ts and is
      //     wired through this single call. `dispatchRoute` returns
      //     `null` when no module matched the request — we fall
      //     through to the 404 below.
      const dispatchResult = await dispatchRoute(req, url, ctx);
      if (dispatchResult !== null) return dispatchResult as Response;

      return new Response("Not Found", { status: 404 });
    },

    websocket: {
      open(ws: WsClient) {
        wsClients.add(ws);
        log.debug(`WebSocket client connected (total: ${wsClients.size})`);
      },
      async message(ws: WsClient, message: string | Buffer) {
        const msg = typeof message === "string" ? message : message.toString();
        const response = await rpcHandler(msg);
        if (response) {
          ws.send(response);
        }
      },
      close(ws: WsClient) {
        wsClients.delete(ws);
        log.debug(`WebSocket client disconnected (total: ${wsClients.size})`);
      },
    },
  });

  log.info(`Loadout running at http://localhost:${port}`);
  log.info(`API server ready. UI served by the Electrobun overlay (bun run dev:electrobun).`);

  // --- Start CEF injector (connects to Steam's debug port and injects plugins) ---
  const injector = new SteamInjector({
    loaderPort: port,
    sessionToken: token,
    injectBundles: injectBundles.vendor ? injectBundles : undefined,
    log: (msg: string) => log.info(msg),
    // Bypass Steam CEF's fetch-blocking by dispatching the broadcast in-process
    // from the injector's binding callback. Without this, game launches show
    // up in the injector log but never reach plugin handlers.
    onGameLaunch: async (appId, gameName) => {
      const called = await broadcastToPlugins("handleGameLaunch", [appId, gameName]);
      log.info(`[broadcast] handleGameLaunch fanned out to ${called} plugin(s)`);
    },
    onGameExit: async (appId) => {
      const called = await broadcastToPlugins("handleGameExit", [appId]);
      log.info(`[broadcast] handleGameExit fanned out to ${called} plugin(s)`);
    },
    // Audit A-021: when the injector exhausts its crash-retry budget, fan
    // a __system event out so UI subscribers can surface "injector stopped"
    // instead of the previous silent failure.
    onGiveUp: (info) => {
      log.warn(`[injector] gave up after ${info.crashCount} crashes (${info.reason})`);
      broadcast({ type: "event", plugin: "__system", event: "inject-failed", data: info });
    },
  });
  injector.start().catch((err) => {
    log.error(`[injector] Fatal error: ${err}`);
  });

  // --- File watching for hot reload ---
  const { watch } = await import("node:fs");
  const watchers: ReturnType<typeof watch>[] = [];

  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  function debounced(key: string, fn: () => void, ms = 300) {
    const existing = debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    debounceTimers.set(key, setTimeout(fn, ms));
  }

  // Watch each plugin directory for changes
  for (const [id] of plugins) {
    // Skip synthetic core services — they're code-resident, not on disk.
    if (id.startsWith("__core:")) continue;
    const pluginDir = join(pluginsDir, id);
    const watcher = watch(pluginDir, { recursive: true }, (_eventType, filename) => {
      if (shouldIgnoreReloadFilename(filename)) return;
      debounced(`plugin-${id}`, () => {
        log.debug(`[hot-reload] Plugin ${id} changed: ${filename}`);
        bundleCache.delete(id); // Invalidate cached bundle
        broadcast({ type: "event", plugin: "__system", event: "reload", data: { plugin: id } });
      });
    });
    watchers.push(watcher);
  }

  // Watch packages/ui/ for SDK changes
  const uiSrcDir = join(projectRoot, "packages/ui/src");
  const uiWatcher = watch(uiSrcDir, { recursive: true }, (_eventType, filename) => {
    if (!filename) return;
    debounced("sdk", () => {
      log.debug(`[hot-reload] SDK changed: ${filename}`);
      bundleCache.clear(); // SDK change invalidates all bundles
      broadcast({ type: "event", plugin: "__system", event: "reload", data: { plugin: "__sdk" } });
    });
  });
  watchers.push(uiWatcher);

  return { server, watchers };
}
