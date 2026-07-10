#!/usr/bin/env bun
/**
 * Capture short feature clips of the running overlay and encode them to
 * animated WebP (the README-embeddable format), with per-step captions burned
 * into the video — plus optional GIF / MP4.
 *
 * Why WebP: GitHub markdown renders repo-relative `![](…)` images, and an
 * animated WebP autoplays + loops inline like a GIF but at a fraction of the
 * size. Repo-relative `<video>`/MP4 does NOT render on GitHub, so committed
 * WebP is the one format that is both self-contained *and* inline-animated.
 * See docs/media-capture.md.
 *
 * Two capture surfaces:
 *
 *   Per-plugin TOURS (default) — each plugin may ship `plugins/<id>/tour.json`
 *     (opt-in): a scripted tour with captions. `--tours` discovers every plugin
 *     that has one, navigates to it, records the beats, burns the captions in,
 *     and writes to a review folder (`videos/review/<id>.webp`) for you to watch
 *     before `--promote=<id,…>` copies it to `plugins/<id>/assets/demo.webp`
 *     and inserts a `## Demo` section into that plugin's README.
 *
 *   STEAM Big Picture (`--target=steam`) — records Steam's own CEF (:8080),
 *     where theme-loader CSS and Store Bridge's Epic collection live. Run it
 *     from Gaming Mode with Big Picture in the foreground.
 *
 * The CDP connection + hash-navigation + recipe-step vocabulary is shared with
 * `capture-screenshots.ts` via `lib/overlay-cdp.ts`.
 *
 * Usage:
 *   bun run capture:videos                          # capture every plugin tour
 *   bun run capture:videos --tours --plugins=tdp-control
 *   bun run capture:videos --promote=tdp-control    # review clip → tracked asset + README
 *   bun run capture:videos --list                   # list tours + steam clips
 *   bun run capture:videos --format=all             # WebP + GIF + MP4
 *   bun run capture:videos --width=960 --fps=15
 *   bun run capture:videos --keep-frames            # leave raw JPEG frames
 *   bun run capture:videos --target=steam           # Big Picture clips
 *
 * Requires: ffmpeg (encode) and a sans font via fontconfig (captions).
 */
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  copyFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join, resolve, relative } from "node:path";
import { listCefTabs } from "@loadout/steam-cdp";
import {
  CDP,
  cdpWs,
  navigate,
  setSidebarCollapsed,
  waitForIdle,
  clickSelector,
  clickText,
  clickWithRetry,
  sleep,
  SETTLE_MS,
  type Step,
} from "./lib/overlay-cdp";

const ROOT = resolve(import.meta.dir, "..");
// Scratch tree for raw frames + intermediate encodes, and the review folder
// where freshly-captured tours land. Gitignored — `--promote` copies the
// approved clip into the plugin's tracked `assets/` dir.
const OUT = join(ROOT, "videos");
const REVIEW = join(OUT, "review");
const rel = (p: string) => relative(ROOT, p);

type Format = "webp" | "gif" | "mp4";

// Plugins whose UI renders identifying / personal data that must NEVER be
// recorded into a committed clip. `network-info` leaks MAC/SSID/IP; `playtime`
// reveals personal play history. Enforced two ways: tours are opt-in (no
// `tour.json` → no tour) AND these are hard-skipped even if a `tour.json`
// exists. Mirrors PRIVACY_SKIP in capture-screenshots.ts.
const TOUR_SKIP = new Set(["network-info", "playtime"]);

// ── Per-plugin tour recipes (plugins/<id>/tour.json) ────────────────────────
//
// A tour reuses the overlay `Step` vocabulary (`wait` / `nav` / `sidebar` /
// `tile` / `aria` / `text`); the script auto-navigates to `#/plugin/<id>`
// first, so steps describe in-plugin beats only. Any step — or the `title` —
// may carry a `caption`, shown from when that step fires until the next
// caption, burned in as a lower-third.
type TourStep = Step & { caption?: string };

interface Tour {
  /** Optional intro caption, shown from the first frame. */
  title?: string;
  /** Output frame rate for this tour (default `DEFAULT_FPS`). */
  fps?: number;
  /** Hold time on the final frame, ms (default 600). */
  tailMs?: number;
  steps: TourStep[];
}

// ── Steam (Big Picture) clips ───────────────────────────────────────────────
//
// These record Steam's OWN CEF UI (:8080), not the overlay. Steam's Big
// Picture has no hash routes and its GamepadUI selectors are version-fragile,
// so the vocabulary is deliberately small:
//   eval   — run JS in the Big Picture tab (used for the theme toggle)
//   theme  — flip every theme-loader-injected <style> on/off, which is exactly
//            what theme-loader does; a real, deterministic recolor
//   manual — pause with a countdown so YOU navigate Big Picture by hand while
//            recording continues (the honest path for library/collection nav)
//   wait   — hold
type SteamStep =
  | { kind: "wait"; ms: number }
  | { kind: "eval"; js: string }
  | { kind: "theme"; on: boolean }
  | { kind: "manual"; ms: number; prompt: string };

// Selector for every <style> theme-loader injects (id `theme-loader-<id>`,
// see safeStyleId() in plugins/theme-loader/backend.ts).
const THEME_STYLE_SELECTOR = 'style[id^="theme-loader-"]';

// Where a Steam clip's encoded file lands:
//   plugin → plugins/<id>/assets/demo.<ext>
//   docs   → docs/assets/<file>.<ext>
type Dest = { kind: "plugin"; id: string } | { kind: "docs"; file: string };

interface SteamClip {
  name: string;
  title: string;
  dest: Dest;
  setup?: SteamStep[];
  steps: SteamStep[];
  tailMs?: number;
  fps?: number;
  /** Guard run before recording; false skips the clip. */
  precheck?: (cdp: CDP) => Promise<boolean>;
}

const STEAM_CLIPS: SteamClip[] = [
  {
    name: "steam-theme",
    title: "Theme Loader — live Big Picture recolor",
    dest: { kind: "docs", file: "steam-theme" },
    precheck: async (cdp) => {
      const n = (await cdp.eval(
        `document.querySelectorAll('${THEME_STYLE_SELECTOR}').length`,
      )) as number;
      if (!n) {
        console.log("  ↷ no active theme found in Big Picture — enable one in theme-loader first");
        return false;
      }
      return true;
    },
    steps: [
      { kind: "wait", ms: 900 },
      { kind: "theme", on: false },
      { kind: "wait", ms: 1200 },
      { kind: "theme", on: true },
      { kind: "wait", ms: 1200 },
      { kind: "theme", on: false },
      { kind: "wait", ms: 1000 },
      { kind: "theme", on: true },
      { kind: "wait", ms: 800 },
    ],
  },
  {
    name: "steam-epic",
    title: "Store Bridge — Epic games as a Steam collection",
    dest: { kind: "plugin", id: "store-bridge" },
    steps: [
      {
        kind: "manual",
        ms: 9000,
        prompt:
          "Open your Store Bridge / Epic collection in Big Picture now — panning the grid reads best.",
      },
    ],
  },
];

// ── Encoding knobs (overridable via flags) ──────────────────────────────────
const DEFAULT_WIDTH = 1280; // native handheld width so UI text stays legible
const DEFAULT_FPS = 20; // normalize the (variable-rate) screencast to CFR
// A hold with no visual change emits no screencast frames, so its duration is
// the gap to the NEXT frame. Cap that gap so a long idle never freezes the
// clip; floor it so timestamp jitter can't produce a zero-length frame.
const MIN_FRAME_SEC = 1 / 120;
const MAX_FRAME_SEC = 2.0;
// Fewer captured frames than this means the surface never really repainted
// (e.g. a backgrounded Big Picture) — treat it as a failed capture.
const MIN_USABLE_FRAMES = 4;

interface RunOpts {
  formats: Format[];
  width: number;
  fpsOverride: number | null;
  keepFrames: boolean;
}

// ── Screencast recording ────────────────────────────────────────────────────

interface Frame {
  data: Buffer;
  /** Arrival time, ms (monotonic). */
  t: number;
}

/**
 * Record a CDP screencast for the duration of `run()`. Returns the frames in
 * arrival order. Frames are JPEG (small, fast to ack); ffmpeg re-encodes them.
 */
async function record(cdp: CDP, run: () => Promise<void>): Promise<Frame[]> {
  const frames: Frame[] = [];
  const off = cdp.on("Page.screencastFrame", (p) => {
    const data = p["data"];
    const sessionId = p["sessionId"];
    if (typeof data === "string") {
      frames.push({ data: Buffer.from(data, "base64"), t: performance.now() });
    }
    // Must ack or the browser stops sending frames after a few in flight.
    if (sessionId !== undefined) {
      void cdp.call("Page.screencastFrameAck", { sessionId });
    }
  });
  await cdp.call("Page.enable");
  await cdp.call("Page.startScreencast", {
    format: "jpeg",
    quality: 90,
    everyNthFrame: 1,
  });
  try {
    await run();
  } finally {
    await cdp.call("Page.stopScreencast");
    off();
  }
  return frames;
}

// ── ffmpeg encoding ─────────────────────────────────────────────────────────

function run(cmd: string[]): void {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) {
    console.error(new TextDecoder().decode(r.stderr));
    throw new Error(`${cmd[0]} exited ${r.exitCode}`);
  }
}

/**
 * Write frames to disk and build an ffmpeg concat list that carries each
 * frame's real duration, so deliberate holds and animation pacing survive into
 * the encode. Returns the list path and the clip's total duration (seconds) —
 * the latter anchors caption timing.
 */
function writeFrames(
  dir: string,
  frames: Frame[],
  tailSec: number,
): { list: string; totalSec: number } {
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  let totalSec = 0;
  frames.forEach((f, i) => {
    const file = join(dir, `frame-${String(i).padStart(5, "0")}.jpg`);
    writeFileSync(file, f.data);
    const next = frames[i + 1];
    const raw = next ? (next.t - f.t) / 1000 : tailSec;
    const dur = Math.min(MAX_FRAME_SEC, Math.max(MIN_FRAME_SEC, raw));
    totalSec += dur;
    lines.push(`file '${file}'`, `duration ${dur.toFixed(3)}`);
  });
  // The concat demuxer ignores the final entry's `duration` unless the last
  // file is repeated, so repeat it to honour the tail hold.
  const last = frames[frames.length - 1];
  if (last) {
    lines.push(`file '${join(dir, `frame-${String(frames.length - 1).padStart(5, "0")}.jpg`)}'`);
  }
  const listPath = join(dir, "frames.txt");
  writeFileSync(listPath, lines.join("\n") + "\n");
  return { list: listPath, totalSec };
}

interface TimedCaption {
  text: string;
  start: number;
  end: number;
}

/** Resolve raw (text, arrival-time) caption events into on-timeline windows:
 *  each caption shows until the next one fires (last runs to the clip end). */
function resolveCaptions(
  raw: { text: string; t: number }[],
  t0: number,
  totalSec: number,
): TimedCaption[] {
  const sorted = raw
    .map((c) => ({ text: c.text, start: Math.max(0, (c.t - t0) / 1000) }))
    .sort((a, b) => a.start - b.start);
  return sorted.map((c, i) => ({
    ...c,
    end: i + 1 < sorted.length ? sorted[i + 1]!.start : totalSec,
  }));
}

/** Locate a sans-serif font file for drawtext. Empty string if none found
 *  (captions are then skipped rather than failing the whole encode). */
function findFont(): string {
  const r = Bun.spawnSync(["fc-match", "-f", "%{file}", "sans-serif"]);
  if (r.exitCode === 0) {
    const f = new TextDecoder().decode(r.stdout).trim();
    if (f && existsSync(f)) return f;
  }
  for (const p of [
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/noto/NotoSans-Regular.ttf",
  ]) {
    if (existsSync(p)) return p;
  }
  return "";
}

/** Build the `,drawtext=…` filter chain that burns captions in as a
 *  lower-third. Caption text goes through a textfile to avoid escaping. */
function captionFilters(caps: TimedCaption[], font: string, dir: string, width: number): string {
  const size = Math.max(18, Math.round(width / 34));
  return caps
    .map((c, i) => {
      const tf = join(dir, `cap-${i}.txt`);
      writeFileSync(tf, c.text + "\n");
      // Single-quoted option values keep commas/colons literal inside the
      // filtergraph; textfile/font paths under the repo have no special chars.
      return (
        `,drawtext=fontfile='${font}':textfile='${tf}'` +
        `:fontsize=${size}:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=18` +
        `:line_spacing=6:x=(w-text_w)/2:y=h-text_h-48` +
        `:enable='between(t,${c.start.toFixed(2)},${c.end.toFixed(2)})'`
      );
    })
    .join("");
}

const baseVf = (width: number, fps: number) => `fps=${fps},scale=${width}:-1:flags=lanczos`;

function encodeWebp(list: string, out: string, width: number, fps: number, caps: string): void {
  run([
    "ffmpeg",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-vf",
    `${baseVf(width, fps)}${caps}`,
    "-c:v",
    "libwebp",
    "-loop",
    "0",
    "-lossless",
    "0",
    "-q:v",
    "55",
    "-compression_level",
    "6",
    "-an",
    out,
  ]);
}

function encodeGif(
  dir: string,
  list: string,
  out: string,
  width: number,
  fps: number,
  caps: string,
): void {
  // Two-pass palette for a clean GIF: generate an optimized palette, then map.
  const palette = join(dir, "palette.png");
  run([
    "ffmpeg",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-vf",
    `${baseVf(width, fps)}${caps},palettegen=stats_mode=diff`,
    palette,
  ]);
  run([
    "ffmpeg",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-i",
    palette,
    "-lavfi",
    `${baseVf(width, fps)}${caps} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    "-loop",
    "0",
    out,
  ]);
}

function encodeMp4(list: string, out: string, width: number, fps: number, caps: string): void {
  run([
    "ffmpeg",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    // yuv420p + even dimensions are required for broad H.264 playback.
    "-vf",
    `${baseVf(width, fps)}${caps},pad=ceil(iw/2)*2:ceil(ih/2)*2`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-an",
    out,
  ]);
}

/** Encode a clip into every requested format, deriving gif/mp4 paths from the
 *  webp path. `caps` is the (possibly empty) burned-in caption filter chain. */
function encodeAll(
  outWebp: string,
  list: string,
  dir: string,
  caps: string,
  formats: Format[],
  width: number,
  fps: number,
): void {
  for (const fmt of formats) {
    const out = outWebp.replace(/\.webp$/, `.${fmt}`);
    mkdirSync(join(out, ".."), { recursive: true });
    if (fmt === "webp") encodeWebp(list, out, width, fps, caps);
    else if (fmt === "gif") encodeGif(dir, list, out, width, fps, caps);
    else encodeMp4(list, out, width, fps, caps);
    const kb = Math.round(Bun.file(out).size / 1024);
    console.log(`  → ${rel(out)} (${kb} KB)`);
  }
}

// ── Per-plugin tours ────────────────────────────────────────────────────────

/** Discover every `plugins/<id>/tour.json` (opt-in), minus the privacy
 *  blacklist. Sorted for stable ordering. */
function discoverTours(): { id: string; tour: Tour }[] {
  const out: { id: string; tour: Tour }[] = [];
  for (const d of readdirSync(join(ROOT, "plugins"), { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const p = join(ROOT, "plugins", d.name, "tour.json");
    if (!existsSync(p)) continue;
    if (TOUR_SKIP.has(d.name)) {
      console.warn(`[tours] refusing privacy-blacklisted plugin with a tour.json: ${d.name}`);
      continue;
    }
    let tour: Tour;
    try {
      tour = JSON.parse(readFileSync(p, "utf8")) as Tour;
    } catch (err) {
      console.error(`[tours] ${d.name}/tour.json is not valid JSON: ${err}`);
      process.exit(1);
    }
    if (!Array.isArray(tour.steps) || tour.steps.length === 0) {
      console.error(`[tours] ${d.name}/tour.json has no steps`);
      process.exit(1);
    }
    out.push({ id: d.name, tour });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

async function captureTour(
  cdp: CDP,
  id: string,
  tour: Tour,
  font: string,
  opts: RunOpts,
): Promise<void> {
  console.log(`\n[tour] ${id}${tour.title ? ` — ${tour.title}` : ""}`);
  await navigate(cdp, `#/plugin/${id}`);
  await waitForIdle(cdp);

  const raw: { text: string; t: number }[] = [];
  if (tour.title) raw.push({ text: tour.title, t: performance.now() });
  const frames = await record(cdp, async () => {
    for (const step of tour.steps) {
      if (step.caption) raw.push({ text: step.caption, t: performance.now() });
      await runOverlayStep(cdp, step);
    }
  });
  console.log(`  captured ${frames.length} frame(s)`);
  if (frames.length < MIN_USABLE_FRAMES) {
    console.warn(`  ↷ only ${frames.length} frame(s) — nothing repainted; skipping ${id}`);
    return;
  }

  const dir = join(OUT, `tour-${id}`);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  const { list, totalSec } = writeFrames(dir, frames, (tour.tailMs ?? 600) / 1000);
  const fps = opts.fpsOverride ?? tour.fps ?? DEFAULT_FPS;
  const caps =
    font && raw.length
      ? captionFilters(resolveCaptions(raw, frames[0]!.t, totalSec), font, dir, opts.width)
      : "";
  if (!font && raw.length) {
    console.warn("  ↷ no sans font found (install fontconfig/dejavu) — encoding without captions");
  }

  mkdirSync(REVIEW, { recursive: true });
  encodeAll(join(REVIEW, `${id}.webp`), list, dir, caps, opts.formats, opts.width, fps);
  console.log(`  review: ${rel(join(REVIEW, `${id}.webp`))} — promote with --promote=${id}`);
  if (!opts.keepFrames) rmSync(dir, { recursive: true, force: true });
}

/** Copy an approved review clip into the plugin's tracked assets and insert a
 *  `## Demo` section into its README (idempotent). */
function promote(ids: string[]): void {
  for (const id of ids) {
    const src = join(REVIEW, `${id}.webp`);
    if (!existsSync(src)) {
      console.error(`[promote] no review clip for "${id}" at ${rel(src)} — run --tours first`);
      continue;
    }
    const dest = join(ROOT, "plugins", id, "assets", "demo.webp");
    mkdirSync(join(dest, ".."), { recursive: true });
    copyFileSync(src, dest);
    console.log(`[promote] ${id}: ${rel(src)} → ${rel(dest)}`);
    insertDemoSection(id);
  }
}

/** Add a `## Demo` block (matching the scaffold template) above the plugin
 *  README's `## Screenshots`. No-op if a demo embed is already present. */
function insertDemoSection(id: string): void {
  const readme = join(ROOT, "plugins", id, "README.md");
  if (!existsSync(readme)) {
    console.warn(`[promote] ${id}: no README.md to edit`);
    return;
  }
  let text = readFileSync(readme, "utf8");
  if (text.includes("./assets/demo.webp")) return; // already embedded
  const name = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? id;
  const block = `## Demo\n\n![${name} demo](./assets/demo.webp)\n\n`;
  text = text.includes("## Screenshots")
    ? text.replace("## Screenshots", `${block}## Screenshots`)
    : `${text.trimEnd()}\n\n${block}`;
  writeFileSync(readme, text);
  console.log(`[promote] ${id}: inserted ## Demo section`);
}

// ── Steam capture ───────────────────────────────────────────────────────────

function destPath(dest: Dest, ext: Format): string {
  if (dest.kind === "plugin") {
    return join(ROOT, "plugins", dest.id, "assets", `demo.${ext}`);
  }
  return join(ROOT, "docs", "assets", `${dest.file}.${ext}`);
}

async function captureSteamClips(cdp: CDP, clips: SteamClip[], opts: RunOpts): Promise<void> {
  for (const clip of clips) {
    console.log(`\n[clip] ${clip.name} — ${clip.title}`);
    for (const step of clip.setup ?? []) await runSteamStep(cdp, step);
    await sleep(SETTLE_MS);
    if (clip.precheck && !(await clip.precheck(cdp))) continue;

    const frames = await record(cdp, async () => {
      for (const step of clip.steps) await runSteamStep(cdp, step);
    });
    console.log(`  captured ${frames.length} frame(s)`);
    if (frames.length < MIN_USABLE_FRAMES) {
      console.warn(
        `  ↷ only ${frames.length} frame(s) — nothing repainted; skipping ${clip.name}.` +
          ` (Steam clips must run with Big Picture in the foreground.)`,
      );
      continue;
    }

    const dir = join(OUT, clip.name);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    const { list } = writeFrames(dir, frames, (clip.tailMs ?? 600) / 1000);
    const fps = opts.fpsOverride ?? clip.fps ?? DEFAULT_FPS;
    encodeAll(destPath(clip.dest, "webp"), list, dir, "", opts.formats, opts.width, fps);
    if (!opts.keepFrames) rmSync(dir, { recursive: true, force: true });
  }
}

/** Resolve the WebSocket URL of Steam's Big Picture CEF tab (port 8080). */
async function steamBigPictureWs(port: number): Promise<string> {
  let tabs;
  try {
    tabs = await listCefTabs({ debugPort: port });
  } catch (err) {
    console.error(
      `[video] couldn't reach Steam's CEF on localhost:${port}/json — is Steam ` +
        `running with remote debugging enabled?\n  ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }
  const bp =
    tabs.find((t) => t.type === "page" && t.title === "Steam Big Picture Mode") ??
    tabs.find((t) => t.type === "page" && /big picture/i.test(t.title));
  if (!bp) {
    console.error(
      "[video] no 'Steam Big Picture Mode' tab found — open Big Picture / Gaming Mode first.\n" +
        `[video] tabs seen: ${tabs.map((t) => t.title).join(", ")}`,
    );
    process.exit(1);
  }
  return bp.webSocketDebuggerUrl;
}

// ── Step runners ────────────────────────────────────────────────────────────

/**
 * Run one overlay beat. Unlike the screenshot runner, a missing click target
 * is logged and skipped rather than aborting — a video tolerates a dropped
 * beat, and hard-failing mid-record would waste the whole clip.
 */
async function runOverlayStep(cdp: CDP, step: Step): Promise<void> {
  switch (step.kind) {
    case "wait":
      await sleep(step.ms);
      return;
    case "nav":
      await navigate(cdp, step.hash);
      return;
    case "sidebar":
      await setSidebarCollapsed(cdp, step.collapsed);
      return;
    case "tile": {
      const ok = await clickWithRetry(() => clickSelector(cdp, "[data-game-card]"));
      if (!ok) console.log("  ↷ no [data-game-card] on screen — skipping beat");
      else {
        await sleep(SETTLE_MS);
        await waitForIdle(cdp);
      }
      return;
    }
    case "aria": {
      const ok = await clickWithRetry(() => clickSelector(cdp, `[aria-label="${step.label}"]`));
      if (!ok) console.log(`  ↷ no [aria-label="${step.label}"] — skipping beat`);
      else {
        await sleep(SETTLE_MS);
        await waitForIdle(cdp);
      }
      return;
    }
    case "text": {
      const ok = await clickWithRetry(() => clickText(cdp, step.label));
      if (!ok) console.log(`  ↷ no "${step.label}" control — skipping beat`);
      else {
        await sleep(SETTLE_MS);
        await waitForIdle(cdp);
      }
      return;
    }
  }
}

/**
 * Run one Steam (Big Picture) beat. `theme` flips theme-loader's injected CSS;
 * `manual` pauses with a countdown so you navigate Steam by hand while the
 * screencast keeps rolling.
 */
async function runSteamStep(cdp: CDP, step: SteamStep): Promise<void> {
  switch (step.kind) {
    case "wait":
      await sleep(step.ms);
      return;
    case "eval":
      await cdp.eval(step.js);
      return;
    case "theme": {
      const n = (await cdp.eval(
        `(() => { const els = [...document.querySelectorAll('${THEME_STYLE_SELECTOR}')];` +
          ` els.forEach((e) => { e.disabled = ${step.on ? "false" : "true"}; }); return els.length; })()`,
      )) as number;
      if (!n) console.log("  ↷ no theme-loader styles present — enable a theme first");
      return;
    }
    case "manual": {
      console.log(`  ⏵ ${step.prompt}`);
      for (let s = Math.ceil(step.ms / 1000); s > 0; s--) {
        console.log(`    recording… ${s}s`);
        await sleep(1000);
      }
      return;
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

function parseFormats(arg: string | undefined): Format[] {
  if (!arg || arg === "webp") return ["webp"];
  if (arg === "all") return ["webp", "gif", "mp4"];
  const parts = arg.split(",").map((s) => s.trim());
  const ok: Format[] = ["webp", "gif", "mp4"];
  const bad = parts.filter((p) => !ok.includes(p as Format));
  if (bad.length) {
    console.error(`[video] unknown format(s): ${bad.join(", ")} (webp|gif|mp4|all)`);
    process.exit(1);
  }
  return parts as Format[];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const has = (name: string) => argv.includes(`--${name}`);

  // Promote is a pure file op — no capture, no CDP.
  const promoteArg = flag("promote");
  if (promoteArg) {
    promote(
      promoteArg
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    return;
  }

  const target = flag("target") ?? "overlay";
  if (target !== "overlay" && target !== "steam") {
    console.error(`[video] unknown --target=${target} (overlay|steam)`);
    process.exit(1);
  }

  if (has("list")) {
    for (const { id, tour } of discoverTours()) {
      console.log(
        `  [tour]  ${id.padEnd(16)} ${tour.title ?? id}  →  plugins/${id}/assets/demo.webp`,
      );
    }
    for (const c of STEAM_CLIPS) {
      const d =
        c.dest.kind === "plugin"
          ? `plugins/${c.dest.id}/assets/demo`
          : `docs/assets/${c.dest.file}`;
      console.log(`  [steam] ${c.name.padEnd(16)} ${c.title}  →  ${d}.webp`);
    }
    return;
  }

  if (!Bun.which("ffmpeg")) {
    console.error("[video] ffmpeg not found on PATH — required to encode clips.");
    process.exit(1);
  }

  const fpsFlag = flag("fps");
  const opts: RunOpts = {
    formats: parseFormats(flag("format")),
    width: Number(flag("width") ?? DEFAULT_WIDTH),
    fpsOverride: fpsFlag ? Number(fpsFlag) : null,
    keepFrames: has("keep-frames"),
  };

  if (target === "steam") {
    const port = Number(flag("port") ?? 8080);
    let clips = STEAM_CLIPS;
    const only = flag("clips") ?? flag("clip");
    if (only) {
      const want = new Set(only.split(",").map((s) => s.trim()));
      clips = STEAM_CLIPS.filter((c) => want.has(c.name));
    }
    console.log(
      `[video] steam · ${clips.length} clip(s) · ${opts.width}px · ${opts.formats.join("+")}`,
    );
    const cdp = await CDP.connect(await steamBigPictureWs(port));
    await captureSteamClips(cdp, clips, opts);
    cdp.close();
    process.exit(0);
  }

  // Default: per-plugin tours.
  let tours = discoverTours();
  const only = flag("plugins") ?? flag("plugin");
  if (only) {
    const want = only
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const known = new Set(tours.map((t) => t.id));
    const unknown = want.filter((w) => !known.has(w));
    if (unknown.length) {
      console.error(`[video] no tour.json for: ${unknown.join(", ")}`);
      console.error(`[video] tours available: ${tours.map((t) => t.id).join(", ") || "(none)"}`);
      process.exit(1);
    }
    tours = tours.filter((t) => want.includes(t.id));
  }
  if (tours.length === 0) {
    console.error(
      "[video] no plugin tours found — add a plugins/<id>/tour.json (see docs/media-capture.md).",
    );
    process.exit(1);
  }

  const font = findFont();
  console.log(
    `[video] tours · ${tours.length} plugin(s) · ${opts.width}px · ${fpsFlag ? `${fpsFlag}fps` : "per-tour fps"} · ${opts.formats.join("+")}${font ? "" : " · captions OFF (no font)"}`,
  );
  const cdp = await CDP.connect(await cdpWs());
  for (const { id, tour } of tours) await captureTour(cdp, id, tour, font, opts);
  cdp.close();
  process.exit(0);
}

main();
