/**
 * A sub-page of the rule builder — the palette, or a rule's parameters.
 *
 * **Deliberately not a modal.** The whole Loadout UI is already an overlay
 * laid over Steam, so a dialog here is a modal on top of a modal: it dims a
 * surface that is itself floating, and in desktop mode — where the overlay is
 * an ordinary window — a centred sheet with its own scrim reads as a mistake.
 *
 * It also could not be made to fit. A `position: fixed` panel inside the
 * shell's zoomed subtree escapes the plugin's own bounds, and the `max-h-*`
 * class meant to cap it does not exist in the shell's stylesheet (see the
 * note in `README.md`), so the panel grew to its full content height and ran
 * off the top of a 1280×800 screen.
 *
 * As a page it inherits the plugin's normal scroll box and padding, which is
 * the same reason `RuleBuilder` replaces the browse view rather than opening
 * beside it: one screen, one focus region, nothing for the D-pad to fight
 * over.
 *
 * B and Escape still pop one level rather than leaving the plugin — that part
 * of the modal behaviour was worth keeping.
 */

import { useCallback, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { IconButton, PluginHeader, Spinner, pushBackInterceptor } from "@loadout/ui";
import { FaChevronLeft } from "react-icons/fa6";

export interface BuilderPageProps {
  title: string;
  /** One line under the title explaining what this page is for. */
  description?: string;
  /** Pops back to the rule tree. */
  onBack: () => void;
  children: ReactNode;
  /** Actions pinned under the content, e.g. Save rule. */
  footer?: ReactNode;
  /** Label for the back control. */
  backLabel?: string;
  /**
   * Work is in flight and the page is inert.
   *
   * Puts a spinner in the topbar, because the alternative is a page that stops
   * responding with nothing to say why — and a press that shows no sign of
   * having registered gets pressed again.
   */
  busy?: boolean;
}

/** Interactive descendants, in DOM order. */
const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function BuilderPage({
  title,
  description,
  onBack,
  children,
  footer,
  backLabel = "Back",
  busy = false,
}: BuilderPageProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);

  // Held in a ref so the effects don't re-register when a parent re-renders
  // with a fresh closure.
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const back = useCallback(() => onBackRef.current(), []);

  // B on a controller, routed through the shell's back chain. Returning true
  // consumes the press so it pops this page instead of the whole plugin.
  useEffect(() => pushBackInterceptor(() => {
    back();
    return true;
  }), [back]);

  // Escape from a real keyboard — the docked path does not necessarily go
  // through the shell's back chain, and docked mouse-and-keyboard is the
  // input TabMaster is broken on.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      back();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [back]);

  // Move focus into the content on open. Targets the content rather than the
  // page, whose first focusable is Back — landing there offers "leave" as the
  // opening move.
  useEffect(() => {
    contentRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, []);

  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      {/* Title and Back go in the shell's topbar, not the page body. Back is
          navigation, and navigation belongs in the chrome — in the body it
          scrolls away with the content, which on a long rule palette means the
          only way out is off-screen. */}
      <PluginHeader>
        <div className="flex items-center justify-between gap-4 w-full min-w-0">
          <div className="flex flex-col gap-0.5 min-w-0">
            <h1 className="text-xl font-semibold m-0 leading-tight truncate">{title}</h1>
            {description ? (
              <span className="text-[11.5px] text-base-content/55 truncate leading-tight">
                {description}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {busy ? <Spinner size={16} /> : null}
            <IconButton onClick={back} title={backLabel} ariaLabel={backLabel}>
              <FaChevronLeft size={13} />
            </IconButton>
          </div>
        </div>
      </PluginHeader>

      <div ref={contentRef} className="flex flex-col gap-3">
        {children}
      </div>

      {footer ? (
        <div className="flex justify-end gap-2 border-t border-base-300 pt-3">
          {footer}
        </div>
      ) : null}
    </section>
  );
}
