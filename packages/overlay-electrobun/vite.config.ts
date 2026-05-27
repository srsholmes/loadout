import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const BACKEND_URL = "http://localhost:33820";

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
  root: "src/webview",
  resolve: {
    alias: {
      "@loadout/ui": path.resolve(__dirname, "../ui/src"),
      "@loadout/types": path.resolve(__dirname, "../types/src"),
      "@overlay": path.resolve(__dirname, "../overlay/src"),
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
    // packages/overlay-electrobun/webview-dist/ — safe to `rm -rf` and
    // well away from the repo-root dist/ that ships loadout.
    outDir: "../../webview-dist",
    emptyOutDir: true,
  },
});
