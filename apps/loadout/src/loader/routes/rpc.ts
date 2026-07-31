/**
 * Plugin RPC dispatch — `/api/rpc` (POST).
 *
 * This is the HTTP-side entry to every plugin's exported method. The
 * injected scripts in Steam BPM use it when CEF's WebSocket / fetch
 * to localhost can't be relied on (mixed-content gates, in-game
 * overlay state). Body shape: `{ plugin, method, args, id? }`.
 *
 * `id` is the request-correlation field the WebSocket transport needs
 * to match responses to callers (`RpcRequest` in `@loadout/types`).
 * Over HTTP the response IS the correlation, so callers routinely omit
 * it — but `createRpcHandler` rejects an id-less request by returning
 * `null`, which this route used to surface as a bare
 * `{"error": "No response"}` with nothing pointing at the real cause.
 * Only the `__broadcast` path (handled below, before the handler ever
 * sees the body) had ever been exercised over HTTP, so the trap went
 * unnoticed. We synthesise an id when the caller omits one; an id the
 * caller *did* supply is passed through untouched and echoed back.
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
    const body = await req.text();

    // Parse separately from the dispatch below so a malformed body is a
    // 400 (the caller's bug) rather than sharing the 500 the plugin's
    // own exceptions get.
    let parsed: {
      id?: string;
      plugin?: string;
      method?: string;
      args?: unknown[];
    };
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      return jsonErrorResponse({ error: `Invalid JSON body: ${err}` }, 400);
    }

    try {
      // __broadcast: fan-out to all plugins that implement the method.
      if (parsed.plugin === "__broadcast" && parsed.method) {
        const called = await ctx.broadcastToPlugins(
          parsed.method,
          parsed.args ?? [],
        );
        return jsonResponse({ ok: true, broadcast: parsed.method, called });
      }

      // `plugin` and `method` are the other two fields createRpcHandler
      // silently drops a request over. Name them explicitly — a caller
      // that mistyped one deserves better than "No response".
      if (!parsed.plugin || !parsed.method) {
        const missing = [
          !parsed.plugin ? "plugin" : null,
          !parsed.method ? "method" : null,
        ]
          .filter(Boolean)
          .join(", ");
        return jsonErrorResponse(
          {
            error: `Missing required field(s): ${missing}. Body shape is { plugin, method, args?, id? }.`,
          },
          400,
        );
      }

      // Re-serialise rather than string-patching the raw body: the
      // handler parses it again anyway, and this keeps the synthesised
      // id out of the caller's hands when they didn't ask for one.
      const request =
        typeof parsed.id === "string" && parsed.id !== ""
          ? body
          : JSON.stringify({ ...parsed, id: crypto.randomUUID() });

      const response = await ctx.rpcHandler(request);
      // Defensive backstop. `createRpcHandler` only returns null for a
      // request missing `id`/`plugin`/`method`, and all three are
      // guaranteed present by the checks above — so reaching here means
      // the handler's contract changed underneath us.
      if (!response) {
        return jsonErrorResponse({
          error: "RPC handler returned no response for a well-formed request",
        });
      }
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
