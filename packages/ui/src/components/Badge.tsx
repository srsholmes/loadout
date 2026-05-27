import { type ReactNode } from "react";

export type BadgeVariant =
  | "neutral"
  | "primary"
  | "secondary"
  | "accent"
  | "info"
  | "success"
  | "warning"
  | "error";

export type BadgeSize = "xs" | "sm" | "md" | "lg" | "xl";

export function Badge({
  children,
  variant = "neutral",
  size = "sm",
  className,
}: {
  children: ReactNode;
  variant?: BadgeVariant;
  size?: BadgeSize;
  className?: string;
}) {
  // Soft variants for colored badges — muted background with legible
  // same-hue text. Neutral uses the default (solid) badge since there's
  // no `badge-soft` for plain neutral that looks right against our dark
  // panels.
  const variantClass =
    variant === "neutral" ? "badge-neutral" : `badge-soft badge-${variant}`;
  return (
    <span
      className={`badge ${variantClass} badge-${size}${className ? ` ${className}` : ""}`}
    >
      {children}
    </span>
  );
}
