/**
 * Self-update routes (issue #173).
 *
 *   POST /api/self-update  { tag: "vX.Y.Z" } — start a root-side
 *        binary + plugins update. 202 on accept; 400/409 otherwise.
 *   GET  /api/self-update — poll the in-flight update's status.
 *   POST /api/restart — restart our own service via a transient unit.
 *        Replaces the overlay host's broken `systemctl --user restart
 *        loadout` (the backend has been a root SYSTEM unit since the
 *        installer heredoc moved it; a user session can't restart it).
 *
 * All three sit behind the loader's bearer-token gate like every other
 * /api/* path. The hard security guarantees (tag-only input, pinned
 * repo, checksum verify, no downgrades) live in ../self-update.
 */

import { jsonResponse } from "../index";
import type { RouteHandler } from "./types";
import {
  getSelfUpdateStatus,
  scheduleServiceRestart,
  startSelfUpdate,
} from "../self-update";

export const selfUpdateRoute: RouteHandler = {
  name: "self-update",
  match: (_req, url) => url.pathname === "/api/self-update",
  async handle(req, _url, ctx) {
    if (req.method === "GET") {
      return jsonResponse(getSelfUpdateStatus());
    }
    if (req.method !== "POST") {
      return jsonResponse({ error: "method not allowed" }, 405);
    }
    let tag: unknown;
    try {
      const body = (await req.json()) as { tag?: unknown };
      tag = body?.tag;
    } catch {
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    if (typeof tag !== "string") {
      return jsonResponse({ error: "missing tag" }, 400);
    }
    const result = startSelfUpdate({ tag, pluginsDir: ctx.pluginsDir });
    if (!result.ok) {
      return jsonResponse({ error: result.error }, result.code ?? 400);
    }
    return jsonResponse({ ok: true, status: getSelfUpdateStatus() }, 202);
  },
};

export const restartRoute: RouteHandler = {
  name: "self-update.restart",
  match: (req, url) => url.pathname === "/api/restart" && req.method === "POST",
  async handle() {
    scheduleServiceRestart();
    return jsonResponse({ ok: true });
  },
};
