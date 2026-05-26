import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const BACKEND_URL = "http://127.0.0.1:33820";

// Strip `crossorigin` from HTML <script>/<link> tags — CEF rejects
// crossorigin-tagged assets loaded from the views:// custom scheme.
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
      "@loadout/ui": path.resolve(__dirname, "../../packages/ui/src"),
      "@loadout/types": path.resolve(__dirname, "../../packages/types/src"),
      "@loadout/overlay-shell": path.resolve(
        __dirname,
        "../../packages/overlay-shell/src",
      ),
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
    outDir: "../../webview-dist",
    emptyOutDir: true,
  },
});
