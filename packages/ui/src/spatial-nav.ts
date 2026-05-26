/**
 * Spatial navigation re-export.
 *
 * `@loadout/ui` is bundled once by the shell (via Vite) and exposed on
 * `window.__LOADOUT_UI`. Plugin bundles compiled by the server have their
 * `@loadout/ui` imports rewritten to that global, so every plugin shares
 * the shell's bundled copy of `@noriginmedia/norigin-spatial-navigation`
 * — which means a single `SpatialNavigation` singleton, and one focus
 * tree across every React root in the overlay.
 *
 * No custom hook, no `window.__LOADOUT_SPATIAL_NAV` proxy. The shell calls
 * `init()` once during boot; everything else is library default.
 */
export {
  useFocusable,
  FocusContext,
} from "@noriginmedia/norigin-spatial-navigation";
export {
  init,
  setFocus,
  getCurrentFocusKey,
  navigateByDirection,
  pause as pauseNav,
  resume as resumeNav,
  updateAllLayouts,
  destroy as destroyNav,
  doesFocusableExist,
  setKeyMap,
  setThrottle,
  updateRtl,
  ROOT_FOCUS_KEY,
  SpatialNavigation,
} from "@noriginmedia/norigin-spatial-navigation";

// ---- Back interceptor stack ------------------------------------------------
//
// Modal-style components (dropdowns, lightboxes) push an interceptor that
// runs when the user presses B/Escape. If the interceptor returns true,
// the shell's default back handler is suppressed for that press. LIFO so
// the most recently opened modal handles back first.

export type BackInterceptor = () => boolean;

function getBackStack(): BackInterceptor[] {
  if (typeof window === "undefined") return [];
  if (!window.__LOADOUT_BACK_INTERCEPTORS__) window.__LOADOUT_BACK_INTERCEPTORS__ = [];
  return window.__LOADOUT_BACK_INTERCEPTORS__;
}

export function pushBackInterceptor(fn: BackInterceptor): () => void {
  const stack = getBackStack();
  stack.push(fn);
  return () => {
    const i = stack.indexOf(fn);
    if (i >= 0) stack.splice(i, 1);
  };
}

export function tryRunBackInterceptor(): boolean {
  const stack = getBackStack();
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]()) return true;
  }
  return false;
}
