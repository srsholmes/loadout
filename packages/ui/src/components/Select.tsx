import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { FocusContext, pushBackInterceptor, setFocus, useFocusable } from "../spatial-nav";

export interface SelectOption<T extends string> {
  value: T;
  label: ReactNode;
}

/**
 * Custom dropdown — does NOT use a native `<select>`. The overlay's
 * embedded webview doesn't always render the native popup consistently,
 * so we render a button + positioned options panel ourselves. Styled
 * with daisyUI.
 *
 * Each option is a focusable so it integrates with gamepad spatial nav.
 *
 * Two ways to provide options:
 *   - `options={["a","b","c"]} labels={{a:"A",b:"B"}}`
 *   - `options={[{value:"a",label:"A"},...]}`
 */
export function Select<T extends string>({
  value,
  options,
  labels,
  onChange,
  size = "sm",
  className,
  style,
  placeholder,
}: {
  value: T;
  options: readonly T[] | readonly SelectOption<T>[];
  labels?: Partial<Record<T, ReactNode>>;
  onChange: (value: T) => void;
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
  style?: CSSProperties;
  placeholder?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const { ref: triggerRef, focusKey: triggerFocusKey } = useFocusable({
    onEnterPress: () => setOpen((o) => !o),
  });

  // Normalize options to {value, label}[]
  const normalized: SelectOption<T>[] = (options as readonly unknown[]).map(
    (opt): SelectOption<T> => {
      if (typeof opt === "string") {
        const v = opt as T;
        return { value: v, label: labels?.[v] ?? v };
      }
      return opt as SelectOption<T>;
    },
  );

  const current = normalized.find((o) => o.value === value);
  const displayLabel = current ? current.label : (placeholder ?? value);

  // Generate stable, unique focusKeys for each option scoped to this Select.
  const optionFocusKey = (v: string) => `${triggerFocusKey}-opt-${v}`;

  const closeAndRestoreFocus = () => {
    setOpen(false);
    setFocus(triggerFocusKey);
  };

  // Close on outside pointer-down (use mousedown so we close before any
  // click handler on the option fires).
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Register a back interceptor while open — captures B/Escape via the
  // shell's runBack chain so the dropdown closes instead of navigating back.
  useEffect(() => {
    if (!open) return;
    return pushBackInterceptor(() => {
      closeAndRestoreFocus();
      return true;
    });
    // closeAndRestoreFocus is stable enough — values it captures change with `open`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, triggerFocusKey]);

  // When the dropdown opens, move focus to the currently selected option
  // (or the first option). Wait one tick so the options have mounted
  // and registered with the spatial-nav singleton.
  useEffect(() => {
    if (!open) return;
    const target = current ? current.value : normalized[0]?.value;
    if (target == null) return;
    const id = setTimeout(() => setFocus(optionFocusKey(target)), 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Map size → button height class to roughly match `select-{size}`
  const sizeClass =
    size === "xs"
      ? "h-6 text-xs px-2"
      : size === "lg"
        ? "h-12 text-base px-4"
        : size === "md"
          ? "h-10 text-sm px-3"
          : "h-8 text-sm px-3";

  return (
    <div ref={wrapperRef} className="relative inline-block" style={style}>
      <button
        ref={triggerRef as React.RefObject<HTMLButtonElement>}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`${sizeClass} min-w-[140px] inline-flex items-center justify-between gap-2 rounded-field border border-base-300 bg-base-100 text-base-content cursor-pointer transition-colors hover:bg-base-200 ${className ?? ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="truncate">{displayLabel}</span>
        <svg
          className={`shrink-0 w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`}
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 4.5L6 7.5L9 4.5" />
        </svg>
      </button>

      {open && (
        <FocusContext.Provider value={triggerFocusKey}>
          <ul
            role="listbox"
            className="absolute left-0 top-full mt-1 z-50 min-w-full max-h-60 overflow-y-auto rounded-box border border-base-300 bg-base-100 shadow-xl py-1"
          >
            {normalized.map((opt) => (
              <SelectOptionRow
                key={opt.value}
                focusKey={optionFocusKey(opt.value)}
                option={opt}
                isSelected={opt.value === value}
                onSelect={() => {
                  onChange(opt.value);
                  closeAndRestoreFocus();
                }}
              />
            ))}
          </ul>
        </FocusContext.Provider>
      )}
    </div>
  );
}

function SelectOptionRow<T extends string>({
  focusKey,
  option,
  isSelected,
  onSelect,
}: {
  focusKey: string;
  option: SelectOption<T>;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const { ref, focused } = useFocusable({
    focusKey,
    onEnterPress: onSelect,
  });

  return (
    <li>
      <button
        ref={ref as React.RefObject<HTMLButtonElement>}
        type="button"
        onClick={onSelect}
        role="option"
        aria-selected={isSelected}
        className={`w-full text-left px-3 py-2 text-sm whitespace-nowrap cursor-pointer transition-colors ${
          isSelected
            ? "bg-primary/20 text-primary font-medium"
            : focused
              ? "bg-base-200 text-base-content"
              : "text-base-content hover:bg-base-200"
        }`}
      >
        {option.label}
      </button>
    </li>
  );
}
