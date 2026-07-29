/**
 * Product version for the overlay UI.
 *
 * Baked in at build time by `vite.config.ts` as `__OVERLAY_VERSION__` (read from
 * this app's package.json). Guarded with `typeof` so it falls back to "dev"
 * outside a Vite build — e.g. under `bun test`, where the define isn't applied.
 * Mirrors the backend's `__LOADOUT_VERSION__` guard in apps/loadout/src/version.ts.
 */
export const OVERLAY_VERSION: string =
  typeof __OVERLAY_VERSION__ !== "undefined" ? __OVERLAY_VERSION__ : "dev";
