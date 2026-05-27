# Gamepad Navigation Guide

Comprehensive reference for building plugins that are fully navigable with d-pad, analog sticks, and gamepad buttons. This guide is designed to be self-contained — AI agents designing plugins should follow it to produce correct navigation code.

## How Navigation Works

Loadout uses **spatial navigation** — focus moves between elements based on their physical position on screen, not DOM order.

### Architecture

```
Gamepad → useGamepadInput.ts → synthetic KeyboardEvents → norigin-spatial-navigation → focus moves
```

- **D-pad / left stick** → `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight` → spatial nav moves focus to the nearest element in that direction
- **A button** → `Enter` key → fires `onEnterPress` callback on the focused element
- **B button** → `Escape` key → handled by the shell (navigates back / closes overlay)
- **Right stick** → smooth analog scrolling of the nearest scrollable container

### Focus Tree

All focusable elements register in a shared focus tree via `window.__SPATIAL_NAV__`. The shell initializes the tree; plugins join it through `PluginProvider`:

```tsx
export function mount(container: HTMLElement, opts?: { parentFocusKey?: string }) {
  const root = createRoot(container);
  root.render(
    <PluginProvider parentFocusKey={opts?.parentFocusKey}>
      <MyPlugin />
    </PluginProvider>
  );
  return () => root.unmount();
}
```

`PluginProvider` wraps your plugin in a `FocusContext.Provider`, so every `useFocusable()` call inside your plugin automatically registers as a child of the shell's focus tree.

### Built-in Components Are Gamepad-Ready

These `@loadout/ui` components already use `useFocusable()` internally — **no extra work needed**:

| Component | Gamepad Behavior |
|-----------|-----------------|
| `<Button>` | A/Enter activates `onClick`, shows focus ring |
| `<Toggle>` | A/Enter toggles on/off, shows focus ring |
| `<Slider>` | D-pad Left/Right adjusts value, Up/Down navigates away |
| `<TabBar>` | D-pad Left/Right moves between tabs, A/Enter selects |
| `<TextInput>` | A/Enter activates native input (opens on-screen keyboard) |

Non-interactive components (`<Panel>`, `<Field>`, `<Text>`, `<Spinner>`) are correctly NOT focusable.

---

## The Golden Rule

> **Every interactive element must be focusable.** If a user can click it with a mouse, they must be able to reach it with the d-pad and activate it with the A button.

Two ways to achieve this:

1. **Use built-in components** (preferred) — `Button`, `Slider`, `Toggle`, `TabBar`, `TextInput`
2. **Use `useFocusable()` hook** for custom interactive elements

---

## Layout Patterns

### Pattern 1: Custom Clickable Element

For cards, list items, image tiles, or any custom interactive element that isn't a standard button:

```tsx
import { useFocusable } from "@loadout/ui";

function GameCard({ game, onSelect }: { game: Game; onSelect: (id: string) => void }) {
  const { ref, focused } = useFocusable({
    onEnterPress: () => onSelect(game.id),
  });

  return (
    <div
      ref={ref}
      className={`card bg-base-200 p-3 cursor-pointer min-h-[48px]
        ${focused ? "ring-2 ring-primary/40" : "hover:bg-base-300/50"}
        transition-all`}
    >
      <img src={game.cover} className="rounded" />
      <span className="text-sm font-medium">{game.name}</span>
    </div>
  );
}
```

**Key points:**
- `useFocusable({ onEnterPress })` makes it d-pad navigable and A-button activatable
- `ref={ref}` attaches to the outermost DOM element
- `focused` boolean drives visual focus ring: `ring-2 ring-primary/40`
- `min-h-[48px]` ensures adequate touch/focus target size

### Pattern 2: Vertical List

```tsx
function DeviceList({ devices, onConnect }: Props) {
  return (
    <div className="flex flex-col gap-1">
      {devices.map((device) => (
        <DeviceRow key={device.id} device={device} onConnect={onConnect} />
      ))}
    </div>
  );
}

function DeviceRow({ device, onConnect }: Props) {
  const { ref, focused } = useFocusable({
    onEnterPress: () => onConnect(device.id),
  });

  return (
    <div
      ref={ref}
      className={`flex items-center justify-between p-3 rounded-lg min-h-[48px]
        ${focused ? "ring-2 ring-primary/40 bg-primary/10" : "hover:bg-base-300/50"}`}
    >
      <span>{device.name}</span>
      <span className="text-xs text-base-content/60">{device.status}</span>
    </div>
  );
}
```

**Key points:**
- Each row is its own focusable — d-pad Up/Down moves between them
- Use `flex flex-col gap-1` (not margin) — spatial nav calculates distance between element edges
- Each row has `min-h-[48px]` for adequate target size

### Pattern 3: Horizontal Button Row

```tsx
import { Button } from "@loadout/ui";

function PresetRow({ presets, active, onSelect }: Props) {
  return (
    <div className="flex flex-wrap gap-2">
      {presets.map((p) => (
        <Button
          key={p.id}
          variant={active === p.id ? "primary" : "default"}
          onClick={() => onSelect(p.id)}
        >
          {p.label}
        </Button>
      ))}
    </div>
  );
}
```

`Button` already uses `useFocusable()` — d-pad Left/Right moves between buttons naturally. No extra work needed.

### Pattern 4: Grid Layout

```tsx
import { useFocusable } from "@loadout/ui";

function ImageGrid({ images, onSelect }: Props) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {images.map((img) => (
        <GridCell key={img.id} img={img} onSelect={onSelect} />
      ))}
    </div>
  );
}

function GridCell({ img, onSelect }: Props) {
  const { ref, focused } = useFocusable({
    onEnterPress: () => onSelect(img.id),
  });

  return (
    <div
      ref={ref}
      className={`aspect-video rounded-lg overflow-hidden cursor-pointer
        ${focused ? "ring-2 ring-primary/40 scale-105" : ""}
        transition-transform`}
    >
      <img src={img.url} className="w-full h-full object-cover" />
    </div>
  );
}
```

Spatial nav handles grid navigation automatically — d-pad moves to the nearest neighbor in any direction.

### Pattern 5: Tabs with Content

```tsx
import { TabBar, Panel } from "@loadout/ui";

function SettingsPage() {
  const [tab, setTab] = useState("general");

  return (
    <div>
      <TabBar
        tabs={[
          { id: "general", label: "General" },
          { id: "advanced", label: "Advanced" },
        ]}
        activeTab={tab}
        onTabChange={setTab}
      />
      {tab === "general" && <GeneralSettings />}
      {tab === "advanced" && <AdvancedSettings />}
    </div>
  );
}
```

`TabBar` handles d-pad Left/Right to move between tabs and A/Enter to select.

### Pattern 6: Slider with Value Display

```tsx
import { Slider, Field } from "@loadout/ui";

function BrightnessControl({ value, onChange }: Props) {
  return (
    <Field label="Brightness">
      <div className="flex items-center gap-3 w-full">
        <Slider value={value} onChange={onChange} min={0} max={100} step={5} />
        <span className="text-sm font-bold w-12 text-right">{value}%</span>
      </div>
    </Field>
  );
}
```

`Slider` handles d-pad Left/Right to adjust the value, and Up/Down to navigate away to other elements.

### Pattern 7: Scrollable Content Area

```tsx
function LongList({ items }: Props) {
  return (
    <div className="overflow-y-auto max-h-[400px]">
      {items.map((item) => (
        <ItemRow key={item.id} item={item} />
      ))}
    </div>
  );
}
```

When focus moves to items outside the visible viewport, they **automatically scroll into view**. The right stick also provides smooth analog scrolling of the nearest scrollable container.

### Pattern 8: Disabled / Conditional States

```tsx
function ActionButton({ canSave, onSave }: Props) {
  return (
    <Button variant="primary" onClick={onSave} disabled={!canSave}>
      Save
    </Button>
  );
}
```

Disabled elements use `focusable: !disabled` internally — spatial nav automatically skips them.

**When conditionally hiding elements**, be aware that focus can get lost if the currently-focused element is removed from the DOM. Prefer disabling over hiding when possible.

---

## DO / DON'T

```
DO:  Use <Button> from @loadout/ui for all clickable actions
DON'T:  Use raw <button> or <a> elements — they're not gamepad-navigable

DO:  Use useFocusable() for custom interactive elements (cards, list items, images)
DON'T:  Use onClick alone — mouse works but gamepad users can't reach it

DO:  Return true from onArrowPress for directions you don't handle
DON'T:  Return false for all directions — this traps focus inside your component

DO:  Use min-h-[44px] or min-h-[48px] on interactive elements
DON'T:  Make tiny clickable areas — they're hard to focus with spatial navigation

DO:  Apply focus ring consistently: ring-2 ring-primary/40
DON'T:  Use custom focus styles that look different from the rest of the UI

DO:  Use flex/grid with gap for spacing between focusable items
DON'T:  Use margin between focusable siblings — spatial nav uses element edges for distance

DO:  Show focused state visually (ring, background change, or scale)
DON'T:  Have invisible focus — users won't know where they are

DO:  Keep interactive elements in a logical spatial order (top-to-bottom, left-to-right)
DON'T:  Use absolute positioning that creates confusing navigation paths

DO:  Wrap each interactive item in its own useFocusable()
DON'T:  Wrap a large container and expect items inside to be individually focusable

DO:  Use the disabled prop on Button/Toggle/Slider when actions are unavailable
DON'T:  Hide elements conditionally without considering where focus goes
```

---

## `useFocusable()` API Reference

Import from `@loadout/ui`:

```tsx
import { useFocusable } from "@loadout/ui";
```

### Config Options

```tsx
const { ref, focused, hasFocusedChild, focusSelf, focusKey } = useFocusable({
  // Called when user presses A/Enter on this element
  onEnterPress: () => void,

  // Called on d-pad direction. Return false to consume (stop propagation),
  // true to let spatial nav handle it (move focus).
  onArrowPress: (direction: "up" | "down" | "left" | "right") => boolean,

  // Whether this element can receive focus (default: true)
  focusable: boolean,

  // Creates a focus boundary — focus can't escape via d-pad
  isFocusBoundary: boolean,

  // Remember which child was last focused (default: true)
  saveLastFocusedChild: boolean,

  // Track whether any child is focused
  trackChildren: boolean,

  // Focus/blur callbacks
  onFocus: (layout, props, details) => void,
  onBlur: (layout, props, details) => void,
});
```

### Return Values

| Value | Type | Description |
|-------|------|-------------|
| `ref` | `RefObject` | Attach to the outermost DOM element |
| `focused` | `boolean` | Whether this element currently has focus |
| `hasFocusedChild` | `boolean` | Whether any descendant has focus |
| `focusSelf` | `() => void` | Programmatically focus this element |
| `focusKey` | `string` | Unique identifier in the focus tree |

### `onArrowPress` Return Value

This is important to get right:

- **Return `true`** (or don't provide `onArrowPress`) — spatial nav handles the direction normally (moves focus)
- **Return `false`** — you consumed this direction (e.g., Slider consumes Left/Right to adjust value)

**Example: Slider-like component**

```tsx
const { ref, focused } = useFocusable({
  onArrowPress: (direction) => {
    if (direction === "left" || direction === "right") {
      // Adjust our value — consume the event
      adjustValue(direction === "right" ? 1 : -1);
      return false;
    }
    // Let Up/Down navigate to other elements
    return true;
  },
});
```

---

## Component Quick Reference

| I need... | Use this | Gamepad behavior |
|-----------|----------|-----------------|
| Clickable action | `<Button onClick={fn}>` | A/Enter activates, focus ring |
| On/off switch | `<Toggle checked={v} onChange={fn}>` | A/Enter toggles, focus ring |
| Numeric value | `<Slider value={v} onChange={fn}>` | Left/Right adjusts, Up/Down navigates away |
| Tab navigation | `<TabBar tabs={[...]} onTabChange={fn}>` | Left/Right switches, A/Enter selects |
| Text entry | `<TextInput value={v} onChange={fn}>` | A/Enter activates keyboard, focus ring |
| Custom interactive | `useFocusable()` + `ring-2 ring-primary/40` | You define onEnterPress/onArrowPress |
| Display only | `<Panel>`, `<Field>`, `<Text>`, `<Spinner>` | Not focusable (correct) |

---

## Testing Checklist

Before shipping a plugin, verify with a gamepad (or keyboard arrows + Enter):

- [ ] Every clickable element is reachable via d-pad
- [ ] Every clickable element activates with A button (Enter)
- [ ] B button navigates back (handled by shell — don't override)
- [ ] Focus ring (`ring-2 ring-primary/40`) is visible on all interactive elements
- [ ] No focus traps — d-pad can always escape any section
- [ ] Scrollable areas scroll to show the focused item
- [ ] Disabled elements are skipped by focus navigation
- [ ] Tab/mode switches work with d-pad + A button
- [ ] Sliders adjust with d-pad Left/Right
- [ ] Long lists are scrollable with d-pad and right stick
- [ ] Conditional rendering doesn't leave focus in a broken state

---

## Common Mistakes

### Using raw HTML elements

```tsx
// WRONG — not gamepad-navigable
<button onClick={handleClick}>Save</button>
<div onClick={handleSelect} className="card">...</div>

// CORRECT — use Button for actions
<Button onClick={handleClick}>Save</Button>

// CORRECT — use useFocusable for custom elements
function Card({ onSelect }) {
  const { ref, focused } = useFocusable({ onEnterPress: onSelect });
  return (
    <div ref={ref} className={`card ${focused ? "ring-2 ring-primary/40" : ""}`}>
      ...
    </div>
  );
}
```

### Trapping focus with onArrowPress

```tsx
// WRONG — focus can never leave this element
onArrowPress: (direction) => {
  doSomething(direction);
  return false; // ALL directions consumed!
}

// CORRECT — only consume directions you handle
onArrowPress: (direction) => {
  if (direction === "left" || direction === "right") {
    adjustValue(direction);
    return false; // Consumed horizontal
  }
  return true; // Let vertical navigation work
}
```

### Wrapping containers instead of items

```tsx
// WRONG — the whole list is one focusable, items inside aren't individually reachable
<div ref={ref}>
  {items.map(item => <div onClick={() => select(item)}>{item.name}</div>)}
</div>

// CORRECT — each item is focusable
{items.map(item => <FocusableItem key={item.id} item={item} onSelect={select} />)}
```

### Missing focus ring

```tsx
// WRONG — user can't see where focus is
const { ref } = useFocusable({ onEnterPress: handleClick });
return <div ref={ref}>Click me</div>;

// CORRECT — visual feedback on focus
const { ref, focused } = useFocusable({ onEnterPress: handleClick });
return (
  <div ref={ref} className={focused ? "ring-2 ring-primary/40 rounded-lg" : ""}>
    Click me
  </div>
);
```
