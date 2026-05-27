# Loadout Design System

Design guidelines for building consistent, theme-aware plugin UIs.

## Stack

- **Tailwind CSS v4** + **DaisyUI v5** for all styling
- **Loadout token layer** sits on top of DaisyUI — provides the
  surface/foreground ramps the UI actually uses (defined per theme in
  `packages/overlay/src/index.css`)
- **@loadout/ui** shared component library (Button, Panel, Text, Field, Toggle, Spinner, Slider, TextInput, TabBar)
- **@noriginmedia/norigin-spatial-navigation** for gamepad/d-pad focus management

## Color System

Two layers, both legal:

1. **DaisyUI v5 base** — semantic primitives (primary, error, success, etc.)
   that follow the active theme.
2. **Loadout layer** — neutral surface ramps and an accent scale on top of
   DaisyUI, defined per theme in `packages/overlay/src/index.css`. This is
   what most chrome (cards, insets, borders, accent strokes) reaches for.

Never hardcode hex / `rgb()` / `oklch(...)` literals for UI chrome — go
through one of the two layers below.

### DaisyUI v5 CSS Variables (semantic primitives)

| Variable | Use |
|---|---|
| `--color-primary` | Primary actions, active states, accent |
| `--color-primary-content` | Text on primary backgrounds |
| `--color-secondary` | Secondary actions |
| `--color-accent` | Highlights, badges |
| `--color-neutral` | Subdued backgrounds |
| `--color-base-100` | Page background |
| `--color-base-200` | Card/surface background |
| `--color-base-300` | Borders, dividers, elevated surfaces |
| `--color-base-content` | Primary text |
| `--color-error` | Errors, destructive actions |
| `--color-success` | Success states, positive indicators |
| `--color-warning` | Warnings, caution states |
| `--color-info` | Informational messages |

### Loadout layer (surface + accent ramps)

These are defined in `packages/overlay/src/index.css` for every shipped
theme. Reach for them when you need a surface ramp finer than DaisyUI's
three base shades, or an accent treatment beyond `--color-primary`.

| Variable | Use |
|---|---|
| `--bg-0` … `--bg-3` | Layered surface ramp (page → card → elevated) |
| `--bg-inset` | Inset surface (input, well, list-row bg) |
| `--fg-1` | Primary text |
| `--fg-2` | Secondary text |
| `--fg-3` | Tertiary / muted text |
| `--line` | Dividers, faint borders |
| `--line-strong` | Stronger borders, panel edges |
| `--accent` | Active accent stroke / dot |
| `--accent-hi` | Brighter accent (focus rings, hover) |
| `--accent-lo` | Dimmer accent (resting state) |
| `--accent-soft` | Tinted accent fill (15% opacity backplate) |
| `--glow-accent` | Composite shadow for elevated accent surfaces |

If you find yourself wanting a colour that isn't here, add it to the
Loadout layer in `index.css` (for every theme) rather than inventing a
per-component variable.

### In Tailwind Classes (preferred)

```
bg-base-100       bg-base-200       bg-base-300
text-base-content text-base-content/60   (60% opacity for secondary text)
text-primary      text-error        text-success     text-warning
bg-primary        bg-error          bg-success
border-base-300   border-primary
```

### In Inline Styles (when needed)

Import from `@loadout/ui/colors`:

```ts
import { colors } from "@loadout/ui/colors";

// colors.text       = var(--color-base-content)
// colors.accent     = var(--color-primary)
// colors.surface    = var(--color-base-200)
// colors.border     = var(--color-base-300)
// colors.error      = var(--color-error)
// colors.success    = var(--color-success)
```

### Never Do This

```ts
// WRONG: hardcoded hex
style={{ color: "#dcdedf" }}

// WRONG: DaisyUI v4 variable names (don't exist in v5)
style={{ color: "oklch(var(--p))" }}
style={{ background: "oklch(var(--bc))" }}
style={{ border: "1px solid oklch(var(--b3))" }}

// WRONG: ad-hoc @theme variables not defined in index.css
className="text-text-primary"
style={{ background: "var(--color-background)" }}
```

### These are fine

```ts
// OK: DaisyUI primitive
className="bg-base-200 text-base-content"

// OK: Loadout layer (defined per theme in index.css)
style={{ background: "var(--bg-inset)", color: "var(--fg-2)" }}
style={{ border: "1px solid var(--line)" }}
style={{ boxShadow: "var(--glow-accent)" }}
```

## Components

### Shared UI Components

Always prefer `@loadout/ui` components over raw HTML:

| Component | Use | DaisyUI class |
|---|---|---|
| `<Button>` | All clickable actions | `btn btn-primary`, `btn-ghost`, `btn-error` |
| `<IconButton>` | Icon-only square button (variants: primary/ghost/danger) | Themed |
| `<HeaderBackButton>` | Back chevron in plugin headers (handles B/Esc) | — |
| `<Toggle>` | On/off switches | `toggle toggle-primary` |
| `<Panel>` | Content sections with title | Card-like container |
| `<Text>` | Body/secondary/heading text | Themed text |
| `<Field>` | Label + value pair | — |
| `<Badge>` | Inline status chip | `badge badge-primary` |
| `<Spinner>` | Loading indicator (variant: "spinner" \| "dots") | Themed spinner |
| `<Slider>` | Range input | Themed accent |
| `<TextInput>` | Text entry | Themed border + focus |
| `<SearchField>` | Search-flavoured text input | — |
| `<Select>` | Single-select dropdown with spatial-nav | — |
| `<Segmented>` (+ `<SegmentedItem>`) | Tab-style toggle group | — |
| `<TabBar>` | Tab navigation | Themed underline |
| `<GameCard>` | Library tile (image + title + collection badge, with image-fallback chain) | — |
| `<PluginHeader>` | Plugin-shell topbar slot | — |

Drift policy: when a new renderable is added to `packages/ui/src/index.ts`,
add the row here in the same PR. Audit G-012 (2026-05) left this as a
manual discipline after the build-time differ proved too fragile against
type-only / namespace exports; the table is small enough that drift is
caught at review.

### DaisyUI Utility Classes

Use these directly in plugin `app.tsx` files:

```tsx
// Buttons
<button className="btn btn-primary">Action</button>
<button className="btn btn-ghost btn-sm">Secondary</button>
<button className="btn btn-error btn-outline">Danger</button>

// Badges
<span className="badge badge-primary">v1.0</span>
<span className="badge badge-outline">Status</span>

// Cards
<div className="card bg-base-200">
  <div className="card-body p-4">...</div>
</div>

// Inputs
<input className="input input-bordered w-full" />
<input type="range" className="range range-primary range-sm" />

// Alerts
<div className="alert alert-error">Error message</div>
<div className="alert alert-success">Success!</div>
```

## Layout Patterns

### Full Page Plugin

```tsx
<div className="p-6 max-w-2xl">
  {/* Header */}
  <div className="mb-6">
    <h1 className="text-2xl font-bold mb-2">Plugin Name</h1>
    <Text variant="secondary">Short description.</Text>
  </div>

  {/* Content sections */}
  <Panel title="Section Name">
    <Field label="Setting">Value</Field>
  </Panel>
</div>
```

### QAM Widget

```tsx
<div className="px-3.5 py-2.5">
  <div className="flex justify-between items-center mb-1.5">
    <span className="text-xs font-semibold uppercase tracking-wide text-base-content/60">
      Widget Title
    </span>
    <span className="text-xs font-bold text-base-content">
      Status
    </span>
  </div>
  {/* Compact content */}
</div>
```

### Status Colors

```tsx
// Installed/active/connected
<span className="text-success">Active</span>

// Not found/offline/unavailable
<span className="text-error">Offline</span>

// Warning/degraded
<span className="text-warning">Degraded</span>

// Neutral/secondary info
<span className="text-base-content/60">Unknown</span>
```

## Focus & Accessibility

### Gamepad Navigation

All interactive elements must be gamepad-navigable. Built-in `@loadout/ui` components (`Button`, `Slider`, `Toggle`, `TabBar`, `TextInput`) handle this automatically. Custom interactive elements must use `useFocusable()` from `@loadout/ui`.

Focus rings use a consistent style across all components:

```
ring-2 ring-primary/40
```

**For the full gamepad navigation guide** — including layout patterns, DO/DON'T rules, `useFocusable()` API reference, and a testing checklist — see **[docs/gamepad-navigation-guide.md](docs/gamepad-navigation-guide.md)**.

### Touch Targets

Minimum 44px height for all interactive elements (buttons, toggles, list items). The `btn` class handles this by default.

### Keyboard / Gamepad Mapping

- D-pad / left stick navigates between elements
- A button / Enter activates
- B button / Escape goes back
- D-pad Left/Right adjusts sliders
- Right stick scrolls content

## Theme Switching

The app supports 35+ DaisyUI themes via `data-theme` attribute on `<html>`. All plugin UIs automatically adapt when themes change, as long as they use DaisyUI variables/classes.

The theme switcher is in Settings. Themes are persisted to `localStorage`.

Test your plugin with at least: `dark`, `light`, `synthwave`, `dracula`.

## Plugin File Structure

```
plugins/my-plugin/
  package.json    # Plugin metadata + "plugin" field
  backend.ts      # PluginBackend class (required)
  app.tsx          # React frontend (optional)
```

### Frontend Pattern

```tsx
import { useState, useEffect, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { PluginProvider, useBackend, Panel, Button, Text, Field, Spinner } from "@loadout/ui";

function MyPlugin() {
  const { call, useEvent } = useBackend("my-plugin");
  // ... component logic
}

function MyWidget() {
  const { call } = useBackend("my-plugin");
  // ... compact widget logic
}

export function mount(container: HTMLElement, opts?: { parentFocusKey?: string }) {
  const root = createRoot(container);
  root.render(
    <PluginProvider parentFocusKey={opts?.parentFocusKey}>
      <MyPlugin />
    </PluginProvider>
  );
  return () => root.unmount();
}

export function mountWidget(container: HTMLElement, opts?: { parentFocusKey?: string }) {
  const root = createRoot(container);
  root.render(
    <PluginProvider parentFocusKey={opts?.parentFocusKey}>
      <MyWidget />
    </PluginProvider>
  );
  return () => root.unmount();
}
```

## Checklist

Before submitting a plugin:

- [ ] All colors use DaisyUI classes or `@loadout/ui/colors` -- no hardcoded hex
- [ ] Renders correctly in `dark` and `light` themes
- [ ] All buttons use `<Button>` from `@loadout/ui` or DaisyUI `btn` class
- [ ] Interactive elements have 44px min touch target
- [ ] Loading states show `<Spinner>` 
- [ ] Empty states have helpful text (not just blank)
- [ ] Error states show what went wrong with a retry action
- [ ] QAM widget (if applicable) is compact and information-dense
- [ ] No console errors
