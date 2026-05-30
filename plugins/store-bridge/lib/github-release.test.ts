import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { downloadFile, fetchLatestRelease, githubToken } from "./github-release";

// Tiny in-process fetch stub. Bun-test runs every spec in a single
// process — patching globalThis.fetch is the lowest-friction shim
// and lets us assert on the URL + headers the helper produced.
const originalFetch = globalThis.fetch;
let requests: Array<{ url: string; init?: RequestInit }> = [];
function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  (globalThis as { fetch: typeof fetch }).fetch = ((url: string, init?: RequestInit) => {
    requests.push({ url, init });
    return impl(url, init);
  }) as unknown as typeof fetch;
}

describe("downloadFile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "store-bridge-download-"));
    requests = [];
    // Force the no-token branch so the assertions are predictable.
    process.env.GITHUB_TOKEN = "";
  });

  afterEach(async () => {
    (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  });

  it("streams the body to disk and reports progress", async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    stubFetch(
      () =>
        Promise.resolve(
          new Response(payload, {
            status: 200,
            headers: { "content-length": String(payload.byteLength) },
          }),
        ),
    );
    const dest = join(dir, "nested", "out.bin");
    const seen: Array<[number, number]> = [];
    await downloadFile(
      "https://github.com/x/y/releases/download/v1/legendary",
      dest,
      (d, t) => {
        seen.push([d, t]);
      },
    );
    const written = await readFile(dest);
    expect(written).toEqual(Buffer.from(payload));
    // Progress callback fires at least once with the final total.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toEqual([payload.byteLength, payload.byteLength]);
  });

  it("throws on non-2xx responses", async () => {
    stubFetch(() => Promise.resolve(new Response("nope", { status: 404 })));
    await expect(
      downloadFile(
        "https://github.com/x/y/releases/download/v1/missing",
        join(dir, "x.bin"),
      ),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("rejects an off-domain start URL before issuing the first request", async () => {
    stubFetch(() => Promise.resolve(new Response("nope", { status: 200 })));
    await expect(
      downloadFile("https://evil.example/payload", join(dir, "x.bin")),
    ).rejects.toThrow(/untrusted host evil\.example/);
    // The host check happens BEFORE the fetch — no request issued.
    expect(requests).toHaveLength(0);
  });

  it("walks the canonical github.com → objects.githubusercontent.com redirect manually", async () => {
    // First hop: 302 from github.com to objects.githubusercontent.com.
    // Second hop: 200 with the body. The manual walk re-validates the
    // host on each hop before issuing the next fetch.
    stubFetch((url) => {
      if (url.startsWith("https://github.com/")) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "https://objects.githubusercontent.com/blob/abc" },
          }),
        );
      }
      return Promise.resolve(
        new Response(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), {
          status: 200,
          headers: { "content-length": "4" },
        }),
      );
    });
    await downloadFile(
      "https://github.com/x/y/releases/download/v1/legendary",
      join(dir, "ok.bin"),
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toContain("github.com");
    expect(requests[1]?.url).toContain("objects.githubusercontent.com");
  });

  it("refuses to follow a redirect to a non-allow-listed host", async () => {
    // 302 from github.com pointing at an attacker host — the manual
    // walker must reject BEFORE issuing the second fetch, so the
    // attacker host never sees our request (no Authorization leak,
    // no body read).
    stubFetch((url) => {
      if (url.startsWith("https://github.com/")) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "https://evil.example/payload" },
          }),
        );
      }
      return Promise.resolve(new Response("should not happen", { status: 200 }));
    });
    await expect(
      downloadFile(
        "https://github.com/x/y/releases/download/v1/legendary",
        join(dir, "x.bin"),
      ),
    ).rejects.toThrow(/untrusted host evil\.example/);
    // Exactly one request — the second hop refused before being
    // dispatched, so the attacker host never received anything.
    expect(requests).toHaveLength(1);
  });

  it("doesn't trip on github.com.evil.com lookalike hosts", async () => {
    stubFetch((url) => {
      if (url.startsWith("https://github.com/x")) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "https://github.com.evil.com/payload" },
          }),
        );
      }
      return Promise.resolve(new Response("should not happen", { status: 200 }));
    });
    await expect(
      downloadFile(
        "https://github.com/x/y/asset",
        join(dir, "lookalike.bin"),
      ),
    ).rejects.toThrow(/untrusted host github\.com\.evil\.com/);
  });

  it("sends an Authorization header when GITHUB_TOKEN is set", async () => {
    stubFetch(
      () =>
        Promise.resolve(
          new Response(new Uint8Array([0]), {
            status: 200,
            headers: { "content-length": "1" },
          }),
        ),
    );
    process.env.GITHUB_TOKEN = "ghp_abc123";
    await downloadFile(
      "https://github.com/x/y/releases/download/v1/auth.bin",
      join(dir, "auth.bin"),
    );
    const headers = requests[0]!.init!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer ghp_abc123");
  });

  it("sends a SteamLoader User-Agent header", async () => {
    stubFetch(
      () =>
        Promise.resolve(
          new Response(new Uint8Array([0]), {
            status: 200,
            headers: { "content-length": "1" },
          }),
        ),
    );
    await downloadFile(
      "https://github.com/x/y/releases/download/v1/ua.bin",
      join(dir, "ua.bin"),
    );
    expect(requests[0]?.init?.headers).toBeDefined();
    const headers = requests[0]!.init!.headers as Record<string, string>;
    expect(headers["User-Agent"]).toContain("Loadout-StoreBridge");
  });

  it("aborts after MAX_HOPS redirects to prevent loops", async () => {
    // Two github hosts that bounce back and forth — the walker should
    // give up after 10 hops and throw without ever returning a body.
    stubFetch((url) => {
      const next = url.includes("/a")
        ? "https://objects.githubusercontent.com/b"
        : "https://github.com/a";
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: next },
        }),
      );
    });
    await expect(
      downloadFile("https://github.com/a", join(dir, "loop.bin")),
    ).rejects.toThrow();
    // Hard cap: never more than the 10-hop limit (one extra check
    // would still tolerate the off-by-one).
    expect(requests.length).toBeLessThanOrEqual(11);
  });
});

describe("fetchLatestRelease", () => {
  const env = process.env.GITHUB_TOKEN;
  beforeEach(() => {
    requests = [];
    process.env.GITHUB_TOKEN = "";
  });
  afterEach(() => {
    (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    process.env.GITHUB_TOKEN = env ?? "";
  });

  it("hits the latest-release endpoint and parses JSON", async () => {
    stubFetch(
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              tag_name: "v1.2.3",
              assets: [
                { name: "legendary", browser_download_url: "https://x/y", size: 100 },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
    );
    const r = await fetchLatestRelease("derrod/legendary");
    expect(r.tag_name).toBe("v1.2.3");
    expect(r.assets[0]?.name).toBe("legendary");
    expect(requests[0]?.url).toContain("/repos/derrod/legendary/releases/latest");
  });

  it("throws on non-200", async () => {
    stubFetch(() => Promise.resolve(new Response("rate limited", { status: 403 })));
    await expect(fetchLatestRelease("nope/nope")).rejects.toThrow(/HTTP 403/);
  });
});

describe("githubToken", () => {
  const env = process.env.GITHUB_TOKEN;
  afterEach(() => {
    process.env.GITHUB_TOKEN = env ?? "";
  });

  it("prefers GITHUB_TOKEN from the environment", async () => {
    process.env.GITHUB_TOKEN = "ghp_envtoken123";
    expect(await githubToken()).toBe("ghp_envtoken123");
  });
});
