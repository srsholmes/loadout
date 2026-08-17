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
        // Disable Chrome's variations-seed, field-trial and component-
        // update machinery. This *reduces* — but does not eliminate — a
        // helper-subprocess crash, so it's worth spelling out.
        //
        // Every zygote-forked helper is spawned with
        // `--change-stack-guard-on-fork=enable` (Chromium re-randomizes
        // the stack canary after fork). Chromium's own main() is built
        // with NO_STACK_PROTECTOR to survive that; the Electrobun-shipped
        // `bun Helper` main() is not. So any helper that *returns from*
        // `CefExecuteProcess` aborts with `*** stack smashing detected ***`
        // at the end of main(). Long-lived helpers (renderer, GPU) only
        // return at shutdown, so in practice it's the short-lived utility
        // helpers — `unzip.mojom.Unzipper`, `patch.mojom.FilePatcher` —
        // that visibly die, each leaving a coredump and (in desktop mode)
        // a DrKonqi "encountered a fatal error" popup.
        //
        // The crash is post-work and harmless: the helper has already
        // finished unzipping/patching when main() returns, and the browser
        // process is unaffected.
        //
        // These flags kill the variations-seed unzip path, but they do NOT
        // cover everything: CEF still runs the component updater ~60s after
        // launch and updates the CRLSet, which spawns Unzipper + FilePatcher
        // regardless of `disable-component-update` (observed 2026-08-17,
        // CertificateRevocation 10718 → 10720). The real fix is rebuilding
        // `bun Helper` with `-fno-stack-protector` on main() and vendoring
        // it next to libNativeWrapper.so — an upstream Electrobun bug.
        // Note `--change-stack-guard-on-fork=disable` is not a workaround:
        // the zygote host appends `enable` when building each child's
        // command line, overwriting anything set here.
        //
        // (Disabling variations also kills remote experiment overrides,
        // which we don't want under a kiosk-style overlay anyway.)
        "disable-features":
          "FieldTrialConfig,Variations,GlicActorUi,LensOverlay",
        "disable-field-trial-config": "",
        "disable-component-update": "",
      },
    },
  },
};
