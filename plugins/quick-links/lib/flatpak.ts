/**
 * Pure flatpak app-id helpers. Kept in `lib/` so the validation
 * regex is exercised directly without any subprocess mocks.
 */

/**
 * Validate a flatpak app id to keep CLI args safe from injection.
 * Matches the reverse-DNS-ish ids flatpak itself emits (must start
 * with a letter, then letters/digits/dots/underscores/hyphens).
 */
export function isValidFlatpakAppId(appId: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9._-]*$/.test(appId);
}
