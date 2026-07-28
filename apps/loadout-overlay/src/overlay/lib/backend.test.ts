// Unit tests for the plugin-bundle fetch retry in lib/backend.ts.
//
// The bug this covers: the overlay fires every plugin's bundle fetch in
// parallel ~3 ms into page load. On a handheld booting straight into gaming
// mode, Wi-Fi is often still associating right then — the interface goes
// active, Chromium flushes its socket pool, and every in-flight request dies
// with ERR_NETWORK_CHANGED (a bare `TypeError: Failed to fetch` in JS).
// Nothing re-requested them, so those plugins' widgets and icons stayed dead
// for the whole session. Observed live: 8 bundles landed before the flush, 17
// died; the identical fetches all succeeded seconds later.
//
// importPluginBundle itself isn't unit-tested here — it evaluates the bundle
// via `import()` of a blob: URL, which needs a real browser module loader.
// fetchBundleSource holds all the retry logic, so it's the unit under test.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { fetchBundleSource } from "./backend";

// No real backoff — the ladder's *shape* is what matters, not the wall time.
const NO_DELAY = [0, 0, 0] as const;

type FetchResult = Response | Error;

let calls: string[] = [];
let origFetch: unknown;

/** Queue a scripted sequence of outcomes, one per fetch attempt. Errors are
 *  thrown (network layer); Responses are returned (HTTP layer). The last
 *  entry repeats forever, so "fails and keeps failing" is one entry.
 *
 *  Footgun: repeating an entry hands back the SAME Response object, so a
 *  script whose repeated entry is an `ok()` would throw "Body already used"
 *  on the second read. Only repeat entries whose body is never read (errors,
 *  or non-2xx, which short-circuit before `.text()`). */
function scriptFetch(results: FetchResult[]): void {
  let i = 0;
  (globalThis as { fetch: unknown }).fetch = (url: string) => {
    calls.push(url);
    const r = results[Math.min(i, results.length - 1)];
    i++;
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  };
}

const ok = (body: string) => new Response(body, { status: 200 });
const status = (code: number) => new Response("", { status: code });
/** What Chromium surfaces to JS when the socket pool is flushed. */
const networkChanged = () => new TypeError("Failed to fetch");

beforeEach(() => {
  calls = [];
  origFetch = (globalThis as { fetch?: unknown }).fetch;
});

afterEach(() => {
  (globalThis as { fetch?: unknown }).fetch = origFetch;
});

describe("fetchBundleSource", () => {
  it("returns the body without retrying when the first attempt succeeds", async () => {
    scriptFetch([ok("export const x = 1")]);
    const text = await fetchBundleSource({ pluginId: "battery-tracker", delays: NO_DELAY });
    expect(text).toBe("export const x = 1");
    expect(calls.length).toBe(1);
  });

  it("recovers from the ERR_NETWORK_CHANGED flush that broke the widgets", async () => {
    scriptFetch([networkChanged(), ok("export const y = 2")]);
    const text = await fetchBundleSource({ pluginId: "display-settings", delays: NO_DELAY });
    expect(text).toBe("export const y = 2");
    expect(calls.length).toBe(2);
  });

  it("keeps retrying up to the full ladder before giving up", async () => {
    scriptFetch([networkChanged(), networkChanged(), networkChanged(), ok("late")]);
    const text = await fetchBundleSource({ pluginId: "wifi", delays: NO_DELAY });
    expect(text).toBe("late");
    // 1 initial + 3 retries — the last retry is the one that lands.
    expect(calls.length).toBe(4);
  });

  it("gives up after the ladder is exhausted and surfaces the last error", async () => {
    scriptFetch([networkChanged()]);
    await expect(
      fetchBundleSource({ pluginId: "bluetooth", delays: NO_DELAY }),
    ).rejects.toThrow("Failed to fetch");
    expect(calls.length).toBe(NO_DELAY.length + 1);
  });

  it("retries a 5xx — a server hiccup usually clears on the next attempt", async () => {
    scriptFetch([status(503), ok("recovered")]);
    const text = await fetchBundleSource({ pluginId: "storage", delays: NO_DELAY });
    expect(text).toBe("recovered");
    expect(calls.length).toBe(2);
  });

  it("does NOT retry a 404 — the plugin is genuinely gone", async () => {
    scriptFetch([status(404)]);
    await expect(
      fetchBundleSource({ pluginId: "ghost-plugin", delays: NO_DELAY }),
    ).rejects.toThrow("HTTP 404");
    expect(calls.length).toBe(1);
  });

  it("does NOT retry a 401 — re-asking without credentials repeats the answer", async () => {
    scriptFetch([status(401)]);
    await expect(
      fetchBundleSource({ pluginId: "quick-links", delays: NO_DELAY }),
    ).rejects.toThrow("HTTP 401");
    expect(calls.length).toBe(1);
  });

  it("cache-busts per attempt so a retry can't be served the failed response", async () => {
    scriptFetch([networkChanged(), networkChanged(), ok("fresh")]);
    await fetchBundleSource({ pluginId: "rgb-control", delays: NO_DELAY });
    expect(calls.length).toBe(3);
    expect(new Set(calls).size).toBe(3);
    for (const url of calls) {
      expect(url).toContain("/plugins/rgb-control/app-bundle.js");
      expect(url).toMatch(/\?t=\d+/);
    }
  });

  it("uses the ladder rungs in order, not some other index", async () => {
    // Two rungs, far apart, with BOTH bounds asserted. A single-rung test
    // can't catch an off-by-one: `delays[attempt]` would read past the end,
    // and any fallback (or a re-read of the wrong rung) still "waits a bit".
    // Failing twice forces both rungs to be paid — 40 + 250 = 290ms — so
    // reading the wrong index lands outside the window.
    scriptFetch([networkChanged(), networkChanged(), ok("third time")]);
    const t0 = performance.now();
    const text = await fetchBundleSource({
      pluginId: "network-info",
      delays: [40, 250],
    });
    const elapsed = performance.now() - t0;
    expect(text).toBe("third time");
    expect(elapsed).toBeGreaterThanOrEqual(280);
    // Generous headroom for scheduler jitter, but far below 40+40 (wrong rung
    // reused), 250+250, or a 1000ms fallback creeping in.
    expect(elapsed).toBeLessThan(700);
  });

  it("keeps the HTTP status in the error when a 5xx exhausts the ladder", async () => {
    // Guards the `lastErr = err` on the 5xx branch: without it the rejection
    // degrades to "…: undefined" and the status — the only diagnostic the
    // user ever sees — is lost.
    scriptFetch([status(503)]);
    await expect(
      fetchBundleSource({ pluginId: "storage", delays: NO_DELAY }),
    ).rejects.toThrow("HTTP 503");
    expect(calls.length).toBe(NO_DELAY.length + 1);
  });

  it("retries a body that dies mid-stream after headers arrived", async () => {
    const truncated = {
      ok: true,
      status: 200,
      text: () => Promise.reject(new TypeError("Failed to fetch")),
    } as unknown as Response;
    scriptFetch([truncated, ok("intact")]);
    const text = await fetchBundleSource({ pluginId: "hltb", delays: NO_DELAY });
    expect(text).toBe("intact");
    expect(calls.length).toBe(2);
  });

  it("makes exactly one attempt when the ladder is empty", async () => {
    scriptFetch([networkChanged()]);
    await expect(
      fetchBundleSource({ pluginId: "apex", delays: [] }),
    ).rejects.toThrow("Failed to fetch");
    expect(calls.length).toBe(1);
  });
});
