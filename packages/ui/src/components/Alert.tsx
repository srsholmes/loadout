import { type ReactNode } from "react";
import { IconButton } from "./IconButton";

export type AlertVariant = "info" | "success" | "warning" | "error";

interface AlertProps {
  /** daisyUI variant. Default `"info"`. */
  variant?: AlertVariant;
  /** Lead icon node (e.g. `<FaTemperatureHalf size={18} />`). */
  icon?: ReactNode;
  /** Bold title line above the body. Optional — body-only alerts are fine. */
  title?: ReactNode;
  /** Body text or JSX. */
  children: ReactNode;
  /** Extra Tailwind classes for the outer container. Defaults to `mb-4`. */
  className?: string;
  /**
   * Opt-in dismissal. When provided, a close button is rendered and this
   * fires on click — the caller owns the "stay hidden" state, and therefore
   * owns when the message comes back. Omit it for load-bearing messages
   * (safety overrides, "this won't work in your session") that the user must
   * not be able to silence.
   */
  onDismiss?: () => void;
  /** Accessible label for the dismiss button. */
  dismissLabel?: string;
}

/**
 * Standard alert / banner. Used for safety overrides, distro-or-DE-specific
 * "this feature won't work in your session" warnings, and similar
 * non-blocking advisories.
 *
 * Non-dismissable by DEFAULT: when a plugin needs the user to acknowledge a
 * message, it's load-bearing and shouldn't be silenced. Pass `onDismiss` for
 * the narrower case of a purely informational notice the user may reasonably
 * want out of the way — the caller then owns both the hidden state and the
 * policy for when it returns.
 *
 * Wraps daisyUI's `alert alert-<variant>` so theming is consistent with
 * the rest of the overlay (success/warning/error chips, etc.).
 */
export function Alert({
  variant = "info",
  icon,
  title,
  children,
  className = "mb-4",
  onDismiss,
  dismissLabel = "Dismiss",
}: AlertProps) {
  return (
    <div role="alert" className={`alert alert-${variant} ${className}`}>
      {icon}
      <div className="flex-1">
        {title && <div className="font-semibold">{title}</div>}
        <div className="text-xs opacity-90">{children}</div>
      </div>
      {onDismiss && (
        // IconButton, not a bare <button>: spatial nav in this overlay is
        // registration-based (useFocusable), with no DOM scan or tabindex
        // fallback. A plain button can never take d-pad focus, which would
        // make "dismissable" true only for mouse/touch — useless on the
        // handheld this runs on. It also gets a 28px hit target instead of
        // btn-xs's 24px.
        <IconButton onClick={onDismiss} ariaLabel={dismissLabel} size={28}>
          ✕
        </IconButton>
      )}
    </div>
  );
}
