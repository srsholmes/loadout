/**
 * User config persistence route — `/api/user-config`.
 *
 *   GET   → returns the full config JSON ({} if none yet)
 *   PATCH → merges a partial object into the config
 *   PUT   → replaces the config entirely
 *
 * Persists to `~/.config/loadout/config.json` via the
 * user-config module (atomic writes + schema-lite validation).
 * Body must be a plain object — arrays and primitives 400.
 */

import {
  readUserConfig,
  patchUserConfig,
  writeUserConfig,
  type UserConfig,
} from "../user-config";
import { log } from "../logger";
import { jsonResponse, jsonErrorResponse } from "../index";
import type { RouteHandler } from "./types";

export const userConfigRoute: RouteHandler = {
  name: "user-config",
  match: (_req, url) => url.pathname === "/api/user-config",
  async handle(req, _url, ctx) {
    try {
      if (req.method === "GET") {
        return jsonResponse(await readUserConfig());
      }
      if (req.method === "PATCH") {
        const body = (await req.json()) as UserConfig;
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return jsonErrorResponse({ error: "Body must be an object" }, 400);
        }
        const next = await patchUserConfig(body);
        // Let the loader react to plugin enablement changes (loads a
        // newly-enabled plugin live). Fire-and-forget by contract.
        ctx.onUserConfigChanged(next);
        return jsonResponse(next);
      }
      if (req.method === "PUT") {
        const body = (await req.json()) as UserConfig;
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return jsonErrorResponse({ error: "Body must be an object" }, 400);
        }
        await writeUserConfig(body);
        ctx.onUserConfigChanged(body);
        return jsonResponse(body);
      }
      return new Response("Method Not Allowed", { status: 405 });
    } catch (err) {
      log.error(`/api/user-config failed: ${err}`);
      return jsonErrorResponse({ error: String(err) });
    }
  },
};
