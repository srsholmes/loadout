#!/usr/bin/env bun
/**
 * Capture overlay screenshots: the homepage (sidebar expanded + collapsed),
 * the settings page, and every plugin — including each plugin's in-app pages
 * (game detail, per-plugin settings/config, content tabs).
 *
 * Captures in whatever theme the overlay is CURRENTLY set to (read from
 * `data-theme`); it never changes the theme. Switch themes manually and
 * re-run to build a per-theme set under `screenshots/<theme>/`.
 *
 * The overlay shell only routes `#/`, `#/settings`, `#/plugin/<id>` — a
 * plugin's sub-pages are internal React state with no URL. So sub-pages are
 * reached by clicking DOM elements over CDP, driven by the per-plugin
 * `PAGE_RECIPES` table below (the shared `<GameCard>` carries a stable
 * `data-game-card` hook; gears/tabs/back are matched by aria-label / text).
 *
 * The CDP connection + hash navigation + recipe-step machinery is shared
 * with `capture-videos.ts` and lives in `lib/overlay-cdp.ts`.
 */
import { readdirSync, existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import {
  CDP,
  cdpWs,
  navigate,
  runSteps,
  setSidebarCollapsed,
  waitForIdle,
  type Step,
} from "./lib/overlay-cdp";

// Repo root, derived from this script's location so the capture
// script runs the same way for every contributor regardless of where
// they checked out the repo.
const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "screenshots");
const rel = (p: string) => relative(ROOT, p);

// Source of truth: every plugin directory under `plugins/` that has
// a `package.json` OR a `plugin.json` (the standalone loader
// manifest some plugins use). Sorted alphabetically so the numbered
// output filenames are stable across runs.
//
// Keep this filter in sync with `loadPluginMeta` in
// `scripts/scaffold-plugin-readmes.ts`.
// Plugins whose UI renders real, identifying device data (MAC addresses,
// SSIDs, IPs) that must never be committed to a public repo. They're skipped
// entirely rather than captured — see the network-info MAC-leak incident.
const PRIVACY_SKIP = new Set(["network-info"]);

const PLUGINS = readdirSync(join(ROOT, "plugins"), { withFileTypes: true })
  .filter(
    (d) =>
      d.isDirectory() &&
      !PRIVACY_SKIP.has(d.name) &&
      (existsSync(join(ROOT, "plugins", d.name, "package.json")) ||
        existsSync(join(ROOT, "plugins", d.name, "plugin.json"))),
  )
  .map((d) => d.name)
  .sort();

// ── Per-plugin sub-page recipes ────────────────────────────────────────────
//
// Each page is captured from a freshly-(re)navigated plugin landing, so steps
// describe the path from the landing — no need to back out between pages. If a
// step's target isn't on screen (e.g. an empty library has no tile), the page
// is skipped rather than producing a misleading shot. See the `Step`
// vocabulary in `lib/overlay-cdp.ts`.

interface PageShot {
  /** Suffix in the filename: `NN-<plugin>-<name>.png`. */
  name: string;
  steps: Step[];
}

// Per-plugin sub-pages to capture. Settings/config pages are deliberately
// NOT captured — they're not interesting screenshots.
const PAGE_RECIPES: Record<string, PageShot[]> = {
  recomp: [{ name: "detail", steps: [{ kind: "tile" }] }],
  hltb: [{ name: "detail", steps: [{ kind: "tile" }] }],
  // The landing shot is the Library (available games) tab; only the
  // Installed tab is captured as a sub-page. Downloads/Detected/detail
  // shots were dropped — they're empty/low-signal on a fresh install.
  "store-bridge": [{ name: "installed", steps: [{ kind: "text", label: "Installed" }] }],
  "launch-options": [
    { name: "detail", steps: [{ kind: "tile" }] },
    { name: "presets", steps: [{ kind: "aria", label: "Manage presets" }] },
  ],
  steamgriddb: [{ name: "detail", steps: [{ kind: "tile" }] }],
  // The custom-device form lives on its own sub-view behind the header gear —
  // a real feature page (define TDP limits for an unlisted handheld), not a
  // generic settings screen, so it's worth capturing.
  "tdp-control": [{ name: "settings", steps: [{ kind: "aria", label: "Custom device settings" }] }],
  // Custom fan-curve editor only renders in Manual mode after the Custom
  // preset is selected — flip Manual (header), then pick Custom to reveal
  // the curve graph + per-point sliders.
  "fan-control": [
    {
      name: "custom-curve",
      steps: [
        { kind: "text", label: "Manual" },
        { kind: "text", label: "Custom" },
      ],
    },
  ],
};

// Steps run on a plugin's LANDING view before its landing shot — to put a
// plugin into the state that screenshots best. PlayTime defaults to the
// week view; "All" shows the full library grid, which reads better.
const LANDING_SETUP: Record<string, Step[]> = {
  playtime: [{ kind: "text", label: "All" }],
};

/**
 * Scroll the plugin's main scroll container to a random position so the
 * game grids don't show the identical first row in every shot. No-op when
 * there's nothing meaningfully scrollable. Returns whether it scrolled
 * (so the caller can wait for newly-revealed art to load).
 */
async function scrollRandom(cdp: CDP): Promise<boolean> {
  const frac = Math.random(); // vary the view run-to-run
  const expr = `(() => {
    const els = [...document.querySelectorAll('.overflow-y-auto, [style*="overflow-y"]')];
    const el = els.find((e) => e.scrollHeight - e.clientHeight > 80);
    if (!el) return false;
    el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * ${frac});
    return true;
  })()`;
  return (await cdp.eval(expr)) === true;
}

/** Number of game-art tiles that counts as "a grid" worth scrolling. */
const GRID_TILE_THRESHOLD = 6;

// Plugins whose grid we keep pinned to the top instead of random-
// scrolling: their hero/top row is the intended look (RecompHub's hero
// row, TDP's controls, PlayTime's headline + day filters).
const NO_SCROLL = new Set(["recomp", "tdp-control", "playtime"]);

/**
 * Before a shot, randomly scroll grid views so each capture shows a
 * different slice of the library — except the `NO_SCROLL` plugins, which
 * stay at the top. Then re-wait for newly-revealed artwork to load.
 */
async function varyGridView(cdp: CDP, pluginId: string): Promise<void> {
  if (NO_SCROLL.has(pluginId)) return;
  const tiles = (await cdp.eval(`document.querySelectorAll('[data-game-card]').length`)) as number;
  if (tiles < GRID_TILE_THRESHOLD) return;
  if (await scrollRandom(cdp)) await waitForIdle(cdp);
}

// ── Post-processing: copy to plugin assets + cull stale shots ──────────────

function copyToPluginAssets(theme: string, only?: Set<string>): void {
  // Copy each plugin's shots (from the captured theme dir) into its
  // tracked `assets/` dir so the plugin README + the root README gallery
  // reference stable paths that live next to the source:
  //   landing      NN-<id>.png        → assets/screenshot.png
  //   sub-pages    NN-<id>-<page>.png → assets/screenshot-<page>.png
  // `only` (from --plugins=) scopes the copy to a subset so a filtered
  // capture never rewrites other plugins' assets.
  const srcDir = join(OUT, theme);
  if (!existsSync(srcDir)) {
    console.error(`[copy] ${rel(srcDir)} missing — run a capture first`);
    return;
  }
  PLUGINS.forEach((pid, idx) => {
    if (only && !only.has(pid)) return;
    const nn = String(idx + 3).padStart(2, "0");
    const destDir = join(ROOT, "plugins", pid, "assets");

    const landingSrc = join(srcDir, `${nn}-${pid}.png`);
    if (!existsSync(landingSrc)) {
      console.log(`[copy] skip ${pid}: ${nn}-${pid}.png not captured`);
      return;
    }
    mkdirSync(destDir, { recursive: true });
    copyFileSync(landingSrc, join(destDir, "screenshot.png"));
    console.log(`[copy] ${pid} → ${rel(join(destDir, "screenshot.png"))}`);

    for (const page of PAGE_RECIPES[pid] ?? []) {
      const src = join(srcDir, `${nn}-${pid}-${page.name}.png`);
      if (!existsSync(src)) continue; // page was skipped during capture
      const dest = join(destDir, `screenshot-${page.name}.png`);
      copyFileSync(src, dest);
      console.log(`[copy] ${pid} → ${rel(dest)}`);
    }
  });
}

function expectedFilenames(): Set<string> {
  // The set of filenames every per-theme directory SHOULD have after a
  // capture pass — the global shots, each plugin's landing, and each
  // plugin's recipe sub-pages. Anything else matching `NN-name.png` is
  // stale (plugin renamed/dropped, recipe page removed) and is culled.
  const files = new Set(["00-home.png", "02-home-sidebar-collapsed.png"]);
  PLUGINS.forEach((pid, idx) => {
    const nn = String(idx + 3).padStart(2, "0");
    files.add(`${nn}-${pid}.png`);
    for (const page of PAGE_RECIPES[pid] ?? []) {
      files.add(`${nn}-${pid}-${page.name}.png`);
    }
  });
  return files;
}

// Filename shape this script owns. Anything matching `NN-name.png`
// is potentially-stale capture output; anything NOT matching is left
// alone (e.g. a contributor's debug `notes.png` dropped in a theme dir).
const CAPTURE_FILENAME = /^\d{2}-.*\.png$/;

function cullStaleScreenshots(): void {
  // Remove screenshots/<theme>/<num>-<old-name>.png entries that don't
  // match the current expected filename set. Idempotent on a freshly-
  // captured tree. Only touches files matching the `NN-name.png` shape.
  if (!existsSync(OUT)) return;
  const expected = expectedFilenames();
  for (const themeDir of readdirSync(OUT, { withFileTypes: true })) {
    if (!themeDir.isDirectory()) continue;
    const dir = join(OUT, themeDir.name);
    for (const png of readdirSync(dir)) {
      if (!CAPTURE_FILENAME.test(png)) continue;
      if (!expected.has(png)) {
        rmSync(join(dir, png));
        console.log(`[cull] removed ${rel(join(dir, png))} (stale)`);
      }
    }
  }
}

async function main(): Promise<void> {
  // `--copy-only` and `--cull-only` skip the capture pass entirely and
  // COMPOSE (cull first so newly-orphaned shots aren't propagated to
  // assets). They don't connect to CDP, so they can't detect the live
  // theme — pass `--theme=<name>` (default `midnight`) to pick the source
  // theme dir for the asset copy.
  const args = new Set(process.argv.slice(2));
  const themeArg = [...args].find((a) => a.startsWith("--theme="))?.split("=")[1];

  // `--plugins=a,b,c` (or `--plugin=a`) limits capture to a subset. When set,
  // the global home shots are skipped and stale-culling is disabled, so a
  // focused run never touches other plugins' screenshots/assets. Numbering
  // still uses each plugin's index in the full list, so filenames stay stable.
  const onlyArg = [...args]
    .find((a) => a.startsWith("--plugins=") || a.startsWith("--plugin="))
    ?.split("=")[1];
  let only: Set<string> | null = null;
  if (onlyArg) {
    const requested = onlyArg
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const unknown = requested.filter((p) => !PLUGINS.includes(p));
    if (unknown.length) {
      console.error(`[capture] unknown plugin(s): ${unknown.join(", ")}`);
      console.error(`[capture] available: ${PLUGINS.join(", ")}`);
      process.exit(1);
    }
    only = new Set(requested);
    console.log(`[capture] limited to: ${requested.join(", ")}`);
  }

  if (args.has("--copy-only") || args.has("--cull-only")) {
    if (args.has("--cull-only") && !only) cullStaleScreenshots();
    if (args.has("--copy-only")) copyToPluginAssets(themeArg ?? "midnight", only ?? undefined);
    return;
  }

  const cdp = await CDP.connect(await cdpWs());

  // Capture whatever theme the overlay is currently in — never change it.
  const theme =
    ((await cdp.eval(`document.documentElement.getAttribute('data-theme')`)) as string | null) ??
    "midnight";
  console.log(`[theme] capturing current theme: ${theme}`);

  // Global surfaces (home only — the settings page isn't a useful shot).
  // Skipped on a filtered run — only the requested plugins are captured.
  if (!only) {
    await setSidebarCollapsed(cdp, false);
    await navigate(cdp, "#/");
    const home = join(OUT, theme, "00-home.png");
    await cdp.screenshot(home, rel(home));
    await navigate(cdp, "#/");
    await setSidebarCollapsed(cdp, true);
    const collapsed = join(OUT, theme, "02-home-sidebar-collapsed.png");
    await cdp.screenshot(collapsed, rel(collapsed));
    await setSidebarCollapsed(cdp, false);
  }

  // Each plugin: landing shot, then each recipe sub-page.
  for (let idx = 0; idx < PLUGINS.length; idx++) {
    const pid = PLUGINS[idx]!;
    if (only && !only.has(pid)) continue;
    const nn = String(idx + 3).padStart(2, "0");
    await navigate(cdp, `#/plugin/${pid}`);
    if (LANDING_SETUP[pid]) await runSteps(cdp, LANDING_SETUP[pid]);
    await varyGridView(cdp, pid);
    const landing = join(OUT, theme, `${nn}-${pid}.png`);
    await cdp.screenshot(landing, rel(landing));

    for (const page of PAGE_RECIPES[pid] ?? []) {
      // Reset to the plugin landing so each page starts from a clean base.
      // A plugin's sub-pages are internal React state with no hash change,
      // so re-setting the SAME `#/plugin/<id>` is a no-op — bounce through
      // home to force a fresh remount back to the landing view.
      await navigate(cdp, "#/");
      await navigate(cdp, `#/plugin/${pid}`);
      const reached = await runSteps(cdp, page.steps);
      if (!reached) {
        console.log(`  ↷ skip ${pid}-${page.name} (nav target not on screen)`);
        continue;
      }
      await varyGridView(cdp, pid); // grid sub-pages (e.g. store tabs) vary too
      const sub = join(OUT, theme, `${nn}-${pid}-${page.name}.png`);
      await cdp.screenshot(sub, rel(sub));
    }
  }

  // Culling compares against the FULL expected set, so it's only meaningful
  // on a complete pass — skip it on a filtered run to avoid surprises.
  if (!only) cullStaleScreenshots();
  copyToPluginAssets(theme, only ?? undefined);
  process.exit(0);
}

main();
