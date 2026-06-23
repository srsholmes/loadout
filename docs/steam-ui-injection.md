# Steam UI Injection

## How Steam's UI Works

Steam's UI is a full React application compiled with webpack, running inside a Chromium Embedded Framework (CEF) browser. On Steam Deck, this runs within Gamescope, Valve's Wayland micro-compositor. The CEF browser exposes a remote debug port on localhost, which is the primary hook point for injection.

The `SharedJSContext` is a special CEF tab with no visible UI where most JS executes and `window.SteamClient` is available as a global object.

## Injectable Surfaces

### Quick Access Menu (QAM)
The side panel opened by pressing the `...` button. Has distinct pages (Performance, Friends, Downloads, Settings), each registered via Steam's internal router. Can add new pages or inject widgets into existing Valve pages.

### Main Library
The game grid view:
- **Game tiles** — Add badges/overlays on game tiles
- **Sidebar filters** — Add custom filter categories
- **Sort/filter bar** — Add custom sort options

### Game Detail Page
Shows game banner, play button, achievements, friends activity. Can add entire new sections: personal notes, ProtonDB details, HLTB completion time, last session stats.

### Main Navigation Bar
Library, Store, Community, etc. Can register entirely new top-level navigation destinations.

### Home Screen
"What to play next" screen. Can inject recommendation sections.

### In-Game Overlay
Opened by pressing the Steam button during gameplay. Injectable. Best for game-specific plugin surfaces.

### Game Launch / Pre-Launch
The moment between pressing Play and the game launching. Can intercept to show a toast or modal (e.g., Proton compatibility warnings).

### Store
Steam store pages. Can inject into game store pages with additional data (HLTB times, external ratings).

### Notifications / Toasts
Steam's own toast notification system, accessible via webpack modules.

### Modal Dialogs
Steam's modal system is exposed. Can open native-feeling dialogs.

## Four Layers of Injection Depth

### Layer 1 — CSS Injection (Easy, Stable)

Pure stylesheet injection into the CEF context. Zero JS involvement, targets Valve's internal class names. Survives most updates.

### Layer 2 — SteamClient API Calls (Moderate, Fairly Stable)

`window.SteamClient` is available as a global in `SharedJSContext`. It's an IPC bridge between the CEF frontend and the actual Steam process. Core methods tend not to vanish because Valve needs them for their own UI.

### Layer 3 — Webpack Module Extraction (Hard, Moderately Stable)

Walk Valve's webpack chunk array (`webpackChunksteamui`) module registry. Find and steal references to actual React components and hooks. Monkey-patch, wrap with HOCs, or intercept props. Millennium has reverse-engineered Steam's React implementation for direct hooks.

### Layer 4 — HTTP Request Interception (Hardest, Most Powerful)

Millennium-style: intercept Steam's internal API calls. Augment or replace responses from store page loading, library metadata fetches, cloud save operations.

## Design Rule

**Use the highest-level API available for each surface.** If Valve exposed a page registration API — use it. If Valve exposed a toast API — use it. If Valve exposed Router navigation — use it. Only drop to lower layers when necessary.

## Stability Spectrum

| Stability | What |
|---|---|
| **Most stable** | QAM page registration, Router, toast notification API, `window.SteamClient` — effectively public APIs Valve uses themselves |
| **Moderately stable** | React component extraction via webpack — components exist and are findable but prop interfaces change |
| **Least stable** | Direct DOM manipulation, reading internal component state via React fiber walking, hooks into specific minified function implementations |

## `window.SteamClient` Namespace Reference

| Namespace | Capabilities |
|---|---|
| `SteamClient.Apps` | Game installs/uninstalls events, launch/exit events, download progress, app state changes. Trigger launches, read per-game metadata, query installed apps, get playtime data |
| `SteamClient.GameSessions` | Callbacks when game session starts/ends (including appid) |
| `SteamClient.User` | Account info, login state, Steam ID, account flags |
| `SteamClient.Friends` | Friend list, online status, rich presence data, friend activity events |
| `SteamClient.Notifications` | Post custom toast-style notifications (fragile) |
| `SteamClient.Downloads` | Queue state, progress, pause/resume controls |
| `SteamClient.System` | Battery level, performance stats, hardware info on Deck |
| `SteamClient.Music` | Playback state, track info, controls |
| `SteamClient.Screenshots` | Screenshot events and library |
| `SteamClient.Storage` | Cloud save status per game |

Also available: **Steam Router** — Valve's internal React Router instance, navigable programmatically to any route.

## Webpack Module Resilience

Steam updates can break webpack-based injection in three ways:
1. **Module IDs change** — webpack assigns numeric IDs that shift between builds
2. **Prop names change** — the minifier renames exported properties
3. **Component structure changes** — a component is rewritten

### Strategy 1: Multi-Criteria Module Finding

```ts
function getAllModules(): unknown[] {
  const registry: Record<string, { exports: unknown }> = {};

  (window as any).webpackChunksteamui.push([
    [Symbol()],
    {},
    (require: any) => Object.assign(registry, require.c)
  ]);

  return Object.values(registry)
    .map(m => m?.exports)
    .filter(Boolean);
}

export function findByProps(...props: string[]): unknown {
  return getAllModules().find(mod => {
    if (!mod || mod === window) return false;
    if (props.every(p => p in (mod as any))) return mod;
    if (props.every(p => p in ((mod as any).default ?? {}))) return (mod as any).default;
  });
}

export function findByCode(...strings: string[]): unknown {
  return getAllModules().find(mod => {
    const code = String(mod);
    return strings.every(s => code.includes(s));
  });
}

export function findWithFallbacks<T>(...finders: Array<() => T | undefined>): T | null {
  for (const finder of finders) {
    try {
      const result = finder();
      if (result) return result;
    } catch {}
  }
  return null;
}
```

### Strategy 2: Lazy Module Proxies

```ts
export function findLazy<T extends object>(...finders: Array<() => T | undefined>): T {
  let resolved: T | null = null;

  return new Proxy({} as T, {
    get(_, prop) {
      if (!resolved) {
        resolved = findWithFallbacks(...finders);
        if (!resolved) {
          console.warn(`[loadout] Module not found for prop: ${String(prop)}`);
          return undefined;
        }
      }
      return (resolved as any)[prop];
    }
  });
}
```

### Strategy 3: Code-String Patching (Vencord's Approach)

Intercept webpack chunk loading and patch module source code before execution:

```ts
interface Patch {
  find: string;
  replacement: { match: RegExp; replace: string };
}

function installWebpackInterceptor() {
  const originalPush = (window as any).webpackChunksteamui.push.bind(
    (window as any).webpackChunksteamui
  );

  (window as any).webpackChunksteamui.push = function(chunk: any[]) {
    if (chunk[1]) {
      for (const [id, factory] of Object.entries(chunk[1])) {
        const factoryStr = String(factory);
        for (const patch of patches) {
          if (factoryStr.includes(patch.find)) {
            const patched = factoryStr.replace(
              patch.replacement.match,
              patch.replacement.replace
            );
            (chunk[1] as any)[id] = new Function(
              "module", "exports", "require",
              patched.slice(patched.indexOf("{") + 1, patched.lastIndexOf("}"))
            );
          }
        }
      }
    }
    return originalPush(chunk);
  };
}
```

### Strategy 4: Automated Compatibility CI

A CI job that:
1. Launches a Steam instance
2. Connects to CEF debug port
3. Injects a test harness
4. Runs `validateAllModules()` testing every entry in `steam-components.ts`
5. Reports which finders are broken

Test against three Steam versions: SteamOS stable (oldest), SteamOS beta, and latest Steam (Bazzite/CachyOS).

### The Resilience Stack

```
Plugin author imports @loadout/ui
        ↓
Stable abstraction layer (your code, never breaks)
        ↓
Multi-strategy lazy finders (tries 3-4 ways to find each module)
        ↓
Webpack interceptor (patches code before execution where needed)
        ↓
SteamOS update happens...
        ↓
CI job detects broken finders, files issue
        ↓
Loader gets a small update fixing just the broken finders
        ↓
Plugins are unaffected — they were shielded
```

Goal: a SteamOS update requires ~20-50 lines touching `steam-components.ts`. Zero plugin authors need to do anything.

## How Gamescope Works

Gamescope is a Wayland micro-compositor developed by Valve:

- **Purpose** — Intermediary layer between games and the display server. Provides resolution scaling, frame limiting, HDR support, improved game compatibility
- **In embedded mode (Deck)** — Gets game frames through Wayland via Xwayland with no extra copies. Can use DRM/KMS to directly flip game frames to screen even when notifications are up. When compositing with GPU, uses async Vulkan compute
- **Steam UI** — Runs as a layer within Gamescope. The CEF browser is one of Gamescope's surfaces
- **Overlays** — `GAMESCOPE_EXTERNAL_OVERLAY` X atom mechanism theoretically lets external processes render overlays
- **Key insight** — Gamescope is a display compositor, not an application runtime. You can't inject into it. The hook point is the CEF debug protocol on the Steam process, which is why both Decky and Loadout use CEF injection rather than Gamescope-level hooks
