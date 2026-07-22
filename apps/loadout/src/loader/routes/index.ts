/**
 * Route-module dispatch table. Iterated in order on every request
 * after the auth gate; the first `match` that returns true takes the
 * request. Anything that falls through here returns to `index.ts`
 * (which still has the inlined-route blocks during the A-001 split)
 * and ultimately the global 404.
 *
 * Migration discipline:
 *
 *   - Each route module lands as ONE commit, alongside the deletion
 *     of the matching inlined `if` block in `index.ts`. That way a
 *     `git revert` of the route's commit re-adds the inlined block in
 *     a single hunk — no partial-state risk.
 *   - The dispatch order doesn't matter for currently-extracted
 *     routes (every route's `match` is a unique-path test), but the
 *     order MAY matter once `/plugins/<id>/...` and `/inject/...`
 *     land — they share path-prefix space with future static-asset
 *     surfaces. List them last when they land so the more specific
 *     `/api/...` routes match first.
 */

import type { RouteContext, RouteHandler } from "./types";
import { statusRoute } from "./health";
import { userConfigRoute } from "./user-config";
import { steamGridRoute } from "./steam-grid";
import { pluginsRoutes } from "./plugins";
import { rpcRoute } from "./rpc";
import { injectRoutes } from "./inject";
import { overlayButtonRoute } from "./overlay-button";
import { selfUpdateRoute, restartRoute } from "./self-update";

/**
 * Ordered route list. Populated incrementally as A-001 progresses;
 * an empty list is a valid steady state (everything falls through
 * to the inlined blocks in `index.ts`).
 */
const routes: RouteHandler[] = [
  statusRoute,
  userConfigRoute,
  steamGridRoute,
  ...pluginsRoutes,
  rpcRoute,
  overlayButtonRoute,
  selfUpdateRoute,
  restartRoute,
  ...injectRoutes,
];

/**
 * Try every registered route in order. Returns the first non-null
 * response, or `null` if no route matched — the caller then falls
 * through to the inlined routes (and ultimately the 404).
 *
 * Routes whose `match` throws are skipped with a warning and the
 * dispatch continues — a buggy route shouldn't 500 unrelated paths.
 * (The route's `handle` is the dangerous surface; we let exceptions
 * there propagate to the caller's try/catch.)
 */
export async function dispatchRoute(
  req: Request,
  url: URL,
  ctx: RouteContext,
): Promise<Response | undefined | null> {
  for (const route of routes) {
    let matched = false;
    try {
      matched = route.match(req, url);
    } catch {
      // Bad matcher — skip this route, log nothing in the hot path.
      continue;
    }
    if (matched) return route.handle(req, url, ctx);
  }
  return null;
}

export type { RouteContext, RouteHandler } from "./types";
