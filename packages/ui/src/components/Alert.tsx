import { type ReactNode } from "react";

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
}

/**
 * Standard alert / banner. Used for safety overrides, distro-or-DE-specific
 * "this feature won't work in your session" warnings, and similar
 * non-blocking advisories. Non-dismissable by design — when a plugin needs
 * the user to acknowledge the message, the message is load-bearing and
 * shouldn't be silenced.
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
}: AlertProps) {
  return (
    <div role="alert" className={`alert alert-${variant} ${className}`}>
      {icon}
      <div className="flex-1">
        {title && <div className="font-semibold">{title}</div>}
        <div className="text-xs opacity-90">{children}</div>
      </div>
    </div>
  );
}
