import type { CSSProperties, ReactNode } from "react";

const variantClasses = {
  body: "text-sm text-base-content leading-relaxed m-0",
  secondary: "text-sm text-base-content/50 leading-relaxed m-0",
  heading: "text-lg font-semibold text-base-content mb-2 leading-snug",
};

export function Text({
  variant = "body",
  children,
  style,
}: {
  variant?: "body" | "secondary" | "heading";
  children: ReactNode;
  style?: CSSProperties;
}) {
  return <p className={variantClasses[variant]} style={style}>{children}</p>;
}
