/**
 * Gamepad / spatial navigation via @noriginmedia/norigin-spatial-navigation.
 *
 * Plugin authors wrap interactive elements with useFocusable() to make them
 * d-pad navigable. The library handles spatial focus, scrolling, and zones.
 */
import { useEffect, useState, useCallback, type ReactNode, type CSSProperties } from "react";
import {
  init,
  useFocusable,
  FocusContext,
  setFocus,
  getCurrentFocusKey,
  SpatialNavigation,
} from "@noriginmedia/norigin-spatial-navigation";
import { colors } from "./styles";

export type { FocusableComponentLayout, FocusDetails } from "@noriginmedia/norigin-spatial-navigation";
export { useFocusable, FocusContext };

// Initialize the spatial navigation service.
// shouldFocusDOMNode: true makes it call .focus() on the real DOM element
// so :focus-visible CSS and native input behavior work.
init({
  debug: false,
  visualDebug: false,
  shouldFocusDOMNode: true,
  throttle: 100,
});

// ---------------------------------------------------------------------------
// Root provider
// ---------------------------------------------------------------------------

export function GamepadNavProvider({ children }: { children: ReactNode }) {
  const { ref, focusKey, focusSelf } = useFocusable({
    isFocusBoundary: false,
    trackChildren: true,
    saveLastFocusedChild: true,
  });

  useEffect(() => {
    focusSelf();
  }, [focusSelf]);

  // B button (Escape): if focus is inside plugin content, go back to
  // sidebar. If already in sidebar (or root), hide the overlay.
  useEffect(() => {
    function isInsideZone(zone: string): boolean {
      let key = getCurrentFocusKey();
      const components = (SpatialNavigation as any).focusableComponents;
      // Walk up the parent chain looking for the zone
      for (let i = 0; i < 20; i++) { // guard against infinite loop
        if (!key || key === "SN:ROOT") break;
        if (key === zone) return true;
        const comp = components?.[key];
        if (!comp) break;
        key = comp.parentFocusKey;
      }
      return false;
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (isInsideZone("content")) {
          setFocus("sidebar");
        } else {
          document.title = "__HIDE_OVERLAY__";
          setTimeout(() => { document.title = "Loadout"; }, 100);
        }
      }
    }
    // Use capture phase to run before any other Escape handlers
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} style={{ display: "contents" }}>
        {children}
      </div>
    </FocusContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Legacy useGamepadNav (for components that used registerZone)
// ---------------------------------------------------------------------------

export function useGamepadNav() {
  const result = useFocusable({
    trackChildren: true,
    saveLastFocusedChild: true,
  });
  return {
    ref: result.ref,
    focusKey: result.focusKey,
    focusSelf: result.focusSelf,
    focused: result.focused,
    hasFocusedChild: result.hasFocusedChild,
    // Shims for old API — registerZone is now a no-op since norigin
    // handles zones via FocusContext parent/child tree.
    registerZone: (_zone: string, _el: HTMLElement | null) => {},
    setActiveZone: (_zone: string) => {},
  };
}

// ---------------------------------------------------------------------------
// Focusable wrapper component
// ---------------------------------------------------------------------------

export interface FocusableProps {
  children: ReactNode;
  onActivate?: () => void;
  style?: CSSProperties;
  className?: string;
}

/**
 * Wraps children in a d-pad-navigable container.
 * Shows a focus ring when focused. Calls onActivate on Enter/A button.
 */
export function Focusable({ children, onActivate, style, className }: FocusableProps) {
  const { ref, focused } = useFocusable({
    onEnterPress: () => onActivate?.(),
  });

  return (
    <div
      ref={ref}
      tabIndex={-1}
      className={className}
      style={{
        ...style,
        outline: focused ? `3px solid ${colors.accent}` : "none",
        outlineOffset: focused ? 2 : 0,
      }}
    >
      {children}
    </div>
  );
}
