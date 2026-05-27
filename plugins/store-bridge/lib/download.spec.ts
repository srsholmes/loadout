import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { downloadFile, fetchLatestRelease, githubToken } from "./download";

// Tiny in-process fetch stub. Bun-test runs every spec in a single
// process — patching globalThis.fetch is the lowest-friction shim
// and lets us assert on the URL + headers the helper produced.
const originalFetch = globalThis.fetch;
let lastRequest: { url: string; init?: RequestInit } | null = null;
function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  (globalThis as { fetch: typeof fetch }).fetch = ((url: string, init?: RequestInit) => {
    lastRequest = { url, init };
    return impl(url, init);
  }) as unknown as typeof fetch;
}

describe("downloadFile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "store-bridge-download-"));
    lastRequest = null;
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
    await downloadFile("https://example.test/file.bin", dest, (d, t) => {
      seen.push([d, t]);
    });
    const written = await readFile(dest);
    expect(written).toEqual(Buffer.from(payload));
    // Progress callback fires at least once with the final total.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toEqual([payload.byteLength, payload.byteLength]);
  });

  it("throws on non-2xx responses", async () => {
    stubFetch(() => Promise.resolve(new Response("nope", { status: 404 })));
    await expect(
      downloadFile("https://example.test/missing", join(dir, "x.bin")),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("refuses to follow a redirect off github.com / githubusercontent.com", async () => {
    // Simulate the response a compromised release would produce:
    // the body comes back fine, but `res.url` (the post-redirect
    // final URL fetch reports) is an attacker host. Bun's fetch
    // would have stripped Authorization, but the body would still
    // be written to disk without this guard.
    stubFetch(() => {
      const r = new Response(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), {
        status: 200,
        headers: { "content-length": "4" },
      });
      Object.defineProperty(r, "url", { value: "https://evil.example/payload" });
      return Promise.resolve(r);
    });
    await expect(
      downloadFile("https://github.com/x/y/releases/download/v1/legendary", join(dir, "x.bin")),
    ).rejects.toThrow(/redirect landed on untrusted host evil\.example/);
  });

  it("allows the canonical github.com → objects.githubusercontent.com redirect", async () => {
    stubFetch(() => {
      const r = new Response(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), {
        status: 200,
        headers: { "content-length": "4" },
      });
      Object.defineProperty(r, "url", {
        value: "https://objects.githubusercontent.com/blob/abc",
      });
      return Promise.resolve(r);
    });
    await expect(
      downloadFile(
        "https://github.com/x/y/releases/download/v1/legendary",
        join(dir, "ok.bin"),
      ),
    ).resolves.toBeUndefined();
  });

  it("doesn't trip on github.com.evil.com lookalike hosts", async () => {
    stubFetch(() => {
      const r = new Response(new Uint8Array([0]), {
        status: 200,
        headers: { "content-length": "1" },
      });
      Object.defineProperty(r, "url", {
        value: "https://github.com.evil.com/payload",
      });
      return Promise.resolve(r);
    });
    await expect(
      downloadFile("https://github.com/x/y/asset", join(dir, "lookalike.bin")),
    ).rejects.toThrow(/redirect landed on untrusted host github\.com\.evil\.com/);
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
    await downloadFile("https://example.test/auth.bin", join(dir, "auth.bin"));
    const headers = lastRequest!.init!.headers as Record<string, string>;
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
    await downloadFile("https://example.test/ua.bin", join(dir, "ua.bin"));
    expect(lastRequest?.init?.headers).toBeDefined();
    const headers = lastRequest!.init!.headers as Record<string, string>;
    expect(headers["User-Agent"]).toContain("SteamLoader-StoreBridge");
  });
});

describe("fetchLatestRelease", () => {
  const env = process.env.GITHUB_TOKEN;
  beforeEach(() => {
    lastRequest = null;
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
    expect(lastRequest?.url).toContain("/repos/derrod/legendary/releases/latest");
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
