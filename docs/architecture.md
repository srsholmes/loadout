# Architecture

> **Doc currency (2026-05).** This page describes the system as it ships today.
> Two notes worth reading before you trust everything below:
>
> - Most plugins render in the **Electrobun overlay**, not Steam's CEF UI.
>   The overlay entry is `app.tsx` (consumed by `packages/overlay-electrobun`
>   via the `@overlay/*` alias). `panel.tsx` is reserved for plugins that
>   inject UI directly into Steam's CEF — currently only `game-browser/` does
>   that. Both shapes are supported; pick based on where the user sees it.
> - Plugin process isolation (child-process spawn) is on the roadmap
>   (TODOS.md P1) but **not shipped yet** — backends are still loaded with
>   `import(backendPath)` in `plugin-manager.ts`. Treat the "child procs"
>   note in the diagram below as the target state.

## Overview

Loadout is a three-layer system: a Bun backend service, a CEF-injected frontend, and a typed WebSocket bridge connecting them.

```
┌─────────────────────────────────────────┐
│              Steam CEF (UI)             │
│  ┌─────────────┐  ┌─────────────────┐  │
│  │ Plugin UIs  │  │ Steam React App │  │
│  └──────┬──────┘  └─────────────────┘  │
│         │ WebSocket                     │
└─────────┼───────────────────────────────┘
          │
┌─────────┼───────────────────────────────┐
│         ▼          Bun Server           │
│  ┌─────────────┐  ┌─────────────────┐  │
│  │  WebSocket   │  │ Plugin Backends │  │
│  │   Bridge     │  │  (child procs)  │  │
│  └─────────────┘  └─────────────────┘  │
│         systemd user service            │
└─────────────────────────────────────────┘
```

## Bun Server (systemd Service)

The loader runs as a **systemd user service** — no sudo required, survives SteamOS updates.

- Service file: `~/.config/systemd/user/loadout.service`
- Binary: `~/.local/share/loadout/loadout`
- Plugins: `~/.local/share/loadout/plugins/`

```ini
[Unit]
Description=Loadout
After=network.target

[Service]
Type=simple
ExecStart=%h/.local/share/loadout/loadout
Restart=on-failure
RestartSec=5
Environment=PLUGINS_DIR=%h/.local/share/loadout/plugins

[Install]
WantedBy=default.target
```

## CEF Injection

Steam's UI is a Chromium Embedded Framework (CEF) browser. Steam exposes a CEF remote debug port on localhost. The loader:

1. Connects to the CEF debug endpoint via WebSocket
2. Finds the `SharedJSContext` tab — a non-visual tab where `window.SteamClient` is available
3. Injects the compiled frontend bundle into that context
4. The injected code fetches the plugin manifest from the loader's HTTP server and loads each plugin's compiled UI bundle

## Plugin Structure

A plugin is a single folder. The exact file set depends on where the UI
renders:

```
# Overlay plugin (the default pattern)
my-plugin/
├── package.json     # Plugin metadata under the `plugin` field
├── backend.ts       # PluginBackend class with RPC methods
└── app.tsx          # React component rendered in the Electrobun overlay

# Steam-injection plugin (renders into Steam's own UI instead)
my-plugin/
├── package.json
├── backend.ts
└── panel.tsx        # React component injected into Steam's CEF
```

Plugins can also ship both `app.tsx` and `panel.tsx` if they need surfaces
in both places.

## Plugin Backend Isolation

Plugins are spawned as **child processes**, not imported in-process. A crashed plugin cannot take down the loader.

```ts
import { spawn } from "bun";

async function loadPlugin(pluginDir: string) {
  const meta: PluginMeta = await Bun.file(join(pluginDir, "plugin.json")).json();

  const proc = spawn({
    cmd: [process.execPath, join(pluginDir, "backend.ts")],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PLUGIN_ID: meta.id,
      LOADER_PORT: String(PORT),
    },
  });
}
```

## Startup Sequence

1. **Boot** — Bun server starts via systemd
2. **Scan** — Reads `plugins/` directory, loads each `plugin.json`
3. **Import backends** — Spawns each plugin's `backend.ts` as a child process, calls `onLoad()`
4. **Build frontends** — Runs `Bun.build()` on each `panel.tsx`, outputs browser-compatible bundles to `/tmp/plugin-bundles/`
5. **CEF inject** — Connects to Steam's CEF debug port, injects loader script into `SharedJSContext`
6. **Plugin load** — Injected script fetches `/plugins` manifest, then fetches and `eval()`s each plugin's compiled bundle

## WebSocket Bridge (Typed RPC)

All frontend-backend communication uses UUID-tagged WebSocket messages.

### Request Flow

1. Frontend calls `call("getReport", appId)` via `useBackend()` hook
2. SDK generates UUID, sends `{ id, plugin: "protondb-badges", method: "getReport", args: [12345] }` over WebSocket
3. Bun's request handler looks up the plugin instance, finds the method by name, calls it with the args
4. Method executes (file I/O, fetch, subprocess — anything Bun can do) and returns a value
5. Bun sends `{ id, result: { tier: "gold", ... } }` back over WebSocket
6. Pending Promise resolves, React re-renders

### Event Flow

1. Backend calls `this.emit("cacheCleared", data)`
2. Loader broadcasts `{ type: "event", plugin: "protondb-badges", event: "cacheCleared", data }` to all connected clients
3. Any `useEvent("cacheCleared", fn)` subscription in the frontend fires immediately

### Inter-Plugin Events

```ts
// In theme-loader's backend
this.emit("theme-changed", { theme: "dracula", accentColor: "#bd93f9" });

// In another plugin's backend
this.on("plugin:theme-loader:theme-changed", (data) => {
  this.applyTheme(data.accentColor);
});
```

## Runtime Distribution

The loader ships as a single standalone binary built with `bun build --compile`:

```bash
bun build ./src/loader.ts \
  --compile \
  --target=bun-linux-x64 \
  --minify \
  --outfile ./dist/loadout-linux-x64
```

- ~95MB single binary, no dependencies
- Full Bun runtime embedded — `Bun.build()` and dynamic `import()` work at runtime
- Users don't need Bun installed

```
GitHub Releases
└── loadout-linux-x64          (~95MB, single binary)

User's Deck
├── ~/.local/share/loadout/
│   ├── loadout                 (the binary)
│   └── plugins/
│       └── protondb-badges/
│           ├── plugin.json
│           ├── backend.ts
│           └── panel.tsx
└── ~/.config/systemd/user/
    └── loadout.service
```

## Installation

A `.desktop` file (same pattern as Decky) that, when double-clicked in Gaming Mode, downloads the binary and writes the systemd unit:

```bash
set -e

INSTALL_DIR="$HOME/.local/share/loadout"
SERVICE_FILE="$HOME/.config/systemd/user/loadout.service"
BINARY_URL="https://github.com/you/loadout/releases/latest/download/loadout-linux-x64"

echo "Installing Loadout..."

mkdir -p "$INSTALL_DIR"
curl -L "$BINARY_URL" -o "$INSTALL_DIR/loadout"
chmod +x "$INSTALL_DIR/loadout"

mkdir -p "$(dirname $SERVICE_FILE)"
cat > "$SERVICE_FILE" << EOF
[Unit]
Description=Loadout
After=network.target

[Service]
Type=simple
ExecStart=$INSTALL_DIR/loadout
Restart=on-failure
RestartSec=5
Environment=PLUGINS_DIR=$HOME/.local/share/loadout/plugins

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now loadout

echo "Done. Loadout is running."
```

## Self-Update

```ts
async function selfUpdate() {
  const latestUrl = "https://github.com/you/loadout/releases/latest/download/loadout-linux-x64";
  const tmpPath = process.execPath + ".new";

  const res = await fetch(latestUrl);
  await Bun.write(tmpPath, res);
  await Bun.$`chmod +x ${tmpPath}`;
  await Bun.$`mv ${tmpPath} ${process.execPath}`;
  await Bun.$`systemctl --user restart loadout`;
}
```

## Monorepo Structure

```
loadout/
├── packages/
│   ├── loader/              # The Bun server binary
│   │   └── src/
│   │       ├── loader.ts
│   │       ├── plugin-manager.ts
│   │       └── update.ts
│   ├── ui/                  # @loadout/ui — component library
│   │   └── src/
│   │       ├── components/  # Own components: Panel, Toggle, etc.
│   │       ├── steam/       # Extracted: SliderField, Router, etc.
│   │       └── sdk.ts       # useBackend, definePlugin, etc.
│   ├── types/               # @loadout/types — shared type definitions
│   │   └── src/
│   │       ├── SteamClient.d.ts
│   │       ├── plugin.ts
│   │       └── ipc.ts
│   └── injector/            # The CEF injection script
│       └── src/
│           └── inject.ts
├── plugins/                 # First-party plugins
│   ├── protondb-badges/
│   ├── theme-loader/
│   ├── steamgriddb/
│   ├── power-tools/
│   └── tabmaster/
├── community/               # Third-party plugins (CODEOWNERS)
├── tools/
│   ├── ci-validator/        # SteamOS update compatibility checker
│   ├── dev-server/          # Hot-reload dev environment
│   └── plugin-scaffold/     # bun create loadout/plugin my-plugin
├── package.json             # Bun workspaces
└── bunfig.toml
```

Bun workspaces handle dependencies natively. Each plugin's `package.json` lists `"@loadout/ui": "workspace:*"`.

## Licensing

- **Apache 2.0** for core loader and packages (explicit patent grant, maximises adoption)
- **MIT** for `@loadout/types` (convention for type definition packages)
- **CLA** for contributions (allows future relicensing)
- Completely separate source code from Decky — not bound by GPL v2
