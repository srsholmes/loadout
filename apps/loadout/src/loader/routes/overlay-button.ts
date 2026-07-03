/**
 * Steam main-menu "Loadout" entry refresh — `POST /api/overlay-button/refresh`
 * (issue #169).
 *
 * The overlay's Settings toggle hits this after flipping
 * `steamOverlayButtonMainMenu` so the change lands in the running Steam
 * client immediately (and the injection result can drive a success/failure
 * toast). Authenticated via the `/api/*` gate in index.ts.
 *
 * Body: `{ mainMenu?: boolean }` — the explicit desired state, passed
 * straight through to the injector so it doesn't have to re-read
 * `/api/user-config` (which the toggle PATCHes asynchronously, a race).
 * A malformed / missing body falls back to persisted config.
 */

import { jsonResponse } from "../index";
import type { RouteHandler } from "./types";

export const overlayButtonRoute: RouteHandler = {
  name: "overlay-button-refresh",
  match: (req, url) =>
    url.pathname === "/api/overlay-button/refresh" && req.method === "POST",
  async handle(req, _url, ctx) {
    let mainMenu: boolean | undefined;
    try {
      const body = (await req.json()) as { mainMenu?: unknown };
      if (typeof body?.mainMenu === "boolean") mainMenu = body.mainMenu;
    } catch {
      // No / invalid body — fall back to persisted config in the injector.
    }

    const result = await ctx.refreshOverlayButton(mainMenu);
    // 503 when injection couldn't be applied (Steam not attached, desktop
    // mode, transient read failure) so the client branches on status.
    return jsonResponse(result, result.ok ? 200 : 503);
  },
};
