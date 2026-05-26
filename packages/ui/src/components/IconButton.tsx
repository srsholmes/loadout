import { type CSSProperties, type ReactNode } from "react";
import { useFocusable } from "../spatial-nav";
import { applyFocusPulse, focusScaleClass } from "../focus-style";

export type IconButtonVariant = "neutral" | "accent" | "danger";

export function IconButton({
  children,
  onClick,
  disabled,
  title,
  ariaLabel,
  variant = "neutral",
  size = 28,
  className,
  style,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  variant?: IconButtonVariant;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const { ref, focused } = useFocusable({
    focusable: !disabled,
    onEnterPress: () => !disabled && onClick(),
  });

  const variantClass = (() => {
    switch (variant) {
      case "accent":
        return "border-primary text-primary";
      case "danger":
        return "border-base-300 text-error";
      default:
        return "border-base-300 text-base-content/60 hover:text-base-content";
    }
  })();

  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      className={`rounded-md grid place-items-center bg-base-100 border shrink-0 transition-transform duration-100 disabled:opacity-50 ${variantClass} ${focusScaleClass(focused, "1.04")} ${className ?? ""}`}
      style={applyFocusPulse(focused, { width: size, height: size, ...style })}
    >
      {children}
    </button>
  );
}
