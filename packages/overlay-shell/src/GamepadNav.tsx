import { useCallback, useEffect, type ReactNode } from "react";
import {
  useFocusable,
  FocusContext,
} from "@noriginmedia/norigin-spatial-navigation";
import { tryRunBackInterceptor } from "@loadout/ui";

/**
 * Wraps the shell tree with the root focus boundary. Listens for Escape
 * (Bun-side evdev relays the B button as Escape) and runs the back chain.
 */
export function GamepadNavProvider({
  children,
  onBack,
}: {
  children: ReactNode;
  onBack?: () => void;
}) {
  const { ref, focusKey, focusSelf } = useFocusable({
    isFocusBoundary: false,
    trackChildren: true,
    saveLastFocusedChild: true,
  });

  const handleBack = useCallback(() => {
    if (tryRunBackInterceptor()) return;
    onBack?.();
  }, [onBack]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        handleBack();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleBack]);

  useEffect(() => {
    focusSelf();
  }, [focusSelf]);

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref as unknown as React.RefObject<HTMLDivElement>} className="contents">
        {children}
      </div>
    </FocusContext.Provider>
  );
}
