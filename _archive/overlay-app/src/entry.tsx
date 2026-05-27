/**
 * Browser entry point for the overlay app.
 * Compiled by Bun and served as /overlay/app.js.
 *
 * The overlay window passes ?mode=qam or ?mode=expanded via URL, and can
 * switch modes at runtime via the "loadout-mode" CustomEvent (injected
 * from the Python overlay window).
 *
 * - mode=qam: compact sidebar (slides over game for quick access)
 * - mode=expanded or default: full overlay with sidebar + content
 */
// Expose SpatialNavigation singleton BEFORE anything else — plugins
// register focusable elements against this shared instance.
import "./shared-modules";

import { createRoot } from "react-dom/client";
import { App } from "./App";
import { CompactSidebar } from "./CompactSidebar";
import { installGlobalErrorHandlers } from "./utils/error-reporter";
import { ensureConnected, subscribe } from "@loadout/ui/src/ws-client";

installGlobalErrorHandlers();

const root = createRoot(document.getElementById("root")!);

function renderMode(mode: string | null) {
  if (mode === "qam") {
    root.render(<CompactSidebar />);
  } else {
    root.render(<App />);
  }
}

// Initial render from URL param
const initialMode =
  (window as any).__LOADOUT_MODE__ ??
  new URLSearchParams(window.location.search).get("mode");
renderMode(initialMode);

// Listen for runtime mode switches from the overlay window
window.addEventListener("loadout-mode", (e: Event) => {
  const mode = (e as CustomEvent).detail as string;
  renderMode(mode);
});

// Hot-reload: full page reload when overlay-app or SDK source changes
ensureConnected();
subscribe({
  plugin: "__system",
  event: "reload",
  handler: (data: unknown) => {
    const plugin = (data as any)?.plugin;
    if (plugin === "__overlay" || plugin === "__sdk") {
      console.log(`[hot-reload] ${plugin} changed, reloading...`);
      location.reload();
    }
  },
});
