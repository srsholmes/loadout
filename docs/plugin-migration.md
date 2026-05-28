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
      "permissions": { "network": [], "commands": [] },
      "category": "…",
      "target": { "type": "overlay" }
    }
  }
  ```
  `id` / `name` / `description` are required; `permissions` / `category` / `target` / `routes` are optional. See `PluginMeta` in `packages/types/src/plugin.ts`.
- `backend.ts` (optional) — default-export a class `implements PluginBackend` (from `@loadout/types`). Lifecycle: `onLoad?` / `onUnload?` / `emit?` / `log?`. **Every public, non-underscore method becomes an RPC endpoint.** Prefix private helpers with `_` to keep them off the wire.
- UI entry — `app.tsx`. The plugin renders in the Electrobun overlay. Backends that need to drive Steam's CEF UI talk to it via `@loadout/steam-cdp` (extracted from `apps/loadout/src/steam-cdp/`).
- `lib/**` (optional) — inlined helper modules.
- Carry over `assets/`, `README.md`, `LICENSE` if present.

**`app.tsx` shape** (overlay):
- `export function mount(container: HTMLElement, opts?: { parentFocusKey?: string }): () => void` — render with `createRoot`, wrap the tree in `<PluginProvider parentFocusKey={opts?.parentFocusKey}>`, return a cleanup that calls `root.unmount()`.
- Optional `export const icon` (a `react-icons` component).
- Optional `export function mountHeader(...)` with the same signature.
- SDK comes from `@loadout/ui`: `useBackend`, `PluginProvider`, components (`Panel`, `Button`, `Text`, `Field`, `Slider`, `TextInput`, `Spinner`, …), `useFocusable`, `navigate` / `navigateToPage` / `navigateBack`, `injectCSS`, `useCurrentGame`, etc.

**Imports allowed** (runtime-hoisted by `scripts/prepare-plugins.sh`): ONLY `@loadout/ui`, `@loadout/types`, `@loadout/exec`, `@loadout/steam-paths`, plus `react`, `react-dom`, `react-icons`. Anything else must be either declared in this plugin's `package.json` `dependencies` OR inlined into `lib/`. **Never import another plugin** — relative cross-plugin imports and `@loadout/plugin-*` imports are blocked by the plugin-seal rules in `eslint.config.js`.

**Subprocess:** route through `@loadout/exec` (`run` / `runFull` / `runCode` / `runStreaming` / `spawn`). Never call `Bun.spawn` / `Bun.spawnSync` directly — eslint-enforced (spec files may mock).

**Commands (capability gate):** the backend runs as **root** (a system service), so plugins can write hardware sysfs and call privileged tools **directly** — do NOT shell out to `sudo` / `pkexec`; drop those wrappers from the ported code (e.g. `sudo tee /sys/...` becomes `tee /sys/...`, or just an `fs` write). In exchange, declare every external binary you run in `plugin.permissions.commands` (binary names, e.g. `["ryzenadj", "systemctl", "tee"]`). The loader scopes a per-plugin policy around `onLoad` + every RPC call and `@loadout/exec` *actively denies* any undeclared binary — deny-by-default, so an empty/missing list blocks all commands (`packages/exec/src/index.ts` → `withCommandPolicy`, mirrors the network sandbox). Matching is on `basename(cmd[0])` only (not arguments). Every command a plugin runs is logged to `~/.config/loadout/logs`. **Known gap:** writing `/sys` or `/dev/hidraw*` *directly via `fs`* (not a subprocess) is not command-gated — declare those paths in `permissions.filesystem` for visibility.

**Bundled binaries (`plugin.bundled_bins`):** if the plugin ships its own binary (e.g. tdp-control bundles `ryzenadj`), each entry MUST have ALL of:
- `name` — basename of the binary as it appears in `permissions.commands`.
- `path` — relative to plugin dir; ELF for every listed platform.
- `version` — matching the upstream tag.
- `source` — upstream repo URL.
- `license` — SPDX identifier (e.g. `LGPL-3.0`).
- `license_file` — relative path that **resolves on disk**.
- `platforms` — e.g. `["linux-x64"]`; must match `file <path>` arch.
- `rebuild_with` — relative path to an **executable** build script that reproduces `path` from `source`.
- `sha256` — checksum of the binary at `path`. Used to verify reproducibility (`sha256sum <path>` must match at review and CI time).
- `rationale` — one-sentence justification ("why bundle, not require install").

A missing field is a merge blocker. tdp-control's `bundled_bins[0]` is the reference shape.

**Network:** declare every domain you fetch in `plugin.permissions.network`. The loader's sandboxed fetch *actively blocks* undeclared hosts (`apps/loadout/src/loader/sandboxed-fetch.ts`); an empty/missing list blocks all network.

**Tests** — the repo is **all-`bun:test`** (no vitest, no shell scripts). Filename picks the runner/env:
- **backend / pure-logic → `*.test.ts`**, run by `bun test test.ts` in bun's native env (no DOM). `backend.ts` ≥ 100 LOC → `backend.test.ts`; any `lib/**/*.ts` ≥ 100 LOC → sibling `.test.ts`. (Enforced by `scripts/check-plugin-specs.sh`, MIN_LOC = 100.)
- **React / DOM (UI) → `*.spec.tsx`**, run by `bun test spec.tsx --preload ./test/bun-test-setup.ts` (happy-dom). `app.tsx` ≥ 100 LOC → `app.spec.tsx`.
- Use the **`bun:test` API**, NOT vitest: `import { describe, it, expect, mock } from "bun:test"`. `mock()` replaces `vi.fn`. For module mocks, `mock.module(spec, () => ({ ...real, ...overrides }))` — capture the real module via a static `import * as real` first and `await import()` the SUT **after** the mock (bun's `mock.module` isn't hoisted). Fake timers: `jest.useFakeTimers()` / `jest.advanceTimersByTime()`. Subprocess mocking via `Bun.spawn` stubs is fine in tests.
- **Isolation:** `test:backend` and `test:ui` pass `--isolate` (Bun 1.3.14+), so each spec file gets a fresh global and `mock.module` no longer leaks across files. Still **prefer `spyOn(obj, "method")`** for built-in/shared modules (`fs`, `node:fs/promises`, `@loadout/*`) — it patches the live binding cleanly and is more explicit about what's being faked. See `docs/test-mock-contamination.md`.
- Port the source plugin's tests, converting vitest→`bun:test`; don't drop coverage.
- **Pure-logic extraction:** if `backend.ts` contains pure helpers (no `this`, no I/O — `parse*`, `compute*`, `clamp*`, etc.), promote them to `lib/<name>.ts` with a co-located `<name>.test.ts`. The `check:specs` script enforces "≥100 LOC → sibling test exists"; this rule goes further — pure logic SHOULD live in `lib/` regardless of LOC, because that's where it's testable without mocks.

**Lint baseline:** the codebase carries a standing pool of `@typescript-eslint/no-explicit-any` warnings (currently ~35). The PR must NOT regress that count vs `main`, AND must add zero new errors:

```bash
git checkout main && BASE=$(bun run lint 2>&1 | grep -oE '[0-9]+ problems' | head -1 | grep -oE '[0-9]+')
git checkout - && CUR=$(bun run lint 2>&1 | grep -oE '[0-9]+ problems' | head -1 | grep -oE '[0-9]+')
echo "Baseline: $BASE — PR: $CUR — Delta: $((CUR - BASE))"
```

If the delta is positive, the new warnings must be justified in the PR description (usually a few `as any` casts in tests, capped at +2 per plugin).

---

## Cross-distro compatibility (review-time check)

Loadout targets Linux gaming handhelds + gaming desktops. The reviewer classifies every entry in `plugin.permissions.commands`, every path in `permissions.filesystem`, and the runtime behaviour against this matrix:

| Distro | Notes |
|---|---|
| **SteamOS** (stock Deck) | Arch-based, `/usr` immutable, AMD only, gamescope compositor default. Most utility binaries present; no AUR — bundle anything not in stock. |
| **CachyOS** | Arch desktop, AUR available, KDE/Hyprland/GNOME variants, any hardware vendor. |
| **Bazzite** | Fedora atomic, `rpm-ostree`, SELinux strict, KDE Plasma default. Bazzite-Deck variant ships ectool. |
| **Nobara** | Fedora-based gaming distro, mutable, gaming tooling preinstalled, no SELinux strict by default. |
| **ChimeraOS** | Arch-based handheld console image. ryzenadj/ectool/handheld utilities preinstalled. |

**Binary classification:**
- ✅ **Universal** (all five): `systemctl`, `busctl`, `bluetoothctl`, `ip`, `nmcli`, `upower`, `udevadm`, `xinput`, `tee`, `cat`.
- ⚠️ **Session-conditional** (works on some sessions, silently no-ops on others):
  - `xrandr` — X11/XWayland only; **no-ops under native Wayland** (default on Bazzite/Nobara KDE, CachyOS Hyprland/GNOME Wayland).
  - `pactl` / `pw-cli` — PipeWire (default everywhere now).
  - `busctl --user org.kde.KWin.*` — KDE only.
  - `hyprctl` — Hyprland only.
  - `xprop GAMESCOPE_*` — gamescope only (SteamOS Gaming Mode, ChimeraOS, Bazzite-Deck Gaming Mode).
- ❌ **Hardware / distro-specific** (absent without bundling):
  - `ryzenadj` — AMD only. **NOT on SteamOS/Bazzite/Nobara stock**; available on ChimeraOS, CachyOS via AUR. Bundle for SteamOS coverage.
  - `ectool` — Steam Deck firmware. SteamOS ✅, Bazzite-Deck ✅, ChimeraOS ✅; vanilla Arch/Fedora/Nobara ❌.
  - `intel_gpu_top`, `intel_pstate_*` — Intel only.
  - `nvidia-smi`, `nvml`, `nvidia-settings` — NVIDIA only.

**Filesystem-path classification:**
- `/sys/class/backlight/*` — needs backlight driver; common on handhelds/laptops, **absent on most desktops**.
- `/sys/class/hwmon/*` — needs hwmon modules; universal, but each device's labels differ — never hardcode.
- `/sys/devices/system/cpu/*`, `/sys/class/drm/*`, `/sys/class/power_supply/*` — universal.
- `/sys/devices/platform/oxp-*`, `asus-nb-wmi`, `acpi/*` — vendor-handheld specific; the plugin MUST detect-and-degrade if absent.

**Implications for migrators:**
- If you use a ⚠️ binary, the plugin MUST detect-and-degrade — don't crash if the user is on Wayland-without-XWayland, GNOME-not-KDE, etc.
- If you use a ❌ binary, bundle a fallback via `bundled_bins` (per the schema above) OR document in the PR which distros the plugin won't work on (and why that's OK).
- The reviewer's `/review-migration N` skill renders a per-distro verdict (✅ likely / ⚠️ partial / ❌ broken) for the PR.

---

## Porting procedure

1. **Copy** the source plugin tree `plugins/{{PLUGIN_ID}}/` from SOURCE into TARGET `plugins/{{PLUGIN_ID}}/`.
2. **Rename the scope** on every ported file: `sed -i 's#@steam-loader/#@loadout/#g'` (review the diff — only the four allowed packages should remain after step 4).
3. **Fold `plugin.json` into `package.json`.** Move the manifest fields into the `plugin` field of `package.json`, set `name` to `@loadout/plugin-{{PLUGIN_ID}}`, add `"type": "module"` and the real `dependencies`. Delete the standalone `plugin.json`.
4. **Resolve removed-package deps by inlining** (see the decision rule below). The packages `plugin-storage`, `vdf`, `external-cache`, `sgdb-art`, `steam-shortcut`, `file-picker`, and `per-game-profiles` DO NOT exist in the target — replace each import with inlined code in this plugin's `lib/` *by default*.
5. **Adapt to the current SDK / manifest shape.** Reconcile any `@loadout/ui` / `@loadout/types` API drift against the reference plugin and `packages/types/src/plugin.ts`. The source repo's `panel.tsx` plugins (Steam-CEF injection) port to `app.tsx` — the Electrobun overlay is the surface; backends drive Steam's CEF via `@loadout/steam-cdp` when needed. Ensure the `mount` / `PluginProvider` / `icon` shape matches `plugins/steam-gamescope-ipc/app.tsx`.
6. **Port the tests to `bun:test`.** Convert the source's backend `*.spec.ts` → `*.test.ts` and keep UI tests as `*.spec.tsx`; rewrite any vitest API to `bun:test` (see **Tests** above). Add tests for any ≥100-LOC `lib/**` module.
7. **Wire it into `plugins/`** so the workspace picks it up (it's a workspace via `plugins/*`). Confirm it loads (see Definition of Done).

---

## Isolate vs. extract — READ THIS

> **Share when reuse is real. Inline when it's a one-off.**

- **Extract to `packages/<name>` when ≥2 consumers genuinely share the same helper.** Consumers can be already-merged plugins, in-flight migration PRs, or plugins clearly pending migration with the same dep (a `@steam-loader/<name>` import in ≥2 source plugins is strong evidence).
- **Inline into `lib/<name>.ts`** when the helper is only used by one plugin OR it's tightly coupled to the plugin's domain. One-off `parse* / clamp* / format*` helpers stay local.
- The old steam-loader repo's package list is a strong hint about future-consumer counts. Cross-reference: `git grep '@steam-loader/<name>' /var/home/srsholmes/Work/linux-gaming-plugin-manager/plugins/` to count real consumers.
- **When in doubt, flag it in your PR description** ("`external-cache` inlined here; same helper appears in source plugin X — extract when X migrates"). The reviewer extracts in a follow-up sweep.

**Removed helper packages — current strategy** (consumer counts are from the source-repo audit, sorted by usage):

| Old package | Source-plugin consumers | What to do |
|---|---|---|
| `plugin-storage` | 8 — audio-mixer, disable-controller-input, fan-control, quick-links, recomp, steamgriddb, store-bridge, tdp-control | **EXTRACTED ✓** as `@loadout/plugin-storage`. Always use it; never inline. |
| `vdf` | 7 — game-browser, hltb, launch-options, quick-links, recomp, steamgriddb, store-bridge | **EXTRACT** as `@loadout/vdf` before any of those migrate. 7 inline copies is wrong. |
| `external-cache` | 5 — hltb, protondb-badges, recomp, steamgriddb, store-bridge | **EXTRACT** as `@loadout/external-cache`. protondb-badges already has an inlined copy on its in-flight PR; migrate that to the package post-extraction. |
| `per-game-profiles` | 2 — audio-mixer, fan-control (plus tdp-control on main already duplicating the logic) | **EXTRACT** as `@loadout/per-game-profiles` + retro-migrate fan-control + tdp-control. |
| `sgdb-art` | 2 — recomp, store-bridge | Extract when those two migrate together. |
| `steam-shortcut` | 2 — recomp, store-bridge | Extract when those two migrate together. |
| `file-picker` | 1 — recomp | Inline into `lib/file-picker.ts` (~50 LOC). |
| `steam-cdp` / `injector` | 9 / 1 — used by every Steam-CEF-injection plugin in the source | **N/A in Loadout.** The source repo used external CDP control (the loader spawned a separate process and drove Steam's CEF over the DevTools Protocol); Loadout uses `target: { type: "panel" }` + webpack patches instead. CEF-touching plugins must be re-architected as panel-targets — there's no `@loadout/steam-cdp` equivalent. See `apps/loadout/src/injector/` for how the loader handles CDP internally. |

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
- [ ] `bun run lint` — **0 errors AND** warning-count not regressed vs `main` baseline (see Lint baseline above).
- [ ] `bun run check:specs` (MIN_LOC=100 enforces backend/lib have sibling tests).
- [ ] `bun run test:backend` AND `bun run test:ui` (or `bun run test`) — all green, ported coverage preserved.
- [ ] `bun run build`.
- [ ] **Behavior parity**: walked through every RPC method, emitted event, and UI surface against the SOURCE plugin — no regressions, same names/signatures/payloads.
- [ ] **Plugin loads**: the loader logs `Loaded plugin: {{PLUGIN_NAME}} ({{PLUGIN_ID}}) …` (from `apps/loadout/src/loader/plugin-manager.ts`).
- [ ] Only `@loadout/{ui,types,exec,steam-paths,plugin-storage}` + react/react-dom/react-icons remain as external imports (everything else is declared in `package.json` or inlined). No cross-plugin imports. No direct `Bun.spawn`.
- [ ] **Pure logic in `lib/`**: every pure helper that lived inline in `backend.ts` has been promoted to `lib/<name>.ts` with a co-located `<name>.test.ts`. Backend = I/O + RPC plumbing only; pure stuff = `lib/`.
- [ ] **Storage** (if persisted): uses `@loadout/plugin-storage` (`readPluginStorage` / `writePluginStorage`). No inlined fs helpers.
- [ ] **Mount** (UI): `mountComponent(Component)` + `mountHeaderStub` (or `mountComponent(Header)` for separate-tree pattern) from `@loadout/ui`. No inlined `createRoot + PluginProvider` boilerplate.
- [ ] **Bundled binaries** (if any): every `bundled_bins[i]` has `name`, `path`, `version`, `source`, `license`, `license_file` (resolves), `platforms` (matches ELF arch), `rebuild_with` (executable), `sha256` (matches `sha256sum <path>`), `rationale`.
- [ ] **Cross-distro check**: for each `permissions.commands` and `permissions.filesystem` entry, classified per the matrix above. PR description lists the per-distro verdict (SteamOS / CachyOS / Bazzite / Nobara / ChimeraOS): ✅ likely / ⚠️ partial / ❌ broken, with the reason for any non-✅.
- [ ] Any new shared `packages/<name>` (if created at all) is justified by 2+ already-migrated consumers.

---

## Fill these in per plugin (issue author)
- **Plugin id:** `{{PLUGIN_ID}}`
- **Plugin name:** `{{PLUGIN_NAME}}`
- **Source path:** `linux-gaming-plugin-manager/plugins/{{PLUGIN_ID}}/`
- **UI surface:** overlay (`app.tsx`) — only surface. Steam-CEF UI driven from the backend via `@loadout/steam-cdp`.
- **Removed-package deps used:** (e.g. plugin-storage, vdf) → inline target(s)
- **Network domains to declare:** …
- **Subprocess usage:** y/n (must route through `@loadout/exec`)
- **Commands to declare** (`permissions.commands`): … (binary names; drop any `sudo`/`pkexec` — backend is root)
- **Notable risks / gotchas:** …
