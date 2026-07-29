## Overlay architecture

The overlay is an Electrobun (CEF) app at `apps/loadout-overlay/`:

- `src/bun/` — the main process (Bun + libc FFI). Owns the evdev read
  loop, EVIOCGRAB / EVIOCSMASK, Gamescope atoms, NavController, the
  X11 window, and the RPC surface the webview talks to.
- `src/webview/` — the CEF-rendered UI boot shim. Pulls the shared
  React tree in via the `@overlay/*` path alias and wires
  `rpc.send("overlay-action", …)` → synthetic KeyboardEvents for
  norigin-spatial-navigation.

The shared React tree lives at `apps/loadout-overlay/src/overlay/`. The
host-RPC shim sits at `apps/loadout-overlay/src/overlay/lib/host.ts`;
every callsite imports from `@overlay/lib/host`. Its counterpart inside
the Electrobun webview is
`apps/loadout-overlay/src/webview/lib/electrobun.ts`.

CEF's DevTools live on `http://localhost:9222` in dev (baked in via
`electrobun.config.ts` → `build.linux.chromiumFlags`). Attach Chromium
or use CDP directly.

## Internationalization (i18n)

Runtime-switchable translations are driven by a single shared i18next
instance that lives in `@loadout/ui` (`packages/ui/src/i18n.ts`). Because
plugin bundles resolve `@loadout/ui` to the shell's `__LOADOUT_SDK`
global, the shell and every plugin share that one instance — calling
`setLanguage(code)` re-renders the whole tree, no reload.

- **Language codes** are lowercase BCP-47-ish (`en-gb`, `zh-cn`) and match
  the translation filenames. English (`en-gb`) is the source + fallback.
  Supported languages: `SUPPORTED_LANGUAGES` in `packages/ui/src/i18n.ts`.
- **Shell strings** live under the `app` namespace in
  `apps/loadout-overlay/src/overlay/i18n/<code>.json` (statically bundled).
  Use `const { t } = useTranslation("app")`.
- **Plugin strings**: each plugin ships an `i18n/` folder with one
  `<code>.json` per language (flat `key: "value"` pairs — same schema for
  every plugin). The plugin id is its i18next namespace. In `app.tsx`:

  ```tsx
  import { usePluginTranslation } from "@loadout/ui";
  const { t } = usePluginTranslation("my-plugin-id");
  <span>{t("some_key")}</span>
  ```

  Files are served by the loader at `/plugins/<id>/i18n/<code>.json` and
  lazy-loaded on first use; missing keys fall back to English.
- **Detection / override**: the active language is persisted in user
  config under `language`. It's detected once at first run (host OS locale
  → `navigator.language` → English) in
  `apps/loadout-overlay/src/overlay/lib/i18n-setup.ts`, and the user can
  override it in Settings → General → Language.

When adding a new plugin, ship at least `i18n/en-gb.json` and wrap visible
strings in `t()`. `battery-tracker` is the reference implementation.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
