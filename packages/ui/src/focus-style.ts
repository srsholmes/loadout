import type { CSSProperties } from "react";

/**
 * Shared focus-ring styling for interactive components. Centralises what
 * used to be a copy-pasted "focusPulse animation + scale-[1.02]" pair on
 * every focusable component.
 */

const PULSE_ANIMATION = "focusPulse 2s ease-in-out infinite";

export function focusScaleClass(focused: boolean, amount = "1.02"): string {
  return focused ? `scale-[${amount}]` : "";
}

export function applyFocusPulse(
  focused: boolean,
  base: CSSProperties | undefined = undefined,
): CSSProperties | undefined {
  if (!focused) return base;
  return { ...(base ?? {}), animation: PULSE_ANIMATION };
}
