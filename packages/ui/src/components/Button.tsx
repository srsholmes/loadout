import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { useFocusable } from "../spatial-nav";
import { applyFocusPulse } from "../focus-style";

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

function variantClass(variant: ButtonVariant): string {
  switch (variant) {
    case "primary":
      return "btn-primary";
    case "secondary":
      return "btn-secondary";
    case "accent":
      return "btn-accent";
    case "info":
      return "btn-info";
    case "success":
      return "btn-success";
    case "warning":
      return "btn-warning";
    case "error":
    case "danger":
      return "btn-error";
    case "neutral":
    case "default":
    default:
      return "btn-soft";
  }
}

export function Button({
  children,
  variant = "default",
  size = "md",
  onClick,
  disabled,
  style,
}: {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  onClick?: () => void;
  disabled?: boolean;
  style?: CSSProperties;
}) {
  const [pressed, setPressed] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
  }, []);

  const { ref, focused } = useFocusable({
    focusable: !disabled,
    onEnterPress: () => {
      if (disabled || !onClick) return;
      setPressed(true);
      onClick();
      pressTimer.current = setTimeout(() => setPressed(false), 120);
    },
  });

  const scaleClass = pressed ? "scale-[0.97]" : focused ? "scale-[1.02]" : "";
  const sizeClass = size === "sm" ? "btn-sm text-xs" : "min-h-[44px] text-sm";

  return (
    <button
      ref={ref}
      className={`btn ${variantClass(variant)} ${sizeClass} transition-transform duration-100 ${scaleClass}`}
      style={applyFocusPulse(focused, style)}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
