// Electrobun configuration for the Loadout overlay.
//
// Schema sourced from node_modules/electrobun/dist-linux-x64/api/bun/
// ElectrobunConfig.ts (v1.16). Keep the shapes here aligned with that type
// definition — the scaffold's first pass was based on doc guesses and didn't
// match the actual runtime. No top-level `windows` block — windows are
// constructed at runtime via `new BrowserWindow()`. bundleCEF lives under
// `linux`, not at the build root.

import pkg from "./package.json" with { type: "json" };

export default {
  app: {
    name: "loadout-overlay",
    identifier: "com.loadout.overlay",
    version: pkg.version,
    description: "Loadout overlay (Electrobun port — research scaffold)",
  },
  build: {
    // Bun-side main process entrypoint.
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    // The webview is built separately by Vite (`bunx vite build` or
    // `bun run webview:build` from this package) so it can use the
    // shared @overlay React tree via path aliases, tailwind/daisyUI,
    // and the JSX pipeline Electrobun's internal Bun.build doesn't handle.
    // The vite output lands in webview-dist/; we copy it wholesale into
    // the bundle under Resources/app/views/overlay/, which is where
    // `views://overlay/index.html` resolves at runtime.
    //
    // `views:` block deliberately omitted — we don't want Electrobun to
    // try building the view with its own bundler.
    copy: {
      "webview-dist": "views/overlay",
    },
    // Comma-separated string per schema, not array.
    targets: "linux-x64,linux-arm64",
    // Linux-specific: bundle CEF so we avoid the system webkit2gtk-4.1
    // dependency and gain proper compositing for the overlay. Picks CEF
    // as the default renderer so BrowserWindow doesn't need an explicit
    // renderer opt-in on every construction.
    linux: {
      bundleCEF: true,
      defaultRenderer: "cef",
      // Enable CEF DevTools over HTTP so we can debug the webview from
      // Chrome: visit http://localhost:9222 in a normal browser and
      // pick the overlay webview.
      chromiumFlags: {
        "remote-debugging-port": "9222",
        "remote-allow-origins": "*",
        // Mirror the webview's console.log/.warn/.error to the CEF
        // helper's stderr so systemd journal picks it up. Without this
        // CEF-side logs are only visible via the DevTools at :9222.
        "enable-logging": "stderr",
        // CEF defaults severity to `error`, which silently drops every
        // console.log / console.warn from the webview. Set to `info`
        // so the webview's own diagnostic breadcrumbs (plugin mount /
        // header mount / bundle fetch lifecycle) reach the journal,
        // which is how we diagnose crashes after the window dies.
        "log-severity": "info",
        // Force touch events on regardless of runtime device detection.
        // Under gamescope / nested X windows the auto-detection often
        // misses the handheld touchscreen, which left the overlay UI
        // un-scrollable by finger. This flag makes Chromium treat touch
        // as available and route it into the DOM, so overflow-auto
        // scrolls and TouchEvent listeners fire.
        "touch-events": "enabled",
        // Disable Chrome's variations-seed and field-trial machinery.
        // Reason: every utility helper subprocess gets spawned with
        // `--change-stack-guard-on-fork=enable` (Chromium's stack-canary
        // re-randomization between fork and exec). The Electrobun-
        // shipped `bun Helper` wrapper main() doesn't survive that —
        // crashes immediately with `*** stack smashing detected ***`
        // before reaching CEF's actual code. The helper most often
        // observed crashing is the `unzip.mojom.Unzipper` utility used
        // to unpack the variations seed. Killing variations means that
        // helper is never spawned, sidestepping the bug entirely.
        // (Also disables remote experiment overrides, which we don't
        // want under a kiosk-style overlay anyway.)
        "disable-features":
          "FieldTrialConfig,Variations,GlicActorUi,LensOverlay",
        "disable-field-trial-config": "",
        "disable-component-update": "",
      },
    },
  },
};
