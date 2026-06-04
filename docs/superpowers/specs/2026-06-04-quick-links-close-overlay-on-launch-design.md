# Quick Links — close the overlay when a link opens

**Date:** 2026-06-04
**Plugins/packages:** `packages/ui` (new SDK export), `plugins/quick-links` (call site)
**Status:** Approved design, pending implementation plan

## Problem

When the user opens a link from Quick Links (a landing-page chip or a home-widget
chip), the link launches in their browser but the Loadout overlay stays on top.
The user has to dismiss the overlay manually. The overlay should close itself once
a link successfully opens.

## Decisions (locked)

1. **Mechanism:** add a sanctioned `hideOverlay()` to the plugin SDK (`@loadout/ui`)
   and call it from the plugin. (Not a quick-links-local global poke.)
2. **Trigger:** close **only on a successful launch** (`launchUrl` →
   `{ launched: true }`). On `not-installed` / error, keep the overlay open so the
   user sees the toast and can fix it.

## Mechanism (confirmed)

Plugins are mounted into the overlay's webview document (PluginHost mounts each
plugin bundle into a div, same document) and resolve `@loadout/ui` to the shell's
shared instance (`globalThis.__LOADOUT_SDK`). The Electrobun host installs its RPC
bridge at `globalThis.__electroview.rpc.request.*`; the overlay's own
`@overlay/lib/host` shim already calls `…request.hide()` to hide the window
(routes to the Bun host's `toggleOverlay("rpc:hide")` — the same path the wake
button uses). So a plugin can hide the overlay through that same global at runtime.

## Design

### 1. `@loadout/ui` gains `hideOverlay()`

New file `packages/ui/src/host.ts`:

```ts
declare global {
  // Installed by the Electrobun webview host. Absent in standalone dev / tests.
  // eslint-disable-next-line no-var
  var __electroview:
    | { rpc?: { request?: Record<string, (args?: unknown) => Promise<unknown>> } }
    | undefined;
}

/** Ask the Electrobun overlay host to hide the overlay window. No-ops
 *  safely outside the overlay webview (standalone dev, unit tests). */
export async function hideOverlay(): Promise<void> {
  const hide = globalThis.__electroview?.rpc?.request?.hide;
  if (typeof hide === "function") await hide();
}
```

Exported from `packages/ui/src/index.ts`. Mirrors the existing `@overlay/lib/host`
shim; uses `globalThis` (CEF `window === globalThis`) so it is also safe in the
non-DOM bun test environment. Runtime-guarded: a missing transport is a no-op.

### 2. Call site — `useLinkLauncher` in `plugins/quick-links/app.tsx`

`useLinkLauncher` is the single chokepoint both the landing chips and the home
widget use to open a URL. On the success path only:

```ts
if (result.launched) {
  void hideOverlay().catch(() => {});
  return;
}
```

The `not-installed` branch and the `catch` error branch are unchanged — the overlay
stays open on failure. Import `hideOverlay` from `@loadout/ui`.

## Data flow

plugin webview (`useLinkLauncher`) → `hideOverlay()` → `globalThis.__electroview.rpc.request.hide()`
→ Bun host `toggleOverlay("rpc:hide")` → overlay window hidden.

## Error handling

`hideOverlay()` is fire-and-forget with `.catch(() => {})` (matches the file's
idiom). Outside the overlay (no `__electroview`) it is a silent no-op.

## Testing

- **`packages/ui` unit test** (`packages/ui/src/host.spec.tsx`, runs under `test:ui`
  with happy-dom): `hideOverlay()` invokes the host's `hide` when
  `globalThis.__electroview.rpc.request.hide` exists; no-ops without throwing when
  `__electroview` is absent.
- **quick-links** (`plugins/quick-links/app.spec.tsx`): extend the `@loadout/ui`
  mock with a `hideOverlay` spy; assert it is called after a successful `launchUrl`
  (a landing chip click resolves `{ launched: true }`) and **not** called when
  `launchUrl` resolves `{ launched: false }`.

## Out of scope

- Backend / RPC / storage changes.
- Changing what "hide" does on the host side (reuses the existing `hide` RPC).
- Closing the overlay from any other plugin (the SDK function is reusable, but only
  quick-links wires it up here).
