/**
 * Shared color palette for the UI component library.
 *
 * Each entry maps a **semantic role** (`background`, `surface`, `accent`,
 * `error`, …) onto the DaisyUI v5 token that currently fills it. The
 * indirection isn't decorative — it lets components reach for
 * `colors.surface` instead of hardcoding `var(--color-base-200)`, so
 * swapping the underlying theme system (DaisyUI → Loadout, etc.) is
 * one file edit instead of a sweep across every component. Plugins
 * that want a colour outside this palette should add a new semantic
 * role here rather than using a raw `var(--color-*)` literal.
 *
 * The audit (C-019, 2026-05) flagged that the alias intent wasn't
 * documented; that's what this header is for. The set is intentionally
 * small — expand only when a new role is required, not just to surface
 * a new shade.
 */
export const colors = {
  background: 'var(--color-base-100)',
  surface: 'var(--color-base-200)',
  surfaceHover: 'var(--color-base-300)',
  border: 'var(--color-base-300)',
  text: 'var(--color-base-content)',
  textSecondary: 'color-mix(in oklch, var(--color-base-content) 60%, transparent)',
  accent: 'var(--color-primary)',
  accentHover: 'color-mix(in oklch, var(--color-primary) 80%, transparent)',
  error: 'var(--color-error)',
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
} as const;
