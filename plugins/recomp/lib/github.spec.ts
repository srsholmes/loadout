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
