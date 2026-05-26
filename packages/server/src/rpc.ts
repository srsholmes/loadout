import type { RpcRequest, RpcResponse, PluginBackend } from "@loadout/types";
import { resolveMethod } from "@loadout/types";

export interface RpcEntry {
  instance: PluginBackend;
}

export type RpcHandler = (message: string) => Promise<string | null>;

/** Hard cap on RPC args to bound JSON-parsed memory cost. */
const MAX_ARGS = 64;

function reply(res: RpcResponse): string {
  return JSON.stringify(res);
}

function isValidRequest(req: unknown): req is RpcRequest {
  if (typeof req !== "object" || req === null) return false;
  const r = req as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.plugin === "string" &&
    typeof r.method === "string" &&
    Array.isArray(r.args)
  );
}

export function createRpcHandler(plugins: Map<string, RpcEntry>): RpcHandler {
  return async (message: string): Promise<string | null> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return null;
    }
    if (!isValidRequest(parsed)) {
      // Reply with an error envelope when an id is at least present so the
      // caller's pending-promise resolves instead of hanging forever.
      const id =
        parsed && typeof (parsed as { id?: unknown }).id === "string"
          ? (parsed as { id: string }).id
          : undefined;
      return id ? reply({ id, error: "Malformed RPC request" }) : null;
    }
    const req = parsed;
    if (req.args.length > MAX_ARGS) {
      return reply({ id: req.id, error: `Too many args (max ${MAX_ARGS})` });
    }

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
