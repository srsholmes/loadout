/**
 * Semantic palette. Maps a role to the DaisyUI v5 token currently filling it.
 * Components reach for `colors.surface` instead of hardcoding
 * `var(--color-base-200)` — swapping the theme system becomes a single edit.
 */
export const colors = {
  background: "var(--color-base-100)",
  surface: "var(--color-base-200)",
  surfaceHover: "var(--color-base-300)",
  border: "var(--color-base-300)",
  text: "var(--color-base-content)",
  textSecondary: "color-mix(in oklch, var(--color-base-content) 60%, transparent)",
  accent: "var(--color-primary)",
  accentHover: "color-mix(in oklch, var(--color-primary) 80%, transparent)",
  error: "var(--color-error)",
  success: "var(--color-success)",
  warning: "var(--color-warning)",
} as const;
