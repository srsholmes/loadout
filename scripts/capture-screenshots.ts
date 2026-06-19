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
 */
import {
  readdirSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { join, resolve, relative } from "node:path";

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
const PLUGINS = readdirSync(join(ROOT, "plugins"), { withFileTypes: true })
  .filter(
    (d) =>
      d.isDirectory() &&
      (existsSync(join(ROOT, "plugins", d.name, "package.json")) ||
        existsSync(join(ROOT, "plugins", d.name, "plugin.json"))),
  )
  .map((d) => d.name)
  .sort();

// ── Per-plugin sub-page recipes ────────────────────────────────────────────
//
// A `Step` is a single CDP-driven action. `tile` clicks the first shared
// GameCard (`[data-game-card]`) to open a detail page; `aria`/`text` click a
// control by aria-label / visible text (gears, tabs); `wait` adds settle time.
//
// Each page is captured from a freshly-(re)navigated plugin landing, so steps
// describe the path from the landing — no need to back out between pages. If a
// step's target isn't on screen (e.g. an empty library has no tile), the page
// is skipped rather than producing a misleading shot.
type Step =
  | { kind: "tile" }
  | { kind: "aria"; label: string }
  | { kind: "text"; label: string }
  | { kind: "wait"; ms: number };

interface PageShot {
  /** Suffix in the filename: `NN-<plugin>-<name>.png`. */
  name: string;
  steps: Step[];
}

const PAGE_RECIPES: Record<string, PageShot[]> = {
  recomp: [
    { name: "detail", steps: [{ kind: "tile" }] },
    { name: "settings", steps: [{ kind: "aria", label: "RecompHub settings" }] },
  ],
  hltb: [
    { name: "detail", steps: [{ kind: "tile" }] },
    { name: "settings", steps: [{ kind: "aria", label: "Plugin preferences" }] },
  ],
  "store-bridge": [
    { name: "installed", steps: [{ kind: "text", label: "Installed" }] },
    { name: "downloads", steps: [{ kind: "text", label: "Downloads" }] },
    { name: "detected", steps: [{ kind: "text", label: "Detected" }] },
    { name: "detail", steps: [{ kind: "tile" }] },
    { name: "settings", steps: [{ kind: "aria", label: "Settings" }] },
  ],
  "launch-options": [
    { name: "detail", steps: [{ kind: "tile" }] },
    { name: "presets", steps: [{ kind: "aria", label: "Manage presets" }] },
  ],
  "protondb-badges": [
    { name: "settings", steps: [{ kind: "aria", label: "Plugin preferences" }] },
  ],
  steamgriddb: [
    { name: "detail", steps: [{ kind: "tile" }] },
    { name: "settings", steps: [{ kind: "aria", label: "Plugin preferences" }] },
  ],
  "quick-links": [
    { name: "settings", steps: [{ kind: "aria", label: "Quick Links settings" }] },
  ],
  "lsfg-vk": [
    { name: "settings", steps: [{ kind: "aria", label: "Plugin preferences" }] },
  ],
};

const sleep = (ms: number) => Bun.sleep(ms);
// Brief settle for the route swap + first paint before we poll for idle.
const SETTLE_MS = 300;
// Async-loading wait: many plugins fetch over the network on mount
// (ProtonDB, HLTB, SteamGridDB, store libraries), so a fixed sleep either
// over-waits or fires mid-spinner. Poll until no loading indicators remain.
const IDLE_TIMEOUT_MS = 8000;
const IDLE_POLL_MS = 200;
// The DOM must stay idle this long before we trust it — guards the gap
// between one fetch's spinner clearing and the next appearing.
const IDLE_STABLE_MS = 400;

async function cdpWs(): Promise<string> {
  const res = await fetch("http://localhost:9222/json");
  const targets = (await res.json()) as Array<{
    title?: string;
    webSocketDebuggerUrl: string;
  }>;
  const overlay = targets.find((t) => t.title === "Loadout Overlay");
  if (!overlay) {
    console.error("overlay target not found");
    process.exit(1);
  }
  return overlay.webSocketDebuggerUrl;
}

class CDP {
  private ws!: WebSocket;
  private id = 0;
  private pending = new Map<number, (msg: Record<string, unknown>) => void>();

  static async connect(url: string): Promise<CDP> {
    const cdp = new CDP();
    cdp.ws = new WebSocket(url);
    cdp.ws.addEventListener("message", (ev: MessageEvent) => {
      const msg = JSON.parse(
        typeof ev.data === "string" ? ev.data : ev.data.toString(),
      );
      // Responses carry an `id`; CDP events don't — ignore the latter.
      if (typeof msg.id === "number" && cdp.pending.has(msg.id)) {
        cdp.pending.get(msg.id)!(msg);
        cdp.pending.delete(msg.id);
      }
    });
    await new Promise<void>((res, rej) => {
      cdp.ws.addEventListener("open", () => res(), { once: true });
      cdp.ws.addEventListener("error", () => rej(new Error("CDP ws error")), {
        once: true,
      });
    });
    return cdp;
  }

  call(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const id = ++this.id;
    return new Promise((res) => {
      this.pending.set(id, res);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expr: string, awaitPromise = false): Promise<unknown> {
    const r = (await this.call("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise,
    })) as { result?: { result?: { value?: unknown } } };
    return r.result?.result?.value;
  }

  async screenshot(path: string): Promise<void> {
    const r = (await this.call("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    })) as { result?: { data?: string } };
    const data = r.result?.data;
    if (!data) throw new Error(`no data: ${JSON.stringify(r)}`);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, Buffer.from(data, "base64"));
    console.log(`  → ${rel(path)}`);
  }
}

/**
 * Wait until the overlay has no visible loading state — no DaisyUI
 * `.loading` spinners (the shared `<Spinner>`) and no `animate-spin`
 * icons — staying clear for `IDLE_STABLE_MS` so we don't fire in the
 * gap between two sequential fetches. Falls through after
 * `IDLE_TIMEOUT_MS` so a perpetually-spinning view still gets captured.
 */
async function waitForIdle(cdp: CDP): Promise<void> {
  const expr = `document.querySelectorAll('.loading, [class*="animate-spin"]').length`;
  const start = Date.now();
  let idleSince: number | null = null;
  while (Date.now() - start < IDLE_TIMEOUT_MS) {
    const busy = ((await cdp.eval(expr)) as number) > 0;
    if (busy) {
      idleSince = null;
    } else {
      idleSince ??= Date.now();
      if (Date.now() - idleSince >= IDLE_STABLE_MS) return;
    }
    await sleep(IDLE_POLL_MS);
  }
}

async function navigate(cdp: CDP, hashPath: string): Promise<void> {
  await cdp.eval(`location.hash='${hashPath}'; void 0`);
  await sleep(SETTLE_MS); // let the route swap + mount begin
  await waitForIdle(cdp); // then wait out any async loading
}

async function setSidebarCollapsed(cdp: CDP, collapsed: boolean): Promise<void> {
  // The toggle is a Focusable button; flipping the checkbox directly
  // updates the drawer classes but not React state. Instead click the
  // actual button so React's onClick runs.
  const expr = `
  (function(){
    const input = document.getElementById('sl-drawer');
    if (input.checked === ${collapsed ? "false" : "true"}) return 'already';
    const btn = document.querySelector('[aria-label="Toggle sidebar"]');
    btn && btn.click();
    return 'clicked';
  })()
  `;
  await cdp.eval(expr);
  await sleep(250);
}

// ── Recipe step execution ──────────────────────────────────────────────────

/** Click the first element matching `selector`. Returns whether it existed. */
async function clickSelector(cdp: CDP, selector: string): Promise<boolean> {
  const expr = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.click();
    return true;
  })()`;
  return (await cdp.eval(expr)) === true;
}

/** Click the first button/[role=button] whose text starts with `label`. */
async function clickText(cdp: CDP, label: string): Promise<boolean> {
  const expr = `(() => {
    const els = [...document.querySelectorAll('button, [role="button"]')];
    const el = els.find((e) => (e.textContent || "").trim().startsWith(${JSON.stringify(label)}));
    if (!el) return false;
    el.click();
    return true;
  })()`;
  return (await cdp.eval(expr)) === true;
}

// A click target may not exist yet — plugin headers/grids that fetch data
// (recomp, hltb, steamgriddb, launch-options) render their gear/tiles only
// after the load resolves. Poll for the element before giving up so a slow
// fetch doesn't read as "page absent".
const CLICK_TRIES = 6;
const CLICK_RETRY_MS = 500;

async function clickWithRetry(
  cdp: CDP,
  fn: () => Promise<boolean>,
): Promise<boolean> {
  for (let i = 0; i < CLICK_TRIES; i++) {
    if (await fn()) return true;
    await sleep(CLICK_RETRY_MS);
  }
  return false;
}

/** Run a page recipe's steps. Returns false (page unreachable) if any
 *  click target never appears. */
async function runSteps(cdp: CDP, steps: Step[]): Promise<boolean> {
  for (const step of steps) {
    if (step.kind === "wait") {
      await sleep(step.ms);
      continue;
    }
    let ok = false;
    if (step.kind === "tile")
      ok = await clickWithRetry(cdp, () => clickSelector(cdp, "[data-game-card]"));
    else if (step.kind === "aria")
      ok = await clickWithRetry(cdp, () =>
        clickSelector(cdp, `[aria-label="${step.label}"]`),
      );
    else if (step.kind === "text")
      ok = await clickWithRetry(cdp, () => clickText(cdp, step.label));
    if (!ok) return false;
    await sleep(SETTLE_MS);
    await waitForIdle(cdp); // sub-page may fetch on open (detail pages)
  }
  return true;
}

// ── Post-processing: copy to plugin assets + cull stale shots ──────────────

function copyToPluginAssets(theme: string): void {
  // Copy each plugin's shots (from the captured theme dir) into its
  // tracked `assets/` dir so the plugin README + the root README gallery
  // reference stable paths that live next to the source:
  //   landing      NN-<id>.png        → assets/screenshot.png
  //   sub-pages    NN-<id>-<page>.png → assets/screenshot-<page>.png
  const srcDir = join(OUT, theme);
  if (!existsSync(srcDir)) {
    console.error(`[copy] ${rel(srcDir)} missing — run a capture first`);
    return;
  }
  PLUGINS.forEach((pid, idx) => {
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
  const files = new Set([
    "00-home.png",
    "01-settings.png",
    "02-home-sidebar-collapsed.png",
  ]);
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
  const themeArg = [...args]
    .find((a) => a.startsWith("--theme="))
    ?.split("=")[1];
  if (args.has("--copy-only") || args.has("--cull-only")) {
    if (args.has("--cull-only")) cullStaleScreenshots();
    if (args.has("--copy-only")) copyToPluginAssets(themeArg ?? "midnight");
    return;
  }

  const cdp = await CDP.connect(await cdpWs());

  // Capture whatever theme the overlay is currently in — never change it.
  const theme =
    ((await cdp.eval(
      `document.documentElement.getAttribute('data-theme')`,
    )) as string | null) ?? "midnight";
  console.log(`[theme] capturing current theme: ${theme}`);

  // Global surfaces.
  await setSidebarCollapsed(cdp, false);
  await navigate(cdp, "#/");
  await cdp.screenshot(join(OUT, theme, "00-home.png"));
  await navigate(cdp, "#/settings");
  await cdp.screenshot(join(OUT, theme, "01-settings.png"));
  await navigate(cdp, "#/");
  await setSidebarCollapsed(cdp, true);
  await cdp.screenshot(join(OUT, theme, "02-home-sidebar-collapsed.png"));
  await setSidebarCollapsed(cdp, false);

  // Each plugin: landing shot, then each recipe sub-page.
  for (let idx = 0; idx < PLUGINS.length; idx++) {
    const pid = PLUGINS[idx]!;
    const nn = String(idx + 3).padStart(2, "0");
    await navigate(cdp, `#/plugin/${pid}`);
    await cdp.screenshot(join(OUT, theme, `${nn}-${pid}.png`));

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
      await cdp.screenshot(join(OUT, theme, `${nn}-${pid}-${page.name}.png`));
    }
  }

  cullStaleScreenshots();
  copyToPluginAssets(theme);
  process.exit(0);
}

main();
