import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

const BACKEND_URL = "http://localhost:33820";

// Single source of truth for the UI-visible product version. Read from this
// app's package.json and baked in as `__OVERLAY_VERSION__` so Settings, the
// sidebar badge, and error reports all track one number — bump the package.json
// (the release script does) and every display follows.
const OVERLAY_VERSION = (
  JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf8")) as { version: string }
).version;

import type { Plugin } from "vite";

// Strip `crossorigin` from HTML script/link tags: CEF rejects
// crossorigin-tagged scripts loaded from the views:// custom scheme.
function stripCrossorigin(): Plugin {
  return {
    name: "strip-crossorigin",
    transformIndexHtml(html) {
      return html.replace(/ crossorigin/g, "");
    },
  };
}

// Electrobun 2 ships its SDK through Hutch's projected devkit, not
// node_modules — the `electrobun` npm package is a CLI bootstrap whose
// exports all throw. `electrobun prepare` (run by every package.json build
// script) writes .hutch/devkit/; we alias `electrobun/view` & co. onto its
// API sources from the devkit's export map. This mirrors upstream's
// .hutch/devkit/api/config/electrobun-vite.ts, inlined because that helper
// is TypeScript and a static import of it would make this config fail to
// load (knip, editors) before the devkit has been prepared.
const DEVKIT = path.resolve(__dirname, ".hutch/devkit");

function electrobunAliases(): { find: RegExp; replacement: string }[] {
  const manifestPath = path.join(DEVKIT, "package.json");
  if (!existsSync(manifestPath)) return [];
  const { exports = {} } = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    exports?: Record<string, unknown>;
  };
  const apiRoot = path.join(DEVKIT, "api") + path.sep;
  return Object.entries(exports).flatMap(([subpath, target]) => {
    if (typeof target !== "string" || !target.startsWith("./api/")) return [];
    const replacement = path.resolve(DEVKIT, target);
    if (!replacement.startsWith(apiRoot)) return [];
    const specifier = subpath === "." ? "electrobun" : `electrobun/${subpath.slice(2)}`;
    return [
      { find: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), replacement },
    ];
  });
}

// Fail the build (not config load — knip evaluates this config as a build)
// when the devkit is missing: without the aliases `electrobun/view` falls
// through to the npm bootstrap, whose exports throw at runtime.
function requireElectrobunDevkit(aliases: unknown[]): Plugin {
  return {
    name: "require-electrobun-devkit",
    apply: "build",
    buildStart() {
      if (aliases.length === 0) {
        this.error(
          `Electrobun devkit missing at ${DEVKIT} — run \`bunx electrobun prepare\` first`,
        );
      }
    },
  };
}

export default defineConfig(() => {
  const electrobun = electrobunAliases();
  return {
    plugins: [react(), tailwindcss(), stripCrossorigin(), requireElectrobunDevkit(electrobun)],
    define: {
      __OVERLAY_VERSION__: JSON.stringify(OVERLAY_VERSION),
    },
    root: "src/webview",
    resolve: {
      alias: [
        ...electrobun,
        { find: "@loadout/ui", replacement: path.resolve(__dirname, "../../packages/ui/src") },
        {
          find: "@loadout/types",
          replacement: path.resolve(__dirname, "../../packages/types/src"),
        },
        { find: "@overlay", replacement: path.resolve(__dirname, "src/overlay") },
      ],
    },
    server: {
      port: 1420,
      strictPort: true,
      proxy: {
        "/api": BACKEND_URL,
        "/ws": { target: BACKEND_URL, ws: true },
        "/plugins": BACKEND_URL,
      },
    },
    build: {
      // Relative to `root: src/webview`, so this lands at
      // apps/loadout-overlay/webview-dist/ — safe to `rm -rf` and
      // well away from the repo-root dist/ that ships loadout.
      outDir: "../../webview-dist",
      emptyOutDir: true,
    },
  };
});
