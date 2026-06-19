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

/**
 * Human titles for each captured page. The capture script names files
 * `assets/screenshot.png` (landing) and `assets/screenshot-<page>.png`
 * for sub-pages; `<page>` matches `PAGE_RECIPES` in
 * `scripts/capture-screenshots.ts`. Keep these two in loose sync.
 */
const PAGE_TITLES: Record<string, string> = {
  "": "Overview",
  detail: "Game detail",
  settings: "Settings",
  config: "Settings",
  presets: "Presets",
  library: "Library",
  installed: "Installed games",
  downloads: "Downloads",
  detected: "Detected games",
};

// Display order for a plugin's screenshots: landing first, then this
// preferred order, then anything else alphabetically.
const PAGE_ORDER = [
  "",
  "library",
  "installed",
  "downloads",
  "detected",
  "detail",
  "presets",
  "settings",
  "config",
];

interface Shot {
  page: string;
  title: string;
  file: string;
}

/** Discover a plugin's captured screenshots (landing + sub-pages),
 *  ordered for display. */
function pluginScreenshots(id: string): Shot[] {
  const dir = join(PLUGINS_DIR, id, "assets");
  if (!existsSync(dir)) return [];
  const shots: Shot[] = [];
  for (const file of readdirSync(dir)) {
    const m = /^screenshot(?:-([a-z0-9-]+))?\.png$/.exec(file);
    if (!m) continue;
    const page = m[1] ?? "";
    shots.push({ page, title: PAGE_TITLES[page] ?? toDisplayName(page), file });
  }
  const rank = (p: string) => {
    const i = PAGE_ORDER.indexOf(p);
    return i === -1 ? PAGE_ORDER.length : i;
  };
  shots.sort((a, b) => rank(a.page) - rank(b.page) || a.page.localeCompare(b.page));
  return shots;
}

/**
 * A short "what it does + why it's useful" paragraph per plugin,
 * rendered under the one-line description in each README. Plain-English
 * and benefit-oriented — not exhaustive docs. Plugins without an entry
 * just show their one-liner (and hand-tuned READMEs ignore this).
 */
const PLUGIN_ABOUT: Record<string, string> = {
  "battery-tracker":
    "Keeps an eye on your battery while you play — current charge, how fast it's draining or charging, estimated time left, and a short history of the session. On a handheld it answers the question that matters: will I reach a save point before I need the charger?",
  bluetooth:
    "Connect, disconnect, and scan for paired Bluetooth devices straight from the overlay, so swapping to headphones or a controller never means dropping back to the desktop — handy in Gaming Mode where Steam's own Bluetooth controls are fiddly.",
  "disable-controller-input":
    "Mutes a specific controller by asking InputPlumber to drop its virtual inputs — the fix for handhelds where the built-in gamepad steals player 1 from the controller you actually want to use. Toggle a pad off without unpairing or unplugging it.",
  "display-settings":
    "Adjust screen brightness and colour saturation from the overlay — a quick way to dim the panel at night or punch up washed-out colours without leaving your game.",
  "fan-control":
    "Monitor temperatures and fan speed and apply fan-curve presets, trading noise for cooling on demand. Useful for keeping a handheld quiet on the couch or cooler during a long session.",
  "flatpak-manager":
    "List and update your installed Flatpak apps without dropping to the desktop, so emulators and launchers stay current from inside Gaming Mode.",
  hltb: "Pulls HowLongToBeat completion times into Steam's library and store pages, so you can see at a glance how long a game takes to finish and pick something that fits the time you have.",
  "input-plumber":
    "Installs the InputPlumber input-routing daemon that other controller features rely on, and quietly does nothing if it's already present. Mostly a one-time setup helper so the rest 'just works'.",
  "launch-options":
    "Edit Steam launch options per game and save reusable presets, turning common flags and environment variables into a couple of clicks instead of typed-out strings — great for applying the same tweak across many games.",
  "lsfg-vk":
    "Installs and configures the LSFG-VK Vulkan frame-generation layer and applies it per game, boosting perceived frame rate on titles that run below your display's refresh. Set it up once and toggle it where it actually helps.",
  "network-info":
    "Shows your connection details — WiFi signal, addresses — and runs a Cloudflare speed test from the overlay, so you can quickly tell whether the network (not the game) is the problem.",
  playtime:
    "Tracks how long you play each game, including non-Steam titles, with per-day breakdowns and an all-time view that merges in Steam's own lifetime hours — so you can actually see where your time goes.",
  "protondb-badges":
    "Adds ProtonDB compatibility ratings to your Steam library — a tier badge on every game tile plus per-game detail in the home widget — so you know whether something is likely to run well on Linux/Proton before you install it.",
  recomp:
    "Browse, install, and launch community recompilations and native ports of classic games — you supply your own game files and it handles the rest, turning supported retro titles into properly native Linux builds.",
  "rgb-control":
    "Control the RGB lighting on Linux handhelds via OpenRGB, sysfs LEDs, and platform-specific interfaces — set colours and effects, or kill the lights to save battery, without reaching for extra desktop tools.",
  "sound-loader":
    "Browse, install, and switch community UI sound packs from deckthemes.com, giving Steam's interface sounds a personal touch from inside Gaming Mode.",
  steamgriddb:
    "Browse and apply custom artwork — grids, heroes, logos, icons — from SteamGridDB. The fix for non-Steam shortcuts and any title with missing or ugly library art.",
  "storage-cleaner":
    "Shows where your disk space is going, including shader-cache sizes, and lets you reclaim it in a couple of taps — useful on storage-tight handhelds before installing the next big game.",
  "store-bridge":
    "Surfaces your Epic, GOG, Amazon, Ubisoft, and xCloud libraries and adds them to Steam as shortcuts, so non-Steam-store games install and launch right alongside everything else.",
  "tdp-control":
    "Set your CPU/APU power limit (TDP) with quick presets and a slider, optionally per game, to balance performance against battery life and heat — the single biggest knob for tuning a handheld.",
  "theme-loader":
    "Browse, install, and toggle community CSS themes for Steam's Big Picture UI, restyling the interface to taste from inside Gaming Mode.",
};

function templateFor(meta: PluginMeta): string {
  const shots = pluginScreenshots(meta.id);
  const about = PLUGIN_ABOUT[meta.id];
  // One screenshot → show it untitled (a heading would be noise). More
  // than one → title each so the reader knows which view they're seeing.
  const shotBlock =
    shots.length > 1
      ? shots.flatMap((s) => [
          `### ${s.title}`,
          "",
          `![${meta.name} — ${s.title}](./assets/${s.file})`,
          "",
        ])
      : [
          `![${meta.name}](./assets/${shots[0]?.file ?? "screenshot.png"})`,
          "",
        ];
  return [
    `# ${meta.name}`,
    "",
    `> ${meta.description}`,
    "",
    ...(about ? [about, ""] : []),
    "## Screenshots",
    "",
    ...shotBlock,
    "## See also",
    "",
    `- [All plugins](../../README.md#plugins)`,
    `- [Plugin model](../../README.md#plugin-model)`,
    "",
  ].join("\n");
}

/**
 * Curated showcase for the top of the root README — the most
 * visually/functionally impactful plugins, shown with their hero
 * (landing) screenshot. Order here is the order they appear.
 */
const FEATURED: readonly string[] = [
  "recomp",
  "store-bridge",
  "steamgriddb",
  "theme-loader",
  "hltb",
  "protondb-badges",
  "playtime",
  "lsfg-vk",
];

/** Featured block: big hero screenshot + linked heading per plugin. */
function buildFeaturedMarkdown(metas: PluginMeta[]): string {
  const byId = new Map(metas.map((m) => [m.id, m]));
  const lines: string[] = [];
  for (const id of FEATURED) {
    const meta = byId.get(id);
    if (!meta) continue;
    lines.push(`#### [${meta.name}](plugins/${id}/README.md)`);
    lines.push("");
    lines.push(meta.description);
    lines.push("");
    lines.push(`![${meta.name}](plugins/${id}/assets/screenshot.png)`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/**
 * Full plugin list for the root README — a compact, scannable index
 * (linked name + one-liner) for every plugin. The hero shots live in
 * the Featured block above and on each plugin's own README, so this
 * stays image-free to keep the README tight.
 */
function buildGalleryMarkdown(metas: PluginMeta[]): string {
  return metas
    .map((m) => `- **[${m.name}](plugins/${m.id}/README.md)** — ${m.description}`)
    .join("\n");
}

const FEATURED_START =
  "<!-- PLUGINS_FEATURED_START — generated by scripts/scaffold-plugin-readmes.ts -->";
const FEATURED_END = "<!-- PLUGINS_FEATURED_END -->";
const GALLERY_START =
  "<!-- PLUGINS_GALLERY_START — generated by scripts/scaffold-plugin-readmes.ts -->";
const GALLERY_END = "<!-- PLUGINS_GALLERY_END -->";

/** Rewrite the content between a pair of marker comments in the root
 *  README, leaving everything else untouched. */
function replaceBetween(
  text: string,
  startMarker: string,
  endMarker: string,
  body: string,
): { text: string; status: "updated" | "unchanged" | "no-markers" } {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker);
  if (start < 0 || end < 0 || end <= start) {
    return { text, status: "no-markers" };
  }
  const before = text.slice(0, start + startMarker.length);
  const after = text.slice(end);
  const next = `${before}\n\n${body}\n\n${after}`;
  return { text: next, status: next === text ? "unchanged" : "updated" };
}

function updateRootGallery(
  metas: PluginMeta[],
): "updated" | "unchanged" | "no-markers" {
  const readmePath = join(ROOT, "README.md");
  let text = readFileSync(readmePath, "utf8");
  const featured = replaceBetween(
    text,
    FEATURED_START,
    FEATURED_END,
    buildFeaturedMarkdown(metas),
  );
  text = featured.text;
  const gallery = replaceBetween(
    text,
    GALLERY_START,
    GALLERY_END,
    buildGalleryMarkdown(metas),
  );
  text = gallery.text;
  if (featured.status === "no-markers" || gallery.status === "no-markers") {
    return "no-markers";
  }
  if (featured.status === "unchanged" && gallery.status === "unchanged") {
    return "unchanged";
  }
  writeFileSync(readmePath, text);
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
