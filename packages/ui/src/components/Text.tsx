import type { CSSProperties, ReactNode } from "react";

const VARIANTS = {
  body: "text-sm text-base-content leading-relaxed m-0",
  secondary: "text-sm text-base-content/50 leading-relaxed m-0",
  heading: "text-lg font-semibold text-base-content mb-2 leading-snug",
} as const;

export type TextVariant = keyof typeof VARIANTS;

export function Text({
  variant = "body",
  children,
  style,
}: {
  variant?: TextVariant;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <p className={VARIANTS[variant]} style={style}>
      {children}
    </p>
  );
}
