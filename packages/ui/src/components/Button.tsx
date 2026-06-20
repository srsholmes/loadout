import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { useFocusable } from "../spatial-nav";

export type ButtonVariant =
  | "default"
  | "neutral"
  | "primary"
  | "secondary"
  | "accent"
  | "info"
  | "success"
  | "warning"
  | "error"
  | "danger";

export type ButtonSize = "sm" | "md";

export function Button({
  children,
  variant = "default",
  size = "md",
  fullWidth = false,
  onClick,
  disabled,
  style,
}: {
  children: ReactNode;
  variant?: ButtonVariant;
  /**
   * `"md"` (default) is the standard 44px touch-target button. `"sm"` is a
   * ~32px DaisyUI `btn-sm` for compact rows where a full 44px button would
   * be visually heavy — replaces the old `chip` / `btn-sm` plugin callsites.
   */
  size?: ButtonSize;
  /**
   * Stretch the button to fill its container's width. Used by the game-card
   * tiles (store-bridge, recomp, LSFG-VK) so the action button spans the
   * full tile rather than hugging its label.
   */
  fullWidth?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  style?: CSSProperties;
}) {
  const [pressed, setPressed] = useState(false);
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (pressTimerRef.current !== null) {
        clearTimeout(pressTimerRef.current);
      }
    };
  }, []);

  const { ref, focused } = useFocusable({
    onEnterPress: () => {
      if (!disabled && onClick) {
        window.__SL_SOUNDS__?.playSelect?.();
        setPressed(true);
        onClick();
        pressTimerRef.current = setTimeout(() => setPressed(false), 120);
      }
    },
    focusable: !disabled,
  });

  // Solid DaisyUI variants for colored buttons; default/neutral uses
  // `btn-soft` — a muted but legible surface that contrasts well with
  // solid primary/accent selections.
  const cls = (() => {
    switch (variant) {
      case "primary":   return "btn-primary";
      case "secondary": return "btn-secondary";
      case "accent":    return "btn-accent";
      case "info":      return "btn-info";
      case "success":   return "btn-success";
      case "warning":   return "btn-warning";
      case "error":
      case "danger":    return "btn-error";
      case "neutral":
      case "default":
      default:          return "btn-soft";
    }
  })();

  const scaleClass = pressed ? "scale-[0.97]" : focused ? "scale-[1.02]" : "";
  const focusStyle: CSSProperties = focused
    ? { ...style, animation: "focusPulse 2s ease-in-out infinite" }
    : style ?? {};

  const sizeClass = size === "sm" ? "btn-sm text-xs" : "min-h-[44px] text-sm";
  const widthClass = fullWidth ? "w-full" : "";

  return (
    <button
      ref={ref}
      className={`btn ${cls} ${sizeClass} ${widthClass} transition-transform duration-100 ${scaleClass}`}
      style={focusStyle}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
