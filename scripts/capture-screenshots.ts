#!/usr/bin/env bun
/**
 * Capture overlay screenshots in light + dark themes, across every plugin,
 * the homepage (sidebar expanded + collapsed), and the settings page.
 *
 * Targets the overlay's own CDP session (filtered by title), drives the app
 * via `location.hash` for routing and flips the sidebar state by clicking
 * the toggle button. Theme is set via `document.documentElement`'s
 * `data-theme` attribute so we don't pollute the user's persisted
 * preference.
 *
 * Bun port of the original capture-screenshots.py — uses Bun's global
 * WebSocket for the CDP session and node:fs for the file shuffling, so it
 * runs with the same toolchain as the rest of the repo (no Python +
 * `websockets` dependency).
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
// manifest some plugins use). Skips stale `.cache`-only leftovers
// like the `browser/` dir post-quick-links-fold. Sorted
// alphabetically so the numbered output filenames are stable
// across runs.
//
// Keep this filter in sync with `loadPluginMeta` in
// `scripts/scaffold-plugin-readmes.ts` — both must agree on which
// directories are "real plugins" so the per-theme numbered shots
// and the per-plugin asset copies always cover the same set.
const PLUGINS = readdirSync(join(ROOT, "plugins"), { withFileTypes: true })
  .filter(
    (d) =>
      d.isDirectory() &&
      (existsSync(join(ROOT, "plugins", d.name, "package.json")) ||
        existsSync(join(ROOT, "plugins", d.name, "plugin.json"))),
  )
  .map((d) => d.name)
  .sort();

const sleep = (ms: number) => Bun.sleep(ms);

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

let currentTheme = "midnight";

async function setTheme(cdp: CDP, theme: string): Promise<void> {
  currentTheme = theme;
  await cdp.eval(`document.documentElement.setAttribute('data-theme','${theme}')`);
}

async function navigate(cdp: CDP, hashPath: string): Promise<void> {
  await cdp.eval(`location.hash='${hashPath}'; void 0`);
  await sleep(600); // let plugin mount + fetch data
  // Re-apply the theme after navigation — Settings.tsx syncs theme
  // from the persisted config on every mount, which would otherwise
  // revert a capture-time theme swap.
  await cdp.eval(
    `document.documentElement.setAttribute('data-theme','${currentTheme}')`,
  );
  await sleep(100);
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

function copyToPluginAssets(): void {
  // After capture, copy each plugin's `midnight` shot into the
  // per-plugin `assets/` dir so the plugin's README (and the root
  // README's plugin gallery) can reference a stable path that lives
  // next to the source.
  //
  // Per-theme dumps stay under top-level `screenshots/<theme>/` for
  // development diff-checking; per-plugin assets are the single
  // "default" shot the docs link to.
  const srcDir = join(OUT, "midnight");
  if (!existsSync(srcDir)) {
    console.error(`[copy] ${srcDir} missing — run a capture first`);
    return;
  }
  PLUGINS.forEach((pid, idx) => {
    const i = idx + 3;
    const src = join(srcDir, `${String(i).padStart(2, "0")}-${pid}.png`);
    if (!existsSync(src)) {
      console.log(`[copy] skip ${pid}: ${src.split("/").pop()} not captured`);
      return;
    }
    const destDir = join(ROOT, "plugins", pid, "assets");
    mkdirSync(destDir, { recursive: true });
    const dest = join(destDir, "screenshot.png");
    copyFileSync(src, dest);
    console.log(`[copy] ${pid} → ${rel(dest)}`);
  });
}

function expectedFilenames(): Set<string> {
  // The set of filenames every per-theme directory SHOULD have after a
  // capture pass. Anything else is stale (plugin renamed, dropped, or
  // replaced) and should be culled so the screenshots/ tree doesn't
  // accrete dead shots from the alphabetical-renumber that lands when a
  // new plugin is added in the middle of the list.
  const files = new Set([
    "00-home.png",
    "01-settings.png",
    "02-home-sidebar-collapsed.png",
  ]);
  PLUGINS.forEach((pid, idx) => {
    files.add(`${String(idx + 3).padStart(2, "0")}-${pid}.png`);
  });
  return files;
}

// Filename shape this script owns. Anything matching `NN-name.png`
// is potentially-stale capture output; anything NOT matching is left
// alone (e.g. a contributor's debug `notes.png` dropped in a theme
// dir won't be culled).
const CAPTURE_FILENAME = /^\d{2}-.*\.png$/;

function cullStaleScreenshots(): void {
  // Remove screenshots/<theme>/<num>-<old-name>.png entries that don't
  // match the current expected filename set. Idempotent on a freshly-
  // captured tree. Only touches files matching the `NN-name.png` shape
  // this script generates — unrelated PNGs are left alone.
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
  // `--copy-only` and `--cull-only` skip the capture pass entirely.
  // They COMPOSE — running `--cull-only --copy-only` does both in
  // sensible order (cull first so any newly-orphaned shots don't get
  // propagated into the per-plugin assets dir). Without either flag, the
  // full pass runs: capture → cull → copy.
  const args = new Set(process.argv.slice(2));
  if (args.has("--copy-only") || args.has("--cull-only")) {
    if (args.has("--cull-only")) cullStaleScreenshots();
    if (args.has("--copy-only")) copyToPluginAssets();
    return;
  }

  const cdp = await CDP.connect(await cdpWs());
  const themes = [
    "midnight",
    "paper",
    "synth",
    "terminal",
    "nord",
    "dracula",
    "gruvbox",
    "tokyo",
  ];
  for (const theme of themes) {
    console.log(`[${theme}]`);
    await setTheme(cdp, theme);
    // sidebar expanded
    await setSidebarCollapsed(cdp, false);
    // home
    await navigate(cdp, "#/");
    await cdp.screenshot(join(OUT, theme, "00-home.png"));
    // settings
    await navigate(cdp, "#/settings");
    await cdp.screenshot(join(OUT, theme, "01-settings.png"));
    // sidebar collapsed (on home)
    await navigate(cdp, "#/");
    await setSidebarCollapsed(cdp, true);
    await cdp.screenshot(join(OUT, theme, "02-home-sidebar-collapsed.png"));
    await setSidebarCollapsed(cdp, false);
    // each plugin
    for (let idx = 0; idx < PLUGINS.length; idx++) {
      const pid = PLUGINS[idx]!;
      await navigate(cdp, `#/plugin/${pid}`);
      await cdp.screenshot(
        join(OUT, theme, `${String(idx + 3).padStart(2, "0")}-${pid}.png`),
      );
    }
  }

  cullStaleScreenshots();
  copyToPluginAssets();
  process.exit(0);
}

main();
