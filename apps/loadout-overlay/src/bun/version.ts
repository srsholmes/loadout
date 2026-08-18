/**
 * Product version for the overlay's Bun main process.
 *
 * Baked in by `electrobun.config.ts` via `build.bun.define`, mirroring how
 * `vite.config.ts` bakes `__OVERLAY_VERSION__` for the webview. Falls back to
 * "dev" when running from source (`electrobun dev`), which is also what makes
 * crash reporting treat a dev run as the `development` environment.
 */

declare const __OVERLAY_BUN_VERSION__: string | undefined;

export const OVERLAY_BUN_VERSION: string =
  typeof __OVERLAY_BUN_VERSION__ === "string" ? __OVERLAY_BUN_VERSION__ : "dev";
