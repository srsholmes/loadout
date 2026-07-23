/**
 * Custom spatial navigation hook for the plugin architecture.
 *
 * Uses the consumer's LOCAL React (no cross-root hook issues) but
 * registers with the SHELL's SpatialNavigation singleton via
 * window.__SPATIAL_NAV__ so all focusable elements share one focus tree.
 *
 * This is a reimplementation of norigin-spatial-navigation-react's
 * useFocusable hook (~100 lines) with two key differences:
 *   1. React hooks come from `import "react"` (consumer's React)
 *   2. Registration goes to the shell's singleton via window global
 */
import {
  createContext,
  useContext,
  useCallback,
  useRef,
  useState,
  useMemo,
  useEffect,
  type RefObject,
} from "react";

// ---- Types (mirroring norigin's public API) ----

export interface FocusableComponentLayout {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  x: number;
  y: number;
  node: HTMLElement;
}

export interface FocusDetails {
  event?: KeyboardEvent;
}

interface UseFocusableConfig {
  focusable?: boolean;
  saveLastFocusedChild?: boolean;
  trackChildren?: boolean;
  autoRestoreFocus?: boolean;
  forceFocus?: boolean;
  isFocusBoundary?: boolean;
  focusBoundaryDirections?: string[];
  focusKey?: string;
  preferredChildFocusKey?: string;
  onEnterPress?: (props?: object, details?: FocusDetails) => void;
  onEnterRelease?: (props?: object) => void;
  onArrowPress?: (direction: string, props?: object, details?: FocusDetails) => boolean;
  onArrowRelease?: (direction: string, props?: object) => void;
  onFocus?: (layout: FocusableComponentLayout, props?: object, details?: FocusDetails) => void;
  onBlur?: (layout: FocusableComponentLayout, props?: object, details?: FocusDetails) => void;
  extraProps?: object;
}

interface UseFocusableResult {
  ref: RefObject<any>;
  focusSelf: (focusDetails?: object) => void;
  focused: boolean;
  hasFocusedChild: boolean;
  focusKey: string;
}

// ---- Internals ----

const ROOT_FOCUS_KEY = "SN:ROOT";
const noop = () => {};

// Global counter on window so all plugin bundles share one sequence
// (each bundle gets its own module scope, so a module-level var would collide)
function uniqueId(prefix: string): string {
  window.__SL_FOCUS_ID__ = (window.__SL_FOCUS_ID__ ?? 0) + 1;
  return `${prefix}${window.__SL_FOCUS_ID__}`;
}

/** Get the shell's SpatialNavigation singleton, or null if unavailable. */
function getSpatialNav(): NonNullable<Window["__SPATIAL_NAV__"]> | null {
  return typeof window !== "undefined" ? window.__SPATIAL_NAV__ ?? null : null;
}

// ---- Public API ----

/**
 * FocusContext created with the consumer's React.createContext.
 * Passes parentFocusKey down the component tree within a single React root.
 */
export const FocusContext = createContext<string>(ROOT_FOCUS_KEY);
FocusContext.displayName = "FocusContext";

/**
 * Custom useFocusable hook.
 *
 * React hooks (useState, useEffect, etc.) come from the consumer's React.
 * Registration calls go to window.__SPATIAL_NAV__ (shell's singleton).
 */
export function useFocusable(config: UseFocusableConfig = {}): UseFocusableResult {
  const {
    focusable = true,
    saveLastFocusedChild = true,
    trackChildren = false,
    autoRestoreFocus = true,
    forceFocus = false,
    isFocusBoundary = false,
    focusBoundaryDirections,
    focusKey: propFocusKey,
    preferredChildFocusKey,
    onEnterPress = noop,
    onEnterRelease = noop,
    onArrowPress = () => true,
    onArrowRelease = noop,
    onFocus = noop,
    onBlur = noop,
    extraProps,
  } = config;

  // Stable callbacks that forward to the latest props
  const onEnterPressHandler = useCallback(
    (details?: FocusDetails) => onEnterPress(extraProps, details),
    [onEnterPress, extraProps],
  );
  const onEnterReleaseHandler = useCallback(
    () => onEnterRelease(extraProps),
    [onEnterRelease, extraProps],
  );
  const onArrowPressHandler = useCallback(
    (direction: string, details?: FocusDetails) => onArrowPress(direction, extraProps, details),
    [extraProps, onArrowPress],
  );
  const onArrowReleaseHandler = useCallback(
    (direction: string) => onArrowRelease(direction, extraProps),
    [onArrowRelease, extraProps],
  );
  const onFocusHandler = useCallback(
    (layout: FocusableComponentLayout, details?: FocusDetails) => {
      // Play navigate sound via shell's sound engine
      window.__SL_SOUNDS__?.playNav?.();
      // Auto-scroll focused element into view for d-pad navigation in long lists
      layout.node?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
      onFocus(layout, extraProps, details);
    },
    [extraProps, onFocus],
  );
  const onBlurHandler = useCallback(
    (layout: FocusableComponentLayout, details?: FocusDetails) => onBlur(layout, extraProps, details),
    [extraProps, onBlur],
  );

  const ref = useRef<any>(null);
  const [focused, setFocused] = useState(false);
  const [hasFocusedChild, setHasFocusedChild] = useState(false);
  const parentFocusKey = useContext(FocusContext);

  const focusKey = useMemo(
    () => propFocusKey || uniqueId("sl:focus-"),
    [propFocusKey],
  );

  const focusSelf = useCallback(
    (focusDetails: object = {}) => {
      getSpatialNav()?.setFocus(focusKey, focusDetails);
    },
    [focusKey],
  );

  // Mount: register with the shell's singleton
  useEffect(() => {
    const nav = getSpatialNav();
    const node = ref.current;

    if (nav) {
      nav.addFocusable({
        focusKey,
        node,
        parentFocusKey,
        preferredChildFocusKey,
        onEnterPress: onEnterPressHandler,
        onEnterRelease: onEnterReleaseHandler,
        onArrowPress: onArrowPressHandler,
        onArrowRelease: onArrowReleaseHandler,
        onFocus: onFocusHandler,
        onBlur: onBlurHandler,
        onUpdateFocus: (isFocused: boolean = false) => setFocused(isFocused),
        onUpdateHasFocusedChild: (isFocused: boolean = false) => setHasFocusedChild(isFocused),
        saveLastFocusedChild,
        trackChildren,
        isFocusBoundary,
        focusBoundaryDirections,
        autoRestoreFocus,
        forceFocus,
        focusable,
      });
    }

    // Sync focus on pointer interaction so the focus ring follows the mouse/touch.
    // Use pointerdown (not click) to sync before drag on range inputs.
    const handlePointerDown = () => {
      if (nav && focusable) nav.setFocus(focusKey);
    };
    node?.addEventListener("pointerdown", handlePointerDown);

    return () => {
      node?.removeEventListener("pointerdown", handlePointerDown);
      nav?.removeFocusable({ focusKey });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Update: sync changed props to the singleton
  useEffect(() => {
    const nav = getSpatialNav();
    if (!nav) return;

    nav.updateFocusable(focusKey, {
      node: ref.current,
      preferredChildFocusKey,
      focusable,
      isFocusBoundary,
      focusBoundaryDirections,
      onEnterPress: onEnterPressHandler,
      onEnterRelease: onEnterReleaseHandler,
      onArrowPress: onArrowPressHandler,
      onArrowRelease: onArrowReleaseHandler,
      onFocus: onFocusHandler,
      onBlur: onBlurHandler,
    });
  }, [
    focusKey,
    preferredChildFocusKey,
    focusable,
    isFocusBoundary,
    focusBoundaryDirections,
    onEnterPressHandler,
    onEnterReleaseHandler,
    onArrowPressHandler,
    onArrowReleaseHandler,
    onFocusHandler,
    onBlurHandler,
  ]);

  return { ref, focusSelf, focused, hasFocusedChild, focusKey };
}

// ---- Imperative helpers (proxied to the shell's singleton) ----

export function setFocus(key: string, details?: object) {
  getSpatialNav()?.setFocus(key, details);
}

export function getCurrentFocusKey(): string {
  return getSpatialNav()?.getCurrentFocusKey() ?? "";
}

export function navigateByDirection(direction: string, details?: object) {
  getSpatialNav()?.navigateByDirection(direction, details ?? {});
}

// The four helpers below have no in-repo callers today, but they complete the
// norigin-spatial-navigation API surface this module mirrors, and out-of-tree
// plugins can reach them via the `@loadout/ui/spatial-nav` subpath (plugin
// code is bundled from source at runtime). @public keeps knip from flagging
// them as dead exports.

/** @public */
export function pause() { getSpatialNav()?.pause(); }
/** @public */
export function resume() { getSpatialNav()?.resume(); }
/** @public */
export function updateAllLayouts() { getSpatialNav()?.updateAllLayouts(); }
/** @public */
export function destroy() { getSpatialNav()?.destroy(); }

// ---- Back interceptor stack -------------------------------------------------
//
// Modal-style components (dropdowns, lightboxes) can push an interceptor that
// runs when the user presses B/Escape. If the interceptor returns true, the
// shell's default back handler is suppressed for that press. The stack is LIFO
// so the most recently opened modal handles the back first.

export type BackInterceptor = () => boolean;

function getBackStack(): BackInterceptor[] {
  if (!window.__SL_BACK_INTERCEPTORS__) window.__SL_BACK_INTERCEPTORS__ = [];
  return window.__SL_BACK_INTERCEPTORS__;
}

export function pushBackInterceptor(fn: BackInterceptor): () => void {
  const stack = getBackStack();
  stack.push(fn);
  return () => {
    const i = stack.indexOf(fn);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** Run the back chain. Returns true if a modal interceptor consumed the event. */
export function tryRunBackInterceptor(): boolean {
  const stack = getBackStack();
  for (let i = stack.length - 1; i >= 0; i--) {
    // i iterates within stack bounds; the guard only degrades a torn stack.
    const fn = stack[i];
    if (fn && fn()) return true;
  }
  return false;
}
