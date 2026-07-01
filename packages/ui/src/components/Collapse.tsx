import { useState, type CSSProperties, type ReactNode } from "react";
import { useFocusable } from "../spatial-nav";

export interface CollapseProps {
  /** Always-visible header row; the whole row toggles open/closed. */
  title: ReactNode;
  /** Body revealed when expanded. */
  children: ReactNode;
  /** Start expanded? Default `false` (closed). */
  defaultOpen?: boolean;
  /** Accessible name for the toggle (falls back to a generic label). */
  ariaLabel?: string;
  /** Extra Tailwind classes for the outer container. */
  className?: string;
}

/**
 * Collapsible / accordion box. A rounded, card-styled container with a header
 * row that toggles the body open/closed and a chevron that rotates to show
 * state (closed by default). Driven entirely from React state so mouse and
 * gamepad behave identically.
 *
 * The header is its own flex row (`items-center`) with symmetric padding, so
 * the title is always vertically centred against the chevron — unlike
 * daisyUI's `collapse-title`, whose min-height/padding left the label
 * top-aligned. The row is registered with the shell's spatial-nav
 * (`useFocusable`): D-pad to it and press A (`onEnterPress`) to toggle, with
 * the same focus-pulse treatment as Button/Toggle.
 */
export function Collapse({
  title,
  children,
  defaultOpen = false,
  ariaLabel,
  className = "",
}: CollapseProps) {
  const [open, setOpen] = useState(defaultOpen);
  const { ref, focused } = useFocusable({
    onEnterPress: () => setOpen((o) => !o),
  });

  const focusStyle: CSSProperties | undefined = focused
    ? { animation: "focusPulse 2s ease-in-out infinite" }
    : undefined;

  return (
    <div
      className={`rounded-xl border bg-base-200/40 ${
        focused ? "border-primary" : "border-base-300"
      } ${className}`}
    >
      <div
        ref={ref}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={ariaLabel ?? "Toggle section"}
        className="flex cursor-pointer select-none items-center justify-between gap-2 px-4.5 py-3.5"
        style={focusStyle}
        onClick={() => setOpen((o) => !o)}
      >
        {title}
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 text-base-content/50 transition-transform duration-200"
          style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)" }}
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </div>
      {open && <div className="px-4.5 pb-4">{children}</div>}
    </div>
  );
}
