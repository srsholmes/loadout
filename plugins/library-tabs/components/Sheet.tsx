/**
 * A modal sheet.
 *
 * Exists because editing a rule needs somewhere to put a form without losing
 * the tree behind it — you should be able to see the count you are changing.
 *
 * Three closing paths, all mandatory:
 *
 * - **B / Escape via `pushBackInterceptor`.** Returning `true` consumes the
 *   press, so B closes the sheet instead of popping the whole plugin page.
 *   `Select` has done this from plugin roots since it shipped, so the
 *   mechanism is proven; this follows its pattern deliberately.
 * - **Escape as a real key handler**, because the docked mouse-and-keyboard
 *   path does not route through the overlay's back chain. That path is the
 *   one TabMaster is broken on, so it is a first-class constraint here.
 * - **Backdrop click**, which is what a pointer user reaches for first.
 *
 * Focus is moved into the sheet on open and returned to whatever had it on
 * close. Without the restore, closing a rule editor dumps a gamepad user at
 * the top of the page instead of back on the row they were editing.
 */

import { useCallback, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Text, pushBackInterceptor } from "@loadout/ui";

export interface SheetProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Actions pinned to the bottom, e.g. Save / Cancel. */
  footer?: ReactNode;
  /** Accessible description, announced with the title. */
  description?: string;
}

/** Interactive descendants, in DOM order. */
const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Sheet({
  open,
  title,
  onClose,
  children,
  footer,
  description,
}: SheetProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  /**
   * The scrollable body. Focus targets this rather than the panel, because the
   * panel's first focusable child is the Close button — landing there offers
   * "leave" as the opening move of an edit.
   */
  const contentRef = useRef<HTMLDivElement | null>(null);
  /** Whatever had focus before we opened, so it can be handed back. */
  const returnFocusRef = useRef<Element | null>(null);

  // Kept in a ref so the effects below don't re-register on every render of a
  // parent that passes a fresh closure.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const close = useCallback(() => onCloseRef.current(), []);

  // B on a controller, Escape through the overlay shell. Registered only
  // while open, and the returned disposer runs on close *and* unmount — a
  // leaked interceptor would silently eat the next Back press anywhere in
  // the overlay.
  useEffect(() => {
    if (!open) return;
    return pushBackInterceptor(() => {
      close();
      return true;
    });
  }, [open, close]);

  // Escape from a real keyboard. Not redundant with the interceptor: docked
  // keyboard input does not necessarily pass through the shell's back chain.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  // Move focus in on open, hand it back on close.
  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement;
    const first =
      contentRef.current?.querySelector<HTMLElement>(FOCUSABLE) ??
      panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panelRef.current)?.focus();

    return () => {
      const previous = returnFocusRef.current;
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  const describedBy = description ? "sheet-description" : undefined;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      // The backdrop is a sibling concern: clicking it closes, but a click
      // that started inside the panel and drifted out must not.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="absolute inset-0 bg-black/60" aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={[
          "relative flex max-h-[85vh] w-full max-w-2xl flex-col gap-3",
          "rounded-t-2xl sm:rounded-2xl border border-base-300 bg-base-100 p-4",
        ].join(" ")}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <Text variant="heading">{title}</Text>
            {description ? (
              <span id={describedBy} className="text-xs text-base-content/60">
                {description}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className={[
              "shrink-0 rounded-lg px-3 min-h-[44px] border border-base-300",
              "bg-base-200 text-base-content/70 hover:text-base-content",
              "focus-visible:ring-2 focus-visible:ring-primary",
            ].join(" ")}
          >
            Close
          </button>
        </div>

        <div ref={contentRef} className="flex-1 overflow-y-auto">
          {children}
        </div>

        {footer ? (
          <div className="flex justify-end gap-2 border-t border-base-300 pt-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
