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

/**
 * Pull a safe file extension out of a CDN asset URL.
 *
 * The naive `urlPath.substring(urlPath.lastIndexOf("."))` breaks on:
 *
 *   - Query strings:   `…/grid/12345.png?token=abcd` → `".png?token=abcd"`
 *   - No extension:    `…/grid/12345`                → `""` (then `||"".png"`)
 *   - Dots in path:    `…/foo.bar/12345`             → `".bar/12345"`
 *
 * We strip query/hash first, then take only the segment after the last
 * `/`, then read its extension. Only allow-listed image formats survive
 * — anything else (or no extension at all) returns the `.png` default.
 *
 * Aligns with `@loadout/sgdb-art`'s defensive `extFor` helper so the
 * two implementations of the SGDB write path stay in lockstep.
 */
const ALLOWED_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".ico"]);

export function extFromUrl(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Malformed URL → trust the default rather than guess.
    return ".png";
  }
  // Drop query/hash defensively (URL.pathname already does, but
  // a passed-in raw fragment of a URL might not).
  // split() always yields at least one element, so [0] is in-bounds;
  // the `?? ""` fallbacks only satisfy the type checker.
  const beforeQuery = pathname.split("?")[0] ?? "";
  pathname = beforeQuery.split("#")[0] ?? "";
  // Only the final path segment can carry the extension.
  const segment = pathname.split("/").pop() ?? "";
  const dotIdx = segment.lastIndexOf(".");
  if (dotIdx === -1) return ".png";
  const ext = segment.slice(dotIdx).toLowerCase();
  return ALLOWED_IMAGE_EXTS.has(ext) ? ext : ".png";
}
