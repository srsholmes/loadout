<!--
Canonical plugin-migration prompt. This is the body template for the
per-plugin migration GitHub issues: copy it into an issue and substitute
{{PLUGIN_ID}} / {{PLUGIN_NAME}} (and fill the per-plugin stub at the bottom).
One plugin per issue, migrated one at a time.
-->

# Migrate one plugin: {{PLUGIN_NAME}} (`{{PLUGIN_ID}}`)

**Goal:** Port the `{{PLUGIN_ID}}` plugin from the old Steam Loader repo into the new Loadout repo, one plugin at a time. Port it *faithfully* (zero behavior regressions), simplify only where it is provably safe, and keep all of its code *inside the plugin* unless something is genuinely shared by 2+ already-migrated plugins.

## Locations
- **SOURCE** (old, "Steam Loader"): `/var/home/srsholmes/Work/linux-gaming-plugin-manager`
  - This plugin: `plugins/{{PLUGIN_ID}}/`
  - Imports use the `@steam-loader/*` scope.
- **TARGET** (new, "Loadout"): `/var/home/srsholmes/Work/loadout`
  - Port into: `plugins/{{PLUGIN_ID}}/`
  - Reference example plugin: `plugins/steam-gamescope-ipc/`
  - Plugin dev guide: `docs/plugin-development.md` (note: parts predate the `package.json` `plugin` field — trust the reference plugin over the doc where they disagree)
  - Sandboxed fetch enforcement: `apps/loadout/src/loader/sandboxed-fetch.ts`
  - Plugin contract types: `packages/types/src/plugin.ts`

---

## Target plugin contract (match this exactly)

**Layout** — `plugins/{{PLUGIN_ID}}/`:
- `package.json` — name `@loadout/plugin-{{PLUGIN_ID}}`, `"type": "module"`, deps, and a `plugin` field (the manifest now lives here, NOT in a separate `plugin.json`):
  ```json
  {
    "name": "@loadout/plugin-{{PLUGIN_ID}}",
    "version": "0.0.1",
    "type": "module",
    "dependencies": { "react": "^18.3.0", "react-dom": "^18.3.0", "@loadout/ui": "workspace:*" },
    "plugin": {
      "id": "{{PLUGIN_ID}}",
      "name": "{{PLUGIN_NAME}}",
      "description": "…",
      "permissions": { "network": [] },
      "category": "…",
      "target": { "type": "overlay" }
    }
  }
  ```
  `id` / `name` / `description` are required; `permissions` / `category` / `target` / `routes` are optional. See `PluginMeta` in `packages/types/src/plugin.ts`.
- `backend.ts` (optional) — default-export a class `implements PluginBackend` (from `@loadout/types`). Lifecycle: `onLoad?` / `onUnload?` / `emit?` / `log?`. **Every public, non-underscore method becomes an RPC endpoint.** Prefix private helpers with `_` to keep them off the wire.
- UI entry — `app.tsx` for the **overlay** (the default for almost every plugin) OR `panel.tsx` for **Steam CEF injection**. Use whichever the source plugin used.
- `lib/**` (optional) — inlined helper modules.
- Carry over `assets/`, `README.md`, `LICENSE` if present.

**`app.tsx` shape** (overlay):
- `export function mount(container: HTMLElement, opts?: { parentFocusKey?: string }): () => void` — render with `createRoot`, wrap the tree in `<PluginProvider parentFocusKey={opts?.parentFocusKey}>`, return a cleanup that calls `root.unmount()`.
- Optional `export const icon` (a `react-icons` component).
- Optional `export function mountHeader(...)` with the same signature.
- SDK comes from `@loadout/ui`: `useBackend`, `PluginProvider`, components (`Panel`, `Button`, `Text`, `Field`, `Slider`, `TextInput`, `Spinner`, …), `useFocusable`, `navigate` / `navigateToPage` / `navigateBack`, `injectCSS`, `useCurrentGame`, etc.

**Imports allowed** (runtime-hoisted by `scripts/prepare-plugins.sh`): ONLY `@loadout/ui`, `@loadout/types`, `@loadout/exec`, `@loadout/steam-paths`, plus `react`, `react-dom`, `react-icons`. Anything else must be either declared in this plugin's `package.json` `dependencies` OR inlined into `lib/`. **Never import another plugin** — relative cross-plugin imports and `@loadout/plugin-*` imports are blocked by the plugin-seal rules in `eslint.config.js`.

**Subprocess:** route through `@loadout/exec` (`run` / `runFull` / `runCode` / `spawn`). Never call `Bun.spawn` / `Bun.spawnSync` directly — eslint-enforced (spec files may mock).

**Network:** declare every domain you fetch in `plugin.permissions.network`. The loader's sandboxed fetch *actively blocks* undeclared hosts (`apps/loadout/src/loader/sandboxed-fetch.ts`); an empty/missing list blocks all network.

**Specs** (enforced by `scripts/check-plugin-specs.sh`, MIN_LOC = 100):
- `backend.ts` ≥ 100 LOC → `backend.spec.ts` (`bun:test`).
- `app.tsx` ≥ 100 LOC → `app.spec.tsx` (vitest).
- any `lib/**/*.ts` ≥ 100 LOC → sibling `.spec.ts`.
- Carry over the source plugin's existing specs and adapt them; don't drop coverage.

---

## Porting procedure

1. **Copy** the source plugin tree `plugins/{{PLUGIN_ID}}/` from SOURCE into TARGET `plugins/{{PLUGIN_ID}}/`.
2. **Rename the scope** on every ported file: `sed -i 's#@steam-loader/#@loadout/#g'` (review the diff — only the four allowed packages should remain after step 4).
3. **Fold `plugin.json` into `package.json`.** Move the manifest fields into the `plugin` field of `package.json`, set `name` to `@loadout/plugin-{{PLUGIN_ID}}`, add `"type": "module"` and the real `dependencies`. Delete the standalone `plugin.json`.
4. **Resolve removed-package deps by inlining** (see the decision rule below). The packages `plugin-storage`, `vdf`, `external-cache`, `sgdb-art`, `steam-shortcut`, `file-picker`, and `per-game-profiles` DO NOT exist in the target — replace each import with inlined code in this plugin's `lib/` *by default*.
5. **Adapt to the current SDK / manifest shape.** Reconcile any `@loadout/ui` / `@loadout/types` API drift against the reference plugin and `packages/types/src/plugin.ts`. If the source used `panel.tsx` but renders in the overlay, keep `panel.tsx` only if it's a real Steam-injection plugin; otherwise it stays `app.tsx`. Ensure the `mount` / `PluginProvider` / `icon` shape matches `plugins/steam-gamescope-ipc/app.tsx`.
6. **Carry / port the specs.** Adapt `backend.spec.ts` (bun:test) and `app.spec.tsx` (vitest); add specs for any ≥100-LOC `lib/**` module. Spec files may mock `Bun.spawn` / use `mock.module` — that's allowed.
7. **Wire it into `plugins/`** so the workspace picks it up (it's a workspace via `plugins/*`). Confirm it loads (see Definition of Done).

---

## Isolate vs. extract — READ THIS

> **Simplicity is always preferred. It is better to repeat a little code than to hastily abstract.**

- **Default = INLINE.** Plugin code stays inside the plugin (`lib/`). Do NOT create a `packages/<name>` shared package speculatively.
- **Only promote to `packages/<name>` when the bar is met: 2+ *already-migrated* plugins in this repo genuinely need the same thing.** "A future plugin might want this" does not count. "The old repo had it as a package" does not count.
- When in doubt, repeat. Extraction is a cheap follow-up once real reuse appears; a premature abstraction is expensive to unwind and couples independent plugin capsules.

**Removed helper packages — inline guidance** (old usage counts are hints only; they do NOT justify pre-emptive extraction):

| Old package | Old usage | What to do |
|---|---|---|
| `plugin-storage` | ×8 | Inline: read/write JSON at `~/.config/loadout/plugins/{{PLUGIN_ID}}.json` (~30–50 LOC). |
| `vdf` | ×7 | Inline the parse/stringify subset this plugin actually uses. |
| `external-cache` | ×5 | Inline: tiny TTL disk cache (~40 LOC). |
| `steam-shortcut` | ×2 | Inline. |
| `sgdb-art` | ×2 | Inline. |
| `file-picker` | ×1 | Inline. |
| `per-game-profiles` | — | Inline. |

If this plugin is (say) the 2nd migrated plugin to need an *identical* `plugin-storage` helper, you MAY extract a `packages/plugin-storage` — but only then, only with the duplicate already in tree, and call it out explicitly in the PR.

---

## Simplify without regression

**Safe to cut / collapse:**
- Dead code: unused exports, unreachable branches, commented-out blocks, unused imports/deps.
- Over-abstraction: collapse a one-call-site wrapper/factory/HOC back into its caller; flatten needless indirection layers.
- Redundant wrappers around `@loadout/*` SDK calls that add nothing.
- Compatibility shims for the old scope/build that no longer apply.

**NOT safe — do NOT touch:**
- Anything that changes observable behavior, RPC method names/signatures, emitted event names/payloads, or manifest semantics.
- Debounce/serialize/retry logic, error handling, or timing — preserve it exactly.
- Removing a spec to make a refactor "pass". Adjust the spec to the new shape instead.

If a simplification carries *any* regression risk, leave the code as-is and note it. Faithful port first; tidy second.

---

## Definition of Done

All green from the TARGET repo root (`/var/home/srsholmes/Work/loadout`):
- [ ] `bun run typecheck`
- [ ] `bun run lint`
- [ ] `bun run check:specs`
- [ ] `bun run test`
- [ ] `bun run build`
- [ ] **Behavior parity**: walked through every RPC method, emitted event, and UI surface against the SOURCE plugin — no regressions, same names/signatures/payloads.
- [ ] **Plugin loads**: the loader logs `Loaded plugin: {{PLUGIN_NAME}} ({{PLUGIN_ID}}) …` (from `apps/loadout/src/loader/plugin-manager.ts`).
- [ ] Only `@loadout/{ui,types,exec,steam-paths}` + react/react-dom/react-icons remain as external imports (everything else is declared in `package.json` or inlined). No cross-plugin imports. No direct `Bun.spawn`.
- [ ] Any new shared `packages/<name>` (if created at all) is justified by 2+ already-migrated consumers.

---

## Fill these in per plugin (issue author)
- **Plugin id:** `{{PLUGIN_ID}}`
- **Plugin name:** `{{PLUGIN_NAME}}`
- **Source path:** `linux-gaming-plugin-manager/plugins/{{PLUGIN_ID}}/`
- **UI surface:** overlay (`app.tsx`) | Steam injection (`panel.tsx`)
- **Removed-package deps used:** (e.g. plugin-storage, vdf) → inline target(s)
- **Network domains to declare:** …
- **Subprocess usage:** y/n (must route through `@loadout/exec`)
- **Notable risks / gotchas:** …
