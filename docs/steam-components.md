# Steam UI Components Reference

Steam's Big Picture Mode uses React internally with a full set of UI components. Loadout discovers these components at runtime from Steam's webpack bundle and exposes them as typed, lazy-loaded proxies via `@loadout/ui` (`import { Steam } from "@loadout/ui"`).

> **Where these resolve.** The `Steam.*` proxies only return real components inside a **CEF-injected Steam context** — i.e. when Loadout's injector has run the discovery script inside Steam's `SharedJSContext` and populated `globalThis.__STEAM_COMPONENTS`. This is the path used for badge/CSS injection into Steam's own UI (see `packages/steam-cef-badges`, used by `plugins/protondb-badges` and `plugins/hltb`).
>
> In a normal overlay plugin `app.tsx` — which renders in the Electrobun (CEF) overlay window, **not** inside Steam's UI — `globalThis.__STEAM_COMPONENTS` is absent, so every `Steam.*` proxy resolves to `null` (rendering nothing) and logs a one-time warning. For overlay UI, use the built-in `@loadout/ui` components (`Button`, `Toggle`, `Slider`, `Select`, `TextInput`, `Field`, `TabBar`, `Panel`, etc.) instead. No plugin in this repo currently renders `Steam.*` components directly.

## How It Works

Steam's production JS is fully minified — variable names, function names, and module IDs are all hashed. But **prop names survive minification** because they're part of the component API, and **CSS module keys** retain readable names like `DialogButton` or `Focusable`.

The injector (`apps/loadout/src/injector/steam-components.ts`) builds a discovery script that runs inside Steam's CEF context and uses two strategies:

1. **Code pattern matching** — searches webpack modules for functions with unique prop destructuring patterns (e.g., `onActivate` + `onCancel` + `focusClassName` + `focusWithinClassName` identifies `Focusable`)
2. **CSS key usage** — finds React functions that reference `.ComponentName` on CSS module imports

Discovered components are stored on `globalThis.__STEAM_COMPONENTS` (a plain `name → component` map). The proxies in `packages/ui/src/steam.ts` are backed by a JS `Proxy` whose traps lazily read `globalThis.__STEAM_COMPONENTS?.[name]` on first render. If the global is missing or the name isn't found, the proxy caches `null`, warns once, and renders nothing — so a missing component only affects the code that uses it, never the rest of the UI.

## Usage

```tsx
import { Steam } from "@loadout/ui";

function MyPlugin() {
  return (
    <Steam.Focusable onActivate={() => console.log("activated!")}>
      <Steam.DialogButton onClick={() => console.log("clicked")}>
        Press Me
      </Steam.DialogButton>
    </Steam.Focusable>
  );
}
```

Import prop types for type-safe usage:

```tsx
import { Steam } from "@loadout/ui";
import type { DialogButtonProps } from "@loadout/ui";

const buttonProps: DialogButtonProps = {
  onClick: () => {},
  disabled: false,
  children: "Save",
};
```

### Graceful Degradation

Components may not exist in all SteamOS versions. Always handle missing components:

```tsx
// Check before rendering
if (Steam.has("SliderField")) {
  return <Steam.SliderField nMin={0} nMax={100} nStep={1} />;
}

// Get by name at runtime
const MyComponent = Steam.get("SomeInternalComponent");

// List all available components
const names = Steam.listAll(); // ["DialogButton", "Focusable", ...]
```

## Prop Naming Conventions

Steam uses Hungarian notation for props:

| Prefix | Type | Example |
|--------|------|---------|
| `b` | boolean | `bChecked`, `bInteractableItem` |
| `n` | number | `nMin`, `nMax`, `nProgress` |
| `str` | string | `strOKButtonText`, `strDefaultLabel` |
| `on` | callback | `onActivate`, `onCancel`, `onChange` |
| `rg` | array | `rgOptions` |

Standard React props (`children`, `className`, `style`, `disabled`, `label`) use their normal names.

---

## Component Reference

### Buttons

#### `Steam.DialogButton`

Steam's standard dialog button. Used in modals, settings panels, and toolbars.

```tsx
<Steam.DialogButton onClick={() => doSomething()}>
  Click Me
</Steam.DialogButton>

<Steam.DialogButton disabled={true} className="my-custom-class">
  Disabled Button
</Steam.DialogButton>
```

| Prop | Type | Description |
|------|------|-------------|
| `children` | `ReactNode` | Button label/content |
| `className` | `string` | Additional CSS class |
| `style` | `CSSProperties` | Inline styles |
| `onClick` | `(e: Event) => void` | Click handler |
| `disabled` | `boolean` | Whether the button is disabled |
| `focusOnMount` | `boolean` | Auto-focus on mount |
| `onActivate` | `(e: Event) => void` | Gamepad A button / Enter |

#### `Steam.DialogButtonPrimary`

Primary variant — typically blue/highlighted for the main action. Same props as `DialogButton`.

```tsx
<Steam.DialogButtonPrimary onClick={onSave}>
  Save Changes
</Steam.DialogButtonPrimary>
```

#### `Steam.DialogButtonSecondary`

Secondary variant — typically muted for cancel/back actions. Same props as `DialogButton`.

```tsx
<Steam.DialogButtonSecondary onClick={onCancel}>
  Cancel
</Steam.DialogButtonSecondary>
```

---

### Layout & Focus

#### `Steam.Focusable`

Wrapper that makes children focusable via gamepad/keyboard navigation. This is essential for any interactive content in Big Picture Mode — without it, gamepad users can't navigate to your elements.

```tsx
<Steam.Focusable
  onActivate={() => console.log("A button pressed")}
  onCancel={() => console.log("B button pressed")}
  focusClassName="my-focused-style"
>
  <div>This area is gamepad-navigable</div>
</Steam.Focusable>
```

| Prop | Type | Description |
|------|------|-------------|
| `children` | `ReactNode` | Content to make focusable |
| `className` | `string` | CSS class |
| `style` | `CSSProperties` | Inline styles |
| `onActivate` | `(e: Event) => void` | A button / Enter pressed |
| `onCancel` | `(e: Event) => void` | B button / Escape pressed |
| `focusClassName` | `string` | CSS class when this element has focus |
| `focusWithinClassName` | `string` | CSS class when a descendant has focus |
| `focusable` | `boolean` | Whether this can receive focus (default: `true`) |
| `onFocus` | `(e: Event) => void` | Focus gained |
| `onBlur` | `(e: Event) => void` | Focus lost |
| `onGamepadDirection` | `(e: Event) => void` | Gamepad D-pad direction pressed |

#### `Steam.ScrollPanel`

Scrollable container with gamepad-aware scrolling. Wraps content that may overflow.

```tsx
<Steam.ScrollPanel style={{ maxHeight: 300 }}>
  <div>Long scrollable content here...</div>
</Steam.ScrollPanel>
```

| Prop | Type | Description |
|------|------|-------------|
| `children` | `ReactNode` | Scrollable content |
| `className` | `string` | CSS class |
| `style` | `CSSProperties` | Inline styles |
| `focusable` | `boolean` | Whether the panel is focusable (default: `true`) |
| `scrollable` | `boolean` | Whether scrolling is enabled (default: `true`) |

---

### Form Fields

#### `Steam.SliderField`

Horizontal slider input with label. Used throughout Steam's settings panels.

```tsx
<Steam.SliderField
  label="Volume"
  nMin={0}
  nMax={100}
  nStep={5}
  nValue={75}
  onChange={(value) => setVolume(value)}
/>
```

| Prop | Type | Description |
|------|------|-------------|
| `label` | `string` | Label text above the slider |
| `description` | `string` | Description below the label |
| `nMin` | `number` | Minimum value |
| `nMax` | `number` | Maximum value |
| `nStep` | `number` | Step increment |
| `nValue` | `number` | Current value |
| `onChange` | `(value: number) => void` | Value change handler |
| `disabled` | `boolean` | Whether the field is disabled |
| `className` | `string` | CSS class |

#### `Steam.ToggleField`

Toggle switch with label. Used for boolean settings.

```tsx
<Steam.ToggleField
  label="Enable Notifications"
  bChecked={enabled}
  onChange={(checked) => setEnabled(checked)}
/>
```

| Prop | Type | Description |
|------|------|-------------|
| `label` | `string` | Label text |
| `description` | `string` | Description below the label |
| `bChecked` | `boolean` | Whether the toggle is on |
| `onChange` | `(checked: boolean) => void` | State change handler |
| `disabled` | `boolean` | Whether the field is disabled |
| `className` | `string` | CSS class |

#### `Steam.TextField`

Text input field with label.

```tsx
<Steam.TextField
  label="Username"
  value={name}
  onChange={(e) => setName(e.target.value)}
  placeholder="Enter your name..."
/>
```

| Prop | Type | Description |
|------|------|-------------|
| `label` | `string` | Label text |
| `value` | `string` | Current text value |
| `onChange` | `(e: Event) => void` | Change handler |
| `placeholder` | `string` | Placeholder text |
| `disabled` | `boolean` | Whether the field is disabled |
| `nMaxLength` | `number` | Max input length |
| `bMultiline` | `boolean` | Use a textarea instead of input |
| `className` | `string` | CSS class |

#### `Steam.DropdownField`

Dropdown select field with label.

```tsx
<Steam.DropdownField
  label="Theme"
  strDefaultLabel="Select a theme..."
  rgOptions={[
    { label: "Dark", data: "dark" },
    { label: "Light", data: "light" },
    { label: "System", data: "system" },
  ]}
  selectedOption="dark"
  onChange={(option) => setTheme(option.data)}
/>
```

| Prop | Type | Description |
|------|------|-------------|
| `label` | `string` | Label text |
| `rgOptions` | `DropdownOption[]` | Array of `{ label, data }` options |
| `selectedOption` | `unknown` | Currently selected option's `data` value |
| `strDefaultLabel` | `string` | Placeholder when nothing is selected |
| `onChange` | `(option: DropdownOption) => void` | Selection handler |
| `disabled` | `boolean` | Whether the field is disabled |
| `className` | `string` | CSS class |

---

### Dialogs & Modals

#### `Steam.Dialog`

Container for dialog content with Steam's dialog styling.

```tsx
<Steam.Dialog title="Settings" onCancel={() => closeDialog()}>
  <p>Dialog content here</p>
</Steam.Dialog>
```

| Prop | Type | Description |
|------|------|-------------|
| `children` | `ReactNode` | Dialog content |
| `title` | `string` | Dialog title |
| `onCancel` | `() => void` | Cancel/close handler |
| `className` | `string` | CSS class |
| `style` | `CSSProperties` | Inline styles |

#### `Steam.ConfirmDialog`

Modal confirmation dialog with OK/Cancel buttons.

```tsx
<Steam.ConfirmDialog
  strTitle="Delete Plugin?"
  strDescription="This action cannot be undone."
  strOKButtonText="Delete"
  strCancelButtonText="Keep"
  onOK={() => deletePlugin()}
  onCancel={() => dismiss()}
/>
```

| Prop | Type | Description |
|------|------|-------------|
| `children` | `ReactNode` | Additional content |
| `strTitle` | `string` | Dialog title |
| `strDescription` | `string` | Body text |
| `strOKButtonText` | `string` | OK button text (default: "OK") |
| `strCancelButtonText` | `string` | Cancel button text (default: "Cancel") |
| `onOK` | `() => void` | OK pressed |
| `onCancel` | `() => void` | Cancel pressed |
| `className` | `string` | CSS class |

#### `Steam.ModalRoot`

Root wrapper for modal dialogs. Handles backdrop and focus trapping.

```tsx
<Steam.ModalRoot closeModal={() => setOpen(false)}>
  <Steam.Dialog title="My Modal">
    <p>Modal content</p>
  </Steam.Dialog>
</Steam.ModalRoot>
```

| Prop | Type | Description |
|------|------|-------------|
| `children` | `ReactNode` | Modal content |
| `closeModal` | `() => void` | Close handler |
| `bHideMainWindowForPopouts` | `boolean` | Hide main window for popout modals |
| `className` | `string` | CSS class |

---

### Menus

#### `Steam.Menu`

Context menu container.

```tsx
<Steam.Menu label="Options" onCancel={() => closeMenu()}>
  <Steam.MenuItem onSelected={() => doEdit()}>Edit</Steam.MenuItem>
  <Steam.MenuItem onSelected={() => doDelete()}>Delete</Steam.MenuItem>
</Steam.Menu>
```

| Prop | Type | Description |
|------|------|-------------|
| `children` | `ReactNode` | Menu items |
| `label` | `string` | Menu title |
| `onCancel` | `() => void` | Dismiss handler |
| `cancelText` | `string` | Cancel action text |
| `className` | `string` | CSS class |

#### `Steam.MenuItem`

Individual item within a Menu.

| Prop | Type | Description |
|------|------|-------------|
| `children` | `ReactNode` | Item label/content |
| `onSelected` | `() => void` | Selection handler |
| `bInteractableItem` | `boolean` | Whether the item is interactable (default: `true`) |
| `disabled` | `boolean` | Whether the item is disabled |
| `className` | `string` | CSS class |

#### `Steam.MenuGroup`

Groups related menu items under a label.

```tsx
<Steam.Menu label="Settings">
  <Steam.MenuGroup label="Display">
    <Steam.MenuItem onSelected={() => {}}>Resolution</Steam.MenuItem>
    <Steam.MenuItem onSelected={() => {}}>Brightness</Steam.MenuItem>
  </Steam.MenuGroup>
  <Steam.MenuGroup label="Audio">
    <Steam.MenuItem onSelected={() => {}}>Volume</Steam.MenuItem>
  </Steam.MenuGroup>
</Steam.Menu>
```

| Prop | Type | Description |
|------|------|-------------|
| `children` | `ReactNode` | Grouped menu items |
| `label` | `string` | Group heading |
| `className` | `string` | CSS class |

---

### Navigation

#### `Steam.Tabs`

Tab navigation bar.

```tsx
const [tab, setTab] = useState("general");

<Steam.Tabs activeTab={tab} onShowTab={(id) => setTab(id)}>
  {/* Tab content rendered separately based on activeTab */}
</Steam.Tabs>
```

| Prop | Type | Description |
|------|------|-------------|
| `children` | `ReactNode` | Tab content |
| `activeTab` | `string` | Currently active tab ID |
| `onShowTab` | `(tabId: string) => void` | Tab selection handler |
| `className` | `string` | CSS class |

> **Note:** There is no `Steam.Navigation` component. Steam's route navigation is a singleton API object (not a React component), discovered separately and stored on `globalThis.__LOADOUT_NAVIGATION`. It is exposed through plain function exports from `@loadout/ui`, not the `Steam.*` namespace:
>
> ```tsx
> import { navigate, navigateBack, navigateToPage, closeSideMenus } from "@loadout/ui";
>
> navigate("/library/home"); // Steam route path
> navigateBack();
> ```

---

### Feedback

#### `Steam.ProgressBar`

Horizontal progress bar.

```tsx
<Steam.ProgressBar nProgress={0.65} nTransitionSec={0.3} />
```

| Prop | Type | Description |
|------|------|-------------|
| `nProgress` | `number` | Progress from 0 to 1 |
| `nTransitionSec` | `number` | Animation duration in seconds |
| `className` | `string` | CSS class |

#### `Steam.SteamSpinner`

Steam's native loading spinner animation.

```tsx
<Steam.SteamSpinner size="medium" />
```

| Prop | Type | Description |
|------|------|-------------|
| `size` | `"small" \| "medium" \| "large"` | Spinner size |
| `className` | `string` | CSS class |

---

### Game UI

#### `Steam.GamepadUI`

Top-level GamepadUI component. Generally not used directly by plugins.

| Prop | Type | Description |
|------|------|-------------|
| `GamepadUIDesktop` | `unknown` | Desktop GamepadUI configuration |
| `className` | `string` | CSS class |

---

## SteamClient API

`window.SteamClient` is Steam's native API surface, available inside Steam's own CEF context (the `SharedJSContext` tab), **not** inside the Electrobun overlay. Loadout reaches it over Steam's CEF debug port via CDP. There are two ways to use it:

- **Typed wrapper (preferred, backend-side):** `SteamClient` / `withSteamClient` in `packages/steam-cdp/src/steam-client.ts`. This only wraps the handful of methods Loadout actually consumes — namely `apps.*` (set/clear launch options, add/remove/rename shortcuts, custom artwork, compat tool, user tags, collections, read shortcut/app data) and `url.executeSteamURL` / `url.openWebUrl`. Adding a new method is one new wrapper per Steam call.
- **Raw `window.SteamClient.*`:** evaluated inside the CEF tab (e.g. via the injector or CDP `evaluate`). Used directly in a few places — observed calls in this repo are limited to `SteamClient.Apps.*`, `SteamClient.URL.ExecuteSteamURL`, `SteamClient.GameSessions`, and `SteamClient.System` (e.g. `patch.ts` patches `SteamClient.System.OpenInBrowser`).

The full namespace surface is declared (as `unknown` placeholders) in the `SteamClientAPI` type in `packages/ui/src/steam-types.ts`. As of that type there are **47 namespaces** — listed below as observed at runtime, not an exhaustive or method-level spec:

| Namespace | Namespace | Namespace |
|-----------|-----------|-----------|
| `Apps` | `Auth` | `Broadcast` |
| `Browser` | `BrowserView` | `ClientNotifications` |
| `Cloud` | `CloudStorage` | `CommunityItems` |
| `Compat` | `Console` | `Customization` |
| `Downloads` | `FamilySharing` | `Friends` |
| `FriendSettings` | `GameNotes` | `GameRecording` |
| `GameSessions` | `Input` | `InstallFolder` |
| `Installs` | `MachineStorage` | `Messaging` |
| `Music` | `Notifications` | `OpenVR` |
| `Overlay` | `Parental` | `RemotePlay` |
| `RoamingStorage` | `Screenshots` | `ServerBrowser` |
| `Settings` | `SharedConnection` | `Stats` |
| `SteamChina` | `Storage` | `Streaming` |
| `System` | `UI` | `Updates` |
| `URL` | `User` | `WebChat` |
| `WebUITransport` | `Window` | |

From the backend, use the typed wrapper:

```ts
import { withSteamClient } from "@loadout/steam-cdp";

await withSteamClient(async (sc) => {
  await sc.apps.setAppLaunchOptions(appId, "%command% -foo");
  await sc.url.executeSteamURL(`steam://rungameid/${appId}`);
});
```

`SteamClient` methods throw `SteamClientUnreachableError` when Steam isn't reachable (debug port down, no `SharedJSContext` tab, or the API not yet bound while Steam is still booting), so callers can fall back gracefully.

---

## Discovery Status

Component discovery depends on the Steam client version. Some components may not be found if Steam changes their code patterns. Use `Steam.has()` / `Steam.listAll()` to check availability at runtime.

There is no standalone "components" dev endpoint. To inspect what was discovered, attach to Steam's CEF DevTools and read the global directly — e.g. evaluate `Object.keys(globalThis.__STEAM_COMPONENTS)` in Steam's `SharedJSContext` tab. (The discovery script also POSTs its metadata to the loader at `/api/steam-components/register`, but that is a one-way report, not a browsable list.)
