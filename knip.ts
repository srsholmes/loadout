import type { KnipConfig } from "knip";

/**
 * Dead-code gate (unused files / exports / types / dependencies).
 * Run locally with `bun run check:dead-code`; CI runs it next to lint.
 *
 * The entry points below mirror how loadout actually loads code at
 * runtime — most plugin/SDK code is bundled on the fly with Bun.build()
 * rather than imported statically, so getting these right is what keeps
 * the report honest:
 *
 *  - apps/loadout: the compiled daemon binary starts at src/index.ts.
 *  - apps/loadout-overlay: Electrobun app — bun main process
 *    (src/bun/index.ts) + CEF webview (src/webview/main.tsx via
 *    vite/electrobun configs).
 *  - plugins/*: the daemon discovers each plugin dir and bundles its
 *    backend.ts (Bun runtime) and app.tsx (overlay webview) directly —
 *    see apps/loadout/src/loader/plugin-manager.ts and routes/plugins.ts.
 *  - packages/*: consumed via @loadout/* workspace imports; @loadout/ui
 *    is additionally bundled at runtime as the plugin SDK
 *    (loader/inject-builder.ts).
 *  - *.test.ts / *.spec.tsx: bun test entries (see root test scripts).
 */
const config: KnipConfig = {
  // An `export` consumed inside its own module isn't dead code — flagging
  // it would only force churn (dropping/re-adding the keyword) on symbols
  // that tests or future callers import next week. Cross-file dead exports
  // are still reported.
  ignoreExportsUsedInFile: true,

  // Tailwind v4 CSS carries real dependency edges — `@import "tailwindcss"`,
  // `@plugin "daisyui"`, `@import "react-resizable/css/styles.css"` — that
  // knip's JS/TS parsers can't see. Surface them as import statements so the
  // packages count as used instead of being ignore-listed.
  compilers: {
    css: (text: string) =>
      [...text.matchAll(/(?:@import|@plugin)\s+(["'][^"']+["'])/g)]
        .map(([, spec]) => `import ${spec};`)
        .join("\n"),
  },

  ignoreUnresolved: [
    // Root test:ui script preloads ./test/bun-test-setup.ts; knip's bun
    // plugin re-evaluates that root-relative path from every workspace
    // directory and reports a false miss for each one.
    "./test/bun-test-setup.ts",
    // apps/loadout-overlay/tsconfig.json `types: ["bun-types"]` — provided
    // transitively by the root @types/bun; not a package.json dependency.
    "bun-types",
  ],

  workspaces: {
    ".": {
      // scripts/*.ts are operator tooling invoked ad hoc via `bun
      // scripts/<name>.ts` (release.sh runs bump-version.ts); test/ is the
      // bun-test preload + shared render harness.
      entry: ["scripts/*.ts", "test/*.{ts,tsx}"],
      project: ["scripts/**/*.ts", "test/**/*.{ts,tsx}"],
      ignoreDependencies: [
        // Peer/runtime pair of @happy-dom/global-registrator (the import
        // site); pinned at the root so both move together.
        "happy-dom",
      ],
    },

    // src/index.ts (the compiled daemon binary's entry) is knip's default
    // entry, so only the test entries need declaring.
    "apps/loadout": {
      entry: ["src/**/*.test.ts"],
      project: "src/**/*.{ts,tsx,css}",
      ignoreDependencies: [
        // Not imported statically: the daemon writes a vendor shim at
        // runtime (loader/inject-builder.ts) and Bun.build() resolves
        // react/react-dom from node_modules next to it. Declared here so
        // the dev layout always has them.
        "react",
        "react-dom",
      ],
    },

    "apps/loadout-overlay": {
      entry: [
        "src/bun/index.ts",
        "src/webview/main.tsx",
        // Kept per its header comment for standalone `vite dev` of the
        // shared React tree (the production boot path is
        // src/webview/main.tsx).
        "src/overlay/main.tsx",
        // Deliberate API-parity shim: mirrors @overlay/lib/host inside the
        // Electrobun webview (see CLAUDE.md), so it keeps the full host
        // surface even where main.tsx currently imports only a subset.
        "src/webview/lib/electrobun.ts",
        // Registered wholesale on window.__SL_SOUNDS__ (shared-modules.ts);
        // consumers call members through that global, invisible to knip.
        "src/overlay/lib/sounds.ts",
        "electrobun.config.ts",
        "src/**/*.{test,spec}.{ts,tsx}",
      ],
      project: "src/**/*.{ts,tsx,css}",
    },

    // Each package's src/index.ts is picked up via its package.json
    // `exports`/default entry handling, so only tests need declaring.
    "packages/*": {
      entry: ["src/**/*.{test,spec}.{ts,tsx}"],
      project: "src/**/*.{ts,tsx,css}",
    },

    "plugins/*": {
      entry: ["app.tsx", "backend.ts", "**/*.{test,spec}.{ts,tsx}"],
      project: "**/*.{ts,tsx,css}",
    },

    // recomp additionally ships dynamic-loaded game/mod setup modules and
    // operator scripts on top of the standard plugin entries.
    "plugins/recomp": {
      entry: [
        "app.tsx",
        "backend.ts",
        "**/*.{test,spec}.{ts,tsx}",
        // Per-game/per-mod setup modules are dynamic-imported at install
        // time via games.json `setupModule` (lib/mods.ts), never statically
        // referenced.
        "games/*/setup.ts",
        "games/*/mods/*/setup.ts",
        // Maintainer tooling run ad hoc via `bun plugins/recomp/scripts/...`
        // (catalog audits, installer smoke tests).
        "scripts/*.ts",
      ],
      project: "**/*.{ts,tsx,css}",
    },
  },
};

export default config;
