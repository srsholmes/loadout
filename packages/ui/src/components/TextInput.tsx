import { useEffect, type CSSProperties, type KeyboardEvent, type FocusEvent } from "react";
import { useFocusable } from "../spatial-nav";

export function TextInput({
  value,
  onChange,
  placeholder,
  type,
  inputMode,
  autoFocus,
  disabled,
  onKeyDown,
  onBlur,
  className,
  style,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  inputMode?: "text" | "numeric" | "decimal" | "tel" | "email" | "url" | "search";
  autoFocus?: boolean;
  disabled?: boolean;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  onBlur?: (e: FocusEvent<HTMLInputElement>) => void;
  className?: string;
  style?: CSSProperties;
}) {
  const { ref, focused } = useFocusable({
    onEnterPress: () => {
      if (disabled) return;
      // Give the native input real DOM focus — triggers on-screen keyboard on Steam Deck
      ref.current?.focus();
      ref.current?.select();
    },
    focusable: !disabled,
  });

  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus();
    }
  }, [autoFocus, ref]);

  return (
    <input
      ref={ref}
      type={type ?? "text"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      placeholder={placeholder}
      inputMode={inputMode}
      disabled={disabled}
      className={
        className ??
        `input input-sm input-bordered w-full ${focused ? "ring-2 ring-primary/40" : ""}`
      }
      style={style}
    />
  );
}
