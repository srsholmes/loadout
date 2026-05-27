/**
 * Helpers for working with ThemeDB-format theme packs (the community
 * format used by themes published to deckthemes.com).
 *
 * A pack is a directory containing:
 *
 *   theme.json         — the manifest (name, inject, patches, ...)
 *   *.css              — stylesheets referenced by inject / patches
 *
 * We support manifest_version 1 and 2.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

// ─── CSS Class Translation ─────────────────────────────────────────
// Community themes use obfuscated class names from a specific Steam
// build. Steam changes these on updates. The translation map (loaded
// from `translations-cache.ts`, which fetches from
// api.deckthemes.com at runtime) maps old class names → current ones
// so themes targeting older builds still apply.

import { getTranslationsSync } from "./translations-cache";

/** Replace old obfuscated class names in CSS with current ones. */
function translateCss(css: string, translations: Map<string, string>): string {
  if (translations.size === 0) return css;

  // Collect only translations that appear in the CSS, sorted longest-first
  // to prevent shorter substrings from matching before the full class name.
  const applicable: [string, string][] = [];
  for (const [oldName, newName] of translations) {
    if (oldName.length < 8) continue; // Skip short names to avoid false matches
    if (!css.includes(oldName)) continue;
    applicable.push([oldName, newName]);
  }
  applicable.sort((a, b) => b[0].length - a[0].length);

  let result = css;
  for (const [oldName, newName] of applicable) {
    // Use word-boundary-aware replacement: class names are bounded by
    // non-alphanumeric-underscore-hyphen characters (., space, {, etc.)
    const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("(?<![a-zA-Z0-9_-])" + escaped + "(?![a-zA-Z0-9_-])", "g");
    result = result.replace(re, newName);
  }
  return result;
}
import type {
  InjectMap,
  ThemePackManifest,
  ThemePatch,
} from "./types";

export interface ThemeMeta {
  /** Display name from the community registry, if known. */
  author: string | null;
  description: string | null;
  version: string | null;
  /** Upstream source URL (GitHub repo or deckthemes page). */
  sourceUrl: string | null;
  /** First 4 KB of the upstream LICENSE/COPYING file, if found. */
  license: { fileName: string; content: string } | null;
}

export interface InstalledPack {
  /** Our canonical ID — the deckthemes UUID if known, else the directory name. */
  id: string;
  /** Absolute path to the directory containing `theme.json`. */
  dir: string;
  manifest: ThemePackManifest;
  meta: ThemeMeta | null;
}

const LICENSE_FILE_NAMES = [
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "LICENCE",
  "LICENCE.md",
  "LICENCE.txt",
  "COPYING",
  "COPYING.md",
];
const LICENSE_MAX_BYTES = 4 * 1024;

/**
 * Walk up from `themeRoot` toward `ceilingDir` (inclusive) looking for
 * a top-level LICENSE / LICENCE / COPYING file. Theme repos typically
 * have the license at the repo root, while the theme itself lives in
 * a subdirectory — so we scan multiple levels.
 *
 * Returns the first match found, with content truncated to 4 KB.
 */
export async function findUpstreamLicense(
  themeRoot: string,
  ceilingDir: string,
): Promise<{ fileName: string; content: string } | null> {
  const ceiling = resolve(ceilingDir);
  let cursor = resolve(themeRoot);
  for (let depth = 0; depth < 6; depth++) {
    for (const name of LICENSE_FILE_NAMES) {
      const candidate = join(cursor, name);
      try {
        const buf = await readFile(candidate);
        const content = buf.subarray(0, LICENSE_MAX_BYTES).toString("utf-8");
        return { fileName: name, content };
      } catch { /* not present */ }
    }
    if (cursor === ceiling) break;
    const parent = resolve(cursor, "..");
    if (parent === cursor || !parent.startsWith(ceiling)) break;
    cursor = parent;
  }
  return null;
}

const META_FILE = "theme-meta.json";

export async function readThemeMeta(packDir: string): Promise<ThemeMeta | null> {
  try {
    const text = await readFile(join(packDir, META_FILE), "utf-8");
    return JSON.parse(text) as ThemeMeta;
  } catch {
    return null;
  }
}

export async function writeThemeMeta(packDir: string, meta: ThemeMeta): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(packDir, META_FILE), JSON.stringify(meta, null, 2) + "\n");
}

/** Read and parse `theme.json` from a pack directory. Returns null if missing. */
export async function readManifest(
  packDir: string,
): Promise<ThemePackManifest | null> {
  const manifestPath = join(packDir, "theme.json");
  try {
    const text = await readFile(manifestPath, "utf-8");
    const json = JSON.parse(text) as ThemePackManifest;
    if (!json.name) return null;
    return json;
  } catch {
    return null;
  }
}

/**
 * Some zips wrap the theme in a top-level directory (e.g. `Round/theme.json`)
 * while others have `theme.json` at the root. Walk up to 2 levels deep to
 * find the first directory containing a `theme.json`.
 */
export async function locateThemeRoot(extractDir: string): Promise<string | null> {
  if (await readManifest(extractDir)) return extractDir;
  try {
    const entries = await readdir(extractDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sub = join(extractDir, entry.name);
      if (await readManifest(sub)) return sub;
      // Second-level peek (rare but possible for zips with a "themes/" wrapper)
      try {
        const subEntries = await readdir(sub, { withFileTypes: true });
        for (const subEntry of subEntries) {
          if (!subEntry.isDirectory()) continue;
          const leaf = join(sub, subEntry.name);
          if (await readManifest(leaf)) return leaf;
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return null;
}

/** List every installed pack in the themes root directory. */
export async function listInstalledPacks(
  themesRoot: string,
): Promise<InstalledPack[]> {
  const result: InstalledPack[] = [];
  let entries: string[];
  try {
    entries = await readdir(themesRoot);
  } catch {
    return result;
  }
  for (const name of entries) {
    const dir = join(themesRoot, name);
    let s;
    try { s = await stat(dir); } catch { continue; }
    if (!s.isDirectory()) continue;
    const manifest = await readManifest(dir);
    if (manifest) {
      const meta = await readThemeMeta(dir);
      result.push({ id: name, dir, manifest, meta });
    }
  }
  return result;
}

/**
 * Walk a ThemePackManifest and collect every CSS file that should be
 * injected, respecting the currently-selected patch variants. Files are
 * returned in deterministic order: the baseline `inject` map first, then
 * each patch in manifest key order.
 *
 * `variants` is a per-patch-name → selected value lookup. Missing entries
 * fall back to the patch's `default`.
 *
 * Returns an array of `{ file, targets }` tuples — callers are responsible
 * for loading the files and combining them.
 */
export function collectInjectFiles(
  manifest: ThemePackManifest,
  variants: Record<string, string> = {},
): Array<{ file: string; targets: string[] }> {
  const out: Array<{ file: string; targets: string[] }> = [];

  const pushMap = (map?: InjectMap) => {
    if (!map) return;
    for (const [file, targets] of Object.entries(map)) {
      if (!file) continue;
      out.push({ file, targets: Array.isArray(targets) ? targets : [] });
    }
  };

  pushMap(manifest.inject);

  if (manifest.patches) {
    for (const [patchName, patch] of Object.entries(manifest.patches)) {
      const selectedValue =
        variants[patchName] ??
        selectDefaultVariant(patch);
      const valueMap = patch.values?.[selectedValue];
      if (!valueMap) continue;
      pushMap(valueMap);
    }
  }

  return out;
}

function selectDefaultVariant(patch: ThemePatch): string {
  if (patch.default && patch.values?.[patch.default]) return patch.default;
  const first = patch.values ? Object.keys(patch.values)[0] : undefined;
  return first ?? "";
}

/**
 * Load every file from `collectInjectFiles()`, concatenate them, and return
 * the combined CSS string. Relative paths are resolved under `packDir` and
 * checked for directory traversal.
 */
export async function assemblePackCss(
  packDir: string,
  manifest: ThemePackManifest,
  variants: Record<string, string> = {},
): Promise<string> {
  const resolvedBase = resolve(packDir);
  const pieces: string[] = [];
  const cssVars: string[] = [];
  const files = collectInjectFiles(manifest, variants);

  for (const { file, targets } of files) {
    // CSS variable entries: key starts with "--", value is [cssValue, ...targets]
    // e.g. "--CGV-footer-height": ["40px", "SP"]
    if (file.startsWith("--")) {
      // The "targets" array for CSS vars has the value as the first element
      // because pushMap treats the array as targets. The actual CSS value
      // was the first element of the original array in the manifest.
      const cssValue = targets[0] ?? "";
      if (cssValue) {
        cssVars.push(`  ${file}: ${cssValue};`);
      }
      continue;
    }

    const abs = resolve(packDir, file);
    if (abs !== resolvedBase && !abs.startsWith(resolvedBase + "/")) {
      console.warn(`[theme-loader] Rejecting traversal attempt: ${file}`);
      continue;
    }
    try {
      const css = await readFile(abs, "utf-8");
      pieces.push(`/* ${file} */\n${css}`);
    } catch (err) {
      console.warn(`[theme-loader] Missing file referenced by theme.json: ${file}`, err);
    }
  }

  // Prepend CSS variables as :root declarations
  if (cssVars.length > 0) {
    pieces.unshift(`:root {\n${cssVars.join("\n")}\n}`);
  }

  let css = pieces.join("\n\n");

  // Translate old obfuscated class names to current Steam build.
  // The cache is primed at plugin start; if the user reaches this path
  // (via enableTheme), translations are required to be ready and
  // backend.ts has already gated the call.
  const translations = getTranslationsSync();
  if (translations && translations.size > 0) {
    css = translateCss(css, translations);
  }

  return css;
}

/** Return a shallow summary of patches for the frontend variant picker. */
export function summarizePatches(
  manifest: ThemePackManifest,
): Record<string, { default: string; type?: string; values: string[] }> {
  const out: Record<string, { default: string; type?: string; values: string[] }> = {};
  if (!manifest.patches) return out;
  for (const [name, patch] of Object.entries(manifest.patches)) {
    out[name] = {
      default: patch.default,
      type: patch.type,
      values: patch.values ? Object.keys(patch.values) : [],
    };
  }
  return out;
}
