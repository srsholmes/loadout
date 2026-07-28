// Unit tests for the shared retry policy in lib/retry.ts.
//
// This replaced three hand-rolled retry loops in the overlay, so the tests
// pin both shapes it has to serve: the bounded ladder used by plugin-bundle
// and plugin-list fetches, and the unbounded backoff used by the startup
// gates (session token, sidebar plugin list) where giving up is not an option.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  HttpError,
  exponentialDelays,
  fetchTextNoCache,
  fixedDelays,
  isRetriableError,
  retryAsync,
} from "./retry";

const NO_DELAY = [0, 0, 0] as const;

describe("fixedDelays", () => {
  it("hands back each rung in order, then null to stop", () => {
    const policy = fixedDelays([10, 20, 30]);
    expect(policy(0)).toBe(10);
    expect(policy(1)).toBe(20);
    expect(policy(2)).toBe(30);
    expect(policy(3)).toBeNull();
    expect(policy(99)).toBeNull();
  });

  it("gives up immediately when the ladder is empty", () => {
    expect(fixedDelays([])(0)).toBeNull();
  });

  it("treats a literal 0 rung as a real delay, not as 'stop'", () => {
    // Guards against a truthiness check creeping in — the test suites here
    // pass 0-length ladders to skip real waiting.
    expect(fixedDelays([0])(0)).toBe(0);
  });
});

describe("exponentialDelays", () => {
  it("doubles from the base and clamps at the cap, never stopping", () => {
    const policy = exponentialDelays({ base: 100, cap: 800 });
    expect([0, 1, 2, 3, 4, 50].map(policy)).toEqual([100, 200, 400, 800, 800, 800]);
  });
});

describe("isRetriableError", () => {
  it("retries network-layer failures", () => {
    expect(isRetriableError(new TypeError("Failed to fetch"))).toBe(true);
  });

  it("retries 5xx", () => {
    expect(isRetriableError(new HttpError({ status: 503, message: "x" }))).toBe(true);
  });

  it("retries 408 and 429, the conventional transient 4xx", () => {
    expect(isRetriableError(new HttpError({ status: 408, message: "x" }))).toBe(true);
    expect(isRetriableError(new HttpError({ status: 429, message: "x" }))).toBe(true);
  });

  it("does not retry 404 or 401 — those are real answers", () => {
    expect(isRetriableError(new HttpError({ status: 404, message: "x" }))).toBe(false);
    expect(isRetriableError(new HttpError({ status: 401, message: "x" }))).toBe(false);
  });
});

describe("retryAsync", () => {
  it("returns the first success without retrying", async () => {
    let calls = 0;
    const out = await retryAsync({
      label: "t",
      delays: fixedDelays(NO_DELAY),
      run: async () => { calls++; return "ok"; },
    });
    expect(out).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries a transient failure and returns the eventual success", async () => {
    let calls = 0;
    const out = await retryAsync({
      label: "t",
      delays: fixedDelays(NO_DELAY),
      run: async () => {
        calls++;
        if (calls < 3) throw new TypeError("Failed to fetch");
        return "late";
      },
    });
    expect(out).toBe("late");
    expect(calls).toBe(3);
  });

  it("runs 1 + N attempts, then rethrows the last error", async () => {
    let calls = 0;
    await expect(
      retryAsync({
        label: "t",
        delays: fixedDelays(NO_DELAY),
        run: async () => { calls++; throw new TypeError("Failed to fetch"); },
      }),
    ).rejects.toThrow("Failed to fetch");
    expect(calls).toBe(NO_DELAY.length + 1);
  });

  it("stops at the first non-retriable error without burning the ladder", async () => {
    let calls = 0;
    await expect(
      retryAsync({
        label: "t",
        delays: fixedDelays(NO_DELAY),
        run: async () => {
          calls++;
          throw new HttpError({ status: 404, message: "HTTP 404 loading x" });
        },
      }),
    ).rejects.toThrow("HTTP 404");
    expect(calls).toBe(1);
  });

  it("preserves the failing error's identity, not a wrapped copy", async () => {
    const original = new HttpError({ status: 503, message: "HTTP 503 loading x" });
    const err = await retryAsync({
      label: "t",
      delays: fixedDelays([]),
      run: async () => { throw original; },
    }).catch((e) => e);
    expect(err).toBe(original);
    expect((err as HttpError).status).toBe(503);
  });

  it("uses the ladder rungs in order", async () => {
    let calls = 0;
    const t0 = performance.now();
    await retryAsync({
      label: "t",
      delays: fixedDelays([40, 250]),
      run: async () => {
        calls++;
        if (calls < 3) throw new TypeError("Failed to fetch");
        return "done";
      },
    });
    const elapsed = performance.now() - t0;
    // 40 + 250 = 290. Bounded above so reusing one rung (80 / 500) or a
    // 1000ms fallback creeping back in would fail.
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(700);
  });

  it("keeps retrying past any fixed count under an unbounded policy", async () => {
    let calls = 0;
    const out = await retryAsync({
      label: "t",
      delays: exponentialDelays({ base: 0, cap: 0 }),
      isRetriable: () => true,
      run: async () => {
        calls++;
        if (calls < 12) throw new Error("not ready");
        return "up";
      },
    });
    expect(out).toBe("up");
    expect(calls).toBe(12);
  });

  it("stops when shouldContinue goes false and fires no further attempt", async () => {
    // Deliberately a BOUNDED ladder. The same assertion under an unbounded
    // policy would hang forever if the in-loop shouldContinue check were
    // removed, which is a useless way for a test to fail; bounded means a
    // missing check shows up as calls === 4 instead of a wedged suite.
    let calls = 0;
    let live = true;
    await expect(
      retryAsync({
        label: "t",
        delays: fixedDelays(NO_DELAY),
        isRetriable: () => true,
        shouldContinue: () => live,
        run: async () => {
          calls++;
          live = false; // e.g. the effect unmounted mid-flight
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");
    // Rejects with the real error, not a generic "cancelled" — a caller that
    // failed then got cancelled should still see why it failed.
    expect(calls).toBe(1);
  });

  it("does not run even once when cancelled before starting", async () => {
    let calls = 0;
    await expect(
      retryAsync({
        label: "t",
        delays: fixedDelays(NO_DELAY),
        shouldContinue: () => false,
        run: async () => { calls++; return "never"; },
      }),
    ).rejects.toThrow("cancelled");
    expect(calls).toBe(0);
  });
});

describe("fetchTextNoCache", () => {
  let origFetch: unknown;
  let urls: string[] = [];

  beforeEach(() => {
    urls = [];
    origFetch = (globalThis as { fetch?: unknown }).fetch;
  });
  afterEach(() => {
    (globalThis as { fetch?: unknown }).fetch = origFetch;
  });

  function stub(res: Response | Error): void {
    (globalThis as { fetch: unknown }).fetch = (url: string) => {
      urls.push(url);
      return res instanceof Error ? Promise.reject(res) : Promise.resolve(res);
    };
  }

  it("returns the body on 2xx", async () => {
    stub(new Response("export const x = 1", { status: 200 }));
    expect(await fetchTextNoCache({ url: "http://h/b.js", what: "b" })).toBe(
      "export const x = 1",
    );
  });

  it("throws an HttpError carrying the status on non-2xx", async () => {
    stub(new Response("", { status: 503 }));
    const err = await fetchTextNoCache({ url: "http://h/b.js", what: "b" }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(503);
    expect((err as HttpError).message).toBe("HTTP 503 loading b");
  });

  it("appends a cache-buster with ? when the url has no query", async () => {
    stub(new Response("x", { status: 200 }));
    await fetchTextNoCache({ url: "http://h/b.js", what: "b" });
    expect(urls[0]).toMatch(/^http:\/\/h\/b\.js\?t=\d+$/);
  });

  it("appends with & when the url already has a query", async () => {
    stub(new Response("x", { status: 200 }));
    await fetchTextNoCache({ url: "http://h/api?installed=1", what: "b" });
    expect(urls[0]).toMatch(/^http:\/\/h\/api\?installed=1&t=\d+$/);
  });

  it("propagates a network-layer throw untouched so the policy can classify it", async () => {
    stub(new TypeError("Failed to fetch"));
    await expect(
      fetchTextNoCache({ url: "http://h/b.js", what: "b" }),
    ).rejects.toThrow("Failed to fetch");
  });
});
