/**
 * Pure utilities shared between the SGDB plugin's backend (Bun) and
 * frontend (browser) bundles. Anything in this module must not import
 * `node:*`, FFI, fs, or DOM APIs — it has to load cleanly in both
 * runtimes.
 */

/**
 * Strip parenthesised regions, bracketed tags, disc markers, and
 * version suffixes from a Steam shortcut's name before sending it to
 * SGDB autocomplete. Reduces names like `Super Mario 64 (USA) [v1.0]`
 * down to `Super Mario 64` so the top autocomplete match is more
 * likely the right game. Mined from steam-rom-manager's title cleanup
 * heuristics.
 */
export function cleanTitleForSearch(name: string): string {
  return name
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s*\[[^\]]*\]\s*/g, " ")
    .replace(/\s*-\s*Disc\s*\d+/gi, " ")
    .replace(/\s+v\d+(?:\.\d+)*\b/gi, " ")
    .trim()
    .replace(/\s+/g, " ");
}
