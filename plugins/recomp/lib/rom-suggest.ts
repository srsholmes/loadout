/**
 * ROM file suggestion for the recomp detail page.
 *
 * The detail page calls into this on mount when a game requires a
 * ROM and `settings.romDirectory` is configured. We walk that
 * directory recursively (capped depth, capped breadth), filter
 * candidates by the manifest's `romInfo.extensions`, then rank by
 * fuzzy similarity to the game title.
 *
 * Goal: surface the obvious ROM ("Super Mario 64 (USA).z64" when
 * the game is "Super Mario 64 (Render96 HD)") without making the
 * user dig through a file browser. Browse + manual textbox stay as
 * fallback for non-obvious cases (ROMs named `baserom.us.z64`,
 * etc.).
 *
 * Matching uses `fuzzysort` (already a hoisted dep via
 * `@loadout/ui`'s game-search). We don't reuse
 * `fuzzySearchGames` from `@loadout/ui` because that's tuned
 * for the opposite direction (one query, many games); here we have
 * one game-title query and many filename targets.
 */
import { readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import fuzzysort from "fuzzysort";

export interface RomSuggestion {
  /** Absolute path on disk. */
  path: string;
  /** Just the filename, for the headline line of the UI tile. */
  basename: string;
  /** fuzzysort score (closer to 0 = better; we filter the obviously
   *  bad and clamp to a top-N — useful for debugging / ordering
   *  display badges in the UI later). */
  score: number;
}

/** Game-title noise we strip before matching. Most are platform /
 *  fork / branding annotations that NEVER appear in a ROM filename
 *  (and would only drag the fuzzy score down). The list is small
 *  on purpose — punctuation + `(...)` removal handles most of the
 *  rest. */
const TITLE_STOPWORDS = new Set([
  // Generic English articles + connectives
  "the", "of", "a", "an", "and", "vs",
  // Common edition / version annotations
  "edition", "version", "ver", "remake", "remastered", "deluxe",
  // Recomp-specific suffixes our manifests use
  "decomp", "recomp", "recompiled", "render96", "hd", "ray",
  "tracing", "rt", "rt64",
  // Platform / port markers that pollute filename-side too
  "pc", "port",
]);

/**
 * Normalize a game name for fuzzy matching:
 * - Drop content inside `(...)` and `[...]` (platform / fork /
 *   region annotations rarely appear in ROM filenames)
 * - Lowercase
 * - Tokenize on non-alphanumeric, drop stopwords + single chars
 * - Rejoin with spaces — fuzzysort treats this as a search query
 */
function normalizeTitle(name: string): string {
  const cleaned = name
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ");
  return cleaned
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((tok) => tok.length >= 2 && !TITLE_STOPWORDS.has(tok))
    .join(" ");
}

/**
 * Walk a directory recursively, returning files whose extension is
 * in `extensions` (lowercased, leading-dot stripped). Capped at
 * depth 5 and 3_000 matching files: the suggest now scans the whole
 * `Emulation/roms` parent (all platform subdirs), so this bounds the
 * fuzzy-match cost (and a misconfigured romDirectory pointed at `$HOME`
 * can't spin forever). Each `readdir` is awaited, so the walk yields to
 * the event loop rather than blocking it. 3_000 matching ROM files is a
 * larger library than any realistic setup, so recall is unaffected.
 */
async function walkForExtensions(
  root: string,
  extensions: ReadonlySet<string>,
  cap = 3000,
  maxDepth = 5,
  dirBudget = 5000,
): Promise<string[]> {
  const found: string[] = [];
  // Cap directories visited too, not just matched files: the `found`
  // cap only grows on a match, so a large tree of NON-matching files
  // (e.g. romDirectory pointed at $HOME or a big media library) would
  // otherwise `readdir` every directory unbounded on each detail-page
  // open. This bounds the traversal regardless of how few files match.
  let dirsVisited = 0;
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || found.length >= cap || dirsVisited >= dirBudget) {
      return;
    }
    dirsVisited++;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable / permission denied / not a dir → skip silently
    }
    for (const entry of entries) {
      if (found.length >= cap || dirsVisited >= dirBudget) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip hidden dirs and likely-noise containers
        if (entry.name.startsWith(".") || entry.name === "node_modules") {
          continue;
        }
        await visit(full, depth + 1);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase().replace(/^\./, "");
        if (extensions.size === 0 || extensions.has(ext)) {
          found.push(full);
        }
      }
    }
  };
  await visit(root, 0);
  return found;
}

export interface SuggestOptions {
  /** Top-N results to return. */
  limit?: number;
  /** fuzzysort threshold — scores worse than this are excluded.
   *  Defaults to `-10000` (loose enough to catch ROMs with extra
   *  region/version annotations, tight enough that random files in
   *  the ROM dir don't bubble up). */
  threshold?: number;
}

/**
 * Find likely-matching ROM files in `romDirectory` for `gameTitle`.
 * Empty input or no matches returns `[]` — caller renders nothing
 * special, browse / manual entry stay available.
 *
 * Reads from `romDirectory`. Honours `extensions` if provided (e.g.
 * `["z64", "n64", "v64"]` for SM64-class games).
 */
export async function suggestRomsForTitle(
  gameTitle: string,
  romDirectory: string,
  extensions: ReadonlyArray<string>,
  opts: SuggestOptions = {},
): Promise<RomSuggestion[]> {
  const { limit = 5, threshold = -10000 } = opts;

  const query = normalizeTitle(gameTitle);
  if (query.length === 0) return [];

  const allowedExts = new Set(
    extensions.map((e) => e.toLowerCase().replace(/^\./, "")),
  );
  const files = await walkForExtensions(romDirectory, allowedExts);
  if (files.length === 0) return [];

  // Build search targets from the basenames (no extension, no path
  // separators). fuzzysort would also accept full paths, but
  // matching on basename keeps deeply-nested paths from being
  // penalised — the same ROM under `n64/` shouldn't score worse
  // than one at the root.
  const targets = files.map((path) => {
    const base = basename(path);
    const stem = base.replace(/\.[^.]+$/, "");
    return { path, base, normalized: normalizeTitle(stem) };
  });

  // fuzzysort.go ranks by score (0 = perfect, negative = worse).
  // We feed it the normalized stems so the same noise-stripping
  // applies on both sides — "(USA)" / "(Render96 HD)" don't drag
  // the score down.
  const prepared = targets.map((t) => ({
    ...t,
    prep: fuzzysort.prepare(t.normalized),
  }));
  const hits = fuzzysort.go(query, prepared, {
    key: "prep",
    threshold,
    limit,
  });

  return hits.map((hit) => ({
    path: hit.obj.path,
    basename: hit.obj.base,
    score: hit.score,
  }));
}
