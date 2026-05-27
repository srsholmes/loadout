import { type CSSProperties } from "react";
import { FaMagnifyingGlass, FaXmark } from "react-icons/fa6";
import { useFocusable } from "../spatial-nav";
import { IconButton } from "./IconButton";

/**
 * Compact search field used in plugin headers (hltb, protondb-badges,
 * launch-options, lsfg-vk, theme-loader, steamgriddb). The chromed wrapper
 * + magnifying-glass icon + transparent input + clear-X is the standard
 * dynamic-header look. The `<input>` is wrapped with `useFocusable` so the
 * d-pad reaches it; pressing A gives it native focus, which surfaces the
 * on-screen keyboard via the `useOverlayKeyboard` SDK.
 */
export function SearchField({
  value,
  onChange,
  onClear,
  placeholder = "Filter library…",
  width = 260,
  style,
}: {
  value: string;
  onChange: (v: string) => void;
  onClear?: () => void;
  placeholder?: string;
  width?: number | string;
  style?: CSSProperties;
}) {
  const { ref } = useFocusable({
    onEnterPress: () => {
      ref.current?.focus();
      ref.current?.select();
    },
  });

  return (
    <div
      className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-[var(--bg-inset)] border border-[var(--line)] focus-within:border-[var(--accent)]/60"
      style={{ width, ...style }}
    >
      <FaMagnifyingGlass size={12} className="text-[var(--fg-3)]" />
      <input
        ref={ref}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 bg-transparent border-none outline-none text-[var(--fg-1)] text-xs"
      />
      {value && onClear && (
        <IconButton
          onClick={onClear}
          ariaLabel="Clear search"
          title="Clear search"
          size={20}
          className="border-none bg-transparent"
        >
          <FaXmark size={11} />
        </IconButton>
      )}
    </div>
  );
}
