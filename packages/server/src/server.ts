import { join } from "node:path";
import type { RpcEvent } from "@loadout/types";
import { createSessionAuth } from "./auth";
import { loadPlugins, type LoadedPlugin } from "./plugin-manager";
import { createRpcHandler } from "./rpc";
import { compileBrowserBundle } from "./bundler";
import { watchDir } from "./watcher";
import { log } from "./logger";

export interface ServerOptions {
  port?: number;
  pluginsDir?: string;
  projectRoot?: string;
}

interface WsClient {
  send(data: string): void;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json;charset=utf-8" },
  });
}

function jsResponse(code: string, ok = true): Response {
  return new Response(code, {
    status: ok ? 200 : 500,
    headers: { "Content-Type": "application/javascript;charset=utf-8" },
  });
}

export async function startServer(options: ServerOptions = {}) {
  const port = options.port ?? 33820;
  const projectRoot = options.projectRoot ?? process.cwd();
  const pluginsDir = options.pluginsDir ?? join(projectRoot, "plugins");

  const auth = createSessionAuth();
  log.info(`Session token: ${auth.token}`);

  const wsClients = new Set<WsClient>();
  function broadcast(msg: RpcEvent) {
    const data = JSON.stringify(msg);
    for (const ws of wsClients) {
      try {
        ws.send(data);
      } catch {}
    }
  }

  log.info(`Loading plugins from ${pluginsDir}`);
  const plugins = await loadPlugins({ pluginsDir, broadcast });
  log.info(`Loaded ${plugins.size} plugin(s)`);

  const rpcHandler = createRpcHandler(
    new Map([...plugins].map(([id, p]) => [id, { instance: p.instance }])),
  );

  const bundleCache = new Map<string, string>();

  async function getPluginBundle(pluginId: string): Promise<Response> {
    const plugin = plugins.get(pluginId);
    if (!plugin || !plugin.hasApp) {
      return new Response("Plugin or app.tsx not found", { status: 404 });
    }
    const cached = bundleCache.get(pluginId);
    if (cached) return jsResponse(cached);
    const result = await compileBrowserBundle(join(plugin.dir, "app.tsx"));
    if (result.ok) bundleCache.set(pluginId, result.code);
    return jsResponse(result.code, result.ok);
  }

  function listManifests() {
    return [...plugins.values()].map((p) => ({
      ...p.manifest,
      hasApp: p.hasApp,
    }));
  }

  const server = Bun.serve<{ type: "rpc" }>({
    port,
    hostname: "127.0.0.1",

    async fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === "/up") return new Response("ok");

      if (url.pathname === "/api/token") {
        // Returns the token to in-process callers only. Bound to 127.0.0.1 so
        // anything off-host can't reach this surface.
        return jsonResponse({ token: auth.token });
      }

      if (url.pathname === "/ws") {
        if (!auth.validateRequest(req)) return new Response("Unauthorized", { status: 401 });
        const ok = srv.upgrade(req, { data: { type: "rpc" } });
        return ok ? (undefined as unknown as Response) : new Response("upgrade failed", { status: 400 });
      }

      if (url.pathname.startsWith("/api/") && !auth.validateRequest(req)) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }

      if (url.pathname === "/api/plugins") {
        return jsonResponse({ plugins: listManifests() });
      }

      const bundleMatch = url.pathname.match(/^\/plugins\/([^/]+)\/app-bundle\.js$/);
      if (bundleMatch) {
        if (!auth.validateRequest(req)) return new Response("Unauthorized", { status: 401 });
        return getPluginBundle(bundleMatch[1]);
      }

      return new Response("Not Found", { status: 404 });
    },

    websocket: {
      open(ws: WsClient) {
        wsClients.add(ws);
      },
      async message(ws: WsClient, raw: string | Buffer) {
        const msg = typeof raw === "string" ? raw : raw.toString();
        const response = await rpcHandler(msg);
        if (response) ws.send(response);
      },
      close(ws: WsClient) {
        wsClients.delete(ws);
      },
    },
  });

  log.info(`Loadout server running at http://127.0.0.1:${port}`);

  // Hot reload: any change inside a plugin dir invalidates its bundle and
  // broadcasts a reload event so the overlay can re-import.
  const watchers: ReturnType<typeof watchDir>[] = [];
  for (const [id, plugin] of plugins) {
    const w = watchDir(plugin.dir, (filename) => {
      log.debug(`[hot-reload] ${id}: ${filename}`);
      bundleCache.delete(id);
      broadcast({ type: "event", plugin: "__system", event: "reload", data: { plugin: id } });
    });
    watchers.push(w);
  }

  return {
    server,
    token: auth.token,
    plugins,
    close() {
      for (const w of watchers) w.close();
      server.stop();
    },
  };
}

export type { LoadedPlugin };
