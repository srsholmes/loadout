import type { RpcRequest, RpcResponse, PluginBackend } from "@loadout/types";
import { resolveMethod } from "@loadout/types";
import { withSandboxedFetch } from "./plugin-manager";

export interface RpcPluginEntry {
  instance: PluginBackend;
  sandboxedFetch: typeof globalThis.fetch;
}

/**
 * Special "plugin" id that fans a method call out to every loaded
 * plugin (including `__core:*` services) that implements it.
 * Mirrors the same convention the HTTP `/api/rpc` route already
 * supports — extending it to the WebSocket path here so the overlay
 * UI can call `useBackend("__broadcast").call("clearExternalCache")`
 * to drive the loader-level "Clear all data caches" button without
 * needing a second transport. Returns `{ called: <number>, errors:
 * [{plugin, error}] }`.
 */
export const BROADCAST_PLUGIN_ID = "__broadcast";

export function createRpcHandler(plugins: Map<string, RpcPluginEntry>) {
  return async (message: string): Promise<string | null> => {
    let req: RpcRequest;
    try {
      req = JSON.parse(message);
    } catch {
      return null;
    }

    if (!req.id || !req.plugin || !req.method) {
      return null;
    }

    if (req.plugin === BROADCAST_PLUGIN_ID) {
      // Fan out — collect per-plugin errors instead of failing the
      // whole broadcast so one bad plugin can't strand the rest. The
      // HTTP `/api/rpc` __broadcast handler does the same thing.
      let called = 0;
      const errors: Array<{ plugin: string; error: string }> = [];
      for (const [id, entry] of plugins) {
        const method = resolveMethod({
          instance: entry.instance,
          name: req.method,
        });
        if (!method) continue;
        called++;
        try {
          await withSandboxedFetch(entry.sandboxedFetch, () =>
            method(...req.args),
          );
        } catch (err) {
          errors.push({
            plugin: id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const res: RpcResponse = {
        id: req.id,
        result: { called, errors },
      };
      return JSON.stringify(res);
    }

    const entry = plugins.get(req.plugin);
    if (!entry) {
      const res: RpcResponse = {
        id: req.id,
        error: `Plugin "${req.plugin}" not found`,
      };
      return JSON.stringify(res);
    }

    const method = resolveMethod({ instance: entry.instance, name: req.method });
    if (!method) {
      const res: RpcResponse = {
        id: req.id,
        error: `Method "${req.method}" not found on plugin "${req.plugin}"`,
      };
      return JSON.stringify(res);
    }

    try {
      const result = await withSandboxedFetch(entry.sandboxedFetch, () =>
        method(...req.args),
      );
      const res: RpcResponse = { id: req.id, result };
      return JSON.stringify(res);
    } catch (err) {
      const res: RpcResponse = {
        id: req.id,
        error: err instanceof Error ? err.message : String(err),
      };
      return JSON.stringify(res);
    }
  };
}
