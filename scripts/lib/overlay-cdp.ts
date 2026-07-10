/**
 * Shared Chrome DevTools Protocol (CDP) machinery for driving the running
 * Loadout overlay over its CEF DevTools endpoint (http://localhost:9222 in
 * dev — baked in via electrobun.config.ts → build.linux.chromiumFlags).
 *
 * Both the screenshot capture (`capture-screenshots.ts`) and the video
 * capture (`capture-videos.ts`) drive the overlay the same way: connect to
 * the "Loadout Overlay" target, navigate the shell's hash routes, wait for
 * the DOM to go idle, and click DOM elements to reach a plugin's internal
 * sub-pages (which have no URL of their own). That common surface lives
 * here so the two capture scripts stay in lock-step.
 *
 * The overlay shell only routes `#/`, `#/settings`, `#/plugin/<id>`; a
 * plugin's sub-pages are internal React state reached by clicking, driven
 * by the per-plugin recipe tables in each capture script.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Brief settle for the route swap + first paint before we poll for idle.
export const SETTLE_MS = 300;
// Async-loading wait: many plugins fetch over the network on mount
// (ProtonDB, HLTB, SteamGridDB, store libraries), so a fixed sleep either
// over-waits or fires mid-spinner. Poll until no loading indicators remain.
export const IDLE_TIMEOUT_MS = 8000;
export const IDLE_POLL_MS = 200;
// The DOM must stay idle this long before we trust it — guards the gap
// between one fetch's spinner clearing and the next appearing.
export const IDLE_STABLE_MS = 400;

// A click target may not exist yet — plugin headers/grids that fetch data
// (recomp, hltb, steamgriddb, launch-options) render their gear/tiles only
// after the load resolves. Poll for the element before giving up so a slow
// fetch doesn't read as "page absent".
export const CLICK_TRIES = 6;
export const CLICK_RETRY_MS = 500;

export const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

/** Resolve the WebSocket debugger URL for the running overlay target. */
export async function cdpWs(): Promise<string> {
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

type EventHandler = (params: Record<string, unknown>) => void;

export class CDP {
  private ws!: WebSocket;
  private id = 0;
  private pending = new Map<number, (msg: Record<string, unknown>) => void>();
  // CDP *events* (messages with a `method` and no `id`) are dispatched to
  // handlers registered here. Screencast recording needs this; the
  // request/response `pending` map above can't see events.
  private handlers = new Map<string, Set<EventHandler>>();

  static async connect(url: string): Promise<CDP> {
    const cdp = new CDP();
    cdp.ws = new WebSocket(url);
    cdp.ws.addEventListener("message", (ev: MessageEvent) => {
      const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
      // Responses carry an `id`; CDP events carry a `method` instead.
      if (typeof msg.id === "number" && cdp.pending.has(msg.id)) {
        cdp.pending.get(msg.id)!(msg);
        cdp.pending.delete(msg.id);
      } else if (typeof msg.method === "string") {
        const hs = cdp.handlers.get(msg.method);
        if (hs) for (const h of hs) h(msg.params ?? {});
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

  call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.id;
    return new Promise((res) => {
      this.pending.set(id, res);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Subscribe to a CDP event. Returns an unsubscribe function. */
  on(method: string, handler: EventHandler): () => void {
    let set = this.handlers.get(method);
    if (!set) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  async eval(expr: string, awaitPromise = false): Promise<unknown> {
    const r = (await this.call("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise,
    })) as { result?: { result?: { value?: unknown } } };
    return r.result?.result?.value;
  }

  async screenshot(path: string, label?: string): Promise<void> {
    const r = (await this.call("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    })) as { result?: { data?: string } };
    const data = r.result?.data;
    if (!data) throw new Error(`no data: ${JSON.stringify(r)}`);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, Buffer.from(data, "base64"));
    console.log(`  → ${label ?? path}`);
  }

  close(): void {
    this.ws.close();
  }
}

// ── Recipe step vocabulary ─────────────────────────────────────────────────
//
// A `Step` is a single CDP-driven action shared by both capture scripts.
// `tile` clicks the first shared GameCard (`[data-game-card]`) to open a
// detail page; `aria`/`text` click a control by aria-label / visible text
// (gears, tabs); `wait` adds settle time; `nav` sets a shell hash route;
// `sidebar` toggles the drawer (its expand/collapse animates, so it's a
// useful video beat).
export type Step =
  | { kind: "tile" }
  | { kind: "aria"; label: string }
  | { kind: "text"; label: string }
  | { kind: "wait"; ms: number }
  | { kind: "nav"; hash: string }
  | { kind: "sidebar"; collapsed: boolean };

// "Busy" if any DaisyUI `.loading` spinner / `animate-spin` icon is
// present, OR any *in-viewport* image hasn't finished decoding. The image
// check is what stops us shooting game/detail art before it paints —
// spinners alone don't cover lazy <img> loads. Off-screen lazy images are
// ignored (they never load until scrolled to, so they'd never settle).
export const BUSY_EXPR = `(() => {
  if (document.querySelectorAll('.loading, [class*="animate-spin"]').length) return true;
  const vw = innerWidth, vh = innerHeight;
  for (const img of document.images) {
    const r = img.getBoundingClientRect();
    const inView = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw && r.width > 0 && r.height > 0;
    if (inView && (!img.complete || img.naturalWidth === 0)) return true;
  }
  return false;
})()`;

/**
 * Wait until the overlay has no visible loading state — no spinners and
 * no in-viewport image still decoding — staying clear for `IDLE_STABLE_MS`
 * so we don't fire in the gap between two sequential fetches. Falls
 * through after `IDLE_TIMEOUT_MS` so a perpetually-loading view still gets
 * captured.
 */
export async function waitForIdle(cdp: CDP): Promise<void> {
  const start = Date.now();
  let idleSince: number | null = null;
  while (Date.now() - start < IDLE_TIMEOUT_MS) {
    const busy = (await cdp.eval(BUSY_EXPR)) === true;
    if (busy) {
      idleSince = null;
    } else {
      idleSince ??= Date.now();
      if (Date.now() - idleSince >= IDLE_STABLE_MS) return;
    }
    await sleep(IDLE_POLL_MS);
  }
}

export async function navigate(cdp: CDP, hashPath: string): Promise<void> {
  await cdp.eval(`location.hash='${hashPath}'; void 0`);
  await sleep(SETTLE_MS); // let the route swap + mount begin
  await waitForIdle(cdp); // then wait out any async loading
}

export async function setSidebarCollapsed(cdp: CDP, collapsed: boolean): Promise<void> {
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
export async function clickSelector(cdp: CDP, selector: string): Promise<boolean> {
  const expr = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.click();
    return true;
  })()`;
  return (await cdp.eval(expr)) === true;
}

/** Click the first button/[role=button] whose text starts with `label`. */
export async function clickText(cdp: CDP, label: string): Promise<boolean> {
  const expr = `(() => {
    const els = [...document.querySelectorAll('button, [role="button"]')];
    const el = els.find((e) => (e.textContent || "").trim().startsWith(${JSON.stringify(label)}));
    if (!el) return false;
    el.click();
    return true;
  })()`;
  return (await cdp.eval(expr)) === true;
}

export async function clickWithRetry(fn: () => Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < CLICK_TRIES; i++) {
    if (await fn()) return true;
    await sleep(CLICK_RETRY_MS);
  }
  return false;
}

/**
 * Run a recipe's steps. Returns false (page unreachable) if any click
 * target never appears. `nav`/`sidebar`/`wait` steps always succeed.
 */
export async function runSteps(cdp: CDP, steps: Step[]): Promise<boolean> {
  for (const step of steps) {
    if (step.kind === "wait") {
      await sleep(step.ms);
      continue;
    }
    if (step.kind === "nav") {
      await navigate(cdp, step.hash);
      continue;
    }
    if (step.kind === "sidebar") {
      await setSidebarCollapsed(cdp, step.collapsed);
      continue;
    }
    let ok = false;
    if (step.kind === "tile")
      ok = await clickWithRetry(() => clickSelector(cdp, "[data-game-card]"));
    else if (step.kind === "aria")
      ok = await clickWithRetry(() => clickSelector(cdp, `[aria-label="${step.label}"]`));
    else if (step.kind === "text") ok = await clickWithRetry(() => clickText(cdp, step.label));
    if (!ok) return false;
    await sleep(SETTLE_MS);
    await waitForIdle(cdp); // sub-page may fetch on open (detail pages)
  }
  return true;
}
