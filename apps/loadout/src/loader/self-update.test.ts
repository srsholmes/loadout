import { describe, expect, test } from "bun:test";
import {
  isTrustedGithubHost,
  parseSha256Sums,
  startSelfUpdate,
  downloadToFile,
  type SelfUpdateDeps,
} from "./self-update";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fakeDeps(overrides: Partial<SelfUpdateDeps> = {}): SelfUpdateDeps {
  return {
    fetchFn: (async () => {
      throw new Error("network disabled in test");
    }) as unknown as typeof fetch,
    run: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    resolveExePath: () => "/usr/local/bin/loadout",
    currentVersion: "0.6.0",
    scheduleRestart: () => {},
    sha256File: async () => "0".repeat(64),
    ...overrides,
  };
}

describe("isTrustedGithubHost", () => {
  test("accepts github release hosts", () => {
    expect(isTrustedGithubHost("github.com")).toBe(true);
    expect(isTrustedGithubHost("objects.githubusercontent.com")).toBe(true);
    expect(isTrustedGithubHost("release-assets.githubusercontent.com")).toBe(true);
  });

  test("rejects lookalikes and everything else", () => {
    expect(isTrustedGithubHost("evilgithub.com")).toBe(false);
    expect(isTrustedGithubHost("github.com.evil.example")).toBe(false);
    expect(isTrustedGithubHost("example.com")).toBe(false);
    expect(isTrustedGithubHost("")).toBe(false);
  });
});

describe("parseSha256Sums", () => {
  test("parses sha256sum output", () => {
    const text = [
      "a".repeat(64) + "  loadout-x86_64",
      "b".repeat(64) + " *loadout-plugins-x86_64.tar.xz",
      "",
      "not a sums line",
    ].join("\n");
    const sums = parseSha256Sums(text);
    expect(sums.get("loadout-x86_64")).toBe("a".repeat(64));
    expect(sums.get("loadout-plugins-x86_64.tar.xz")).toBe("b".repeat(64));
    expect(sums.size).toBe(2);
  });

  test("lowercases hashes", () => {
    const sums = parseSha256Sums("ABCDEF" + "0".repeat(58) + "  file");
    expect(sums.get("file")).toBe("abcdef" + "0".repeat(58));
  });
});

describe("startSelfUpdate validation", () => {
  const pluginsDir = join(mkdtempSync(join(tmpdir(), "selfupdate-")), "plugins");

  test("rejects malformed tags", () => {
    for (const tag of ["rolling", "0.7.0", "v0.7", "v0.7.0-rc1", "../etc", ""]) {
      const res = startSelfUpdate({ tag, pluginsDir }, fakeDeps());
      expect(res.ok).toBe(false);
      expect(res.code).toBe(400);
    }
  });

  test("rejects downgrades but allows same-version reinstall shape", () => {
    const down = startSelfUpdate(
      { tag: "v0.5.0", pluginsDir },
      fakeDeps({ currentVersion: "0.6.0" }),
    );
    expect(down.ok).toBe(false);
    expect(down.error).toContain("downgrade");
  });

  test("rejects dev builds", () => {
    const res = startSelfUpdate(
      { tag: "v0.7.0", pluginsDir },
      fakeDeps({ currentVersion: "dev" }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("dev builds");
  });

  test("refuses to self-replace the bun interpreter", () => {
    const res = startSelfUpdate(
      { tag: "v99.0.0", pluginsDir },
      fakeDeps({ resolveExePath: () => "/home/user/.bun/bin/bun" }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("bun");
  });
});

describe("downloadToFile redirect pinning", () => {
  test("refuses an untrusted first hop", async () => {
    let fetched = false;
    const fetchFn = (async () => {
      fetched = true;
      return new Response("x");
    }) as unknown as typeof fetch;
    await expect(
      downloadToFile("https://evil.example/x", "/tmp/never-written", fetchFn),
    ).rejects.toThrow(/untrusted host/);
    expect(fetched).toBe(false); // must fail BEFORE any request is made
  });

  test("refuses a redirect hop to an untrusted host", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/payload" },
      });
    }) as unknown as typeof fetch;
    await expect(
      downloadToFile("https://github.com/x", "/tmp/never-written", fetchFn),
    ).rejects.toThrow(/untrusted host/);
    expect(calls).toEqual(["https://github.com/x"]); // evil host never contacted
  });

  test("follows trusted redirects and writes the body", async () => {
    const dest = join(mkdtempSync(join(tmpdir(), "selfupdate-dl-")), "asset");
    const fetchFn = (async (url: string | URL | Request) => {
      if (String(url).includes("github.com")) {
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://release-assets.githubusercontent.com/asset",
          },
        });
      }
      return new Response("payload-bytes");
    }) as unknown as typeof fetch;
    await downloadToFile("https://github.com/x", dest, fetchFn);
    expect(await Bun.file(dest).text()).toBe("payload-bytes");
  });
});
