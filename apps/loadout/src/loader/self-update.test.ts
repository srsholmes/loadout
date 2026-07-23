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
import { readFile, rename as realRename, copyFile as realCopyFile } from "node:fs/promises";
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
    rename: realRename,
    copyFile: realCopyFile,
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
async function setupApply(opts: { correctSums?: boolean; rename?: SelfUpdateDeps["rename"] } = {}) {
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
    ...(opts.rename ? { rename: opts.rename } : {}),
  });
  return { installDir, exePath, pluginsDir, modulesDir, deps };
}

describe("runSelfUpdate apply path", () => {
  test("happy path swaps the binary, plugins, AND node_modules, ends 'done'", async () => {
    const { installDir, exePath, pluginsDir, modulesDir, deps } = await setupApply();
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
    // The previous binary is KEPT as `.loadout.old` — checksum proves
    // the download's identity, not that it runs; this is the manual
    // rollback copy if the new binary crash-loops. Only the next
    // successful boot (cleanupStaleSelfUpdateArtifacts, which only a
    // working binary executes) may reap it.
    expect(await readFile(join(installDir, ".loadout.old"), "utf8")).toBe("OLD-BINARY");
  });

  test("checksum mismatch aborts before any swap — live binary untouched", async () => {
    const { installDir, exePath, pluginsDir, deps } = await setupApply({ correctSums: false });
    const res = startSelfUpdate({ tag: "v0.7.0", pluginsDir }, deps);
    expect(res.ok).toBe(true); // accepted — the failure must land in status, not the return
    expect(await awaitSettled()).toBe("error");
    expect(getSelfUpdateStatus().message).toContain("checksum mismatch");
    expect(await readFile(exePath, "utf8")).toBe("OLD-BINARY"); // never replaced
    expect(await readFile(join(pluginsDir, "marker"), "utf8")).toBe("old-plugins");
    // BOTH downloaded artifacts are removed on any mismatch — a failed
    // verify must never leave a partial download for the next attempt
    // or the boot cleanup to trip over.
    expect(existsSync(join(installDir, ".loadout.new"))).toBe(false);
    expect(existsSync(join(installDir, ".loadout-plugins.tar.xz"))).toBe(false);
  });

  test("modules-rename failure rolls BOTH old trees back, binary untouched", async () => {
    // Fail the 4th swap rename (stagedModules → modulesDir). The
    // rollback must first move the already-landed new plugins back out
    // (occupied-target subtlety), then restore both .old trees.
    const failing: SelfUpdateDeps["rename"] = async (from, to) => {
      if (from.endsWith("/.plugins-staging/node_modules")) {
        throw new Error("simulated EACCES on modules rename");
      }
      return realRename(from, to);
    };
    const { exePath, pluginsDir, modulesDir, deps } = await setupApply({ rename: failing });
    startSelfUpdate({ tag: "v0.7.0", pluginsDir }, deps);
    expect(await awaitSettled()).toBe("error");
    expect(await readFile(join(pluginsDir, "marker"), "utf8")).toBe("old-plugins");
    expect(await readFile(join(modulesDir, "marker"), "utf8")).toBe("old-modules");
    expect(await readFile(exePath, "utf8")).toBe("OLD-BINARY"); // binary swap never reached
  });

  test("binary-swap failure rolls the plugins back too (no silent skew)", async () => {
    // Plugins/modules land, then the final binary rename fails. The
    // error path must restore the OLD plugins/modules — otherwise the
    // still-running old binary faces new plugins on its next restart —
    // and drop the .loadout.old copy (nothing was swapped).
    const failing: SelfUpdateDeps["rename"] = async (from, to) => {
      if (from.endsWith("/.loadout.new")) {
        throw new Error("simulated EXDEV on binary rename");
      }
      return realRename(from, to);
    };
    const { installDir, exePath, pluginsDir, modulesDir, deps } = await setupApply({
      rename: failing,
    });
    startSelfUpdate({ tag: "v0.7.0", pluginsDir }, deps);
    expect(await awaitSettled()).toBe("error");
    expect(await readFile(exePath, "utf8")).toBe("OLD-BINARY");
    expect(await readFile(join(pluginsDir, "marker"), "utf8")).toBe("old-plugins");
    expect(await readFile(join(modulesDir, "marker"), "utf8")).toBe("old-modules");
    expect(existsSync(join(installDir, ".loadout.old"))).toBe(false);
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

  test("mid-swap crash restores BOTH dirs coherently, not a mixed generation", async () => {
    // Crash between the plugins and modules renames: new plugins are
    // already live (their .old holds the previous tree), node_modules
    // is renamed away (live missing, .old present). Restoring only the
    // missing pair would boot new-plugins/old-modules — a mix nothing
    // detects. Both must come back from .old.
    const installDir = tmp();
    const pluginsDir = join(installDir, "plugins");
    const modulesDir = join(installDir, "node_modules");
    mkdirSync(pluginsDir);
    writeFileSync(join(pluginsDir, "marker"), "new-plugins-half-applied");
    mkdirSync(`${pluginsDir}.old`);
    writeFileSync(join(`${pluginsDir}.old`, "marker"), "old-plugins");
    mkdirSync(`${modulesDir}.old`);
    writeFileSync(join(`${modulesDir}.old`, "marker"), "old-modules");
    expect(existsSync(modulesDir)).toBe(false);

    await cleanupStaleSelfUpdateArtifacts(pluginsDir, fakeDeps());

    expect(await readFile(join(pluginsDir, "marker"), "utf8")).toBe("old-plugins");
    expect(await readFile(join(modulesDir, "marker"), "utf8")).toBe("old-modules");
    expect(existsSync(`${pluginsDir}.old`)).toBe(false);
    expect(existsSync(`${modulesDir}.old`)).toBe(false);
  });

  test("reaps the .loadout.old binary rollback copy (a working binary is running)", async () => {
    const installDir = tmp();
    const pluginsDir = join(installDir, "plugins");
    mkdirSync(pluginsDir);
    const exePath = join(installDir, "loadout");
    writeFileSync(exePath, "CURRENT");
    writeFileSync(join(installDir, ".loadout.old"), "PREVIOUS");
    writeFileSync(join(installDir, ".loadout.new"), "STALE-STAGING");

    await cleanupStaleSelfUpdateArtifacts(pluginsDir, fakeDeps({ resolveExePath: () => exePath }));

    expect(existsSync(join(installDir, ".loadout.old"))).toBe(false);
    expect(existsSync(join(installDir, ".loadout.new"))).toBe(false);
    expect(await readFile(exePath, "utf8")).toBe("CURRENT");
  });
});
