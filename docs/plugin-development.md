# Plugin Development Guide

> **Doc currency (2026-06).** This guide documents the current
> Electrobun-overlay plugin model. A plugin is a workspace package under
> `plugins/<id>/` whose `package.json` carries a `plugin` manifest field,
> an optional `backend.ts`, and a UI entry `app.tsx`. The UI renders in
> the Electrobun (CEF) overlay — there is no in-Steam dev server and no
> `plugin.json` / `panel.tsx`. The `Steam.*` components described near
> the end only resolve in CEF-injected (Steam-side) contexts, not in the
> overlay; the default UI path is `app.tsx`.

This guide covers everything you need to build plugins for Loadout — plugin anatomy, the manifest, the backend RPC API, the frontend SDK and components, permissions, spatial (gamepad) navigation, the dev/build/test loop, and a complete worked example based on a real shipped plugin.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) installed
- For live testing: Steam running in Big Picture / Gaming Mode on the same machine (the overlay attaches to gamescope's display)
- Clone the repository and install dependencies:

```bash
git clone <repo-url>
cd loadout
bun install
```

### Plugin Anatomy

Every plugin is a workspace package living in the `plugins/` directory. A
typical plugin looks like this:

```
plugins/my-plugin/
├── package.json    # npm package + the `plugin` manifest field
├── backend.ts      # (optional) server-side logic — RPC methods, events
├── app.tsx         # React UI — what the user sees, exports `mount`
├── lib/            # (optional) shared pure helpers (parsing, formatting)
├── backend.test.ts # (optional) backend unit tests (`bun test`)
├── app.spec.tsx    # (optional) UI tests (`bun test`)
└── README.md
```

There is **no** `plugin.json` and **no** `panel.tsx` — both are gone. The
manifest is a `plugin` field on `package.json`, and the UI entry is
`app.tsx`.

#### 1. Manifest (`package.json`)

The package is a normal workspace member. The `plugin` field holds the
manifest:

```json
{
  "name": "@loadout/plugin-my-plugin",
  "version": "0.0.1",
  "type": "module",
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "@loadout/ui": "workspace:*",
    "@loadout/types": "workspace:*"
  },
  "plugin": {
    "id": "my-plugin",
    "name": "My Plugin",
    "description": "My first Loadout plugin",
    "category": "Tools",
    "subtitle": "Short tagline shown under the title"
  }
}
```

#### 2. Backend (`backend.ts`)

A default-exported class implementing `PluginBackend` from
`@loadout/types`. Optional — a UI-only plugin can omit it.

```ts
import type { PluginBackend, EmitPayload } from "@loadout/types";

export default class MyPluginBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;

  async onLoad() {
    console.log("My plugin loaded!");
  }

  async greet(name: string): Promise<string> {
    return `Hello, ${name}!`;
  }
}
```

#### 3. Frontend (`app.tsx`)

A React component, exported for mounting via `mountComponent` from
`@loadout/ui`. The overlay shell calls the `mount` export.

```tsx
import { useState } from "react";
import { useBackend, Button, mountComponent } from "@loadout/ui";
import { FaStar as icon } from "react-icons/fa6";

export { icon };

function MyPlugin() {
  const { call } = useBackend("my-plugin");
  const [message, setMessage] = useState("");

  const handleGreet = async () => {
    const result = await call("greet", "World");
    setMessage(result as string);
  };

  return (
    <div className="p-7">
      <p>{message || "Click the button!"}</p>
      <Button variant="primary" onClick={handleGreet}>
        Say Hello
      </Button>
    </div>
  );
}

export const mount = mountComponent(MyPlugin);
```

#### 4. Run It

```bash
# Start the Bun backend server + the Electrobun overlay with hot reload
bun run dev:overlay
```

The UI renders inside the Electrobun (CEF) overlay window. Attach
Chromium (or any CDP client) to `http://localhost:9222` to inspect it
with DevTools.

---

## Setting Up IntelliSense

The project is a Bun monorepo with workspaces (`apps/*`, `packages/*`,
`plugins/*`). Your plugin automatically resolves types from the
workspace packages it depends on:

- `@loadout/types` — backend interfaces (`PluginBackend`, `EmitPayload`, `PluginMeta`, `PluginPermissions`)
- `@loadout/ui` — React components, hooks, and the host SDK
- `@loadout/exec` — the subprocess allow-list (`run`, `spawn`, …)

### Editor Setup

The monorepo's root `tsconfig.json` handles path resolution. Open the
root folder (not the plugin subfolder) for full IntelliSense:

```bash
code /path/to/loadout
```

### Type Imports

```tsx
// Frontend types
import type { DialogButtonProps, SliderFieldProps } from "@loadout/ui";

// Backend types
import type { PluginBackend, EmitPayload, PluginMeta } from "@loadout/types";
```

---

## Manifest Reference

The manifest is the `plugin` object on the plugin's `package.json`. Its
shape is `PluginMeta` in
[`packages/types/src/plugin.ts`](../packages/types/src/plugin.ts).

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique plugin id. Used in RPC routing and route prefixes. IDs starting with `__` are **reserved** (the loader rejects them — that namespace belongs to core services). |
| `name` | `string` | Display name. |
| `version` | `string` | Plugin version. In practice the npm package `version` is used; only set this in the manifest if it must differ. |
| `description` | `string` | One-line description. |
| `author` | `string` | Author. Often omitted in-repo. |
| `category` | `string` | Grouping in the overlay's plugin list, e.g. `Tools`, `Game`, `Steam`, `Performance`, `Device`. |
| `subtitle` | `string` | Short tagline shown under the title. |
| `permissions` | `PluginPermissions` | Sandbox allow-lists — see [Permissions](#permissions). |
| `target` | `PluginTarget \| PluginTarget[]` | Rendering target(s). Defaults to overlay if omitted. |
| `routes` | `Record<string, string>` | Map of route path → named export from the UI. Paths must be prefixed `/loadout/{id}/`. |
| `patches` | `PluginPatch[]` | Webpack module patches — modify Steam's own components before they render (Vencord-style). |
| `styles` | `Record<string, "SharedJSContext" \| "QuickAccess" \| "BigPictureMode">` | CSS files to inject (for `type: "css"` plugins). |
| `loadOnStartup` | `boolean` | If true, the overlay imports the plugin's bundle at startup and calls its exported `init(api)` before the user opens its UI (e.g. to apply persistent settings). Default `false`. |

> Note: `PluginMeta` types `id`, `name`, `version`, `description`, and
> `author` as required, but the live in-repo plugins omit `version` and
> `author` from the manifest (the npm `version` field covers versioning).
> Always set `id`, `name`, and `description`.

### `target`

`PluginTarget` controls where and how a plugin renders:

| Field | Description |
|-------|-------------|
| `type` | `"overlay"` (default), `"qam"`, `"css"`, or `"menu"`. |
| `export` | Which named export from `app.tsx` to render. Defaults to `"default"`. |
| `title` | Display name in the QAM tab bar (required for `type: "qam"`). |
| `position` | Where to insert in the QAM tab bar. Default: append. |
| `overlayPosition` | `{ top?, bottom?, left?, right? }` for overlay-type plugins. |
| `overlaySize` | `{ width?, height? }` for overlay-type plugins. |
| `transparent` | If true, the overlay has no background (HUD-style widgets). |
| `route` | Route path for `type: "menu"` entries — the injector navigates here on activation. |
| `icon` | Emoji/image URL beside a `type: "menu"` label. |

Most plugins are simply `"target": { "type": "overlay" }` (or omit
`target` entirely).

---

## Backend API

The backend is a TypeScript class (default export) that runs in the Bun
loader process. It implements `PluginBackend` from `@loadout/types`.
Every public method becomes an RPC endpoint callable from the frontend.

### The `PluginBackend` interface

```ts
export interface PluginBackend {
  onLoad?(): Promise<void> | void;
  onUnload?(): Promise<void> | void;
  emit?(payload: EmitPayload): void;
  log?: PluginLogger; // scoped logger injected by the loader
}
```

### Lifecycle Hooks

```ts
export default class MyBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;
  private interval?: Timer;

  // Called when the plugin loads
  async onLoad() {
    this.interval = setInterval(() => { /* … */ }, 1000);
  }

  // Called when the plugin unloads — clean up here
  async onUnload() {
    clearInterval(this.interval);
  }
}
```

### RPC Methods

Any public method on your backend class is callable from the frontend
via `call()`. Method resolution lives in `resolveMethod`
([`packages/types/src/plugin.ts`](../packages/types/src/plugin.ts)):

- Lifecycle methods (`onLoad`, `onUnload`, `emit`) and `Object.prototype`
  methods are blocked.
- Methods whose name starts with `_` are treated as private and are not
  callable (the underscore convention).

```ts
export default class SettingsBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;
  private settings: Record<string, unknown> = {};

  async getSetting(key: string): Promise<unknown> {
    return this.settings[key];
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    this.settings[key] = value;
    this.emit?.({ event: "settingChanged", data: { key, value } });
  }

  // Not callable via RPC — leading underscore marks it private.
  private _validate(value: unknown) { /* … */ }
}
```

### Emitting Events

Push real-time events from backend to the frontend. The payload is an
`EmitPayload`: `{ event: string; data: unknown }`.

```ts
this.emit?.({
  event: "statusUpdate",
  data: { cpu: getCpuUsage(), temp: getTemp() },
});
```

### Logging

The loader injects a scoped logger as `this.log` after construction.
Declare the field to use it without a cast:

```ts
import type { PluginBackend, PluginLogger } from "@loadout/types";

export default class MyBackend implements PluginBackend {
  log?: PluginLogger;

  async onLoad() {
    this.log?.info("loaded");
  }
}
```

### Running Commands & Network

Backends do not call `Bun.spawn` directly. All subprocess work goes
through `@loadout/exec`, which enforces the `commands` permission:

```ts
import { run, runFull, runCode, runStreaming, spawn, commandExists } from "@loadout/exec";

// One-shot, trimmed stdout + exit code
const { stdout } = await run(["bluetoothctl", "devices"]);

// Long-lived / streaming process
const proc = spawn(["bluetoothctl", "scan", "on"], { stdout: "ignore", stderr: "ignore" });
```

Each `run`/`runFull`/`runCode`/`runStreaming`/`spawn` checks
`basename(cmd[0])` against the plugin's `permissions.commands` list.
An undeclared binary is **denied** (deny-by-default). `commandExists`
(a `which` probe) is exempt so you can feature-detect a binary before
declaring it.

Backend `fetch()` is likewise sandboxed: only domains listed in
`permissions.network` resolve. Everything else is blocked.

---

## Frontend SDK

The frontend SDK lives in `@loadout/ui`
([`packages/ui/src/index.ts`](../packages/ui/src/index.ts)). The key
pieces for plugin authors are below.

### Mounting

A plugin's `app.tsx` exports a `mount` function the overlay shell calls.
Build it with `mountComponent`:

```tsx
import { mountComponent } from "@loadout/ui";

function MyPlugin() { /* … */ }

export const mount = mountComponent(MyPlugin);
```

`mountComponent(Component)` returns `(container, opts?) => unmount`. It
wraps your component in `PluginProvider` (WebSocket connection + spatial
nav wiring) so you don't write the `createRoot` boilerplate yourself.

Other entry exports the shell recognises:

- `export const icon = …` — a `react-icons` component used in the plugin
  list. Often `export { FaGauge as icon } from "react-icons/fa6"`.
- `export const mountHeader = mountHeaderStub` — the presence of a
  `mountHeader` export reserves the overlay's 60px topbar slot; with
  `mountHeaderStub`, the actual header is portaled from inside `mount()`
  via `<PluginHeader>` (same React tree). Use `mountComponent(Header)`
  instead if you want a separate header tree.
- `export const mountHomeWidget = mountComponent(Widget)` — a compact
  widget shown on the overlay home screen.

### `useBackend(pluginId)`

The main hook for talking to your backend
([`packages/ui/src/sdk.tsx`](../packages/ui/src/sdk.tsx)):

```tsx
const { call, useEvent, ready } = useBackend("my-plugin");
```

| Property | Type | Description |
|----------|------|-------------|
| `call` | `(method: string, ...args: unknown[]) => Promise<unknown>` | Call a backend RPC method |
| `useEvent` | `({ event, handler }) => void` | Subscribe to a backend event |
| `ready` | `boolean` | Whether the WebSocket connection is established |

The returned object is memoized on `pluginId`, so it is safe to put in a
`useEffect` dependency array.

#### Calling methods

```tsx
const devices = await call("getDevices");
await call("connectDevice", mac);

try {
  const data = await call("riskyOperation");
} catch (err) {
  console.error("Backend error:", err);
}
```

#### Subscribing to events

```tsx
useEvent({
  event: "deviceChanged",
  handler: (data) => {
    const changed = data as BluetoothDevice;
    setDevices((prev) => prev.map((d) => (d.mac === changed.mac ? changed : d)));
  },
});
```

### `useCurrentGame()`

Subscribe to the loader's currently-running Steam game. Returns `null`
when no game is active; updates live as games launch and exit. Backed by
the `__core:game-detection` core service — prefer this over polling.

```tsx
import { useCurrentGame } from "@loadout/ui";

const game = useCurrentGame(); // { appId, gameName, startTime } | null
```

### `notify(message, opts?)`

Cross-root toast. Plugins dispatch a window event the shell's toaster
forwards to its singleton:

```tsx
import { notify } from "@loadout/ui";

notify("Saved", { kind: "success" });
notify("Couldn't turn Bluetooth on", { kind: "error" });
```

`opts.kind` is `"success" | "error" | "loading"` (default `"success"`);
`duration` and a stable `id` (replace-in-place) are also supported.

### `hideOverlay()`

Programmatically dismiss the overlay window:

```tsx
import { hideOverlay } from "@loadout/ui";
await hideOverlay();
```

---

## Built-in UI Components

`@loadout/ui` ships a set of overlay-native React components. These work
in the overlay (unlike `Steam.*` — see the caveat below). The full
export list is in
[`packages/ui/src/index.ts`](../packages/ui/src/index.ts). Common ones:

| Component | Purpose |
|-----------|---------|
| `Button`, `IconButton` | Buttons (gamepad-focusable). |
| `Toggle`, `Slider`, `Select`, `TextInput`, `SearchField`, `SegmentedItem` | Form controls. |
| `Panel`, `Field`, `Badge`, `Alert`, `Spinner` | Layout / status primitives. |
| `Collapse` | Collapsible / accordion box (gamepad-focusable, closed by default). |
| `TabBar` | Tab navigation. |
| `PluginHeader`, `PluginHeaderSlotProvider` | Portal content into the overlay's topbar slot. |
| `HeaderBackButton`, `useHeaderBack` | Back button + handler. |
| `GameCard`, `GameHero`, `NowPlaying` | Steam-library-aware presentational components. |

Styling uses Tailwind utility classes plus project CSS tokens (see the
`className`s in real plugins, e.g. `card`, `page-content`, `chip`).

> **⚠️ Adding a NEW `@loadout/ui` component requires an overlay rebuild.**
> The overlay bakes `@loadout/ui` into its build at compile time and exposes
> it to plugins as the `__LOADOUT_SDK` global
> (`apps/loadout-overlay/src/overlay/shared-modules.ts`). A plugin's
> `import { Foo } from "@loadout/ui"` resolves to `__LOADOUT_SDK.Foo` at
> runtime. So if you add a new export to `@loadout/ui`, re-staging plugins
> (`scripts/prepare-plugins.sh`) is **not enough** — the installed overlay's
> baked SDK won't have it, `Foo` will be `undefined`, and the plugin renders
> blank (React "Element type is invalid", minified error #130). Rebuild +
> reinstall the overlay so the new component is baked in:
> `bun run build` then re-copy `apps/loadout-overlay/build/.../loadout-overlay-dev`
> to `~/.local/share/loadout-overlay` (this is what `install-local.sh` does),
> then `bun run restart`. Editing an *existing* component, or plugin-local
> code, only needs a re-stage + backend restart.

---

## Spatial (Gamepad) Navigation

Every interactive element must be navigable with a gamepad (d-pad + A).
Built-in `@loadout/ui` controls (`Button`, `Slider`, `Toggle`, `TabBar`,
`TextInput`, …) handle this automatically. For custom interactive
elements, use `useFocusable()` from `@loadout/ui`
([`packages/ui/src/spatial-nav.ts`](../packages/ui/src/spatial-nav.ts)):

```tsx
import { useFocusable } from "@loadout/ui";

function GameCard({ game, onSelect }) {
  const { ref, focused } = useFocusable({
    onEnterPress: () => onSelect(game.id),
  });
  return (
    <div ref={ref} className={focused ? "ring-2 ring-primary/40" : ""}>
      <img src={game.cover} />
      <span>{game.name}</span>
    </div>
  );
}
```

`useFocusable` registers with the shell's `SpatialNavigation` singleton
via `window.__SPATIAL_NAV__` so every plugin's focusable elements share
one focus tree across React roots. `mountComponent` already wraps your
tree in `PluginProvider`, which supplies the parent focus key.

Related exports: `FocusContext`, `setFocus`, `getCurrentFocusKey`,
`navigateByDirection`, `pushBackInterceptor`, `tryRunBackInterceptor`.

Without `useFocusable()`, gamepad users cannot navigate to your custom
elements. For the full gamepad navigation guide — layout patterns,
DO/DON'T rules, and a testing checklist — see
**[gamepad-navigation-guide.md](gamepad-navigation-guide.md)**.

---

## Permissions

Plugins run sandboxed. Declare allow-lists in
`manifest.permissions` (`PluginPermissions` in
[`packages/types/src/plugin.ts`](../packages/types/src/plugin.ts)):

| Permission | Type | Description |
|-----------|------|-------------|
| `network` | `string[]` | Domains allowed for backend `fetch()`. Everything else is blocked. |
| `filesystem` | `string[]` | File paths the plugin reads/writes, e.g. `read:~/.local/share/Steam`, `write:~/.config/loadout/plugins`. |
| `steam_apis` | `string[]` | Allowed SteamClient API namespaces. |
| `system` | `string[]` | System-level operations. |
| `commands` | `string[]` | Binary names the plugin may run through `@loadout/exec`. |

### `commands` — the subprocess allow-list

This is the most important permission for plugins that shell out. It is
enforced at the `@loadout/exec` choke point: the loader scopes a
per-plugin command policy (`withCommandPolicy`) around `onLoad` and every
RPC call, and each subprocess launch checks `basename(cmd[0])` against
the list.

```json
{
  "plugin": {
    "id": "bluetooth",
    "name": "Bluetooth",
    "description": "Quick connect/disconnect paired Bluetooth devices",
    "permissions": {
      "commands": ["bluetoothctl"]
    }
  }
}
```

Key rules:

- **Deny-by-default.** An empty or missing `commands` list blocks *all*
  subprocesses. An undeclared binary throws with a message naming the
  exact manifest edit to allow it.
- **Binary-level, not argument-level.** Matching is on the executable
  basename only — a plugin allowed to run `tee` can pass it any path.
- **Known gap.** Writing `/sys` or `/dev/hidraw*` directly via `fs`
  (not a subprocess) bypasses this check. Declare those paths in
  `filesystem` for visibility.

---

## Using Steam UI Components (caveat)

`@loadout/ui` also exposes `Steam.*` — lazy proxies for Steam's own
internal React components
([`packages/ui/src/steam.ts`](../packages/ui/src/steam.ts)):

```tsx
import { Steam } from "@loadout/ui";

<Steam.DialogButton onClick={() => {}}>Click Me</Steam.DialogButton>
<Steam.SliderField label="Volume" nMin={0} nMax={100} nValue={75} />
<Steam.Focusable onActivate={() => {}}>…</Steam.Focusable>
```

> **Caveat — these only resolve in CEF-injected (Steam-side) contexts.**
> The proxies resolve against `globalThis.__STEAM_COMPONENTS`, which is
> populated by component discovery inside Steam's webpack bundle. In the
> Electrobun overlay that global does not exist, so a `Steam.*` component
> renders `null` (with a console warning). **The default plugin UI path
> is `app.tsx` rendered in the overlay** — use the built-in `@loadout/ui`
> components there. Reach for `Steam.*` only in plugins that inject into
> Steam's CEF UI (QAM tabs, routes, CSS, patches).

Related Steam-side APIs from `@loadout/ui`: `navigate`, `navigateBack`,
`closeSideMenus`, `navigateToPage` (navigation); `afterPatch`,
`beforePatch`, `insteadPatch`, `getReactFiber`, `findInFiberTree`
(patching); `injectCSS`, `getComponentClass` (CSS); `getTabList`,
`hideTab`, `modifyTab` (QAM); `addContextMenuItem` (context menus).

---

## Complete Example: Bluetooth Plugin

This is the shipped `plugins/bluetooth` plugin, condensed. It manages
paired Bluetooth devices via the `bluetoothctl` CLI — a good template
for a backend that shells out plus an overlay UI that uses live events.

### `plugins/bluetooth/package.json`

```json
{
  "name": "@loadout/plugin-bluetooth",
  "version": "0.0.1",
  "type": "module",
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "@loadout/ui": "workspace:*",
    "@loadout/exec": "workspace:*"
  },
  "plugin": {
    "id": "bluetooth",
    "name": "Bluetooth",
    "description": "Quick connect/disconnect paired Bluetooth devices without leaving the game",
    "category": "Device",
    "subtitle": "Pair devices without leaving the game",
    "permissions": {
      "commands": ["bluetoothctl"]
    }
  }
}
```

### `plugins/bluetooth/backend.ts`

The backend polls device state every few seconds and emits
`deviceChanged` / `adapterChanged` only on a real transition. Every
shell-out goes through `@loadout/exec` (and `bluetoothctl` is declared in
`permissions.commands`).

```ts
import type { PluginBackend, EmitPayload } from "@loadout/types";
import { run, spawn } from "@loadout/exec";
import { parseDeviceList, parseDeviceInfo, type BluetoothDevice } from "./lib/parse";

export default class BluetoothBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;
  private pollInterval?: Timer;
  private lastDeviceState = new Map<string, boolean>();

  async onLoad() {
    this.pollInterval = setInterval(() => {
      this._poll().catch(() => {});
    }, 3000);
  }

  async onUnload() {
    clearInterval(this.pollInterval);
    try { await run(["bluetoothctl", "scan", "off"]); } catch {}
  }

  // Underscore = private, not callable via RPC.
  private async _poll() {
    const devices = await this.getDevices();
    for (const device of devices) {
      const prev = this.lastDeviceState.get(device.mac);
      if (prev !== undefined && prev !== device.connected) {
        this.emit?.({ event: "deviceChanged", data: device });
      }
      this.lastDeviceState.set(device.mac, device.connected);
    }
  }

  async getDevices(): Promise<BluetoothDevice[]> {
    const { stdout } = await run(["bluetoothctl", "devices"]);
    const entries = parseDeviceList(stdout);
    const devices: BluetoothDevice[] = [];
    for (const { mac, name } of entries) {
      const { stdout: info } = await run(["bluetoothctl", "info", mac]);
      devices.push(parseDeviceInfo(mac, name, info));
    }
    return devices;
  }

  async connectDevice(mac: string): Promise<string> {
    const { stdout } = await run(["bluetoothctl", "connect", mac]);
    this.lastDeviceState.set(mac, true);
    return stdout;
  }

  async disconnectDevice(mac: string): Promise<string> {
    const { stdout } = await run(["bluetoothctl", "disconnect", mac]);
    this.lastDeviceState.set(mac, false);
    return stdout;
  }
}
```

### `plugins/bluetooth/app.tsx`

The UI uses built-in `@loadout/ui` components, subscribes to backend
events with `useEvent`, surfaces failures with `notify`, and portals its
title bar into the overlay topbar with `<PluginHeader>`.

```tsx
import { useState, useEffect, useCallback } from "react";
import { FaBluetoothB } from "react-icons/fa6";
import {
  Button,
  PluginHeader,
  Spinner,
  mountComponent,
  mountHeaderStub,
  notify,
  useBackend,
} from "@loadout/ui";
import type { BluetoothDevice } from "./lib/parse";

export const icon = FaBluetoothB;

function BluetoothManager() {
  const { call, useEvent } = useBackend("bluetooth");
  const [devices, setDevices] = useState<BluetoothDevice[]>([]);
  const [loading, setLoading] = useState(true);

  useEvent({
    event: "deviceChanged",
    handler: (data) => {
      const changed = data as BluetoothDevice;
      setDevices((prev) => prev.map((d) => (d.mac === changed.mac ? changed : d)));
    },
  });

  const refresh = useCallback(async () => {
    try {
      setDevices((await call("getDevices")) as BluetoothDevice[]);
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleConnect = useCallback(
    async (mac: string) => {
      try {
        await call("connectDevice", mac);
        setDevices((prev) => prev.map((d) => (d.mac === mac ? { ...d, connected: true } : d)));
      } catch {
        notify("Couldn't connect", { kind: "error" });
      }
    },
    [call],
  );

  return (
    <>
      <PluginHeader>
        <h1 className="text-xl font-semibold">Bluetooth</h1>
      </PluginHeader>

      <div className="p-7 h-full overflow-y-auto">
        {loading ? (
          <Spinner size={32} />
        ) : (
          devices.map((device) => (
            <div key={device.mac} className="flex items-center gap-3.5 py-3.5">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{device.name}</div>
                <div className="mono text-[11px] truncate">{device.mac}</div>
              </div>
              {device.connected ? (
                <Button onClick={() => call("disconnectDevice", device.mac)}>Disconnect</Button>
              ) : (
                <Button variant="primary" onClick={() => handleConnect(device.mac)}>
                  Connect
                </Button>
              )}
            </div>
          ))
        )}
      </div>
    </>
  );
}

export const mount = mountComponent(BluetoothManager);

// Presence of `mountHeader` reserves the overlay's 60px topbar slot;
// the actual header is portaled from inside mount() via <PluginHeader>.
export const mountHeader = mountHeaderStub;
```

---

## Dev / Build / Test Loop

All scripts run from the repo root (`package.json`):

| Script | What it does |
|--------|--------------|
| `bun run dev:overlay` | Starts the Bun backend server **and** the Electrobun overlay with hot reload (`scripts/dev-overlay.sh`). The usual dev command. |
| `bun run dev` | Runs the Bun backend server only (`apps/loadout/src/index.ts`). |
| `bun run dev:electrobun` | Runs only the Electrobun overlay (`@loadout/loadout-overlay dev`). |
| `bun run build` | Builds the distributable (`scripts/build.sh` — compiles the loader binary; the overlay is built separately and copied by `install-local.sh`). |
| `bun run build-and-install` | Build, then install locally (`scripts/install-local.sh`). |
| `bun run typecheck` | `tsc --noEmit`. |
| `bun run test` | Backend (`*.test.ts`) + UI (`*.spec.tsx`) tests via `bun test`. |
| `bun run lint` / `bun run format` | ESLint / Prettier. |

### The real dev loop

```bash
bun run dev:overlay
```

This launches the Bun backend on port `33820` (the loader, plugin
backends, the RPC WebSocket) and the Electrobun overlay window, both with
hot reload. When Steam/gamescope is running, the script matches the
overlay's `DISPLAY` to Steam's inner X server so the overlay appears in
Gaming Mode.

**There is no in-Steam dev server at `localhost:33820` to open in a
browser, and no `dev:inject` script.** The UI renders in the Electrobun
(CEF) overlay. To debug it, attach to CEF's remote DevTools:

```
http://localhost:9222
```

(baked into `electrobun.config.ts` → `build.linux.chromiumFlags`; open it
in Chromium or drive it via CDP). See the project `CLAUDE.md` for the
overlay architecture (`apps/loadout-overlay/src/bun` main process,
`src/webview` boot shim, shared React tree under `src/overlay`).

### Tests

Backend logic and pure helpers go in `lib/` and are unit-tested in
`backend.test.ts`; UI in `app.spec.tsx`. Run them with:

```bash
bun run test          # all
bun test test.ts      # backend only (what test:backend runs)
```

---

## Tips

- **Keep backend methods focused** — one thing each. Use `emit` for
  state changes the UI should react to, rather than polling from the UI.
- **Mark internal backend methods private** with a leading underscore so
  they aren't exposed over RPC.
- **Declare every binary you run** in `permissions.commands`, and every
  domain you fetch in `permissions.network` — both are deny-by-default.
- **Use built-in `@loadout/ui` components in the overlay**; reach for
  `Steam.*` only in CEF-injected (Steam-side) plugins.
- **Wrap custom interactive elements in `useFocusable()`** so gamepad
  users can reach them.
- **Run `bun run typecheck` and `bun run test`** before shipping.
