/**
 * Product-version parsing + comparison, shared by the loader (backend
 * self-update route), the overlay's Bun host (release check) and the
 * webview UI (Settings / startup toast).
 *
 * Loadout release tags are always plain `vX.Y.Z` (scripts/release.sh
 * never emits prerelease suffixes or build metadata), so a strict
 * three-part numeric compare is deliberate. Anything else — "dev",
 * "dev-<hash>" from local builds, the "rolling" release tag — parses
 * to null, and callers treat an unparsable version as "updates
 * disabled" rather than guessing.
 */

/** A valid release tag: `v` + three dot-separated numbers, nothing else.
 *  Used to reject the "rolling" tag and any malformed/hostile input
 *  before it reaches a download URL. */
export const RELEASE_TAG_RE = /^v\d+\.\d+\.\d+$/;

export type ParsedVersion = [major: number, minor: number, patch: number];

/** Parse `"1.2.3"` or `"v1.2.3"` into numeric parts. Returns null for
 *  anything that isn't exactly three numeric dot-separated fields.
 *  Tolerates wrapping double quotes: binaries built before the
 *  scripts/build.sh --define quoting fix baked literal quote chars
 *  into their version string (`loadout "0.6.0"`), and those builds
 *  are already in the field reporting that via /api/status. */
export function parseVersion(input: string): ParsedVersion | null {
  const cleaned = input.trim().replace(/^"(.*)"$/, "$1");
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(cleaned);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareVersions(a: ParsedVersion, b: ParsedVersion): -1 | 0 | 1 {
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

/**
 * True when `candidate` (bare version or `v`-tag) is strictly newer
 * than `installed`. False when either side doesn't parse — an
 * unparsable side means a dev build or a malformed tag, and "no
 * update available" is the safe answer for both.
 */
export function isNewerVersion(candidate: string, installed: string): boolean {
  const c = parseVersion(candidate);
  const i = parseVersion(installed);
  if (!c || !i) return false;
  return compareVersions(c, i) === 1;
}

/** True when both sides parse and denote the same version (ignoring
 *  the optional `v` prefix). False if either is unparsable. */
export function versionsEqual(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return false;
  return compareVersions(pa, pb) === 0;
}
