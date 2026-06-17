/**
 * CEF inject-bundle routes — served to the injector's content scripts
 * inside Steam's CEF context (mixed-content rules block fetch-from-
 * localhost in some cases, so these bundles are pulled via plain
 * `<script src=…>` injection).
 *
 *   GET /vendor/vendor-all.js          → shared React / vendor globals
 *   GET /inject/sdk/bundle.js          → @loadout/ui SDK
 *
 * Bundles are built once at startup by `buildInjectBundles()` and
 * cached on the RouteContext. When the bundle is absent (`vendor` or
 * `sdk` empty string) the routes fall through to the loader's 404 so
 * the requester can detect a missing artifact.
 *
 * The per-plugin bundle route (`/inject/plugins/<id>/bundle.js`) was
 * removed as dead code — issue #60. No plugin ships a panel.tsx, so the
 * bundle map was always empty and the panel-mount path was unreachable.
 */

import { jsResponse } from "../index";
import type { RouteHandler } from "./types";

export const vendorBundleRoute: RouteHandler = {
  name: "inject.vendor",
  match: (_req, url) => url.pathname === "/vendor/vendor-all.js",
  async handle(_req, _url, ctx) {
    if (!ctx.injectBundles.vendor) {
      // Match the pre-extraction behaviour: missing bundle = fall
      // through to the 404 in index.ts.
      return new Response("Not Found", { status: 404 });
    }
    return jsResponse(ctx.injectBundles.vendor);
  },
};

export const sdkBundleRoute: RouteHandler = {
  name: "inject.sdk",
  match: (_req, url) => url.pathname === "/inject/sdk/bundle.js",
  async handle(_req, _url, ctx) {
    if (!ctx.injectBundles.sdk) {
      return new Response("Not Found", { status: 404 });
    }
    return jsResponse(ctx.injectBundles.sdk);
  },
};

export const injectRoutes: RouteHandler[] = [
  vendorBundleRoute,
  sdkBundleRoute,
];
