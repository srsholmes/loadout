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
  const sizeClass = typeof size === "string" ? ` loading-${size}` : "";
  const style = typeof size === "number" ? { width: size, height: size } : undefined;
  return <span className={`loading ${variantClass}${sizeClass} text-primary`} style={style} />;
}
