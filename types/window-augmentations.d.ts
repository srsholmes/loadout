/**
 * Window/globalThis augmentations for the Electrobun host bridge and
 * the vendor/SDK globals shared between the overlay shell and every
 * plugin bundle.
 *
 * Complements `types/window-globals.d.ts` (which covers the
 * cross-React-root services — `__SL_SOUNDS__`, `__SPATIAL_NAV__`, etc.).
 * Kept in a separate file so the Electrobun-specific contract is
 * legible on its own and the loader-side vendor globals don't clutter
 * the shell singletons file.
 *
 * Picked up by `tsc` via `"include": ["types/**\/*.d.ts", ...]` in
 * `tsconfig.json`.
 *
 * @see packages/overlay-electrobun/src/webview/main.tsx (writes __electroview)
 * @see packages/overlay/src/lib/host.ts                (reads __electroview)
 * @see packages/overlay/src/shared-modules.ts          (writes __VENDOR_REACT* + __LOADOUT_SDK)
 * @see packages/loader/src/inject-builder.ts           (emits mirror writes in injected shim)
 * @see packages/injector/src/route-patcher.ts          (registers __LOADOUT_PLUGIN_<id>)
 */

// ---- Electrobun host RPC ---------------------------------------------------

/**
 * Subset of the Electrobun `Electroview` instance the webview stashes
 * on `window.__electroview` at boot. The real type is `Electroview`
 * from `electrobun/view`, but that module only resolves at runtime
 * inside the Electrobun webview process — importing it from the
 * shared React tree would fail under `vite dev`. Typing structurally
 * here means no runtime import is needed at the call site.
 */
interface SteamLoaderElectroview {
  rpc?: {
    /** Map of registered request names → handlers. Each entry returns
     *  whatever the Bun host returned, opaque from the webview side. */
    request?: Record<string, (args?: unknown) => Promise<unknown>>;
    /** Subscribe to Bun → webview push messages by name. */
    addMessageListener?: (
      name: string,
      handler: (payload: unknown) => void,
    ) => void;
    /** Unsubscribe symmetric to `addMessageListener`. May be absent on
     *  older runtimes — call sites use `?.()`. */
    removeMessageListener?: (
      name: string,
      handler: (payload: unknown) => void,
    ) => void;
  };
}

// ---- Vendor React / SDK globals -------------------------------------------
//
// Plugin bundles compile with `react`/`react-dom`/etc. aliased to
// `globalThis.__VENDOR_REACT…` so every bundle shares a single React
// instance with the shell. Typed as `unknown` because the real types
// are `typeof import("react")`, which would force every consumer of
// this `.d.ts` to also have `@types/react` resolved up-front. Consumers
// that need to use the modules go through the normal `react` import
// (which the build rewrites to these globals).

declare global {
  interface Window {
    /** Electroview RPC handle, set by
     *  `packages/overlay-electrobun/src/webview/main.tsx`. */
    __electroview?: SteamLoaderElectroview;
    /** Truthy when the Electrobun runtime is present in this webview. */
    __electrobun?: unknown;

    /** Shared SDK exports (the `@loadout/ui` module surface).
     *  Plugin bundles import `@loadout/ui` aliased to this global
     *  so they share Panel / Button / spatial-nav with the shell. */
    __LOADOUT_SDK?: unknown;

    /** Vendored React shared across the overlay shell + every plugin
     *  bundle so there's exactly one React instance per CEF context.
     *  Real type is `typeof import("react")`; see header note. */
    __VENDOR_REACT?: unknown;
    __VENDOR_REACT_JSX_RUNTIME?: unknown;
    __VENDOR_REACT_JSX_DEV_RUNTIME?: unknown;
    __VENDOR_REACT_DOM?: unknown;
    __VENDOR_REACT_DOM_CLIENT?: unknown;

    /** Per-plugin IIFE bundle, registered by
     *  `packages/injector/src/route-patcher.ts` and the loader-side
     *  shim in `packages/loader/src/inject-builder.ts`. Plugins export
     *  a `{ default?, ... }` module shape, but we keep the contract
     *  loose because plugins can attach anything. */
    [pluginGlobal: `__LOADOUT_PLUGIN_${string}`]: unknown;
  }

  // `interface Window` only types property access through `window.X`.
  // Several call sites read/write through `globalThis.X` (loader-side
  // injector + the vendor shim that runs inside Steam's CEF), so we
  // surface each name on `globalThis` too via `declare var`.
  /** Truthy when the Electrobun runtime is present (webview process only). */
  var __electrobun: unknown | undefined;
  /** Shared SDK exports — mirror of `window.__LOADOUT_SDK`. */
  var __LOADOUT_SDK: unknown;
  var __VENDOR_REACT: unknown;
  var __VENDOR_REACT_JSX_RUNTIME: unknown;
  var __VENDOR_REACT_JSX_DEV_RUNTIME: unknown;
  var __VENDOR_REACT_DOM: unknown;
  var __VENDOR_REACT_DOM_CLIENT: unknown;

  /**
   * Vite HMR API — present in dev (`vite dev`), undefined in the prod
   * Electrobun bundle. Needed because `webview/main.tsx` reads
   * `import.meta.hot` to register a dispose hook for the keystroke
   * dispatcher. `@types/vite` would also provide this but only if Vite
   * is in the TS rootDir, which it isn't for the workspace tsconfig.
   */
  interface ImportMeta {
    hot?: {
      dispose: (cb: () => void) => void;
    };
  }
}

export {};
