# Plan: CSS GUI Theme Editor Plugin

## Context

We want a plugin for Loadout that lets users fully customise Steam's visual appearance through intuitive GUI controls (color pickers, sliders, gradient editors) — no raw CSS editing. The plugin UI renders in the overlay app (WebKitGTK), and the generated CSS gets injected into Steam's CEF tabs via the existing bridge/injector.

This is feasible. The key pieces already exist:
- CSS injection into Steam via CDP (`packages/injector/src/injector.ts` — `injectPluginCSS`, `cdp.evaluate`)
- Component discovery maps readable names to CSS class hashes (`packages/injector/src/steam-components.ts`)
- Plugin backend RPC connects overlay UI to server-side logic (`packages/loader/src/rpc-handler.ts`)
- The overlay plugin pattern is proven (`plugins/hello-world-overlay/`)

### The Gap to Bridge

`injectCSS()` from `@loadout/ui` runs **in-context** — it adds `<style>` tags to whatever document it's called from. The overlay runs in WebKitGTK, not Steam's CEF. So we need a server-side CSS injection path:

```
Overlay UI (color picker changes)
  → call("applyTheme", themeConfig)    [WebSocket RPC]
  → backend.ts generates CSS string    [Bun process]
  → backend uses CDP to inject CSS     [CDP → Steam CEF]
  → Steam's UI updates live
```

This requires the plugin backend to have access to a CDP connection to Steam. Currently, the injector is a separate tool (`tools/inject/`), not integrated into the loader server. **The server needs a thin CDP integration** — or the backend needs access to the injector as a library.

## Implementation Plan

### Phase 1: Server-Side CSS Injection API

Add a mechanism for plugin backends to inject CSS into Steam's CEF.

**Option A (recommended): Loader-level CSS injection service**

Add to `packages/loader/src/index.ts`:
- On startup, optionally connect to Steam's CEF debug port (like the injector does)
- Expose an internal `injectCSSIntoSteam(css: string, target: string)` function
- Make this available to plugin backends via a service injection pattern

**Modify**: `packages/loader/src/index.ts`
- Add optional CDP connection to Steam (reuse `CDPClient` from `packages/injector/src/cdp.ts`)
- Add `POST /api/steam/inject-css` endpoint (body: `{ css: string, target: "bpm" | "qam" | "all" }`)
- Add `DELETE /api/steam/inject-css/:id` endpoint to remove injected styles

**Modify**: `packages/types/src/plugin.ts`
- (Optional) Add `injectCSS` to backend context interface — so backends can call `this.injectCSS(css)`

The key insight: the CSS injection doesn't need webpack modules, component discovery, or React. It's just `cdp.evaluate('inject a <style> tag')` — the simplest possible CDP operation. This is extremely stable.

### Phase 2: CSS Theme Engine (`plugins/css-editor/lib/theme-engine.ts`)

A pure function that takes a theme config object and returns a CSS string.

```ts
interface ThemeConfig {
  // General
  accentColor: string;         // e.g., "#1a9fff"
  accentColorHover: string;
  backgroundColor: string;      // e.g., "#1a1a2e"
  surfaceColor: string;         // e.g., "#16213e"
  textColor: string;            // e.g., "#dcdedf"
  textSecondaryColor: string;   // e.g., "#8b929a"

  // Buttons
  buttonBg: string;
  buttonRadius: number;         // px
  buttonHoverBg: string;

  // QAM
  qamBg: string;
  qamOpacity: number;           // 0-1

  // Library
  gameTileRadius: number;       // px
  gameTileGap: number;          // px
  libraryBg: string;
  selectedGameColor: string;

  // Navigation
  navBg: string;
  navActiveColor: string;

  // Progress bars / sliders
  progressColor: string;
  sliderTrackColor: string;
  sliderThumbColor: string;

  // Typography
  fontScale: number;            // multiplier, e.g., 1.0

  // Advanced
  customCSS: string;            // escape hatch for power users
}
```

**`generateCSS(config: ThemeConfig): string`** produces CSS like:

```css
/* General */
body { background: {{backgroundColor}} !important; color: {{textColor}} !important; }
[class*="gamepadui_MainPanel"] { background: {{surfaceColor}} !important; }

/* Buttons */
[class*="DialogButton"] {
  background: {{buttonBg}} !important;
  border-radius: {{buttonRadius}}px !important;
}
[class*="DialogButton"]:hover { background: {{buttonHoverBg}} !important; }

/* QAM */
[class*="quickaccessmenu"] {
  background: {{qamBg}} !important;
  opacity: {{qamOpacity}} !important;
}

/* Navigation */
[class*="gamepadtabbedpage_Tab"] { color: {{textSecondaryColor}} !important; }
[class*="gamepadtabbedpage_Active"] { color: {{navActiveColor}} !important; }

/* ... etc */
```

**CSS Selector Strategy**: Use `[class*="readable_prefix"]` selectors rather than exact minified class names. Steam's class names follow the pattern `readableName_hash` (e.g., `gamepadui_MainPanel_3a4b5c`). The `*=` selector matches the readable prefix, which is more stable across updates than exact hashes. This is how CSS Loader themes work and is proven to be reasonably resilient.

### Phase 3: Plugin Backend (`plugins/css-editor/backend.ts`)

```ts
import type { PluginBackend } from "@loadout/types";

export default class CSSEditor implements PluginBackend {
  private currentTheme: ThemeConfig = DEFAULT_THEME;
  private configPath: string;  // ~/.local/share/loadout/css-editor/theme.json

  async onLoad() {
    // Load saved theme from disk
    this.currentTheme = await this.loadFromDisk();
    // Apply it immediately
    await this.applyToSteam();
  }

  // Called from overlay UI when any control changes
  async applyTheme(config: ThemeConfig) {
    this.currentTheme = config;
    await this.applyToSteam();
    await this.saveToDisk();
  }

  // Called for live preview (debounced, no save)
  async previewTheme(config: ThemeConfig) {
    await this.applyToSteam(config);
  }

  async getTheme(): Promise<ThemeConfig> {
    return this.currentTheme;
  }

  async resetTheme() {
    this.currentTheme = DEFAULT_THEME;
    await this.applyToSteam();
    await this.saveToDisk();
  }

  async loadPreset(name: string) {
    this.currentTheme = PRESETS[name] ?? DEFAULT_THEME;
    await this.applyToSteam();
    await this.saveToDisk();
  }

  async getPresets(): Promise<string[]> {
    return Object.keys(PRESETS);
  }

  async exportTheme(): Promise<string> {
    return JSON.stringify(this.currentTheme, null, 2);
  }

  async importTheme(json: string) {
    this.currentTheme = JSON.parse(json);
    await this.applyToSteam();
    await this.saveToDisk();
  }

  private async applyToSteam(config?: ThemeConfig) {
    const css = generateCSS(config ?? this.currentTheme);
    // Use the server's CSS injection service (Phase 1)
    await fetch("http://localhost:33820/api/steam/inject-css", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ css, id: "css-editor-theme" }),
    });
  }
}
```

### Phase 4: Plugin Frontend (`plugins/css-editor/app.tsx`)

The overlay UI with visual controls organized into sections.

**Component tree:**
```
<CSSEditor>
  <Header>             — Title, preset selector, reset/export/import buttons
  <TabNav>             — General | Buttons | Library | QAM | Nav | Advanced
  <TabPanel>
    <SectionGeneral>   — Accent, background, surface, text colors + font scale slider
    <SectionButtons>   — Button BG color, radius slider, hover color
    <SectionLibrary>   — Tile radius, gap, background, selected highlight
    <SectionQAM>       — Background color, opacity slider
    <SectionNav>       — Nav BG, active/inactive colors
    <SectionAdvanced>  — Custom CSS textarea, full theme JSON export
  </TabPanel>
</CSSEditor>
```

**Controls needed (all built as React components):**

| Control | Props | For |
|---------|-------|-----|
| `ColorPicker` | `value`, `onChange`, `label` | Every color property |
| `Slider` | `value`, `onChange`, `label`, `min`, `max`, `step`, `unit` | Radius, gap, opacity, font scale |
| `PresetBar` | `presets`, `onSelect`, `active` | Quick theme switching |
| `TabNav` | `tabs`, `active`, `onSelect` | Section navigation |
| `CustomCSS` | `value`, `onChange` | Advanced textarea |

**Color Picker implementation**: Use an `<input type="color">` as the base (native, works in WebKitGTK, no dependencies) wrapped in a styled component showing the hex value and a preview swatch. No need for a complex third-party color picker library.

**Live preview**: Debounce control changes at ~100ms. On each change, call `backend.previewTheme(config)` which regenerates CSS and injects via CDP. The `cdp.evaluate()` call to inject a `<style>` tag is fast (~5-10ms round trip on localhost). Users will see near-instant feedback.

### Phase 5: Theme Presets

Built-in preset configs:

| Preset | Description |
|--------|-------------|
| `default` | Steam's native look (effectively a no-op / reset) |
| `midnight` | Deep dark blues and purples |
| `neon` | Bright accent colors on dark background |
| `forest` | Greens and earth tones |
| `sunset` | Warm oranges and reds |
| `monochrome` | Greyscale only |
| `high-contrast` | Accessibility: strong contrast, large text |

Each preset is just a `ThemeConfig` object. Users can start from a preset and customize.

## File Structure

```
plugins/css-editor/
├── plugin.json              # Manifest
├── app.tsx                  # Main editor UI
├── backend.ts               # Theme application, persistence, presets
├── lib/
│   ├── theme-engine.ts      # generateCSS(config) → CSS string
│   ├── default-theme.ts     # Default ThemeConfig values
│   ├── presets.ts           # Built-in theme presets
│   └── types.ts             # ThemeConfig interface
└── components/
    ├── ColorPicker.tsx      # Color input with swatch
    ├── Slider.tsx           # Range slider with label and value
    ├── TabNav.tsx           # Tab navigation
    ├── PresetBar.tsx        # Preset quick-select
    ├── SectionGeneral.tsx   # General colors panel
    ├── SectionButtons.tsx   # Button styling panel
    ├── SectionLibrary.tsx   # Library view panel
    ├── SectionQAM.tsx       # QAM panel
    ├── SectionNav.tsx       # Navigation panel
    └── SectionAdvanced.tsx  # Custom CSS + export
```

## Files to Modify

| File | Change |
|------|--------|
| `packages/loader/src/index.ts` | Add `POST /api/steam/inject-css` and `DELETE /api/steam/inject-css/:id` endpoints. Add optional CDP connection to Steam on startup. |
| `packages/types/src/plugin.ts` | (Optional) Add `injectCSS` to backend context interface |

## Key Feasibility Assessment

| Concern | Assessment |
|---------|-----------|
| **Can CSS reach Steam from overlay?** | Yes — backend calls server endpoint → CDP evaluates `<style>` injection in Steam's CEF. Path is proven (same mechanism `steam-tweaks` uses, just routed through the backend). |
| **Live preview latency** | ~10-50ms (WebSocket RPC + CDP evaluate). Fast enough for slider dragging with 100ms debounce. |
| **CSS selector stability** | `[class*="readable_prefix"]` selectors are reasonably stable — same approach CSS Loader uses. Not immune to Steam updates, but far more stable than webpack module finding. |
| **Persistence** | JSON file on disk. Trivial. Auto-applied on plugin load. |
| **WebKitGTK color picker** | `<input type="color">` works natively in WebKitGTK. No third-party library needed. |
| **Theme sharing** | Export as JSON, import from JSON. Could later support a theme store. |
| **Multiple CEF tabs** | May need to inject into both BigPictureMode and QuickAccess. CDP connection supports targeting multiple tabs (already implemented in injector). |
| **Steam restarts** | Plugin's `onLoad()` re-applies the saved theme. Injector monitors for page reloads and can re-trigger. |

## What This Does NOT Require

- No webpack module finding
- No React fiber walking
- No component discovery (CSS selectors use `[class*=]` patterns)
- No new dependencies (native `<input type="color">`, standard `<input type="range">`)
- No changes to the overlay app shell

## Verification

1. `bun run dev` → open `localhost:33820/overlay` → CSS Editor plugin loads in sidebar
2. Click a color picker → change accent color → Steam's UI updates within ~100ms
3. Drag a slider (border radius) → Steam's buttons change shape live
4. Select "Neon" preset → all controls update, Steam's UI transforms
5. Close and reopen overlay → theme persists (loaded from disk)
6. Click "Reset" → Steam returns to default appearance
7. Click "Export" → JSON appears. Copy it. Click "Import" → paste → theme applies.
8. Kill Steam, relaunch → theme re-applies automatically on plugin load
9. `bun run test` → theme engine unit tests pass (generateCSS produces valid CSS for each config)
10. `bun run typecheck` → no type errors
