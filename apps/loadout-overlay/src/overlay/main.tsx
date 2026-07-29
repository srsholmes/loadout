import "./shared-modules";
import "./index.css";

import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme } from "./components/Settings";
import { getConfigValue, loadUserConfig } from "./lib/userConfig";
import { seedOverlayI18n, initOverlayI18n } from "./lib/i18n-setup";
import { initBackend } from "./lib/backend";
import { runStartupInits } from "./lib/pluginInit";
import { ensureConnected, subscribe } from "@loadout/ui/ws-client";

// Apply the persisted theme before first render. `getConfigValue` reads
// from the userConfig in-memory cache, which is seeded from its
// localStorage mirror at module load — so this is instant on any boot
// after the first.
applyTheme(getConfigValue<string>("theme", "dark"));

// Seed i18n from the persisted language (mirror-cached) before first
// render so the UI doesn't flash untranslated keys. Reconciled with the
// authoritative on-disk config + first-run detection in boot().
seedOverlayI18n();

const root = createRoot(document.getElementById("root")!);

root.render(<App />);

async function boot() {
  console.log("[main] booting...");

  // Connect to backend (retries until server is up). Once connected, run
  // startup init for any plugins that opted in via `loadOnStartup: true`.
  //
  // The production overlay-action → synthetic KeyboardEvent bridge lives
  // in overlay-electrobun/src/webview/main.tsx. This entry point is kept
  // for standalone `vite dev` of the shared React tree.
  initBackend().then(() => {
    ensureConnected();
    // Pull user config off disk once the backend is reachable and
    // re-apply the theme in case it changed since the last boot.
    loadUserConfig()
      .then(() => {
        applyTheme(getConfigValue<string>("theme", "dark"));
        // Reconcile language with the on-disk config and run first-run
        // OS-locale detection (persists the default if unset).
        return initOverlayI18n();
      })
      .catch((err) => console.warn("[main] loadUserConfig failed:", err));
    subscribe({
      plugin: "__system",
      event: "reload",
      handler: (data: unknown) => {
        const plugin = (data as { plugin?: string } | null)?.plugin;
        if (plugin === "__overlay" || plugin === "__sdk") {
          location.reload();
        }
      },
    });
    runStartupInits().catch((err) => {
      console.error("[main] runStartupInits crashed:", err);
    });
  });
}

boot().catch((e) => console.error("[main] boot crashed:", e));
