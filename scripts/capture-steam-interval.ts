#!/usr/bin/env bun
/**
 * Burst-capture Steam's own UI (Big Picture / Gaming Mode) at a fixed
 * interval for a fixed duration, dropping every frame into a gitignored
 * folder so you can flip through them afterwards and keep the best.
 *
 * Unlike `capture-screenshots.ts` (which drives the *overlay's* CEF on
 * :9222), this points at *Steam's* CEF remote-debug port (:8080) — the
 * surface where theme-loader CSS, ProtonDB badges, HLTB times, and sound
 * packs are injected. So themed/badged library views show up in the shots.
 *
 * Usage — hop into Gaming Mode (or open Big Picture) with a theme + badges
 * active, then run and navigate Steam while it snaps:
 *
 *   bun scripts/capture-steam-interval.ts                 # 20s @ 2s, → screenshot-review/steam/
 *   bun scripts/capture-steam-interval.ts --duration=30 --interval=1
 *   bun scripts/capture-steam-interval.ts --all           # every page tab each tick
 *   bun scripts/capture-steam-interval.ts --out=my-shots --keep
 *
 * Flags:
 *   --duration=<sec>  total capture window         (default 20)
 *   --interval=<sec>  seconds between shots         (default 2)
 *   --port=<n>        Steam CEF debug port          (default 8080)
 *   --out=<dir>       output dir (repo-relative)    (default screenshot-review/steam)
 *   --title=<str>     capture the tab with this exact title instead of
 *                     auto-picking the Big Picture window
 *   --all             capture every `page`-type tab each tick (not just one)
 *   --keep            don't wipe the output dir first
 *
 * Requires Steam's remote debugging enabled (the installer drops the
 * `.cef-enable-remote-debugging` marker; otherwise create it in Steam's
 * root and restart Steam).
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { listCefTabs, isSharedJSContextTab, type CEFTab } from "@loadout/steam-cdp";

const ROOT = resolve(import.meta.dir, "..");
const rel = (p: string) => relative(ROOT, p);
const sleep = (ms: number) => Bun.sleep(ms);

function flag(name: string): string | undefined {
  return process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}
function has(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

const DURATION_MS = (Number(flag("duration")) || 20) * 1000;
const INTERVAL_MS = (Number(flag("interval")) || 2) * 1000;
const PORT = Number(flag("port")) || 8080;
const OUT = resolve(ROOT, flag("out") ?? "screenshot-review/steam");
const TITLE = flag("title");
const ALL = has("all");
const KEEP = has("keep");

/** Filesystem-safe slug from a tab title, for the filename. */
function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[™®]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "tab"
  );
}

/**
 * Pick the tab(s) to capture this tick. With `--all`, every `page`-type
 * tab; with `--title`, the exact-title match; otherwise the Big Picture
 * SharedJSContext window, falling back to the first `page` tab so a
 * desktop-Steam / unfamiliar-UI run still produces something.
 */
function pickTabs(tabs: CEFTab[]): CEFTab[] {
  const pages = tabs.filter((t) => t.type === "page");
  if (ALL) return pages;
  if (TITLE) return pages.filter((t) => t.title === TITLE);
  const shared = tabs.find(isSharedJSContextTab);
  if (shared) return [shared];
  return pages.slice(0, 1);
}

/** Read a PNG's pixel dimensions straight from its IHDR chunk (bytes
 *  16–23, big-endian). Lets us flag offscreen/unrendered tabs, which CEF
 *  returns as a 2×2 placeholder. */
function pngSize(buf: Buffer): { w: number; h: number } {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** Connect, grab one PNG, write it, disconnect. Re-resolved per tick so
 *  Steam navigating to a new target mid-run doesn't strand us on a dead
 *  WebSocket. Returns the written frame's dimensions, or null if nothing
 *  came back. */
async function captureTab(
  tab: CEFTab,
  file: string,
): Promise<{ w: number; h: number } | null> {
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  try {
    await new Promise<void>((res, rej) => {
      ws.addEventListener("open", () => res(), { once: true });
      ws.addEventListener("error", () => rej(new Error("ws error")), { once: true });
    });
    const data = await new Promise<string | undefined>((res) => {
      const handler = (ev: MessageEvent) => {
        const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
        if (msg.id === 1) {
          ws.removeEventListener("message", handler);
          res(msg.result?.data);
        }
      };
      ws.addEventListener("message", handler);
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Page.captureScreenshot",
          params: { format: "png", captureBeyondViewport: false },
        }),
      );
      // Don't hang the whole run if a tab never answers (offscreen JS
      // context, busy renderer) — give up on this frame after 4s.
      setTimeout(() => res(undefined), 4000);
    });
    if (!data) return null;
    const buf = Buffer.from(data, "base64");
    writeFileSync(file, buf);
    return pngSize(buf);
  } finally {
    ws.close();
  }
}

async function main(): Promise<void> {
  // Fail fast with a friendly message if Steam's debug port is dark.
  let firstTabs: CEFTab[];
  try {
    firstTabs = await listCefTabs({ debugPort: PORT });
  } catch (err) {
    console.error(
      `Couldn't reach Steam's CEF on localhost:${PORT}/json — is Steam running ` +
        `with remote debugging enabled?\n  ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }

  const preview = pickTabs(firstTabs);
  if (preview.length === 0) {
    console.error(
      `No matching tab found on :${PORT}. Tabs seen:\n` +
        firstTabs.map((t) => `  [${t.type}] ${t.title} — ${t.url}`).join("\n"),
    );
    process.exit(1);
  }

  if (!KEEP && existsSync(OUT)) {
    for (const f of readdirSync(OUT)) {
      if (f.startsWith("steam-") && f.endsWith(".png")) rmSync(join(OUT, f));
    }
  }
  mkdirSync(OUT, { recursive: true });

  const shots = Math.floor(DURATION_MS / INTERVAL_MS) + 1;
  console.log(
    `Capturing ${ALL ? `${preview.length} tab(s)` : `"${preview[0]!.title}"`} ` +
      `every ${INTERVAL_MS / 1000}s for ${DURATION_MS / 1000}s (~${shots} frames) → ${rel(OUT)}/`,
  );
  console.log("Navigate Steam now…\n");

  const start = Date.now();
  let seq = 0;
  let written = 0;
  let empty = 0; // offscreen/unrendered frames (CEF 2×2 placeholder)
  while (Date.now() - start <= DURATION_MS) {
    const n = String(seq).padStart(3, "0");
    // Re-resolve tabs each tick: targets churn as Steam navigates.
    let tabs: CEFTab[];
    try {
      tabs = await listCefTabs({ debugPort: PORT });
    } catch {
      console.log(`  [${n}] /json unreachable — skipping`);
      seq++;
      await sleep(INTERVAL_MS);
      continue;
    }
    const targets = pickTabs(tabs);
    for (const tab of targets) {
      const name = ALL ? `steam-${n}-${slug(tab.title)}.png` : `steam-${n}.png`;
      const file = join(OUT, name);
      try {
        const size = await captureTab(tab, file);
        if (!size) {
          console.log(`  [${n}] no frame from "${tab.title}"`);
        } else if (size.w <= 2 && size.h <= 2) {
          empty++;
          console.log(`  [${n}] ${rel(file)} — ⚠ ${size.w}×${size.h} (tab not rendered/offscreen)`);
        } else {
          written++;
          console.log(`  [${n}] → ${rel(file)} (${size.w}×${size.h})`);
        }
      } catch (err) {
        console.log(`  [${n}] capture failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    seq++;
    await sleep(INTERVAL_MS);
  }

  console.log(`\nDone — ${written} real frame(s) in ${rel(OUT)}/`);
  if (written === 0 && empty > 0) {
    console.log(
      "\n⚠ Every frame came back blank (2×2). The targeted tab isn't the\n" +
        "  on-screen window — in DESKTOP Steam the SharedJSContext is offscreen.\n" +
        "  Run this from GAMING MODE / Big Picture (where it's the rendered\n" +
        "  window), or try --all and pick whichever tab captured real pixels.",
    );
  }
  process.exit(0);
}

main();
