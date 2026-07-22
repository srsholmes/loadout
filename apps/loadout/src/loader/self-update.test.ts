import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  isTrustedGithubHost,
  parseSha256Sums,
  startSelfUpdate,
  getSelfUpdateStatus,
  resetSelfUpdateStatusForTest,
  cleanupStaleSelfUpdateArtifacts,
  downloadToFile,
  type SelfUpdateDeps,
} from "./self-update";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
    commandExists: async () => false, // no restorecon in tests
    ...overrides,
  };
}

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "selfupdate-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Reset the module status singleton so a terminal apply-path state
// can't leak a spurious 409 into the next startSelfUpdate.
beforeEach(() => resetSelfUpdateStatusForTest());

/** Poll the module status until it leaves the active phases. */
async function awaitSettled(): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const p = getSelfUpdateStatus().phase;
    if (p === "done" || p === "error" || p === "idle") return p;
    await new Promise((r) => setTimeout(r, 10));
  }
  return getSelfUpdateStatus().phase;
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
  const pluginsDir = join(tmp(), "plugins"); // tracked → swept by afterEach

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
    const res = startSelfUpdate({ tag: "v0.7.0", pluginsDir }, fakeDeps({ currentVersion: "dev" }));
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
    const dest = join(tmp(), "asset");
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

// -- Apply path (root-side binary + plugins swap) -----------------------------

async function sha(text: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  h.update(text);
  return h.digest("hex");
}

/** Build a temp install tree (old binary + old plugins/modules) and a
 *  deps bag that serves a fake release and fakes tar/chown so
 *  runSelfUpdate can be driven end-to-end without a real GitHub or a
 *  real archive. */
async function setupApply(opts: { correctSums?: boolean } = {}) {
  const installDir = tmp();
  const exePath = join(installDir, "loadout");
  const pluginsDir = join(installDir, "plugins");
  const modulesDir = join(installDir, "node_modules");
  writeFileSync(exePath, "OLD-BINARY");
  mkdirSync(pluginsDir);
  writeFileSync(join(pluginsDir, "marker"), "old-plugins");
  mkdirSync(modulesDir);
  writeFileSync(join(modulesDir, "marker"), "old-modules");

  const binBytes = "NEW-BINARY-CONTENT";
  const pluginsBytes = "NEW-PLUGINS-TARBALL";
  const sums = [
    `${opts.correctSums === false ? "a".repeat(64) : await sha(binBytes)}  loadout-x86_64`,
    `${opts.correctSums === false ? "b".repeat(64) : await sha(pluginsBytes)}  loadout-plugins-x86_64.tar.xz`,
  ].join("\n");

  const fetchFn = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith("/SHA256SUMS")) return new Response(sums);
    if (u.endsWith("/loadout-x86_64")) return new Response(binBytes);
    if (u.endsWith("/loadout-plugins-x86_64.tar.xz")) return new Response(pluginsBytes);
    throw new Error(`unexpected fetch ${u}`);
  }) as unknown as typeof fetch;

  // Fake `tar -xJf <tar> -C <staging>` by materialising the staged tree
  // the real archive would contain.
  const run = async (argv: string[]) => {
    if (argv[0] === "tar") {
      const dest = argv[argv.indexOf("-C") + 1]!;
      mkdirSync(join(dest, "plugins"), { recursive: true });
      writeFileSync(join(dest, "plugins", "marker"), "new-plugins");
      mkdirSync(join(dest, "node_modules"), { recursive: true });
      writeFileSync(join(dest, "node_modules", "marker"), "new-modules");
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  const deps = fakeDeps({
    fetchFn,
    run,
    resolveExePath: () => exePath,
    currentVersion: "0.6.0",
    // real hashing so SHA256SUMS is actually enforced
    sha256File: async (p) => sha(await readFile(p, "utf8")),
  });
  return { installDir, exePath, pluginsDir, modulesDir, deps };
}

describe("runSelfUpdate apply path", () => {
  test("happy path swaps the binary, plugins, AND node_modules, ends 'done'", async () => {
    const { exePath, pluginsDir, modulesDir, deps } = await setupApply();
    const res = startSelfUpdate({ tag: "v0.7.0", pluginsDir }, deps);
    expect(res.ok).toBe(true);
    expect(await awaitSettled()).toBe("done");
    expect(await readFile(exePath, "utf8")).toBe("NEW-BINARY-CONTENT");
    expect(await readFile(join(pluginsDir, "marker"), "utf8")).toBe("new-plugins");
    // The whole skew bug lives in the plugins-vs-modules rename pairing —
    // assert BOTH halves landed, not just plugins.
    expect(await readFile(join(modulesDir, "marker"), "utf8")).toBe("new-modules");
    // staging + old generations cleaned up
    expect(existsSync(`${pluginsDir}.old`)).toBe(false);
    expect(existsSync(`${modulesDir}.old`)).toBe(false);
  });

  test("checksum mismatch aborts before any swap — live binary untouched", async () => {
    const { exePath, pluginsDir, deps } = await setupApply({ correctSums: false });
    startSelfUpdate({ tag: "v0.7.0", pluginsDir }, deps);
    expect(await awaitSettled()).toBe("error");
    expect(getSelfUpdateStatus().message).toContain("checksum mismatch");
    expect(await readFile(exePath, "utf8")).toBe("OLD-BINARY"); // never replaced
    expect(await readFile(join(pluginsDir, "marker"), "utf8")).toBe("old-plugins");
  });
});

describe("cleanupStaleSelfUpdateArtifacts", () => {
  test("restores plugins from .old when a crash left the live dir missing", async () => {
    const installDir = tmp();
    const pluginsDir = join(installDir, "plugins");
    // Simulate the crash window: live plugins renamed to .old, new not
    // yet moved into place.
    mkdirSync(`${pluginsDir}.old`);
    writeFileSync(join(`${pluginsDir}.old`, "marker"), "survivor");
    expect(existsSync(pluginsDir)).toBe(false);

    await cleanupStaleSelfUpdateArtifacts(pluginsDir, fakeDeps());

    expect(existsSync(pluginsDir)).toBe(true);
    expect(await readFile(join(pluginsDir, "marker"), "utf8")).toBe("survivor");
    expect(existsSync(`${pluginsDir}.old`)).toBe(false); // swept after restore
  });

  test("deletes .old normally when the live dir is present", async () => {
    const installDir = tmp();
    const pluginsDir = join(installDir, "plugins");
    mkdirSync(pluginsDir);
    writeFileSync(join(pluginsDir, "marker"), "current");
    mkdirSync(`${pluginsDir}.old`);

    await cleanupStaleSelfUpdateArtifacts(pluginsDir, fakeDeps());

    expect(await readFile(join(pluginsDir, "marker"), "utf8")).toBe("current");
    expect(existsSync(`${pluginsDir}.old`)).toBe(false);
  });
});
