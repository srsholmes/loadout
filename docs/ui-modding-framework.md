# Loadout — UI Modding Framework

Loadout can inspect, patch, and restyle Steam's Big Picture Mode UI by
attaching to Steam's CEF over the Chrome DevTools Protocol (CDP). This
document describes that framework.

> **Status (2026-06):** The injection plumbing below is real and runs on
> startup, but several capabilities are **infrastructure-only** — they
> exist and are wired into the injector, yet **no shipped plugin uses
> them yet**, so they are effectively untested against real plugins.
> Each section is tagged accordingly. The user-facing plugin model today
> is the Electrobun overlay shell (`target: { type: "overlay" }`), not
> CEF-mounted React panels.

## Architecture

Steam's UI runs in Chromium Embedded Framework (CEF). The injector
(`apps/loadout/src/injector/`) connects to Steam's CEF debug port
(`localhost:8080`) and works across these contexts:

- **SharedJSContext** — Invisible page where webpack/React JavaScript
  executes. Module loading, React rendering logic, route/menu patches,
  and component discovery run here. This is the injector's primary
  target.
- **Big Picture Mode (BPM) tab** — The visible UI window. The element
  inspector and `BigPictureMode`-context CSS are injected here.
- **QuickAccess tab** — The Quick Access Menu (QAM) sidebar. Target for
  `QuickAccess`-context CSS.

Note: Steam splits React *execution* (SharedJSContext) from DOM
*rendering* (BPM tab); they are separate pages. This split is what makes
React DevTools unusable (see Known Limitations).

A separate, simpler injector lives in `packages/steam-cef-badges` and is
used by the **ProtonDB** and **HLTB** plugins to push CSS + small badge
runtimes into BPM game pages and `store.steampowered.com` tabs. It is
CSS + `Runtime.evaluate` only — no webpack patching, inspector, or
component discovery.

## Plugin manifest

Plugins declare their UI surface in the **`plugin` field of their
`package.json`** (typed as `PluginMeta` in
`packages/types/src/plugin.ts`). There is **no `plugin.json`**.

```jsonc
{
  "name": "@loadout/my-plugin",
  "plugin": {
    "id": "my-plugin",
    "name": "My Plugin",
    "version": "1.0.0",
    "description": "…",
    "author": "…",
    "target": { "type": "overlay" },
    "routes": { "/loadout/my-plugin/page": "MyPage" },
    "patches": [ /* … */ ],
    "styles": { "theme.css": "BigPictureMode" }
  }
}
```

### `target`

`PluginTarget` (or an array of them). If omitted, defaults to `overlay`.

| `type`     | Description                                                       | Status |
|------------|-------------------------------------------------------------------|--------|
| `overlay`  | Floating widget rendered by the **Electrobun overlay shell**.     | **Used** (e.g. `quick-links`, `recomp`) |
| `qam`      | Tab in the Quick Access Menu sidebar.                             | **Defined but disabled** — QAM patching is commented out in the injector ("no plugins currently use it usefully") |
| `menu`     | Item in Steam's main menu; navigates to a `route` when activated. | **Wired** (menu-patcher) but no plugin uses it |
| `css`      | CSS-only plugin (injects manifest `styles`, no React component).  | **Wired** but no plugin uses it |

Additional `PluginTarget` fields: `export`, `title` (required for `qam`),
`position` (numeric index or `"before:…"`/`"after:…"` string for `qam`),
`route` + `icon` (for `menu`), and `overlayPosition` / `overlaySize` /
`transparent` (for `overlay`).

> The old CEF-mounted React **panel/overlay** machinery
> (`__LOADOUT_PLUGIN_*` bundles, `panel.tsx`) was **removed as dead
> code** (issue #60) — no plugin shipped a `panel.tsx`. There is **no
> `panel` target**. Overlay plugins render in the Electrobun overlay,
> not inside Steam's CEF.

### `routes`

`Record<string, string>` — map of route path → exported component name.
Paths must be prefixed with `/loadout/{pluginId}/`. Applied in
SharedJSContext by the route-patcher, which falls back to a navigation
shim if it can't locate Steam's router component. **Wired; no plugin
currently declares routes.**

### `patches`

`PluginPatch[]` — Vencord-style webpack module patches (see below).
**Wired; no plugin currently declares patches.**

### `styles`

`Record<string, "SharedJSContext" | "QuickAccess" | "BigPictureMode">` —
map of CSS filename → target context. The injector fetches the file
server-side and injects it as an inline `<style>` (via CDP, to dodge
mixed-content blocks). Applied for `type: "css"` plugins. **Wired; no
plugin currently declares `styles`.**

### `loadOnStartup`

If `true`, the overlay shell imports the plugin's bundle and calls its
`init(api)` at startup, before the user opens its UI. Used by plugins
that apply persistent settings (e.g. `sound-loader`).

## Features

### Webpack Patching (Vencord-style) — *infrastructure, unused by plugins*

`buildWebpackPatcherScript` (`webpack-patcher.ts`) hooks
`webpackChunksteamui.push()` (and intercepts the array's first
assignment via `Object.defineProperty` if it doesn't exist yet) to apply
find/replace patterns to module factory source before execution. The
injector reads each plugin's `patches` from the loader API and injects
this script *first*, before any other bootstrap.

```jsonc
{
  "patches": [
    {
      "find": "someUniqueString",          // string, or string[] (all must match)
      "replacement": [
        { "match": "originalCode", "replace": "modifiedCode" }
      ],
      "optional": false                      // if true, no warning when unmatched
    }
  ]
}
```

`match` may be a plain string or a `/regex/flags` literal. `replace`
supports `$self` (resolves to the plugin's global module) and `$1`/`$2`
capture-group references. This is implemented and runs on startup, but
**no shipped plugin declares patches**, so it is untested in practice.

### CSS Injection — *partly real*

Two distinct mechanisms:

1. **Manifest `styles`** (above) — injected by the injector for
   `type: "css"` plugins. Wired, no plugin uses it yet.

2. **`@loadout/ui` runtime helpers** — for code running inside Steam's
   context:

   ```ts
   import {
     injectCSS,
     injectComponentCSS,
     getComponentClass,
     getAllComponentClasses,
   } from "@loadout/ui";

   // Inject custom styles (returns a cleanup function)
   const cleanup = injectCSS(`.my-class { border: 2px solid #00d4ff; }`);

   // Resolve a Steam component's hashed CSS-module class
   const btnClass = getComponentClass("DialogButton"); // → "_21DkRjmS_…" | null

   // Wrap rules with a component's class; `&` is the placeholder
   injectComponentCSS("DialogButton", `& { border-radius: 12px !important; }`);
   ```

   These are exported and implemented. `getComponentClass` /
   `getAllComponentClasses` read the `__STEAM_COMPONENTS_META` global
   produced by component discovery (below).

### Runtime Patching API — *implemented*

`@loadout/ui` exports monkey-patch helpers for modifying Steam objects
and methods at runtime (post-load), each returning an unpatch function
for cleanup (`packages/ui/src/patch.ts`):

```ts
import { afterPatch, beforePatch, insteadPatch } from "@loadout/ui";

// Run after the original; optionally return a modified value.
// handler(result, thisArg, args)
const unpatch = afterPatch(SteamClient.Apps, "GetAllApps", (result) =>
  result.filter((app) => app.name !== "Hidden Game"),
);

// Run before the original; return an array to replace its arguments.
// handler(thisArg, args)
beforePatch(SteamClient.System, "OpenInBrowser", (_this, args) => {
  console.log("Opening:", args[0]);
});

// Replace the method entirely; call `original` if you want.
// handler(original, thisArg, args)
insteadPatch(SteamClient.Apps, "RunGame", (original, _this, args) =>
  args[0] === blockedAppId ? undefined : original.apply(_this, args),
);
```

Also exported: `getReactFiber(element)` and
`findInFiberTree(fiber, predicate)` for runtime fiber inspection. These
helpers are implemented and exported; like the rest of the patching
surface, no shipped plugin currently consumes them.

### Steam Component Discovery — *implemented, runs on startup*

On injection (in Gaming Mode), `buildComponentDiscoveryScript`
(`steam-components.ts`) scans webpack modules in SharedJSContext to find
Valve's internal React components (DialogButton, Focusable, SliderField,
ToggleField, Dialog, etc.) and their CSS-module class hashes, reporting
metadata back to the loader and exposing it as `__STEAM_COMPONENTS_META`
for `getComponentClass()`. Component *names* are minified in production,
so discovery leans on CSS-module keys and unique prop-destructuring
patterns.

### Element Inspector — *implemented, dev-mode only (currently off)*

`buildInspectorScript` (`inspector.ts`) installs an overlay inspector in
the **BPM tab**:

- A floating **Inspect** button (bottom-left) and **F12** toggle.
- Hover highlights an element; an info panel shows React component name,
  fiber path (parent component chain), tag, CSS classes, and props.
- Click copies a "find pattern" (a source snippet) for use in webpack
  patches. Click **Stop** (the same button) to deactivate.

**Caveat:** the inspector is only injected when the injector is started
with `devMode: true`. The loader (`apps/loadout/src/loader/index.ts`)
**does not set `devMode`**, so in normal builds the inspector is *not*
active. There is currently no command-line flag or env var that turns it
on; enabling it requires a code change to the `SteamInjector`
construction.

## DevTools access

There is **no CDP multiplexer**. The multiplexer that once let Chrome
DevTools and the injector share a connection was deleted (audit A-027)
because it was never wired up. `chrome://inspect` with `localhost:33820`
does **not** work — `33820` is the loader's plain HTTP API port, not a
CEF debug target.

To inspect with Chrome DevTools, point a Chromium-based browser at the
relevant debug port directly:

- **Steam's CEF** — `http://localhost:8080` (open it in Chromium, or
  use `chrome://inspect` → Configure → add `localhost:8080`). Targets:
  BPM, SharedJSContext, QuickAccess.
- **Loadout's own overlay (Electrobun/CEF)** — `http://localhost:9222`
  in dev (baked into `electrobun.config.ts` →
  `build.linux.chromiumFlags`).

## Known Limitations

### React DevTools does not work

Steam splits React execution (SharedJSContext) from DOM rendering (BPM
tab). React DevTools (Chrome extension and standalone
`bunx react-devtools`) requires the JS context and rendered DOM to live
in the same page, which is not the case for Steam.

What was tried:

- Chrome DevTools extension on remote targets — stuck on "Loading React
  Element Tree".
- Standalone React DevTools with a bridge script — same issue.
- Installing `__REACT_DEVTOOLS_GLOBAL_HOOK__` before React loads (via
  `Page.addScriptToEvaluateOnNewDocument` + reload) — the hook captures
  real React internals, but the backend can't traverse the fiber tree
  cross-context.
- Synchronous XHR to load the backend before React — blocked by mixed
  content (HTTPS steamloopback → HTTP localhost).
- Direct CDP injection of the backend — connects, then disconnects in a
  loop due to the cross-context DOM mismatch.

Workaround: use the built-in element inspector (when dev mode is enabled)
for component/prop/class inspection, and Chrome DevTools' Elements tab
via `localhost:8080` for DOM inspection.

### SharedJSContext reload destroys BPM

Reloading SharedJSContext via CDP (`Page.reload`) makes the BPM tab
disappear temporarily. It recovers, but disrupts the UX and requires
retry/reconnect logic. The injector instead detects reloads
(`Page.domContentEventFired`) and re-injects, rather than forcing
reloads itself.

### Route patching is best-effort

The route-patcher may fail if Steam's router component structure changes
between builds. When it can't find the expected component it falls back
to a navigation shim, which is less integrated but still routes.

## Dev workflow

Start the backend + overlay with hot reload:

```sh
bun run dev:overlay
```

This runs `scripts/dev-overlay.sh`, which:

- Starts the Bun loader/API server on port `33820` (override with
  `LOADOUT_PORT`) and waits for its `/up` health check.
- When running under gamescope (Gaming Mode), matches Steam's `DISPLAY`
  so the overlay renders on the correct X server.
- Starts the Electrobun overlay in dev mode (`bunx electrobun dev`),
  with CEF DevTools on `http://localhost:9222`.
- Watches plugin directories and hot-reloads on change (the loader
  re-injects via `SteamInjector.reinject()`).

Related scripts (root `package.json`): `dev` (API server only),
`dev:electrobun` (overlay only), `build`, `build-and-install`,
`typecheck`, `test`, `lint`, `format`.

> The element inspector and any "dev mode injection" are **not** turned
> on by these scripts — see the Element Inspector caveat above. There is
> no `bun run dev:inject` script and no in-Steam dev server on
> `localhost:33820` (that port is the loader's HTTP API).
