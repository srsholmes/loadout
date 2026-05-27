# Plugin Development Guide

> **Doc currency (2026-05).** This guide was originally written for the
> Steam-CEF injection model. Most plugins today render in the **Electrobun
> overlay** instead — the only structural difference is the UI file:
>
> | Surface | UI entry | When to use |
> |---|---|---|
> | Electrobun overlay (default) | `app.tsx` | The user opens the overlay (QAM tile, F16, Ctrl+Shift+O); your plugin renders inside it. **This is the default for most plugins.** |
> | Steam CEF injection | `panel.tsx` | Your plugin needs to render directly inside Steam's UI (e.g. a game-library overlay). |
>
> Plugin metadata also moved from a separate `plugin.json` to a `plugin`
> field on the workspace `package.json` — see any of the live plugins for
> the current shape. The hello-world examples below pre-date that change
> and may show the old `plugin.json` shape.

This guide covers everything you need to build plugins for Loadout — from a simple hello world to advanced patterns like using Steam's native UI components, hooking into Steam events, and communicating between frontend and backend.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) installed
- Steam running in Big Picture Mode with CEF debugging enabled
- Clone the repository and install dependencies:

```bash
git clone <repo-url>
cd loadout
bun install
```

### Create Your First Plugin

Every plugin lives in the `plugins/` directory and has three files:

```
plugins/my-plugin/
├── plugin.json    # Manifest — name, version, permissions
├── backend.ts     # Server-side logic — RPC methods, events
└── panel.tsx      # React UI — what the user sees
```

#### 1. Plugin Manifest (`plugin.json`)

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "description": "My first Loadout plugin",
  "author": "Your Name"
}
```

#### 2. Backend (`backend.ts`)

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

#### 3. Frontend (`panel.tsx`)

```tsx
import { useState } from "react";
import { useBackend, Panel, Text, Button } from "@loadout/ui";

export default function MyPluginPanel() {
  const { call } = useBackend("my-plugin");
  const [message, setMessage] = useState("");

  const handleGreet = async () => {
    const result = await call("greet", "World");
    setMessage(result as string);
  };

  return (
    <Panel title="My Plugin">
      <Text>{message || "Click the button!"}</Text>
      <Button variant="primary" onClick={handleGreet}>
        Say Hello
      </Button>
    </Panel>
  );
}
```

#### 4. Run It

```bash
# Browser-only mode (no Steam needed)
bun run dev

# With injection into Steam Big Picture Mode
bun run dev:inject
```

Open `http://localhost:33820` to see your plugin in the browser, or check Big Picture Mode if running with `--inject`.

---

## Setting Up IntelliSense

The project is a Bun monorepo with workspaces. Your plugin automatically gets TypeScript types from:

- `@loadout/types` — backend interfaces (`PluginBackend`, `EmitPayload`)
- `@loadout/ui` — React components and Steam component proxies

### Editor Setup

The monorepo's `tsconfig.json` handles path resolution. In VS Code, open the root folder (not the plugin subfolder) to get full IntelliSense:

```bash
code /path/to/loadout
```

You'll get autocomplete for:
- All `@loadout/ui` exports (Panel, Button, Text, Steam.*, etc.)
- All `@loadout/types` interfaces
- Steam component props (DialogButtonProps, FocusableProps, etc.)
- Backend method signatures via `PluginBackend`

### Type Imports

```tsx
// Frontend types
import type { DialogButtonProps, SliderFieldProps } from "@loadout/ui";

// Backend types
import type { PluginBackend, EmitPayload, PluginMeta } from "@loadout/types";
```

---

## Plugin Manifest Reference

### Basic

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "What your plugin does",
  "author": "Your Name"
}
```

### With Permissions

Plugins run in a sandbox. Network requests are blocked unless you declare allowed domains:

```json
{
  "id": "protondb-badges",
  "name": "ProtonDB Badges",
  "version": "1.0.0",
  "description": "Shows ProtonDB compatibility ratings",
  "author": "You",
  "permissions": {
    "network": ["protondb.com", "www.protondb.com"]
  }
}
```

| Permission | Description |
|-----------|-------------|
| `network` | Allowed domains for `fetch()` in the backend |
| `filesystem` | File access paths (e.g., `read:~/.local/share/Steam/userdata`) |
| `steam_apis` | SteamClient API namespaces allowed |
| `system` | System-level operations |

---

## Backend API

The backend is a TypeScript class that runs on the server (Bun process). Every public method becomes an RPC endpoint callable from the frontend.

### Lifecycle Hooks

```ts
export default class MyBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;

  // Called when the plugin loads (server start or hot reload)
  async onLoad() {
    console.log("Plugin loaded");
  }

  // Called when the plugin unloads
  async onUnload() {
    console.log("Plugin unloaded");
  }
}
```

### RPC Methods

Any public method on your backend class is callable from the frontend via `call()`:

```ts
// backend.ts
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

  async getAllSettings(): Promise<Record<string, unknown>> {
    return { ...this.settings };
  }
}
```

```tsx
// panel.tsx
const { call } = useBackend("settings-plugin");

// These call the backend methods over WebSocket
const theme = await call("getSetting", "theme");
await call("setSetting", "theme", "dark");
const all = await call("getAllSettings");
```

### Emitting Events

Push real-time events from backend to all connected frontends:

```ts
// backend.ts
async startMonitoring(): Promise<void> {
  setInterval(() => {
    this.emit?.({
      event: "statusUpdate",
      data: { cpu: getCpuUsage(), temp: getTemp() },
    });
  }, 5000);
}
```

### Network Requests

Backend `fetch()` is sandboxed. Only domains listed in `plugin.json` permissions are allowed:

```ts
// This works if "api.example.com" is in permissions.network
const res = await fetch("https://api.example.com/data");

// This will be blocked if the domain isn't declared
const res = await fetch("https://malicious.site/steal"); // Error!
```

---

## Frontend API

### `useBackend(pluginId)`

The main hook for communicating with your backend:

```tsx
const { call, useEvent, ready } = useBackend("my-plugin");
```

| Property | Type | Description |
|----------|------|-------------|
| `call` | `(method: string, ...args: unknown[]) => Promise<unknown>` | Call a backend RPC method |
| `useEvent` | `({ event, handler }) => void` | Subscribe to backend events |
| `ready` | `boolean` | Whether the WebSocket connection is established |

### Calling Backend Methods

```tsx
// Simple call
const result = await call("getJoke");

// With arguments
const report = await call("getReport", appId, { includeDetails: true });

// Error handling
try {
  const data = await call("riskyOperation");
} catch (err) {
  console.error("Backend error:", err);
}
```

### Subscribing to Events

```tsx
// Listen for backend events
useEvent({
  event: "newJoke",
  handler: (data) => {
    const joke = data as { joke: string; timestamp: number };
    setLatestJoke(joke.joke);
  },
});

// Listen for another event
useEvent({
  event: "historyCleared",
  handler: () => {
    setHistory([]);
  },
});
```

---

## Built-in UI Components

`@loadout/ui` provides lightweight components that work everywhere:

### `Panel`

Container with optional title, dark styling matching Steam's aesthetic.

```tsx
import { Panel } from "@loadout/ui";

<Panel title="Settings">
  <p>Content here</p>
</Panel>
```

### `Text`

Styled paragraph with variants.

```tsx
import { Text } from "@loadout/ui";

<Text variant="heading">Section Title</Text>
<Text>Regular body text</Text>
<Text variant="secondary">Muted helper text</Text>
```

| Variant | Description |
|---------|-------------|
| `body` | Default — 14px, light gray |
| `secondary` | 12px, muted gray |
| `heading` | 16px, bold, white |

### `Button`

Clickable button with variants.

```tsx
import { Button } from "@loadout/ui";

<Button onClick={() => doThing()}>Default Button</Button>
<Button variant="primary" onClick={() => save()}>Save</Button>
<Button disabled={loading}>Loading...</Button>
```

| Variant | Description |
|---------|-------------|
| `default` | Gray background |
| `primary` | Orange/accent background |

### `Field`

Label + value row layout.

```tsx
import { Field } from "@loadout/ui";

<Field label="Version">1.0.0</Field>
<Field label="Status">Active</Field>
```

### `Spinner`

Animated loading spinner.

```tsx
import { Spinner } from "@loadout/ui";

<Spinner />
<Spinner size={32} />
```

---

## Using Steam UI Components

The real power is using Steam's own React components. These are the same buttons, toggles, and modals that Steam itself uses — they look native and support gamepad navigation out of the box.

See [Steam Components Reference](./steam-components.md) for the full component list and props.

### Import Pattern

```tsx
import { Steam } from "@loadout/ui";
```

All Steam components are accessed via the `Steam` namespace:

```tsx
<Steam.DialogButton>Click Me</Steam.DialogButton>
<Steam.Focusable onActivate={() => {}}>...</Steam.Focusable>
<Steam.ProgressBar nProgress={0.5} />
```

### Example: Settings Panel with Steam UI

```tsx
import { useState } from "react";
import { useBackend, Panel, Steam } from "@loadout/ui";

export default function SettingsPanel() {
  const { call } = useBackend("my-settings");
  const [volume, setVolume] = useState(75);
  const [notifications, setNotifications] = useState(true);
  const [theme, setTheme] = useState("dark");

  return (
    <Panel title="Settings">
      <Steam.ToggleField
        label="Enable Notifications"
        bChecked={notifications}
        onChange={(checked) => {
          setNotifications(checked);
          call("setSetting", "notifications", checked);
        }}
      />

      <Steam.SliderField
        label="Volume"
        nMin={0}
        nMax={100}
        nStep={5}
        nValue={volume}
        onChange={(value) => {
          setVolume(value);
          call("setSetting", "volume", value);
        }}
      />

      <Steam.DropdownField
        label="Theme"
        strDefaultLabel="Select theme..."
        rgOptions={[
          { label: "Dark", data: "dark" },
          { label: "Light", data: "light" },
          { label: "OLED", data: "oled" },
        ]}
        selectedOption={theme}
        onChange={(option) => {
          setTheme(option.data as string);
          call("setSetting", "theme", option.data);
        }}
      />

      <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
        <Steam.DialogButtonPrimary onClick={() => call("saveAll")}>
          Save
        </Steam.DialogButtonPrimary>
        <Steam.DialogButtonSecondary onClick={() => call("resetDefaults")}>
          Reset
        </Steam.DialogButtonSecondary>
      </div>
    </Panel>
  );
}
```

### Example: Confirmation Dialog

```tsx
import { useState } from "react";
import { Steam, Panel, Button } from "@loadout/ui";

export default function DangerZone() {
  const [showConfirm, setShowConfirm] = useState(false);

  return (
    <Panel title="Danger Zone">
      <Button variant="primary" onClick={() => setShowConfirm(true)}>
        Delete All Data
      </Button>

      {showConfirm && (
        <Steam.ConfirmDialog
          strTitle="Are you sure?"
          strDescription="This will delete all plugin data. This cannot be undone."
          strOKButtonText="Delete Everything"
          strCancelButtonText="Cancel"
          onOK={() => {
            deleteAllData();
            setShowConfirm(false);
          }}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </Panel>
  );
}
```

### Example: Context Menu

```tsx
import { Steam } from "@loadout/ui";

function GameContextMenu({ onClose }: { onClose: () => void }) {
  return (
    <Steam.Menu label="Game Options" onCancel={onClose}>
      <Steam.MenuGroup label="Quick Actions">
        <Steam.MenuItem onSelected={() => launchGame()}>
          Play Now
        </Steam.MenuItem>
        <Steam.MenuItem onSelected={() => viewDetails()}>
          View Details
        </Steam.MenuItem>
      </Steam.MenuGroup>
      <Steam.MenuGroup label="Management">
        <Steam.MenuItem onSelected={() => moveInstall()}>
          Move Install Folder
        </Steam.MenuItem>
        <Steam.MenuItem onSelected={() => uninstall()} disabled={isRunning}>
          Uninstall
        </Steam.MenuItem>
      </Steam.MenuGroup>
    </Steam.Menu>
  );
}
```

### Example: Progress Indicator

```tsx
import { useState, useEffect } from "react";
import { useBackend, Panel, Text, Steam } from "@loadout/ui";

export default function DownloadTracker() {
  const { call, useEvent } = useBackend("download-tracker");
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Waiting...");

  useEvent({
    event: "downloadProgress",
    handler: (data) => {
      const d = data as { percent: number; status: string };
      setProgress(d.percent);
      setStatus(d.status);
    },
  });

  return (
    <Panel title="Download Progress">
      <Text>{status}</Text>
      <Steam.ProgressBar nProgress={progress} nTransitionSec={0.3} />
      <Text variant="secondary">{Math.round(progress * 100)}%</Text>
    </Panel>
  );
}
```

### Gamepad Navigation

Every interactive element must be navigable with a gamepad (d-pad + A button). Built-in `@loadout/ui` components (`Button`, `Slider`, `Toggle`, `TabBar`, `TextInput`) handle this automatically. For custom interactive elements, use `useFocusable()`:

```tsx
import { useFocusable } from "@loadout/ui";

function GameCard({ game, onSelect }) {
  const { ref, focused } = useFocusable({
    onEnterPress: () => onSelect(game.id),
  });
  return (
    <div ref={ref} className={`card ${focused ? "ring-2 ring-primary/40" : ""}`}>
      <img src={game.cover} />
      <span>{game.name}</span>
    </div>
  );
}
```

In CEF-injected contexts (where Steam's UI is available), you can also use `Steam.Focusable`:

```tsx
<Steam.Focusable onActivate={() => handleSelect()}>
  <div className="my-card">
    <img src={coverUrl} />
    <span>{gameName}</span>
  </div>
</Steam.Focusable>
```

Without `useFocusable()` or `Steam.Focusable`, gamepad users won't be able to navigate to your elements.

**For the full gamepad navigation guide** — layout patterns, DO/DON'T rules, API reference, and testing checklist — see **[gamepad-navigation-guide.md](gamepad-navigation-guide.md)**.

---

## Mixing Built-in and Steam Components

You can freely mix `@loadout/ui` components with Steam components:

```tsx
import { Panel, Text, Spinner, Steam } from "@loadout/ui";

export default function HybridPanel() {
  const [loading, setLoading] = useState(true);

  if (loading) {
    return (
      <Panel title="My Plugin">
        <Spinner />
        <Text variant="secondary">Loading...</Text>
      </Panel>
    );
  }

  return (
    <Panel title="My Plugin">
      <Text variant="heading">Settings</Text>

      {/* Steam's native toggle */}
      <Steam.ToggleField label="Feature A" bChecked={true} onChange={() => {}} />

      {/* Steam's native slider */}
      <Steam.SliderField label="Intensity" nMin={0} nMax={100} nStep={1} />

      {/* Our own button with Steam's spinner */}
      <Steam.DialogButton onClick={() => save()}>
        Save Settings
      </Steam.DialogButton>
    </Panel>
  );
}
```

---

## Real-Time Events

### Backend → Frontend

The backend can push events to all connected clients at any time:

```ts
// backend.ts
export default class MonitorBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;
  private interval?: Timer;

  async onLoad() {
    this.interval = setInterval(() => {
      this.emit?.({
        event: "tick",
        data: { timestamp: Date.now(), value: Math.random() },
      });
    }, 1000);
  }

  async onUnload() {
    clearInterval(this.interval);
  }
}
```

```tsx
// panel.tsx
export default function MonitorPanel() {
  const { useEvent } = useBackend("monitor");
  const [value, setValue] = useState(0);

  useEvent({
    event: "tick",
    handler: (data) => {
      setValue((data as { value: number }).value);
    },
  });

  return (
    <Panel title="Monitor">
      <Text>Current Value: {value.toFixed(2)}</Text>
      <Steam.ProgressBar nProgress={value} nTransitionSec={0.3} />
    </Panel>
  );
}
```

---

## Complete Example: Dad Jokes Plugin

This is the included `hello-world` plugin that demonstrates the full plugin lifecycle:

### `plugins/hello-world/plugin.json`

```json
{
  "id": "hello-world",
  "name": "Hello World",
  "version": "0.0.1",
  "description": "A dad joke plugin that demonstrates the Loadout plugin system",
  "author": "Loadout",
  "permissions": {
    "network": ["icanhazdadjoke.com"]
  }
}
```

### `plugins/hello-world/backend.ts`

```ts
import type { PluginBackend, EmitPayload } from "@loadout/types";

interface Joke {
  joke: string;
  timestamp: number;
}

export default class HelloWorldBackend implements PluginBackend {
  private history: Joke[] = [];
  emit?: (payload: EmitPayload) => void;

  async onLoad() {
    console.log("Hello World plugin loaded!");
  }

  async getJoke(): Promise<string> {
    const res = await fetch("https://icanhazdadjoke.com/", {
      headers: { Accept: "application/json" },
    });
    const data = (await res.json()) as { joke: string };
    const entry: Joke = { joke: data.joke, timestamp: Date.now() };
    this.history.push(entry);
    this.emit?.({ event: "newJoke", data: entry });
    return data.joke;
  }

  async getHistory(): Promise<Joke[]> {
    return this.history;
  }

  async clearHistory(): Promise<void> {
    this.history = [];
    this.emit?.({ event: "historyCleared", data: null });
  }
}
```

### `plugins/hello-world/panel.tsx`

```tsx
import { useState, useEffect, useCallback } from "react";
import { useBackend, Panel, Text, Button, Spinner, Field } from "@loadout/ui";

export default function HelloWorldPanel() {
  const { call, useEvent } = useBackend("hello-world");
  const [joke, setJoke] = useState<string | null>(null);
  const [history, setHistory] = useState<{ joke: string; timestamp: number }[]>([]);
  const [loading, setLoading] = useState(false);

  const loadHistory = useCallback(async () => {
    const result = await call("getHistory");
    setHistory(result as { joke: string; timestamp: number }[]);
  }, [call]);

  const fetchJoke = useCallback(async () => {
    setLoading(true);
    try {
      const result = await call("getJoke");
      setJoke(result as string);
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEvent({ event: "newJoke", handler: () => loadHistory() });
  useEvent({ event: "historyCleared", handler: () => { setHistory([]); setJoke(null); } });

  useEffect(() => { fetchJoke(); loadHistory(); }, []);

  return (
    <Panel title="Dad Jokes">
      {loading ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Spinner />
          <Text variant="secondary">Fetching joke...</Text>
        </div>
      ) : joke ? (
        <Text>{joke}</Text>
      ) : (
        <Text variant="secondary">No joke loaded yet</Text>
      )}

      <div style={{ display: "flex", gap: 8, margin: "12px 0" }}>
        <Button variant="primary" onClick={fetchJoke} disabled={loading}>
          Get Another Joke
        </Button>
        {history.length > 0 && (
          <Button onClick={() => call("clearHistory")}>Clear History</Button>
        )}
      </div>

      {history.length > 0 && (
        <Panel title="History">
          {history.map((entry, i) => (
            <Field key={i} label={`#${i + 1}`}>
              {entry.joke.length > 50 ? entry.joke.slice(0, 50) + "..." : entry.joke}
            </Field>
          ))}
        </Panel>
      )}
    </Panel>
  );
}
```

---

## Example: Using Steam Buttons Instead of Built-in

Here's the hello-world plugin upgraded to use Steam's native buttons:

```tsx
import { useState, useEffect, useCallback } from "react";
import { useBackend, Panel, Text, Spinner, Field, Steam } from "@loadout/ui";

export default function HelloWorldSteamUI() {
  const { call, useEvent } = useBackend("hello-world");
  const [joke, setJoke] = useState<string | null>(null);
  const [history, setHistory] = useState<{ joke: string; timestamp: number }[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchJoke = useCallback(async () => {
    setLoading(true);
    try {
      const result = await call("getJoke");
      setJoke(result as string);
    } finally {
      setLoading(false);
    }
  }, [call]);

  const loadHistory = useCallback(async () => {
    const result = await call("getHistory");
    setHistory(result as { joke: string; timestamp: number }[]);
  }, [call]);

  useEvent({ event: "newJoke", handler: () => loadHistory() });
  useEvent({ event: "historyCleared", handler: () => { setHistory([]); setJoke(null); } });

  useEffect(() => { fetchJoke(); loadHistory(); }, []);

  return (
    <Panel title="Dad Jokes">
      {loading ? (
        <Steam.SteamSpinner size="medium" />
      ) : joke ? (
        <Text>{joke}</Text>
      ) : (
        <Text variant="secondary">No joke loaded yet</Text>
      )}

      <Steam.Focusable style={{ display: "flex", gap: 8, margin: "12px 0" }}>
        <Steam.DialogButtonPrimary onClick={fetchJoke} disabled={loading}>
          Get Another Joke
        </Steam.DialogButtonPrimary>
        {history.length > 0 && (
          <Steam.DialogButtonSecondary onClick={() => call("clearHistory")}>
            Clear History
          </Steam.DialogButtonSecondary>
        )}
      </Steam.Focusable>

      {history.length > 0 && (
        <Panel title="History">
          <Steam.ScrollPanel style={{ maxHeight: 200 }}>
            {history.map((entry, i) => (
              <Field key={i} label={`#${i + 1}`}>
                {entry.joke.length > 50 ? entry.joke.slice(0, 50) + "..." : entry.joke}
              </Field>
            ))}
          </Steam.ScrollPanel>
        </Panel>
      )}
    </Panel>
  );
}
```

Key differences from the built-in version:
- `<Steam.DialogButtonPrimary>` instead of `<Button variant="primary">` — uses Steam's native button styling
- `<Steam.DialogButtonSecondary>` instead of `<Button>` — muted native button
- `<Steam.SteamSpinner>` instead of `<Spinner>` — Steam's native loading animation
- `<Steam.Focusable>` wrapping the button row — enables gamepad navigation
- `<Steam.ScrollPanel>` for the history list — gamepad-aware scrolling

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Steam Big Picture Mode                       │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │  SharedJSContext (invisible tab)                                │  │
│  │  ├── window.webpackChunksteamui (Steam's React components)     │  │
│  │  ├── window.SteamClient (native APIs)                          │  │
│  │  ├── globalThis.__STEAM_COMPONENTS (discovered components)     │  │
│  │  └── Plugin panels mounted here (React tree)                   │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │  Big Picture Mode tab (visible UI — about:blank frame)          │  │
│  └─────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
         ▲ CDP (Chrome DevTools Protocol)
         │ Injection + Component Discovery
         │
┌────────┴──────────────────────────────────────────────────────────────┐
│  Loadout Server (Bun)             http://localhost:33820         │
│  ├── HTTP: plugin bundles, SDK, vendor React, component catalog       │
│  ├── WebSocket: RPC bridge (frontend ↔ backend methods)               │
│  ├── Plugin backends (TypeScript classes in-process)                  │
│  ├── File watchers (hot reload on save)                               │
│  └── CDP Multiplexer (injector + DevTools can share connection)       │
└───────────────────────────────────────────────────────────────────────┘
```

### Request Flow

```
Frontend (panel.tsx)          WebSocket              Server (Bun)
     │                           │                       │
     │  call("getJoke")          │                       │
     │──────────────────────────►│                       │
     │  { id, plugin, method,   │                       │
     │    args }                 │──────────────────────►│
     │                           │     look up plugin    │
     │                           │     call getJoke()    │
     │                           │     fetch dad joke    │
     │                           │                       │
     │                           │  { id, result: ... }  │
     │◄──────────────────────────│◄──────────────────────│
     │  Promise resolves         │                       │
     │  setState → re-render     │                       │
```

### Events Flow

```
Backend (backend.ts)             WebSocket              Frontend (panel.tsx)
     │                               │                       │
     │  this.emit({ event, data })   │                       │
     │──────────────────────────────►│                       │
     │                               │  broadcast to all    │
     │                               │  connected clients    │
     │                               │──────────────────────►│
     │                               │                       │  useEvent handler
     │                               │                       │  setState → re-render
```

---

## Wire Protocol

Communication between frontend and backend uses JSON over WebSocket.

### RPC Request (Frontend → Server)

```ts
interface RpcRequest {
  id: string;       // UUID — correlates response to request
  plugin: string;   // Plugin ID from plugin.json
  method: string;   // Method name on the backend class
  args: unknown[];   // Method arguments
}
```

### RPC Response (Server → Frontend)

```ts
interface RpcResponse {
  id: string;        // Matches the request ID
  result?: unknown;  // Return value on success
  error?: string;    // Error message on failure
}
```

### Events (Server → Frontend, broadcast)

```ts
interface RpcEvent {
  type: "event";
  plugin: string;    // Plugin that emitted the event
  event: string;     // Event name
  data: unknown;     // Event payload
}
```

---

## Hot Reload

The dev server watches for file changes and automatically:

1. **Plugin change** (`plugins/my-plugin/*.tsx`): Rebuilds the plugin bundle, reinjects into Steam
2. **SDK change** (`packages/ui/src/*`): Rebuilds SDK + all plugin bundles, reinjects

No manual restart needed. Save your file and see changes immediately.

---

## Dev Server Endpoints

When running `bun run dev` or `bun run dev:inject`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Dev HTML shell |
| `/ws` | WS | RPC WebSocket |
| `/api/plugins` | GET | List loaded plugins |
| `/api/steam-components` | GET | Discovered component metadata |
| `/components` | GET | Component catalog (interactive HTML) |
| `/plugins/{id}/bundle.js` | GET | Plugin UI bundle |
| `/inject/sdk/bundle.js` | GET | SDK bundle (injection mode) |
| `/vendor/vendor-all.js` | GET | React/ReactDOM vendor bundle |
| `/json` | GET | Chrome DevTools target list |

### Chrome DevTools Debugging

When running with `--inject`, you can debug Steam's CEF browser:

1. Open `chrome://inspect` in Chrome/Chromium
2. Click "Configure" and add `localhost:33820`
3. Steam's tabs appear as debug targets
4. Click "inspect" to open DevTools for any tab

The CDP multiplexer allows both the injector and Chrome DevTools to use the same CDP connection simultaneously.

---

## Comparison with Decky Loader

| Aspect | Decky Loader | Loadout |
|--------|-------------|-------------|
| Backend | Python | TypeScript |
| Frontend | TypeScript/React | TypeScript/React |
| Shared types | No (JSON boundary) | Yes (same language) |
| Component access | `@decky/ui` (manually maintained) | `@loadout/ui` with auto-discovery |
| Type safety | Limited (string-based backend calls) | Full (same TypeScript across stack) |
| Permissions | None | Manifest-declared, sandboxed |
| Dev experience | Separate Python + JS toolchains | Single `bun run dev` with hot reload |
| Steam component types | Manual, often outdated | Auto-discovered with typed proxies |
| DevTools | Not integrated | Built-in CDP multiplexer |
| Build system | Rollup + custom CLI | Bun.build (fast, zero config) |

---

## QAM Plugins (Quick Access Menu)

Plugins can render inside Steam's Quick Access Menu — the side panel with Performance, Friends, Downloads, and Settings tabs. Instead of an overlay panel, your plugin appears as a native QAM tab.

### Declaring a QAM Target

Set `target.type` to `"qam"` in your `plugin.json`:

```json
{
  "id": "my-qam-plugin",
  "name": "My QAM Plugin",
  "version": "0.1.0",
  "description": "A plugin that lives in the QAM",
  "author": "Your Name",
  "target": {
    "type": "qam",
    "title": "My Plugin"
  }
}
```

| Field | Description |
|-------|-------------|
| `target.type` | `"qam"` (QAM tab) or `"panel"` (overlay, default) |
| `target.title` | Display name shown in the QAM tab bar |

If `target` is omitted, the plugin uses the current overlay panel behavior.

### Adding Routes

Plugins can define custom full-page routes — useful for settings pages, detail views, etc. Routes map a URL path to a named export from `panel.tsx`:

```json
{
  "id": "my-qam-plugin",
  "name": "My QAM Plugin",
  "version": "0.1.0",
  "description": "QAM plugin with settings",
  "author": "Your Name",
  "target": {
    "type": "qam",
    "title": "My Plugin"
  },
  "routes": {
    "/loadout/my-qam-plugin/settings": "SettingsPage"
  }
}
```

Route paths **must** be prefixed with `/loadout/{pluginId}/` to avoid collisions with Steam's own routes.

### Navigation API

Navigate between views using the navigation functions from `@loadout/ui`:

```tsx
import { navigate, navigateBack, navigateToPage } from "@loadout/ui";

// Navigate to a route
navigate("/loadout/my-plugin/settings");

// Go back in history
navigateBack();

// Close QAM side panel + navigate to a full page
navigateToPage("/loadout/my-plugin/settings");
```

| Function | Description |
|----------|-------------|
| `navigate(path)` | Navigate to a Steam route path |
| `navigateBack()` | Go back in Steam's history stack |
| `closeSideMenus()` | Close QAM and other side menus |
| `navigateToPage(path)` | Close QAM, then navigate (convenience) |

### QAM Plugin Example

Here's a complete QAM plugin with a settings page:

#### `plugins/hello-world-qam/plugin.json`

```json
{
  "id": "hello-world-qam",
  "name": "Hello QAM",
  "version": "0.0.1",
  "description": "A QAM tab with a settings page",
  "author": "Loadout",
  "permissions": {
    "network": ["icanhazdadjoke.com"]
  },
  "target": {
    "type": "qam",
    "title": "Hello World"
  },
  "routes": {
    "/loadout/hello-world-qam/settings": "SettingsPage"
  }
}
```

#### `plugins/hello-world-qam/panel.tsx`

```tsx
import { useState, useCallback, useEffect } from "react";
import {
  useBackend, Panel, Text, Button, Spinner, Steam,
  navigateToPage, navigateBack,
} from "@loadout/ui";

// Default export = QAM panel content
export default function QAMPanel() {
  const { call } = useBackend("hello-world-qam");
  const [joke, setJoke] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchJoke = useCallback(async () => {
    setLoading(true);
    try {
      const result = await call("getJoke");
      setJoke(result as string);
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEffect(() => { fetchJoke(); }, [fetchJoke]);

  return (
    <Panel title="Hello World">
      {loading ? <Spinner /> : joke ? <Text>{joke}</Text> : null}
      <Button variant="primary" onClick={fetchJoke} disabled={loading}>
        New Joke
      </Button>
      <Steam.DialogButton
        onClick={() => navigateToPage("/loadout/hello-world-qam/settings")}
      >
        Open Settings
      </Steam.DialogButton>
    </Panel>
  );
}

// Named export = settings page (referenced in routes)
export function SettingsPage() {
  const { call } = useBackend("hello-world-qam");
  const [history, setHistory] = useState<{ joke: string; timestamp: number }[]>([]);

  useEffect(() => {
    call("getHistory").then((r) => setHistory(r as any[]));
  }, [call]);

  return (
    <div style={{ padding: 32 }}>
      <Text variant="heading">Settings</Text>
      <Text>Joke history: {history.length} jokes</Text>
      <Button onClick={() => call("clearHistory")}>Clear History</Button>
      <Steam.DialogButton onClick={() => navigateBack()}>
        Back
      </Steam.DialogButton>
    </div>
  );
}
```

### How It Works

1. **Loading**: All plugin bundles are loaded regardless of target type. QAM plugins are *not* mounted in the overlay div.
2. **QAM Patching**: After Steam component discovery, the injector walks the React fiber tree to find the QAM tabs component and monkey-patches it to include custom tab entries.
3. **Route Patching**: Custom routes are injected into Steam's router, mapping paths to named exports from your plugin.
4. **Navigation**: The `navigate*` functions wrap Steam's internal Navigation singleton, discovered during component discovery.
5. **Hot Reload**: On file save, patches are cleaned up and re-applied automatically.

---

## Tips

- **Start with built-in components** (`Panel`, `Button`, `Text`) for quick prototyping, then swap in Steam components (`Steam.DialogButton`, `Steam.ToggleField`) for the native look.
- **Always wrap interactive elements in `Steam.Focusable`** if your plugin will be used with a gamepad.
- **Use `Steam.has()` before rendering** Steam components that may not exist in all versions.
- **Keep backend methods focused** — each method should do one thing. Use events for state changes.
- **Declare network permissions** explicitly — be transparent about what domains your plugin accesses.
- **Test in both browser and Big Picture Mode** — `bun run dev` for fast iteration, `bun run dev:inject` for real integration testing.
