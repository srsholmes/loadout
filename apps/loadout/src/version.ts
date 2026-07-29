/**
 * Build version of the loader binary. Extracted from the CLI entry
 * (`src/index.ts`) so HTTP routes (`/api/status`, `/api/self-update`)
 * can report the running version without importing the entry point.
 *
 * The values come from compile-time defines injected by
 * scripts/build.sh (`--define __LOADOUT_VERSION__='"…"'`). Under a
 * bare `bun run` without the build wrapper they fall back to "dev" —
 * which also disables the self-update surface (see loader/self-update).
 */

declare const __LOADOUT_VERSION__: string | undefined;
declare const __LOADOUT_BUILD_DATE__: string | undefined;

export const LOADER_VERSION =
  typeof __LOADOUT_VERSION__ !== "undefined" ? __LOADOUT_VERSION__ : "dev";
export const LOADER_BUILD_DATE =
  typeof __LOADOUT_BUILD_DATE__ !== "undefined" ? __LOADOUT_BUILD_DATE__ : "";
