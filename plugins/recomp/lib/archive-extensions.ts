/**
 * Archive formats `lib/pipeline-archive.ts:extractArchive` can unpack.
 * Single source of truth for the two gates in front of it:
 *
 *   - `backend.ts` `importModFromDisk` / `importGameFromDisk` reject a
 *     picked path whose extension isn't listed here, so a file the
 *     extractor can't read is refused BEFORE the path-gate accepts it
 *     (rather than failing with an opaque "Unsupported archive format"
 *     mid-pipeline).
 *   - `app.tsx` filters the import file-browser to these formats (as
 *     bare tokens, `.tar.gz` → `gz`), intersected with the catalog
 *     entry's `acceptExtensions`, so the user can't pick a file the
 *     backend would then reject.
 *
 * `.rar` / `.7z` go through libarchive's `bsdtar` (declared in
 * package.json `systemTools`, checked by loadout-doctor); everything else
 * through `unzip` / `tar`. `.appimage` is deliberately NOT here: it's a
 * download-only install type, never a user-picked import.
 */
export const ARCHIVE_EXTENSIONS = [
  ".zip",
  ".tar",
  ".tar.gz",
  ".tgz",
  ".7z",
  ".rar",
] as const;

export function hasArchiveExtension(path: string): boolean {
  const lower = path.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** The same set as single-token file-browser filters (`.tar.gz` → `gz`,
 *  deduplicated, order preserved). */
export const ARCHIVE_PICKER_TOKENS: readonly string[] = [
  ...new Set(ARCHIVE_EXTENSIONS.map((e) => e.slice(e.lastIndexOf(".") + 1))),
];

/**
 * File-browser filter for a manual-import entry: the catalog's declared
 * `acceptExtensions` narrowed to what the backend can unpack. If the entry
 * declares nothing usable, fall back to the full supported set so the
 * browser shows "no matching entries" (with the supported list) up front
 * rather than letting an unpickable file through to a backend rejection.
 */
export function supportedImportExtensions(accept?: readonly string[]): string[] {
  const want = (accept ?? []).map((e) => e.replace(/^\./, "").toLowerCase());
  const inter = want.filter((e) => ARCHIVE_PICKER_TOKENS.includes(e));
  return inter.length > 0 ? inter : [...ARCHIVE_PICKER_TOKENS];
}
