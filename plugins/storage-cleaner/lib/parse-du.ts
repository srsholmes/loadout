/**
 * Pure parser for `du -sb path1 path2 ...` stdout. Each line is
 * "<bytes>\t<path>". Returns a Map keyed by the path argument so
 * callers can do a single fork per call instead of one per directory
 * (the source plugin's hot-loop pattern on Decks with 200+ orphaned
 * shadercache entries).
 */

export function parseDuOutput(stdout: string): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const line of stdout.split("\n")) {
    // `du -sb` separates with a literal tab; be permissive and accept
    // any run of whitespace so a `du -h` invocation (which we don't
    // currently make but might in the future) doesn't silently parse
    // to nothing.
    const m = line.match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    // Both groups are mandatory, so on a match they are always present;
    // `?? ""` is a no-op there and keeps the types string.
    sizes.set(m[2] ?? "", parseInt(m[1] ?? "", 10));
  }
  return sizes;
}
