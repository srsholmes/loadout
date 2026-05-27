# Loadout — UI Modding Framework

Loadout provides a UI modding framework for Steam Big Picture Mode, enabling plugin developers to inspect, modify, and extend Steam's interface.

## Architecture

Steam's UI runs in Chromium Embedded Framework (CEF) with three key contexts:

- **SharedJSContext** — Invisible page where webpack/React JavaScript executes. All module loading, React rendering logic, and plugin code runs here.
- **Big Picture Mode (BPM) tab** — The visible UI window. DOM elements rendered by React appear here.
- **QuickAccess tab** — The Quick Access Menu (QAM) sidebar.

The injector connects to all three via Chrome DevTools Protocol (CDP).

## Features

### Element Inspector

A built-in overlay inspector for Steam's BPM UI. Toggle with the **Inspect** button (bottom-left corner) or **F12**.

**When active:**
- Hover over any element to see a highlight overlay
- Info panel shows: React component name, fiber path, CSS classes, props
- Click to copy a find pattern for use in webpack patches
- Click **Stop** to deactivate

The inspector is injected into the BPM tab's DOM (not SharedJSContext).

### Webpack Patching (Vencord-style)

Plugins can intercept webpack module factories before execution, applying find/replace patterns to modify component source code at load time.

```json
{
  "patches": [
    {
      "find": "someUniqueString",
      "replacement": [
        {
          "match": "originalCode",
          "replace": "modifiedCode"
        }
      ]
    }
  ]
}
```

The patcher hooks `webpackChunksteamui.push()` to intercept modules as they load.

### CSS Injection

Plugins can inject and remove CSS at runtime:

```tsx
import { injectCSS, getComponentClass, getAllComponentClasses } from "@loadout/ui";

// Inject custom styles (returns cleanup function)
const cleanup = injectCSS(`
  .my-class { border: 2px solid #00d4ff; }
`);

// Get Steam's CSS module class for a component
const btnClass = getComponentClass("DialogButton");
```

### Plugin Targets

Plugins declare their UI target in `plugin.json`:

| Target | Description |
|--------|-------------|
| `qam` | Tab in the Quick Access Menu sidebar |
| `panel` | Overlay panel mounted in BPM |
| `overlay` | Floating widget with custom positioning |
| `css` | CSS-only plugin (no React component) |

QAM plugins support positioning: numeric index, `"before:TabTitle"`, `"after:TabTitle"`, or append (default).

### Runtime Patching API

```tsx
import { afterPatch, beforePatch, insteadPatch } from "@loadout/ui";

// Run code after a method, optionally modify return value
afterPatch(obj, "methodName", (args, returnValue) => {
  return modifiedReturnValue;
});

// Modify arguments before a method runs
beforePatch(obj, "methodName", (args) => {
  args[0] = modified;
  return args;
});

// Replace a method entirely
insteadPatch(obj, "methodName", (args, originalMethod) => {
  return originalMethod(...args);
});
```

### Steam Component Discovery

On injection, Loadout scans webpack modules to find and register Steam's internal React components (DialogButton, Focusable, Menu, Tabs, etc.) and their CSS module class mappings.

## Chrome DevTools Integration

A CDP multiplexer allows Chrome DevTools and the injector to share the same CDP connection:

1. Add `localhost:33820` in `chrome://inspect` → Configure
2. Click **inspect** on any Steam target (BPM, SharedJSContext, QuickAccess)
3. Use Elements, Console, Network, Sources tabs normally

## Known Limitations

### React DevTools Does Not Work

Steam's architecture splits React execution (SharedJSContext) from DOM rendering (BPM tab). React DevTools (both Chrome extension and standalone `bunx react-devtools`) requires the JavaScript context and rendered DOM to be in the same page, which is not the case for Steam.

**What we tried:**
- Chrome DevTools extension on remote targets — gets stuck on "Loading React Element Tree"
- Standalone React DevTools (`bunx react-devtools`) with bridge script injection — same issue
- Installing `__REACT_DEVTOOLS_GLOBAL_HOOK__` before React loads (via `Page.addScriptToEvaluateOnNewDocument` + reload) — hook captures real React 18.3.1 internals, but DevTools backend can't traverse the fiber tree cross-context
- Synchronous XHR to load DevTools backend before React — blocked by mixed content (HTTPS steamloopback → HTTP localhost)
- Direct CDP injection of DevTools backend script — connects but disconnects in a loop due to cross-context DOM mismatch

**Workaround:** Use the built-in element inspector for component/prop/class inspection. Use Chrome DevTools Elements tab via `chrome://inspect` for DOM inspection.

### SharedJSContext Reload Destroys BPM

Reloading the SharedJSContext via CDP (`Page.reload`) causes the BPM tab to disappear temporarily. While it eventually recovers, it disrupts the user experience and requires retry logic for reconnection.

### Route Patching Limitations

The route patcher may fail if Steam's router component structure changes. Routes use a fallback mechanism when the primary router patch can't find the expected component.

## Dev Mode

Start with `bun run dev:inject` which enables:
- Element inspector (Inspect button + F12)
- CDP multiplexer for Chrome DevTools access
- Hot reload on file changes
