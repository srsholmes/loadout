import { useEffect, type ReactNode } from "react";
import { FaXmark } from "react-icons/fa6";
import {
  FocusContext,
  IconButton,
  pushBackInterceptor,
  useFocusable,
} from "@loadout/ui";

/** Monotonic id generator for tabs / filters. Not persisted-order
 *  sensitive; just needs to be unique within a session's editing. */
let idCounter = 0;
export function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}-${Math.floor(Math.random() * 1e6)}`;
}

/**
 * Full-body overlay panel used for the picker / editor / action sheets.
 * Renders a fixed backdrop + centered card, establishes its own
 * spatial-nav focus zone, and registers a back interceptor so the
 * controller B button (and Escape) closes it before the shell's own
 * back handling runs.
 */
export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const { ref, focusKey } = useFocusable({
    focusKey: "game-tabs-modal",
    trackChildren: true,
    saveLastFocusedChild: true,
    isFocusBoundary: true,
  });

  useEffect(() => {
    const remove = pushBackInterceptor(() => {
      onClose();
      return true;
    });
    return remove;
  }, [onClose]);

  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        className="fixed inset-0 z-50 flex items-center justify-center p-6"
        style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(2px)" }}
      >
        <div
          className="card flex flex-col w-full overflow-hidden"
          style={{
            maxWidth: wide ? 920 : 560,
            maxHeight: "88vh",
            background: "var(--bg-1, #16181d)",
          }}
        >
          <div
            className="flex items-center justify-between gap-4 px-5 py-3.5 border-b"
            style={{ borderColor: "var(--line)" }}
          >
            <h2 className="text-base font-semibold m-0 truncate">{title}</h2>
            <IconButton onClick={onClose} title="Close" ariaLabel="Close">
              <FaXmark size={12} />
            </IconButton>
          </div>
          <div className="flex-1 overflow-y-auto p-5">{children}</div>
          {footer && (
            <div
              className="flex items-center justify-end gap-2 px-5 py-3 border-t"
              style={{ borderColor: "var(--line)" }}
            >
              {footer}
            </div>
          )}
        </div>
      </div>
    </FocusContext.Provider>
  );
}

/** A focusable row that behaves like a menu item — used in the game
 *  action sheet. */
export function ActionRow({
  label,
  hint,
  onSelect,
  icon,
  danger,
}: {
  label: string;
  hint?: string;
  onSelect: () => void;
  icon?: ReactNode;
  danger?: boolean;
}) {
  const { ref, focused } = useFocusable({ onEnterPress: onSelect });
  return (
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      className={[
        "flex items-center gap-3 w-full text-left px-4 py-3 rounded-[10px] transition-all duration-150 cursor-pointer border",
        focused
          ? "bg-[var(--accent-soft)] border-[var(--accent)] scale-[1.02]"
          : "bg-[var(--bg-inset)] border-[var(--line)]",
      ].join(" ")}
      style={focused ? { animation: "focusPulse 2s ease-in-out infinite" } : undefined}
    >
      {icon && <span className="shrink-0 text-[var(--fg-2)]">{icon}</span>}
      <span className="flex flex-col min-w-0">
        <span
          className="text-[13px] font-medium truncate"
          style={{ color: danger ? "var(--danger, #f87171)" : "var(--fg-1)" }}
        >
          {label}
        </span>
        {hint && (
          <span className="text-[11px] text-[var(--fg-3)] truncate">{hint}</span>
        )}
      </span>
    </button>
  );
}
