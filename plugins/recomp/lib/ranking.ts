/**
 * Catalog ordering primitives used by both the backend (the
 * runtime `getGames` sort that drives the catalog grid) and the
 * dev-only `scripts/preview-sort.ts` (verifies what the user
 * actually sees first when the plugin opens).
 *
 * Single source of truth for two pieces of editorial taste:
 *
 *   - `FRANCHISE_GROUPS`: which franchises lead the catalog. Used
 *     as a primary sort key so Zelda games beat Mario beats Sonic
 *     beats the long tail.
 *
 *   - `HEADLINE_IDS`: a hand-picked few that float to the top of
 *     their franchise group. Updated when a new "must-try" recomp
 *     lands (e.g. an Ocarina of Time HD-textures preset on
 *     `ship-of-harkinian` once that PR lands).
 *
 * Keep this file small — it's intentionally just data.
 */

export const FRANCHISE_GROUPS: ReadonlyArray<{ tag: string; rank: number }> = [
  { tag: "zelda", rank: 0 },
  { tag: "mario", rank: 1 },
  { tag: "sonic", rank: 2 },
];

export const HEADLINE_IDS: ReadonlyArray<string> = [
  "dusklight",            // Twilight Princess (recompiled)
  "sm64-decomp",          // Super Mario 64 (Render96 HD, native) — recommended
  "sm64-render96-rt",     // Super Mario 64 (Render96 + Ray Tracing) — premium
];
