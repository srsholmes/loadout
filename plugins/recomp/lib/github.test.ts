import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Spec for the recomp plugin's GitHub-aware HTTP downloader. Pins
 * the `allowedHosts` redirect-guard behaviour introduced for
 * mod `direct-url` downloads — without that guard a CDN response
 * could redirect cross-host to an attacker-controlled file.
 *
 * The non-redirect happy path is exercised end-to-end by
 * `mods.spec.ts`'s github-release test; this spec narrows in on
 * the redirect-validation cases.
 */

let sandboxRoot = "";
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  sandboxRoot = await mkdtemp(join(tmpdir(), "recomp-github-spec-"));
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await rm(sandboxRoot, { recursive: true, force: true });
});

describe("downloadFile — allowedHosts post-redirect guard", () => {
  it("writes the file when the final URL host is in the allowlist", async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async (_req: string) => {
      const res = new Response("bytes", {
        status: 200,
        headers: { "content-length": "5" },
      });
      // Simulate a same-host response (no redirect).
      Object.defineProperty(res, "url", { value: "https://example.com/file.zip" });
      return res;
    }) as unknown as typeof fetch;
    const { downloadFile } = await import("./github");
    const dest = join(sandboxRoot, "out.bin");
    await downloadFile(
      "https://example.com/file.zip",
      dest,
      undefined,
      ["example.com"],
    );
    expect(await readFile(dest, "utf-8")).toBe("bytes");
  });

  it("refuses when the response redirected to a host not on the allowlist", async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async (_req: string) => {
      const res = new Response("bytes", { status: 200 });
      // Simulate a redirect from example.com to evil.com — `res.url`
      // carries the final URL after `redirect: "follow"`.
      Object.defineProperty(res, "url", { value: "https://evil.com/file.zip" });
      return res;
    }) as unknown as typeof fetch;
    const { downloadFile } = await import("./github");
    const dest = join(sandboxRoot, "out.bin");
    await expect(
      downloadFile(
        "https://example.com/file.zip",
        dest,
        undefined,
        ["example.com"],
      ),
    ).rejects.toThrow(/redirected to host "evil\.com"/);
  });

  it("does NOT enforce the guard when allowedHosts is undefined (back-compat)", async () => {
    // Existing github-release downloads (the loader's main install
    // path) don't pass allowedHosts; they rely on implicit GitHub
    // redirect chain. The guard mustn't fire when not opted in.
    (globalThis as { fetch: typeof fetch }).fetch = (async (_req: string) => {
      const res = new Response("ok", { status: 200 });
      Object.defineProperty(res, "url", { value: "https://anywhere.test/file" });
      return res;
    }) as unknown as typeof fetch;
    const { downloadFile } = await import("./github");
    const dest = join(sandboxRoot, "out.bin");
    await downloadFile("https://example.com/file.zip", dest);
    expect(await readFile(dest, "utf-8")).toBe("ok");
  });

  it("throws on non-2xx (no allowedHosts path needed)", async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const { downloadFile } = await import("./github");
    const dest = join(sandboxRoot, "out.bin");
    await expect(
      downloadFile("https://example.com/missing.zip", dest),
    ).rejects.toThrow(/HTTP 404/);
  });
});

describe("downloadFile — FIX 3: truncation / size-mismatch guard", () => {
  it("throws when fewer bytes arrive than Content-Length declares", async () => {
    // Body is 5 bytes but the header claims 999 — a mid-write
    // interruption. The downloader must fail fast, not hand a truncated
    // file to the extractor.
    (globalThis as { fetch: typeof fetch }).fetch = (async () => {
      const res = new Response("bytes", {
        status: 200,
        headers: { "content-length": "999" },
      });
      Object.defineProperty(res, "url", { value: "https://example.com/file.zip" });
      return res;
    }) as unknown as typeof fetch;
    const { downloadFile } = await import("./github");
    const dest = join(sandboxRoot, "trunc.bin");
    await expect(
      downloadFile("https://example.com/file.zip", dest),
    ).rejects.toThrow(/size|truncat|incomplete|mismatch/i);
  });

  it("removes the partial file on a size mismatch", async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () => {
      const res = new Response("bytes", {
        status: 200,
        headers: { "content-length": "999" },
      });
      Object.defineProperty(res, "url", { value: "https://example.com/file.zip" });
      return res;
    }) as unknown as typeof fetch;
    const { downloadFile } = await import("./github");
    const dest = join(sandboxRoot, "trunc2.bin");
    await downloadFile("https://example.com/file.zip", dest).catch(() => {});
    const { existsSync } = await import("node:fs");
    expect(existsSync(dest)).toBe(false);
  });

  it("succeeds when byte count matches Content-Length", async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () => {
      const res = new Response("bytes", {
        status: 200,
        headers: { "content-length": "5" },
      });
      Object.defineProperty(res, "url", { value: "https://example.com/file.zip" });
      return res;
    }) as unknown as typeof fetch;
    const { downloadFile } = await import("./github");
    const dest = join(sandboxRoot, "ok.bin");
    await downloadFile("https://example.com/file.zip", dest);
    expect(await readFile(dest, "utf-8")).toBe("bytes");
  });

  it("succeeds when Content-Length is absent (no expectation to check)", async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () => {
      const res = new Response("bytes", { status: 200 });
      Object.defineProperty(res, "url", { value: "https://example.com/file.zip" });
      return res;
    }) as unknown as typeof fetch;
    const { downloadFile } = await import("./github");
    const dest = join(sandboxRoot, "nolen.bin");
    await downloadFile("https://example.com/file.zip", dest);
    expect(await readFile(dest, "utf-8")).toBe("bytes");
  });
});
