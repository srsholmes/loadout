/**
 * One-time bootstrap of the shared spatial-navigation singleton.
 *
 * The shell uses `@noriginmedia/norigin-spatial-navigation` directly; plugin
 * bundles reach the same singleton via `window.__LOADOUT_SPATIAL_NAV`. The
 * singleton internally is the library's module-level state, so all we need to
 * do is expose its imperative API on a window key for plugin proxies to call.
 */
import {
  init,
  setFocus,
  getCurrentFocusKey,
  navigateByDirection,
  pause,
  resume,
  updateAllLayouts,
  destroy,
} from "@noriginmedia/norigin-spatial-navigation";

let installed = false;

interface NavInternals {
  addFocusable(opts: unknown): void;
  removeFocusable(opts: { focusKey: string }): void;
  updateFocusable(focusKey: string, opts: unknown): void;
}

declare const globalThis: {
  SpatialNavigation?: NavInternals;
} & typeof window;

export function installSpatialNav(): void {
  if (installed) return;
  installed = true;
  init({ debug: false, visualDebug: false, shouldFocusDOMNode: true, throttle: 100 });

  // Norigin v3 exposes its singleton on globalThis.SpatialNavigation. The
  // imperative API exported above (setFocus, navigateByDirection...) goes
  // through that same singleton, so wrapping them here makes the plugin
  // proxy in @loadout/ui call the exact same backing functions.
  const internals = (globalThis.SpatialNavigation ?? {}) as NavInternals;

  window.__LOADOUT_SPATIAL_NAV = {
    addFocusable: (opts) => internals.addFocusable?.(opts),
    removeFocusable: (opts) => internals.removeFocusable?.(opts),
    updateFocusable: (key, opts) => internals.updateFocusable?.(key, opts),
    setFocus,
    getCurrentFocusKey,
    navigateByDirection,
    pause,
    resume,
    updateAllLayouts,
    destroy,
  };
}
