/**
 * Spatial navigation hook. Consumer-React hooks register with a SHARED
 * SpatialNavigation singleton on `window.__LOADOUT_SPATIAL_NAV` so plugins
 * loaded as separate React roots still navigate together via the shell.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

export interface FocusableLayout {
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

export interface UseFocusableConfig {
  focusable?: boolean;
  saveLastFocusedChild?: boolean;
  trackChildren?: boolean;
  autoRestoreFocus?: boolean;
  forceFocus?: boolean;
  isFocusBoundary?: boolean;
  focusBoundaryDirections?: string[];
  focusKey?: string;
  preferredChildFocusKey?: string;
  onEnterPress?: (details?: FocusDetails) => void;
  onEnterRelease?: () => void;
  onArrowPress?: (direction: string, details?: FocusDetails) => boolean;
  onArrowRelease?: (direction: string) => void;
  onFocus?: (layout: FocusableLayout, details?: FocusDetails) => void;
  onBlur?: (layout: FocusableLayout, details?: FocusDetails) => void;
}

export interface UseFocusableResult<T extends HTMLElement = HTMLElement> {
  // Cast as non-null for JSX `ref={ref}` compatibility — useRef<T>(null) returns
  // RefObject<T | null>, which TS won't accept for the `ref` prop expecting
  // RefObject<T>. The current value is null until React attaches the node.
  ref: RefObject<T>;
  focusSelf: (details?: object) => void;
  focused: boolean;
  hasFocusedChild: boolean;
  focusKey: string;
}

const ROOT_FOCUS_KEY = "LOADOUT:ROOT";
const noop = () => {};
const noopArrow = () => true;

function uniqueId(prefix: string): string {
  if (typeof window === "undefined") return `${prefix}server`;
  window.__LOADOUT_FOCUS_ID__ = (window.__LOADOUT_FOCUS_ID__ ?? 0) + 1;
  return `${prefix}${window.__LOADOUT_FOCUS_ID__}`;
}

function getNav() {
  return typeof window !== "undefined" ? (window.__LOADOUT_SPATIAL_NAV ?? null) : null;
}

export const FocusContext = createContext<string>(ROOT_FOCUS_KEY);
FocusContext.displayName = "FocusContext";

export function useFocusable<T extends HTMLElement = HTMLElement>(
  config: UseFocusableConfig = {},
): UseFocusableResult<T> {
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
    onArrowPress = noopArrow,
    onArrowRelease = noop,
    onFocus = noop,
    onBlur = noop,
  } = config;

  const ref = useRef<T>(null as unknown as T);
  const [focused, setFocused] = useState(false);
  const [hasFocusedChild, setHasFocusedChild] = useState(false);
  const parentFocusKey = useContext(FocusContext);

  const focusKey = useMemo(
    () => propFocusKey || uniqueId("loadout:focus-"),
    [propFocusKey],
  );

  const onEnterPressHandler = useCallback(
    (details?: FocusDetails) => onEnterPress(details),
    [onEnterPress],
  );
  const onEnterReleaseHandler = useCallback(() => onEnterRelease(), [onEnterRelease]);
  const onArrowPressHandler = useCallback(
    (direction: string, details?: FocusDetails) => onArrowPress(direction, details),
    [onArrowPress],
  );
  const onArrowReleaseHandler = useCallback(
    (direction: string) => onArrowRelease(direction),
    [onArrowRelease],
  );
  const onFocusHandler = useCallback(
    (layout: FocusableLayout, details?: FocusDetails) => {
      layout.node?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
      onFocus(layout, details);
    },
    [onFocus],
  );
  const onBlurHandler = useCallback(
    (layout: FocusableLayout, details?: FocusDetails) => onBlur(layout, details),
    [onBlur],
  );

  const focusSelf = useCallback(
    (details: object = {}) => getNav()?.setFocus(focusKey, details),
    [focusKey],
  );

  useEffect(() => {
    const nav = getNav();
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
    const onPointerDown = () => {
      if (nav && focusable) nav.setFocus(focusKey);
    };
    node?.addEventListener("pointerdown", onPointerDown);
    return () => {
      node?.removeEventListener("pointerdown", onPointerDown);
      nav?.removeFocusable({ focusKey });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const nav = getNav();
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

export function setFocus(key: string, details?: object) {
  getNav()?.setFocus(key, details);
}
export function getCurrentFocusKey(): string {
  return getNav()?.getCurrentFocusKey() ?? "";
}
export function navigateByDirection(direction: string, details?: object) {
  getNav()?.navigateByDirection(direction, details ?? {});
}
export function pauseNav() {
  getNav()?.pause();
}
export function resumeNav() {
  getNav()?.resume();
}

// ---- Back interceptor stack -----------------------------------------------

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
