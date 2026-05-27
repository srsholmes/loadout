/**
 * Loading indicator. Wraps DaisyUI's `loading` class set so consumers
 * don't have to remember which suffix maps to which animation
 * (`loading-spinner` = the classic ring, `loading-dots` = three blinking
 * dots — used in the overlay's list / picker surfaces where a ring
 * would feel like an error state).
 *
 * `size` accepts either a number (sets the inline width/height in
 * pixels — the `loading-spinner` variant's preferred sizing path) or
 * one of DaisyUI's named scales (`xs`/`sm`/`md`/`lg`) — necessary for
 * the `dots` variant because its width is implicit in the class name,
 * not the inline style. Audit C-008 (2026-05).
 */
type SpinnerVariant = "spinner" | "dots";
type SpinnerNamedSize = "xs" | "sm" | "md" | "lg";

export function Spinner({
  variant = "spinner",
  size = variant === "spinner" ? 20 : "md",
}: {
  variant?: SpinnerVariant;
  size?: number | SpinnerNamedSize;
} = {}) {
  const variantClass = variant === "dots" ? "loading-dots" : "loading-spinner";
  const sizeClass =
    typeof size === "string" ? ` loading-${size}` : "";
  const style =
    typeof size === "number" ? { width: size, height: size } : undefined;
  return (
    <span
      className={`loading ${variantClass}${sizeClass} text-primary`}
      style={style}
    />
  );
}
