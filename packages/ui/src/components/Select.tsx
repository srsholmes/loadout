import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { FocusContext, pushBackInterceptor, setFocus, useFocusable } from "../spatial-nav";

/** Max dropdown height in px — keep in sync with the `max-h-60` class below
 *  (15rem @ 16px). Used to decide whether the menu flips above the trigger. */
const MENU_MAX_HEIGHT = 240;
/** Gap between the trigger and the menu, px. */
const MENU_GAP = 4;

interface MenuPosition {
  left: number;
  minWidth: number;
  /** Effective CSS `zoom` of the trigger's ancestor chain. The menu is
   *  portaled to <body> (outside the overlay's zoomed wrapper), so it must
   *  re-apply that zoom or it renders at 1× — smaller than the rest of the
   *  scaled UI. All the px offsets below are in the menu's own (pre-zoom)
   *  coordinate space, i.e. device px divided by this. */
  zoom: number;
  /** Set for below-placement (fixed `top`). */
  top?: number;
  /** Set for above-placement (fixed `bottom`, measured from viewport bottom). */
  bottom?: number;
}

/**
 * Cumulative CSS `zoom` applied to an element via its ancestor chain. The
 * overlay scales its whole UI with `zoom` on a wrapper div (CEF treats it as
 * a first-class layout property), so getBoundingClientRect returns post-zoom
 * device px. A portaled menu on <body> sits outside that wrapper, so we read
 * the zoom back off the DOM to reproduce it.
 *
 * The walk stops at <body>: the menu is portaled as a child of <body>, so it
 * already inherits any zoom on <body>/<html> natively — re-applying those too
 * would double-scale it. We only re-apply the zoom that lives *between* the
 * trigger and <body> (today, the overlay's inner wrapper div).
 */
function effectiveZoom(el: HTMLElement | null): number {
  let z = 1;
  const stop = el?.ownerDocument.body ?? null;
  for (let node = el; node && node !== stop; node = node.parentElement) {
    const v = parseFloat(getComputedStyle(node).zoom);
    if (!Number.isNaN(v) && v > 0) z *= v;
  }
  return z;
}

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
  const [menuPos, setMenuPos] = useState<MenuPosition | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);

  const { ref: triggerRef, focusKey: triggerFocusKey } = useFocusable({
    onEnterPress: () => setOpen((o) => !o),
  });

  // Position the menu from the trigger's viewport rect. The menu is rendered
  // in a portal with `position: fixed` (below) so it escapes any clipping
  // ancestor — cards use `overflow: hidden` and pages are scroll containers,
  // both of which would otherwise crop an in-flow absolute dropdown. Flip
  // above the trigger when there isn't room below.
  const updatePosition = useCallback(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const z = effectiveZoom(el);
    // The menu re-applies `zoom: z`, which scales its own inset/size values,
    // so express every device-px measurement in the menu's pre-zoom space
    // (÷ z). The flip threshold compares device px against the menu's real
    // rendered height (MENU_MAX_HEIGHT · z).
    const spaceBelow = window.innerHeight - r.bottom;
    const spaceAbove = r.top;
    const flipUp = spaceBelow < MENU_MAX_HEIGHT * z && spaceAbove > spaceBelow;
    setMenuPos({
      zoom: z,
      left: r.left / z,
      minWidth: r.width / z,
      ...(flipUp
        ? { bottom: (window.innerHeight - r.top + MENU_GAP) / z }
        : { top: (r.bottom + MENU_GAP) / z }),
    });
  }, []);

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

  // Compute the menu position when it opens, and keep it pinned to the
  // trigger while any ancestor scrolls or the window resizes. useLayoutEffect
  // so the first paint already has the correct position (no flash at 0,0).
  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const onReflow = () => updatePosition();
    // Capture phase so scrolls inside nested containers are caught too.
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    return () => {
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
  }, [open, updatePosition]);

  // Close on outside pointer-down. The menu lives in a portal (not inside
  // wrapperRef), so an option click counts as "outside" the wrapper — check
  // the menu element too, otherwise mousedown would close before the option's
  // click handler runs and the selection would be lost.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrapperRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
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

      {open &&
        menuPos &&
        createPortal(
          // Portaled to <body> with fixed positioning so no clipping ancestor
          // (cards' overflow:hidden, scrollable pages) can crop the menu.
          // FocusContext still wraps it here in the React tree, so spatial
          // nav is unaffected by the DOM relocation.
          <FocusContext.Provider value={triggerFocusKey}>
            <ul
              ref={menuRef}
              role="listbox"
              className="fixed z-50 max-h-60 overflow-y-auto rounded-box border border-base-300 bg-base-100 shadow-xl py-1"
              style={{
                zoom: menuPos.zoom,
                left: menuPos.left,
                minWidth: menuPos.minWidth,
                top: menuPos.top,
                bottom: menuPos.bottom,
              }}
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
          </FocusContext.Provider>,
          document.body,
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
