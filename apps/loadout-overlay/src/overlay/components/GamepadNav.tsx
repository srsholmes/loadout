/**
 * Gamepad / spatial navigation via @noriginmedia/norigin-spatial-navigation.
 *
 * Plugin authors wrap interactive elements with useFocusable() to make them
 * d-pad navigable. The library handles spatial focus, scrolling, and zones.
 */
import { useEffect, useCallback, type ReactNode, type CSSProperties } from "react";
import {
  init,
  useFocusable,
  FocusContext,
  setFocus,
  getCurrentFocusKey,
} from "@noriginmedia/norigin-spatial-navigation";
import { useGamepadInput } from "../hooks/useGamepadInput";
import { tryRunBackInterceptor } from "@loadout/ui";
const sounds = () => window.__SL_SOUNDS__;

export type { FocusableComponentLayout, FocusDetails } from "@noriginmedia/norigin-spatial-navigation";
export { useFocusable, FocusContext, setFocus, getCurrentFocusKey };

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

/**
 * Run the back chain. First consults the shared `BackInterceptor` stack
 * (used by modals/dropdowns/lightboxes to consume the B-button), then
 * falls back to the shell-provided `onBack` handler.
 */
function runBack(onBack?: () => void): void {
  if (tryRunBackInterceptor()) return;
  if (onBack) {
    sounds()?.playBack?.();
    onBack();
  }
}

export function GamepadNavProvider({ children, onBack }: { children: ReactNode; onBack?: () => void }) {
  const { ref, focusKey, focusSelf } = useFocusable({
    isFocusBoundary: false,
    trackChildren: true,
    saveLastFocusedChild: true,
  });

  // Poll gamepad — B button runs the back chain (interceptors → onBack)
  const handleBack = useCallback(() => {
    runBack(onBack);
  }, [onBack]);

  useGamepadInput(handleBack);

  // Listen for Escape key — the Rust evdev layer injects Escape for the B button.
  // The Gamepad API also handles B via useGamepadInput, but this catches both paths.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        runBack(onBack);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onBack]);

  useEffect(() => {
    focusSelf();
  }, [focusSelf]);

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="contents">
        {children}
      </div>
    </FocusContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Focusable wrapper component
// ---------------------------------------------------------------------------

export interface FocusableProps {
  children: ReactNode;
  onActivate?: () => void;
  /** Optional fixed focus key — useful for setFocus() targeting. */
  focusKey?: string;
  /** Override default arrow handling. Return false to suppress default nav. */
  onArrowPress?: (direction: "up" | "down" | "left" | "right") => boolean;
  style?: CSSProperties;
  className?: string;
}

/**
 * Wraps children in a d-pad-navigable container.
 * Shows a focus ring when focused. Calls onActivate on Enter/A button.
 */
export function Focusable({ children, onActivate, focusKey, onArrowPress, style, className }: FocusableProps) {
  const { ref, focused } = useFocusable({
    focusKey,
    onEnterPress: () => {
      sounds()?.playSelect?.();
      onActivate?.();
    },
    onFocus: () => {
      sounds()?.playNav?.();
    },
    onArrowPress: onArrowPress
      ? (direction: string) => onArrowPress(direction as "up" | "down" | "left" | "right")
      : undefined,
  });

  // Auto-scroll focused element into view for d-pad navigation in long lists
  useEffect(() => {
    if (focused && ref.current) {
      ref.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [focused, ref]);

  const focusStyle: CSSProperties = focused
    ? { ...style, animation: "focusPulse 2s ease-in-out infinite" }
    : { ...style, animation: "none", boxShadow: "none" };

  return (
    <div
      ref={ref}
      tabIndex={-1}
      className={`${className ?? ""} rounded-lg transition-all duration-150 ease-out ${focused ? "scale-[1.02]" : ""}`}
      style={focusStyle}
    >
      {children}
    </div>
  );
}
