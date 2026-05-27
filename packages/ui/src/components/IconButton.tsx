import { type CSSProperties, type ReactNode } from "react";
import { useFocusable } from "../spatial-nav";

const sounds = () => window.__SL_SOUNDS__;

export type IconButtonVariant = "neutral" | "accent" | "danger";

/**
 * Compact (default 28×28) icon button used in plugin headers and inline rows
 * for gear / back / clear-X / refresh / scan / power / trash actions. Wraps
 * `<button>` with `useFocusable` so the d-pad reaches it. Accepts a `size`
 * override and a `className` passthrough so plugins can keep their existing
 * inline icon styling. `<Button>` is too tall (min-h 44px) for these spots.
 */
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
    onEnterPress: () => {
      if (!disabled) {
        sounds()?.playSelect?.();
        onClick();
      }
    },
    focusable: !disabled,
  });

  const variantClass = (() => {
    switch (variant) {
      case "accent":
        return "border-[var(--accent)] text-[var(--accent)]";
      case "danger":
        return "border-[var(--line)] text-[var(--color-error)]";
      case "neutral":
      default:
        return "border-[var(--line)] text-[var(--fg-2)] hover:text-[var(--fg-1)]";
    }
  })();

  const baseClass =
    "rounded-md grid place-items-center bg-[var(--bg-inset)] border shrink-0 transition-transform duration-100 disabled:opacity-50";
  const focusClass = focused ? "scale-[1.04]" : "";

  const mergedStyle: CSSProperties = {
    width: size,
    height: size,
    ...style,
    ...(focused ? { animation: "focusPulse 2s ease-in-out infinite" } : {}),
  };

  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      className={`${baseClass} ${variantClass} ${focusClass} ${className ?? ""}`}
      style={mergedStyle}
    >
      {children}
    </button>
  );
}
