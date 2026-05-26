import type { RpcRequest, RpcResponse, PluginBackend } from "@loadout/types";
import { resolveMethod } from "@loadout/types";

export interface RpcEntry {
  instance: PluginBackend;
}

export type RpcHandler = (message: string) => Promise<string | null>;

function reply(res: RpcResponse): string {
  return JSON.stringify(res);
}

export function createRpcHandler(plugins: Map<string, RpcEntry>): RpcHandler {
  return async (message: string): Promise<string | null> => {
    let req: RpcRequest;
    try {
      req = JSON.parse(message);
    } catch {
      return null;
    }
    if (!req.id || !req.plugin || !req.method) return null;

    const entry = plugins.get(req.plugin);
    if (!entry) {
      return reply({ id: req.id, error: `Plugin "${req.plugin}" not found` });
    }
    const method = resolveMethod(entry.instance, req.method);
    if (!method) {
      return reply({
        id: req.id,
        error: `Method "${req.method}" not found on plugin "${req.plugin}"`,
      });
    }
    try {
      const result = await method(...req.args);
      return reply({ id: req.id, result });
    } catch (err) {
      return reply({
        id: req.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
