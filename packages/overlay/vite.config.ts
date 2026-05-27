import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const BACKEND_URL = "http://localhost:33820";

/** Strip `crossorigin` from HTML tags — Electrobun's views:// protocol
 *  doesn't return CORS headers, so crossorigin-tagged scripts fail to load. */
function stripCrossorigin(): import("vite").Plugin { // eslint-disable-line @typescript-eslint/consistent-type-imports
  return {
    name: "strip-crossorigin",
    transformIndexHtml(html) {
      return html.replace(/ crossorigin/g, "");
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), stripCrossorigin()],
  resolve: {
    alias: {
      "@loadout/ui": path.resolve(__dirname, "../ui/src"),
      "@loadout/types": path.resolve(__dirname, "../types/src"),
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
    outDir: "dist",
    emptyOutDir: true,
  },
});
