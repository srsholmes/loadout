/**
 * Health route. `/up` stays inlined in `index.ts` because it runs
 * *before* the auth gate (no auth, no body, just a liveness probe)
 * and the dispatch table runs after the gate. `/api/status` is the
 * authenticated equivalent for the overlay's StatusIndicator and
 * lives here.
 */

import { jsonResponse } from "../index";
import type { RouteHandler } from "./types";

export const statusRoute: RouteHandler = {
  name: "health.status",
  match: (_req, url) => url.pathname === "/api/status",
  async handle(_req, _url, ctx) {
    return jsonResponse({
      ok: true,
      wsConnected: ctx.wsClients.size > 0,
      wsClients: ctx.wsClients.size,
      plugins: ctx.plugins.size,
    });
  },
};
