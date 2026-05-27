/**
 * Ambient typings for the window-attached singletons the overlay shell
 * uses to share state across React roots and plugin bundles.
 *
 * Each plugin bundle has its own module scope, so a module-level
 * singleton would collide. Instead the shell registers each cross-tree
 * service on `window` once at startup (`packages/overlay/src/shared-modules.ts`)
 * and every consumer pulls it back off via these typed slots.
 *
 * All fields are optional because consumers may run before the shell
 * registers them (e.g. very first React render) and must null-check.
 */

/** Methods the sound engine exposes — every one optional so a custom pack can omit any. */
interface SoundEngine {
  getSoundVolume?: () => number;
  playNav?: () => void;
  playSelect?: () => void;
  playBack?: () => void;
  playToggleOn?: () => void;
  playToggleOff?: () => void;
  playSliderTick?: () => void;
  playError?: () => void;
  playSideMenuIn?: () => void;
  playSideMenuOut?: () => void;
  playTabTransition?: () => void;
}

/**
 * Minimal facade for the norigin SpatialNavigation singleton — only
 * the surface the overlay actually pokes through the `__SPATIAL_NAV__`
 * window slot. The full type lives in
 * `@noriginmedia/norigin-spatial-navigation-core` but isn't re-exported,
 * so we type the bits we use.
 */
interface SpatialNavBridge {
  setFocus: (key: string, details?: object) => void;
  getCurrentFocusKey: () => string;
  navigateByDirection: (direction: string, details: object) => void;
  pause: () => void;
  resume: () => void;
  updateAllLayouts: () => void;
  destroy: () => void;
  addFocusable: (component: object) => void;
  updateFocusable: (key: string, payload: object) => void;
  removeFocusable: (payload: { focusKey: string }) => void;
  focusableComponents?: Record<string, { parentFocusKey: string }>;
}

/** Back-button interceptor — returns true to consume the press. */
type BackInterceptorFn = () => boolean;

declare global {
  interface Window {
    /** Active sound engine — swapped by the sound-loader plugin when packs change. */
    __SL_SOUNDS__?: SoundEngine;
    /** The shell's first-seen sound module, captured by sound-loader so it can restore defaults. */
    __SL_ORIGINAL_SOUNDS__?: SoundEngine;
    /** Norigin spatial-nav singleton, registered by `shared-modules.ts`. */
    __SPATIAL_NAV__?: SpatialNavBridge;
    /** Session token from the loader — set by `initBackend()`, read by the WS client. */
    __LOADOUT_TOKEN__?: string;
    /** Monotonic id counter for `useFocusable` keys — shared across plugin bundles. */
    __SL_FOCUS_ID__?: number;
    /** LIFO stack of back-button interceptors (modals, dropdowns, lightboxes). */
    __SL_BACK_INTERCEPTORS__?: BackInterceptorFn[];
  }
}

export {};
