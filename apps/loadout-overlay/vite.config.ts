import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { readFileSync } from "node:fs";

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

export default defineConfig({
  plugins: [react(), tailwindcss(), stripCrossorigin()],
  define: {
    __OVERLAY_VERSION__: JSON.stringify(OVERLAY_VERSION),
  },
  root: "src/webview",
  resolve: {
    alias: {
      "@loadout/ui": path.resolve(__dirname, "../../packages/ui/src"),
      "@loadout/types": path.resolve(__dirname, "../../packages/types/src"),
      "@overlay": path.resolve(__dirname, "src/overlay"),
    },
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
});
