import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Discover server-only packages by reading every `packages/*/package.json`
// and collecting names where `loadout.serverOnly === true`. The
// corresponding `no-restricted-imports` block forbids plugins (and any
// non-loader code) from importing the implementation — they must consume
// the matching `__core:*` RPC surface instead. New server-only packages
// opt in by adding `"loadout": { "serverOnly": true }` to their
// package.json; this loop picks them up automatically.
const serverOnlyPackages = (() => {
  try {
    return readdirSync("packages", { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => {
        try {
          const pkg = JSON.parse(
            readFileSync(join("packages", d.name, "package.json"), "utf8"),
          );
          return pkg.loadout?.serverOnly ? [pkg.name] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
})();

const serverOnlyPathBlocks = serverOnlyPackages.map((name) => ({
  name,
  message: `${name} is server-only — it's consumed by the loader's __core:* services. Plugins must call the matching RPC surface (e.g. useBackend("__core:game-library")) instead of importing the implementation.`,
}));

export default tseslint.config(
  {
    ignores: [
      "node_modules",
      "dist",
      "**/dist/**",
      ".build",
      "**/.build/**",
      ".sdk-build",
      ".inject-build/**",
      ".vendor-build/**",
      "**/.cache/**",
      ".claude/**",
      // Electrobun build artefact: dev-linux-x64 bundles + webview-dist
      // Vite output. Both are minified bundles of all our deps; linting
      // them produces ~5000 spurious errors against generated code.
      "**/build/**",
      "**/webview-dist/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.tsx", "**/*.ts"],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Audit Q-007 (2026-05): escalated from `warn` to `error` after the
      // six outstanding violations were cleaned up. Going forward, any new
      // exhaustive-deps miss must be explicitly suppressed with a comment
      // explaining why the dep is intentionally omitted.
      "react-hooks/exhaustive-deps": "error",
    },
  },
  // Audit Q-008 (2026-05): route every subprocess through
  // @loadout/exec so the wrapper's timeout, error-handling, and
  // sudo plumbing stays the single source of truth. `packages/exec/`
  // is exempt (it IS the wrapper). Spec files are exempt because
  // bun:test mocks `Bun.spawn` via `mock.module(...)` patterns; the
  // mock dispatcher needs to reference the real symbol.
  {
    files: ["**/*.ts", "**/*.tsx"],
    ignores: [
      "packages/exec/**",
      "**/*.spec.ts",
      "**/*.spec.tsx",
      "**/*.test.ts",
      "**/*.test.tsx",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.name='Bun'][property.name='spawn']",
          message:
            "Use `run`/`runFull`/`spawn` from @loadout/exec instead of `Bun.spawn` directly — preserves the wrapper's timeout + error-handling contract (audit Q-008, 2026-05).",
        },
        {
          selector:
            "MemberExpression[object.name='Bun'][property.name='spawnSync']",
          message:
            "Route through @loadout/exec — same rationale as Bun.spawn (audit Q-008).",
        },
      ],
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-imports": "error",
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
  },
  // Seal plugins: a plugin may import from `@loadout/*` workspace
  // packages, but never from another plugin. Cross-plugin imports break
  // the manager/plugin boundary — plugins are independent capsules the
  // daemon loads/unloads at runtime, not a web of peer deps. Q-009 in
  // the 2026-05 audit; landed at `error` because rg confirmed zero
  // existing violations across plugins/.
  //
  // Detection is regex-based because ESLint's `no-restricted-imports`
  // glob patterns use gitignore semantics (`*` matches `..`), so a naive
  // `../*/**` glob false-positives on `../../test/render` — the shared
  // test helper every plugin's spec.tsx legitimately imports.
  //
  // The number of `../` segments needed to escape the plugin root
  // depends on file depth, so we scope the regex per depth. A file at
  // `plugins/<name>/<sub>/<file>.ts` needs `../../` to land at
  // `plugins/`; its `../<x>` resolves to `plugins/<name>/<x>` (same
  // plugin) and must NOT be flagged. The recomp plugin is the first to
  // ship nested `scripts/` and `games/<id>/` subdirs, so this matters.
  //
  // The `group: ["plugins/**"]` pattern catches absolute-style escapes
  // regardless of depth and applies in every override.
  //
  // `@loadout/plugin-*` is intentionally NOT blocked as a name
  // pattern because `packages/plugin-storage` ships as
  // `@loadout/plugin-storage` (a workspace package, not a plugin)
  // — name-based blocking would false-positive on it. No plugin lists
  // another plugin in its dependencies today, so that vector is moot.
  //
  // Depth 1 (`plugins/<name>/<file>.ts`): any `../<x>` escapes.
  //
  // The `paths` entry seals server-only packages (those whose
  // package.json declares `"loadout": { "serverOnly": true }`).
  // Importing one of those by name from a plugin is forbidden — the
  // plugin must call the matching `__core:*` RPC surface instead. The
  // list is discovered at config-load time; new server-only packages
  // opt in by flipping the flag. ESLint replaces (not merges) rule
  // options across configs, so the seal has to live inside the same
  // `no-restricted-imports` entry as the plugin-seal patterns.
  {
    files: ["plugins/*/*.ts", "plugins/*/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: serverOnlyPathBlocks,
          patterns: [
            {
              regex:
                "^(?:\\.\\./)+(?!(?:test|packages|node_modules)(?:/|$))[\\w-]+(?:/|$)",
              message:
                "Plugins are sealed: don't import from another plugin via a relative path. Lift shared code into a @loadout/* workspace package instead.",
            },
            {
              group: ["plugins/**", "@/plugins/**"],
              message:
                "Plugins are sealed: don't import from another plugin. Lift shared code into a @loadout/* workspace package instead.",
            },
          ],
        },
      ],
    },
  },
  // Depth 2 (`plugins/<name>/<sub>/<file>.ts`): need 2+ `../` to escape.
  {
    files: ["plugins/*/*/*.ts", "plugins/*/*/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: serverOnlyPathBlocks,
          patterns: [
            {
              regex:
                "^(?:\\.\\./){2,}(?!(?:test|packages|node_modules)(?:/|$))[\\w-]+(?:/|$)",
              message:
                "Plugins are sealed: don't import from another plugin via a relative path. Lift shared code into a @loadout/* workspace package instead.",
            },
            {
              group: ["plugins/**", "@/plugins/**"],
              message:
                "Plugins are sealed: don't import from another plugin. Lift shared code into a @loadout/* workspace package instead.",
            },
          ],
        },
      ],
    },
  },
  // Depth 3 (`plugins/<name>/<sub>/<sub2>/<file>.ts`): need 3+ `../`.
  {
    files: ["plugins/*/*/*/*.ts", "plugins/*/*/*/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: serverOnlyPathBlocks,
          patterns: [
            {
              regex:
                "^(?:\\.\\./){3,}(?!(?:test|packages|node_modules)(?:/|$))[\\w-]+(?:/|$)",
              message:
                "Plugins are sealed: don't import from another plugin via a relative path. Lift shared code into a @loadout/* workspace package instead.",
            },
            {
              group: ["plugins/**", "@/plugins/**"],
              message:
                "Plugins are sealed: don't import from another plugin. Lift shared code into a @loadout/* workspace package instead.",
            },
          ],
        },
      ],
    },
  },
  // Forbid `Bun.spawn` outside `packages/exec/`. Plugins and the rest of
  // the codebase route through `@loadout/exec` (run / runFull /
  // runCode / spawn) so subprocess handling stays consistent (timeouts,
  // env merging, mockable spawn). Q-006 in the 2026-05 audit; landed
  // as part of the @loadout/exec migration sweep.
  {
    files: ["**/*.ts", "**/*.tsx"],
    ignores: [
      "packages/exec/**",
      // Spec files mock or stub Bun.spawn directly.
      "**/*.spec.ts",
      "**/*.spec.tsx",
      "**/*.test.ts",
      "**/*.test.tsx",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.name='Bun'][property.name='spawn']",
          message:
            "Don't call Bun.spawn directly. Import { run, runFull, runCode, spawn } from \"@loadout/exec\" instead.",
        },
      ],
    },
  },
  prettier,
);
