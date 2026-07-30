/**
 * Buttons and inputs the D-pad can actually reach. [iso]
 *
 * The shell drives focus through a single `SpatialNavigation` singleton, and
 * a node only joins that tree by registering through `useFocusable`. A raw
 * `<button>` is *invisible* to it — clickable with a mouse in desktop mode,
 * completely unreachable on a handheld.
 *
 * That is how the rule builder shipped unusable on the device it was built
 * for: "Add rule", both ⋮ menus and every value editor were plain elements,
 * so a gamepad user could read the builder and never build anything.
 *
 * These exist rather than `@loadout/ui`'s `Button` because the builder's
 * controls carry their own visual language — selected chips, menu rows, a
 * narrow number field. `Button` would register focus correctly and repaint
 * the whole builder. Same registration, callsite keeps its styling.
 */

import type { CSSProperties, ReactNode } from "react";
import { useFocusable } from "@loadout/ui";

/** The shell's focus treatment, matching `Button` and `Toggle`. */
function focusStyle(focused: boolean, style?: CSSProperties): CSSProperties {
  return focused
    ? { ...style, animation: "focusPulse 2s ease-in-out infinite" }
    : (style ?? {});
}

export interface FocusButtonProps {
  children: ReactNode;
  onClick: () => void;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  ariaLabel?: string;
  ariaExpanded?: boolean;
  ariaChecked?: boolean;
  role?: string;
}

export function FocusButton({
  children,
  onClick,
  className,
  style,
  disabled,
  ariaLabel,
  ariaExpanded,
  ariaChecked,
  role,
}: FocusButtonProps) {
  const { ref, focused } = useFocusable({
    // A disabled control must leave the focus tree entirely, not just ignore
    // Enter — otherwise the D-pad stops on it and appears to have hung.
    focusable: !disabled,
    onEnterPress: () => {
      if (disabled) return;
      window.__SL_SOUNDS__?.playSelect?.();
      onClick();
    },
  });

  return (
    <button
      ref={ref as React.RefObject<HTMLButtonElement>}
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-expanded={ariaExpanded}
      aria-checked={ariaChecked}
      role={role}
      className={className}
      style={focusStyle(focused, style)}
    >
      {children}
    </button>
  );
}

export interface FocusInputProps {
  value: string;
  onChange: (next: string) => void;
  className?: string;
  style?: CSSProperties;
  placeholder?: string;
  inputMode?: "numeric" | "text";
  ariaLabel?: string;
  onEnter?: () => void;
}

/**
 * A text/number field the D-pad can land on.
 *
 * Enter focuses the field rather than submitting, because on a handheld that
 * press is what summons the on-screen keyboard — there is no other way to
 * type a value.
 */
export function FocusInput({
  value,
  onChange,
  className,
  style,
  placeholder,
  inputMode,
  ariaLabel,
  onEnter,
}: FocusInputProps) {
  const { ref, focused } = useFocusable({
    onEnterPress: () => {
      const node = ref.current as HTMLInputElement | null;
      node?.focus();
    },
  });

  return (
    <input
      ref={ref as React.RefObject<HTMLInputElement>}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && onEnter) {
          e.preventDefault();
          onEnter();
        }
      }}
      placeholder={placeholder}
      inputMode={inputMode}
      aria-label={ariaLabel}
      className={className}
      style={focusStyle(focused, style)}
    />
  );
}
