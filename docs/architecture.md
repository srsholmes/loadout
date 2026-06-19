# Architecture

> **Doc currency (2026-06).** This page describes the system as it ships
> today. Two facts to anchor on before the detail below:
>
> - Plugin UIs render in the **Electrobun (CEF) overlay**
>   (`apps/loadout-overlay/`), not inside Steam. The overlay fetches each
>   plugin's compiled `app.tsx` bundle over HTTP from the loader and mounts
>   it in its own React tree.
> - The loader still drives Steam's own CEF over CDP, but only for
>   **Steam-side decoration and navigation** — store/library badges and CSS
>   (e.g. `protondb-badges`, `hltb`) and launching/navigation helpers. No
>   first-party plugin renders its main UI inside Steam.

## Overview

Loadout is a two-process system on the user's Deck:

1. **The loader** (`apps/loadout/`) — a single compiled Bun binary that runs
   as a system service. It discovers plugins, loads their backends, compiles
   their UIs on demand, exposes a typed RPC surface over HTTP + WebSocket on
   `127.0.0.1:33820`, and drives Steam's CEF over CDP for badge/CSS
   injection and game-session detection.
2. **The overlay** (`apps/loadout-overlay/`) — an Electrobun (CEF) app whose
   Bun main process owns the X11 window, the evdev input pipeline and the
   Gamescope atom loop, and whose CEF-rendered React tree is the user-facing
   UI. It talks to the loader over the same WebSocket RPC bridge any plugin
   frontend uses.

```
┌────────────────────────────────────────────────────────┐
│        Electrobun overlay  (apps/loadout-overlay)        │
│  ┌──────────────────────┐    ┌────────────────────────┐ │
│  │  CEF webview (React) │    │  Bun main process      │ │
│  │  App / Sidebar /     │◄──►│  X11 window, evdev,    │ │
│  │  Settings / plugin   │RPC │  Gamescope atoms,      │ │
│  │  app.tsx bundles     │    │  NavController         │ │
│  └──────────┬───────────┘    └────────────────────────┘ │
└─────────────┼────────────────────────────────────────────┘
              │ HTTP + WebSocket RPC (127.0.0.1:33820)
┌─────────────▼────────────────────────────────────────────┐
│        Loader  (apps/loadout)  — system service           │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ HTTP + WS    │  │ Plugin       │  │ Steam CEF      │  │
│  │ RPC server   │  │ backends     │  │ injector (CDP) │  │
│  │ + on-demand  │  │ (in-process) │  │ badges/CSS,    │  │
│  │ TSX compile  │  │              │  │ game session   │  │
│  └──────────────┘  └──────────────┘  └────────────────┘  │
└───────────────────────────────────────────────────────────┘
                              │ CDP (localhost:8080)
                       Steam's own CEF UI
```

## Monorepo Structure

Bun workspaces span three globs: `apps/*`, `packages/*`, `plugins/*`.

```
loadout/
├── apps/
│   ├── loadout/                 # The loader: Bun HTTP/WS server + Steam injector
│   │   └── src/
│   │       ├── index.ts         # CLI entry (port, --user, --version)
│   │       ├── loader/          # server, plugin-manager, rpc-handler,
│   │       │                    #   routes/, services/, sandboxed-fetch, auth
│   │       └── injector/        # CDP-driven Steam CEF injector + patchers
│   └── loadout-overlay/         # Electrobun (CEF) overlay app
│       └── src/
│           ├── bun/             # Bun main process (FFI, evdev, X11, atoms)
│           ├── webview/         # CEF UI boot shim + Electrobun RPC client
│           └── overlay/         # Shared React tree (App, Sidebar, Settings,
│                                #   PluginHost, hooks, lib/host.ts)
├── packages/                    # Shared workspace libraries (@loadout/*)
│   ├── deck-hid/                # Steam Deck HID protocol helpers
│   ├── exec/                    # Subprocess runner + per-plugin command policy
│   ├── external-cache/          # On-disk cache for external API responses
│   ├── file-picker/             # Native file/folder picker
│   ├── game-library/            # Steam app + non-Steam shortcut enumeration
│   ├── per-game-profiles/       # Per-game settings persistence
│   ├── plugin-storage/          # Per-plugin key/value storage on disk
│   ├── sgdb-art/                # SteamGridDB artwork fetching
│   ├── steam-cdp/               # Chrome DevTools Protocol client for Steam's CEF
│   ├── steam-cef-badges/        # Badge/CSS injection into Steam's CEF
│   ├── steam-paths/             # Steam install paths + gamescope detection
│   ├── steam-shortcut/          # shortcuts.vdf (non-Steam shortcut) editing
│   ├── types/                   # @loadout/types — PluginMeta, RPC types, etc.
│   ├── ui/                      # @loadout/ui — shared component library + SDK
│   └── vdf/                     # Valve KeyValues (VDF) parser/serializer
├── plugins/                     # First-party plugins (22 dirs)
├── scripts/                     # build.sh, install-local.sh, dev-overlay.sh, …
├── docs/
├── test/                        # Shared Bun test setup
├── types/                       # Ambient/global type declarations
├── package.json                 # Bun workspaces + root scripts
└── bunfig.toml
```

`packages/types` and `packages/ui` are the two that plugins depend on
directly; everything else is consumed by the loader, the overlay, or other
packages.

## The Overlay Main Process

`apps/loadout-overlay/src/bun/` is a Bun process that uses libc FFI to do
everything the CEF webview cannot. It owns:

- **The X11 window** — a single Electrobun `BrowserWindow`, hidden on boot,
  shown/hidden in response to the wake input. `native/x11.ts` and
  `native/gamescope-atoms.ts` manage the window and the Gamescope X11 atoms
  (the 50 ms active / 500 ms idle atom loop).
- **The evdev read loop** — `native/input-intercept.ts` reads controller
  input directly from `/dev/input`, using `EVIOCGRAB` / `EVIOCSMASK` to
  exclusively grab pads while the overlay is visible so the input doesn't
  also reach Steam. `native/ip-intercept.ts` handles external (network) pads.
- **The NavController** (`native/nav-controller.ts`) — translates controller
  events into navigation actions sent to the webview, which the webview turns
  into synthetic `KeyboardEvent`s for `norigin-spatial-navigation`.
- **The wake watcher** — `native/deck-hidraw-watcher.ts` (built on
  `@loadout/deck-hid`) watches the Deck's wake button.
- **The RPC surface** the webview calls (`show`, `hide`, `toggle`,
  `isGamescopeMode`, `restartServer`, `overlayHeartbeat`, …), registered via
  Electrobun's `defineRPC` and dispatched in `src/bun/rpc-handlers.ts`.

`process.env.DISPLAY` is detected and set before `electrobun/bun` is imported
because the native wrapper dlopens `libNativeWrapper.so` (which opens GTK's
X11 connection) on module load.

CEF's DevTools for the overlay live on `http://localhost:9222` in dev, baked
in via `apps/loadout-overlay/electrobun.config.ts`
(`build.linux.chromiumFlags["remote-debugging-port"] = "9222"`). This is the
overlay's CEF — distinct from Steam's CEF debug port (8080) the loader's
injector connects to.

## The Loader (System Service)

The loader runs as a **systemd service** — see `loadout.service`
(`apps/loadout/src/index.ts` is the entry). It binds loopback only
(`127.0.0.1`), so the RPC surface is never reachable off-box; a per-boot
session token (`loader/auth.ts`) additionally guards `/api/*` and `/ws`.

Responsibilities (`apps/loadout/src/loader/index.ts`):

- Serve the HTTP + WebSocket RPC API on port 33820 (default; `LOADOUT_PORT`
  overrides).
- Discover and load plugins (below).
- Compile plugin `app.tsx` files to browser bundles on demand via
  `Bun.build()` and serve them at `/plugins/<id>/app-bundle.js`.
- Register **core services** as synthetic plugins —
  `__core:game-detection` and `__core:game-library` — so the overlay and
  plugins can `useBackend("__core:…")` over the same RPC channel.
- Start the **Steam CEF injector** (below).
- Watch plugin directories and `packages/ui/src` for changes and broadcast
  `__system` `reload` events for hot reload in dev.

The binary embeds the full Bun runtime, so `Bun.build()` and dynamic
`import()` work at runtime — that's what lets it compile plugin backends and
frontends from source on the user's device.

## Plugin Structure

A plugin is a folder under `plugins/<id>/`. The manifest lives either in a
`plugin.json` or in the `plugin` field of `package.json` (the field shape is
`PluginMeta` in `packages/types/src/plugin.ts`). Both UI and backend are
optional, but in practice every first-party plugin has both.

```
my-plugin/
├── package.json     # PluginMeta under the `plugin` field; permissions at top level
├── backend.ts       # optional — default-exports a PluginBackend class
└── app.tsx          # optional — the React UI mounted in the overlay
```

- `backend.ts` default-exports a class implementing `PluginBackend`
  (`onLoad?`, `onUnload?`, plus any RPC methods). The loader injects `emit`
  and a scoped `log` onto the instance after construction.
- `app.tsx` exports a `mount(container, …)` function. Each plugin bundles its
  own React instance and manages its own root inside the div the overlay
  hands it; a `parentFocusKey` lets the plugin wire its focusables into the
  shell's spatial-navigation tree.
- `target` defaults to `overlay`. The manifest also supports `qam`, `menu`
  and `css` targets that render through the Steam injector, but no shipped
  first-party plugin uses them today.

There is no `panel.tsx` — the old Steam-injected-panel file does not exist in
any current plugin.

## Plugin Discovery and Loading

`loader/plugin-manager.ts` → `loadPlugins()` is the real path. For each entry
in the plugins directory:

1. Read the manifest from `plugin.json`, or from the `plugin` field of
   `package.json`. Entries with neither are skipped. (Permissions live at the
   top level of `package.json`, sibling to `plugin`.)
2. Build a **sandboxed `fetch`** for the plugin from its
   `permissions.network` allow-list (`loader/sandboxed-fetch.ts`,
   deny-by-default), and a **command policy** from `permissions.commands`
   (`@loadout/exec`, deny-by-default).
3. If `backend.ts` exists, bundle it with `Bun.build()` into
   `.cache/backend.bundle.js` (inlining all workspace deps, because a
   compiled Bun binary can't resolve `node_modules` from a dynamically
   imported file), then `import(bundlePath)` it and `new` the default export.
4. Call `onLoad()` inside both gates — command policy outside, sandboxed
   fetch inside — via `AsyncLocalStorage` so the scoping is concurrency-safe.
5. Record whether the plugin has an `app.tsx` (`hasApp`). Frontend bundles
   are compiled lazily on the first HTTP request, not at load time.

> Backends are loaded **in-process** with `import()`, not spawned as child
> processes. A crashed plugin can therefore affect the loader; in production
> the loader swallows uncaught exceptions (except OOM) to stay alive, and
> `LOADOUT_DEBUG=1` / `--debug` re-throws them instead. Process isolation is
> a known follow-up (see `TODOS.md`), not the current state.

## Typed RPC Bridge

Frontend ↔ backend communication is UUID-tagged JSON over WebSocket
(`/ws`), authenticated with the session token. The overlay's webview and any
plugin UI both use the same transport.

### Request flow

1. A plugin UI calls an RPC method (via the `@loadout/ui` SDK / `useBackend`
   hook), which sends `{ id, plugin, method, args }` over the WebSocket.
2. The loader's `rpc-handler.ts` looks up the plugin, resolves the method by
   name (`resolveMethod` in `packages/types`, which blocks lifecycle and
   `Object.prototype` methods and any `_`-prefixed name), and calls it inside
   the plugin's command-policy + sandboxed-fetch scopes.
3. The result is returned as `{ id, result }` (or `{ id, error }`); the
   pending promise resolves and React re-renders.

### Event flow

1. A backend calls `this.emit({ event, data })`.
2. The loader broadcasts `{ type: "event", plugin, event, data }` to every
   connected WebSocket client.
3. Frontend subscribers (`useEvent` and friends) fire. Core services
   broadcast on `__core:<name>` IDs (e.g. `__core:game-detection`'s
   `gameChanged`) so plugins can subscribe without bespoke wiring.

The overlay loads a plugin bundle by fetching its JS text from
`/plugins/<id>/app-bundle.js` and importing it as a same-origin blob URL —
a direct cross-origin `import()` from the `views://` webview origin would be
blocked (`apps/loadout-overlay/src/overlay/lib/backend.ts`).

## Steam-Injection Path (CDP)

The loader connects to Steam's own CEF over the Chrome DevTools Protocol
(`@loadout/steam-cdp`, Steam's debug port 8080) via the injector in
`apps/loadout/src/injector/`. What it's actually used for today:

- **Badge/CSS injection** into Steam's store/library views via
  `@loadout/steam-cef-badges` — `protondb-badges` and `hltb` push ratings and
  How-Long-To-Beat times onto Steam's pages.
- **Navigation / launch helpers** — plugins such as `launch-options`,
  `quick-links` and `store-bridge` use `@loadout/steam-cdp` to navigate
  Steam or drive launches.
- **Game-session detection** — the injector watches Steam for game
  launch/exit and fans `handleGameLaunch` / `handleGameExit` out to plugins
  in-process (Steam's CEF blocks `fetch()` to localhost, so the in-process
  binding callback is the authoritative dispatch path; this feeds the
  `__core:game-detection` service).

The injector's webpack/route/menu patchers and `qam`/`overlay`/`css` plugin
targets exist and gate on Gaming Mode, but the live, exercised path is the
badge/CSS + navigation + session-monitor use above. Plugin **UIs** render in
the overlay, not here.

## Startup Sequence

1. **Loader boots** as a system service (`index.ts` → `startServer`).
2. **Plugins load** — scan the plugins dir, build/import each `backend.ts`,
   call `onLoad()`.
3. **Inject bundles + core services** are prepared; `__core:game-detection`
   and `__core:game-library` register.
4. **HTTP/WS server** starts on `127.0.0.1:33820`.
5. **Steam injector** connects to Steam's CEF (8080), applies badges/CSS and
   starts the game-session monitor.
6. **Overlay app** starts independently; its webview fetches the session
   token (`/api/token`), opens the WebSocket, fetches `/api/plugins`, and
   mounts plugin `app.tsx` bundles on demand as the user navigates.
7. **Hot-reload watchers** (dev) broadcast `__system` `reload` events on
   plugin and SDK source changes.

## Build & Distribution

Root `package.json` scripts:

| Script              | What it does                                            |
| ------------------- | ------------------------------------------------------- |
| `dev`               | `bun run apps/loadout/src/index.ts` (loader, dev)       |
| `dev:overlay`       | `scripts/dev-overlay.sh`                                 |
| `dev:electrobun`    | `bun --filter @loadout/loadout-overlay dev`             |
| `build`             | `scripts/build.sh`                                       |
| `install-local`     | `scripts/install-local.sh`                              |
| `build-and-install` | `build.sh` then `install-local.sh`                      |
| `typecheck`         | `tsc --noEmit`                                           |
| `test`              | backend (`*.test.ts`) + UI (`*.spec.tsx`) Bun tests     |
| `lint` / `format`   | ESLint / Prettier                                       |

`scripts/build.sh`:

1. Compiles the loader with `bun build apps/loadout/src/index.ts --compile
   --minify` (version + build date injected via `--define`) to `dist/loadout`
   — a single self-contained binary (~50–100 MB) with the Bun runtime
   embedded.
2. Builds the overlay: `vite build` (webview) then `electrobun build
   --release` (bundles webview + CEF + the Bun main into
   `apps/loadout-overlay/build/`), then `scripts/inject-patched-wrapper.sh`
   swaps in a patched `libNativeWrapper.so` (the CEF 100%-CPU-spin fix).

The compiled binary does **not** include the overlay tree, the CEF runtime,
or the plugin directories — `scripts/install-local.sh` copies the overlay
build into the install prefix, CEF is fetched by Electrobun at build time,
and plugins are loaded at runtime from `PLUGINS_DIR`.

## Comparison with Decky

Loadout is a clean-room codebase, not a fork of Decky Loader. The main
architectural differences:

- **Overlay-rendered UIs.** Plugin UIs render in Loadout's own Electrobun
  (CEF) overlay rather than being injected into Steam's UI. Steam's CEF is
  touched only for badges/CSS and navigation.
- **Single compiled Bun binary** with the runtime embedded — no separate
  Python backend, and `Bun.build()`/`import()` compile plugins on-device.
- **Capability-scoped plugins** — per-plugin network (`sandboxed-fetch`) and
  command (`@loadout/exec`) allow-lists, deny-by-default.

## Licensing

- **BSD-3-Clause** for Loadout itself (see `LICENSE` / `NOTICE`).
- The overlay shell is built on **Electrobun (MIT)**; verbatim third-party
  license text lives in `THIRD_PARTY_LICENSES.md`.
- Each bundled plugin carries its own per-plugin attribution in a `NOTICE`
  file inside its directory.
- The codebase is independent of Decky Loader — not bound by its license.
