/**
 * Plugin discovery + static asset routes — `/api/plugins`, `/api/token`,
 * `/plugins/<id>/app-bundle.js`, `/plugins/<id>/assets/<...>`.
 *
 * These are loader-level concerns (catalog, auth bootstrap, per-plugin
 * bundle compilation) — not plugin-specific code. The compiled bundle
 * cache lives on the RouteContext so hot-reload (which clears the
 * cache from index.ts) still works.
 *
 * Path-traversal protection on `/plugins/<id>/assets/<...>`: each
 * resolved asset path must stay strictly inside the plugin's root —
 * encoded `..` sequences that escape return 403.
 */

import { join, resolve, sep } from "node:path";
import { jsonResponse, jsResponse } from "../index";
import type { RouteHandler } from "./types";

export const pluginsListRoute: RouteHandler = {
  name: "plugins.list",
  match: (_req, url) => url.pathname === "/api/plugins",
  async handle(_req, url, ctx) {
    // ?all=1 returns all plugins (used by injector for targets/routes).
    // Default returns only plugins with an app.tsx frontend (used by
    // overlay sidebar). Core services (`__core:*`) are always excluded —
    // they have no UI and no targets/routes, and aren't installable
    // plugins.
    const all = url.searchParams.get("all") === "1";
    const metas = [...ctx.plugins.values()]
      .filter((p) => !p.meta.id.startsWith("__core:"))
      .filter((p) => all || p.hasApp)
      .map((p) => p.meta);
    return jsonResponse(metas);
  },
};

export const tokenRoute: RouteHandler = {
  name: "plugins.token",
  match: (_req, url) => url.pathname === "/api/token",
  async handle(_req, _url, ctx) {
    return jsonResponse({ token: ctx.token });
  },
};

const APP_BUNDLE_PATTERN = /^\/plugins\/([^/]+)\/app-bundle\.js$/;
const ASSET_PATTERN = /^\/plugins\/([^/]+)\/assets\/(.+)$/;

export const pluginAppBundleRoute: RouteHandler = {
  name: "plugins.app-bundle",
  match: (_req, url) => APP_BUNDLE_PATTERN.test(url.pathname),
  async handle(_req, url, ctx) {
    const match = url.pathname.match(APP_BUNDLE_PATTERN);
    if (!match) {
      return new Response("Not Found", { status: 404 });
    }
    // Group 1 is a required capture in APP_BUNDLE_PATTERN, so it is always
    // present; `?? ""` only satisfies the type checker.
    const pluginId = match[1] ?? "";
    let code = ctx.bundleCache.get(pluginId);
    if (!code) {
      const appPath = join(ctx.pluginsDir, pluginId, "app.tsx");
      ({ code } = await ctx.compileTsx(appPath));
      ctx.bundleCache.set(pluginId, code);
    }
    return jsResponse(code);
  },
};

export const pluginAssetRoute: RouteHandler = {
  name: "plugins.asset",
  match: (_req, url) => ASSET_PATTERN.test(url.pathname),
  async handle(_req, url, ctx) {
    const match = url.pathname.match(ASSET_PATTERN);
    if (!match) {
      return new Response("Not Found", { status: 404 });
    }
    // Groups 1 and 2 are required captures in ASSET_PATTERN, so they are
    // always present; `?? ""` only satisfies the type checker.
    const pluginId = match[1] ?? "";
    const relPath = decodeURIComponent(match[2] ?? "");
    if (!ctx.plugins.has(pluginId)) {
      return new Response("Not Found", { status: 404 });
    }
    // Resolve + verify path stays within the plugin directory.
    const pluginRoot = resolve(join(ctx.pluginsDir, pluginId));
    const target = resolve(join(pluginRoot, relPath));
    if (target !== pluginRoot && !target.startsWith(pluginRoot + sep)) {
      return new Response("Forbidden", { status: 403 });
    }
    const file = Bun.file(target);
    if (!(await file.exists())) {
      return new Response("Not Found", { status: 404 });
    }
    const ext = target.slice(target.lastIndexOf(".") + 1).toLowerCase();
    const contentType =
      ext === "jpg" || ext === "jpeg"
        ? "image/jpeg"
        : ext === "png"
          ? "image/png"
          : ext === "webp"
            ? "image/webp"
            : ext === "gif"
              ? "image/gif"
              : ext === "svg"
                ? "image/svg+xml"
                : ext === "json"
                  ? "application/json"
                  : "application/octet-stream";
    return new Response(file, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
};

export const pluginsRoutes: RouteHandler[] = [
  pluginsListRoute,
  tokenRoute,
  pluginAppBundleRoute,
  pluginAssetRoute,
];
