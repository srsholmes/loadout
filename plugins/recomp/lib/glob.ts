/**
 * Simple glob matching: `*` matches zero or more characters (not `/`).
 * Ported from pipeline_core.rs glob_matches().
 *
 * Case-INSENSITIVE: upstreams routinely change filename casing
 * between releases ("foo.AppImage" → "foo.appimage",
 * "*-Linux.zip" → "*-linux.zip"). A case-sensitive match would
 * silently fail to find the asset and the user would see "no
 * release available for your platform" — confusing when the file
 * is right there. Matching case-insensitively catches both
 * spellings without requiring every manifest to be brittle-exact.
 * (devilutionx's `.AppImage` → `.appimage` migration is what
 * surfaced this in the deep-test runs.)
 */
export function globMatches(pattern: string, text: string): boolean {
  // Defensive: null patterns DID slip through here once (drmario64-
  // recomp's `releaseAssets: { linux: null }` was returned as
  // `value: null` by getEffectivePlatformValue before its null guard
  // fix). Fail closed so future regressions surface as "no match"
  // (rendered as Unavailable in the UI) rather than a runtime
  // `null.toLowerCase` crash mid-install.
  if (pattern == null || text == null) return false;
  const p = pattern.toLowerCase();
  const t = text.toLowerCase();
  const parts = p.split("*");
  if (parts.length === 0) return p === t;

  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === "") continue;

    const found = t.indexOf(part, pos);
    if (found === -1) return false;

    // First segment must anchor at start
    if (i === 0 && found !== 0) return false;

    pos = found + part.length;
  }

  // If pattern doesn't end with *, text must be fully consumed
  if (!p.endsWith("*")) return pos === t.length;

  return true;
}
