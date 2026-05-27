#!/usr/bin/env bun
/**
 * Scaffold a README.md for every plugin under `plugins/<id>/` that
 * doesn't have one yet, and refresh the root README's plugin-gallery
 * block between the `<!-- PLUGINS_GALLERY_START / _END -->` markers.
 *
 * Metadata sources, in priority order:
 *   1. `plugins/<id>/plugin.json` — `name` and `description`. This
 *      is the loader manifest; when present it's the source of truth
 *      for what the user sees in the overlay.
 *   2. `plugins/<id>/package.json:description` — fallback when the
 *      manifest doesn't ship one yet.
 *   3. `toDisplayName(id)` for the name when neither source has a
 *      `name` field — handles acronyms via `DISPLAY_NAME_OVERRIDES`.
 *
 * Existing READMEs are NEVER overwritten by default — plugin authors
 * who've written richer docs (e.g. `quick-links/README.md` with its
 * 200+ lines of historical context) keep their content. Re-run this
 * script whenever a new plugin lands; idempotent on already-
 * scaffolded entries.
 *
 * Usage:
 *   bun scripts/scaffold-plugin-readmes.ts            # scaffold + gallery refresh
 *   bun scripts/scaffold-plugin-readmes.ts --force    # overwrite existing READMEs too
 *
 * The --force mode is intentionally not the default: README files
 * accumulate hand-tuned context that the template can't reproduce.
 * Useful right after a template edit to reset every scaffolded
 * README at once; review the diff before committing.
 */

import { readdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PLUGINS_DIR = join(ROOT, "plugins");
const FORCE = process.argv.includes("--force");

interface PluginMeta {
  id: string;
  /** Display name, e.g. "Quick Links" — derived from the id. */
  name: string;
  /** Short description from package.json. */
  description: string;
}

/**
 * Plugin ids whose default Title-Case rendering is wrong because of
 * embedded acronyms (HLTB, RGB, TDP, IPC, …) or branded names
 * (SteamGridDB, ProtonDB, RecompHub, …). The fallback name-from-id
 * derivation handles the long tail of plugins; this table is the
 * targeted override for the cases where it produces something
 * obviously wrong on the user-facing READMEs + gallery.
 */
const DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  hltb: "HLTB",
  "lsfg-vk": "LSFG-VK",
  "tdp-control": "TDP Control",
  "rgb-control": "RGB Control",
  "steam-gamescope-ipc": "Gamescope IPC",
  steamgriddb: "SteamGridDB",
  "protondb-badges": "ProtonDB Badges",
  recomp: "RecompHub",
  "handy-dictation": "Dictation",
};

/**
 * Plugin ids whose README is hand-tuned and must NEVER be
 * overwritten — not even by `--force`. Scaffold + force-scaffold
 * both skip these.
 *
 * If you want to rewrite one anyway, run `--force-all`. We
 * deliberately don't expose that as the default because the
 * hand-tuned files (200+ lines on quick-links) can't be regenerated
 * from a template.
 */
const HAND_TUNED: ReadonlySet<string> = new Set(["quick-links"]);
const FORCE_ALL = process.argv.includes("--force-all");

/** Convert `quick-links` → "Quick Links". Override table wins for
 *  acronym-bearing plugin ids. */
function toDisplayName(id: string): string {
  if (DISPLAY_NAME_OVERRIDES[id]) return DISPLAY_NAME_OVERRIDES[id];
  return id
    .split("-")
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join(" ");
}

/**
 * Load a plugin's metadata. The codebase has three places where
 * `name` / `description` can live (historical accretion), checked
 * in priority order:
 *
 *   1. `plugin.json` top-level — the standalone loader manifest
 *      format. Used by a few plugins (e.g. quick-links).
 *   2. `package.json:plugin.{name,description}` — the nested block
 *      most plugins use today (26 of 29).
 *   3. `package.json:{name,description}` — flat metadata, for the
 *      one or two plugins that haven't migrated.
 *
 * For the display name, the override table beats everything (so
 * acronym-bearing ids like `hltb` always render as "HLTB" no
 * matter what the manifest says). For the description, the first
 * non-empty source wins.
 */
function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    // Surface malformed JSON to stderr — a plugin with a broken
    // package.json would otherwise scaffold a placeholder README
    // silently, costing the maintainer 10 minutes of "why is this
    // blank". Returning `{}` keeps the script running for the
    // remaining plugins.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[scaffold] failed to parse ${path}: ${msg}`);
    return {};
  }
}

function pickString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

function loadPluginMeta(id: string): PluginMeta | null {
  const manifest = readJson(join(PLUGINS_DIR, id, "plugin.json"));
  const pkg = readJson(join(PLUGINS_DIR, id, "package.json"));
  const pkgPlugin = (pkg.plugin ?? {}) as Record<string, unknown>;
  if (Object.keys(manifest).length === 0 && Object.keys(pkg).length === 0) {
    return null;
  }
  // Override table wins for the name. Otherwise prefer the
  // manifest's display name, then the nested plugin.name, then
  // derive from the id. Intentionally NOT falling through to
  // `pkg.name` — that's the npm-style "@loadout/plugin-<id>"
  // which would render as ugly user-facing text.
  const name =
    DISPLAY_NAME_OVERRIDES[id] ??
    pickString(manifest.name, pkgPlugin.name) ??
    toDisplayName(id);
  const description =
    pickString(manifest.description, pkgPlugin.description, pkg.description) ??
    "(No description yet — add one to plugin.json or package.json:plugin.description.)";
  return { id, name, description };
}

function templateFor(meta: PluginMeta): string {
  return [
    `# ${meta.name}`,
    "",
    `> ${meta.description}`,
    "",
    "![Screenshot](./assets/screenshot.png)",
    "",
    "## See also",
    "",
    `- [All plugins](../../README.md#plugins)`,
    `- [Plugin model](../../README.md#plugin-model)`,
    "",
  ].join("\n");
}

/**
 * Build the root-README plugin-gallery markdown — alphabetical
 * heading + description + screenshot per plugin. Wrapped in marker
 * comments so this script can rewrite it idempotently without
 * touching the rest of the README.
 */
function buildGalleryMarkdown(metas: PluginMeta[]): string {
  const lines: string[] = [];
  for (const meta of metas) {
    lines.push(`### [${meta.name}](plugins/${meta.id}/README.md)`);
    lines.push("");
    lines.push(meta.description);
    lines.push("");
    lines.push(
      `![${meta.name} screenshot](plugins/${meta.id}/assets/screenshot.png)`,
    );
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

const GALLERY_START =
  "<!-- PLUGINS_GALLERY_START — generated by scripts/scaffold-plugin-readmes.ts -->";
const GALLERY_END = "<!-- PLUGINS_GALLERY_END -->";

function updateRootGallery(
  metas: PluginMeta[],
): "updated" | "unchanged" | "no-markers" {
  const readmePath = join(ROOT, "README.md");
  const text = readFileSync(readmePath, "utf8");
  const start = text.indexOf(GALLERY_START);
  const end = text.indexOf(GALLERY_END);
  if (start < 0 || end < 0 || end <= start) return "no-markers";
  const gallery = buildGalleryMarkdown(metas);
  const before = text.slice(0, start + GALLERY_START.length);
  const after = text.slice(end);
  const next = `${before}\n\n${gallery}\n\n${after}`;
  if (next === text) return "unchanged";
  writeFileSync(readmePath, next);
  return "updated";
}

function main(): void {
  const ids = readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  let scaffolded = 0;
  let skipped = 0;
  let handTuned = 0;
  let missingPkg = 0;
  const metas: PluginMeta[] = [];
  for (const id of ids) {
    const meta = loadPluginMeta(id);
    if (!meta) {
      console.warn(`[scaffold] ${id}: no package.json — skipping`);
      missingPkg += 1;
      continue;
    }
    metas.push(meta);
    const readmePath = join(PLUGINS_DIR, id, "README.md");
    const exists = existsSync(readmePath);
    // HAND_TUNED README files are protected from --force. The only
    // way to overwrite them is the explicit --force-all opt-in,
    // which is intentionally undocumented in the file header so
    // contributors don't reach for it by accident.
    if (exists && HAND_TUNED.has(id) && !FORCE_ALL) {
      console.log(`[scaffold] ${id}: hand-tuned (HAND_TUNED set) — skipping`);
      handTuned += 1;
      continue;
    }
    if (exists && !FORCE && !FORCE_ALL) {
      skipped += 1;
      continue;
    }
    writeFileSync(readmePath, templateFor(meta));
    console.log(`[scaffold] ${id}: ${exists ? "overwrote" : "created"} README.md`);
    scaffolded += 1;
  }
  console.log(
    `\nScaffold — created ${scaffolded}, skipped ${skipped} (already had README), ${handTuned} hand-tuned, ${missingPkg} missing package.json.`,
  );

  const galleryResult = updateRootGallery(metas);
  if (galleryResult === "no-markers") {
    console.warn(
      `Gallery — root README missing markers ${GALLERY_START} / ${GALLERY_END}; skipped.`,
    );
  } else if (galleryResult === "unchanged") {
    console.log(`Gallery — no changes (${metas.length} entries already current)`);
  } else {
    console.log(`Gallery — refreshed ${metas.length} plugin entries in README.md`);
  }
}

main();
