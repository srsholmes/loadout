/**
 * Plugin RPC dispatch — `/api/rpc` (POST).
 *
 * This is the HTTP-side entry to every plugin's exported method. The
 * injected scripts in Steam BPM use it when CEF's WebSocket / fetch
 * to localhost can't be relied on (mixed-content gates, in-game
 * overlay state). Body shape: `{ plugin, method, args }`.
 *
 * `plugin === "__broadcast"` fans the method out to every plugin
 * (including __core:* synthetic services) that implements it —
 * used by the injector's `onGameLaunch`/`onGameExit` callbacks to
 * dispatch in-process when Steam's CEF blocks fetch().
 *
 * **This is the future P1 boundary.** Today the RPC handler runs the
 * plugin method in-process via `await import(backendPath)`. P1
 * (process isolation) swaps the in-process call for child-process
 * IPC — the rest of the loader's HTTP surface is plugin-agnostic, so
 * P1 only touches this module + the broadcast helper on RouteContext.
 *
 * Audit A-028 envelope rule: plugin RPC errors return HTTP 500 with
 * the error envelope as the body, so clients branch on status code
 * instead of grepping the response for an `error` key.
 */

import { jsonResponse, jsonErrorResponse } from "../index";
import type { RouteHandler } from "./types";

export const rpcRoute: RouteHandler = {
  name: "rpc",
  match: (req, url) => url.pathname === "/api/rpc" && req.method === "POST",
  async handle(req, _url, ctx) {
    try {
      const body = await req.text();
      const parsed = JSON.parse(body) as {
        plugin?: string;
        method?: string;
        args?: unknown[];
      };

      // __broadcast: fan-out to all plugins that implement the method.
      if (parsed.plugin === "__broadcast" && parsed.method) {
        const called = await ctx.broadcastToPlugins(
          parsed.method,
          parsed.args ?? [],
        );
        return jsonResponse({ ok: true, broadcast: parsed.method, called });
      }

      const response = await ctx.rpcHandler(body);
      if (!response) return jsonErrorResponse({ error: "No response" });
      const parsedResponse = JSON.parse(response) as Record<string, unknown>;
      // Audit A-028: surface plugin RPC errors as HTTP 500 so clients
      // can branch on status instead of grepping the body.
      const isErrorEnvelope =
        parsedResponse &&
        typeof parsedResponse === "object" &&
        "error" in parsedResponse;
      return isErrorEnvelope
        ? jsonErrorResponse(parsedResponse)
        : jsonResponse(parsedResponse);
    } catch (err) {
      return jsonErrorResponse({ error: String(err) });
    }
  },
};
