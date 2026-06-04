import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "@loadout/exec";

/**
 * Spec for the recomp plugin's archive extraction. Covers:
 *  - FIX 1: nested-archive extraction failures must throw (not be
 *    silently swallowed, leaving a half-extracted binary).
 *  - FIX 2: archive entries that escape the destination directory
 *    (`../escape`, absolute paths, traversal symlinks) must be
 *    rejected — nothing may be written outside `dest`.
 *
 * Archives are built in a temp dir within each test so we exercise
 * the real `tar`/`unzip` codepaths.
 */

let sandbox = "";

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "recomp-archive-spec-"));
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function run(cmd: string[], cwd?: string): Promise<number> {
  const proc = spawn(cmd, {
    ...(cwd ? { cwd } : {}),
    stdout: "ignore",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    // Surface stderr for debuggability when a test's archive build fails.
    void (await new Response(proc.stderr).text());
  }
  return code;
}

describe("extractArchive — happy path", () => {
  it("extracts a clean .tar.gz", async () => {
    const stage = await mkdtemp(join(sandbox, "stage-"));
    await writeFile(join(stage, "hello.txt"), "hi");
    const archive = join(sandbox, "clean.tar.gz");
    await run(["tar", "czf", archive, "-C", stage, "."]);

    const dest = join(sandbox, "dest");
    const { extractArchive } = await import("./pipeline-archive");
    await extractArchive(archive, dest);
    expect(existsSync(join(dest, "hello.txt"))).toBe(true);
  });

  it("extracts a clean .zip", async () => {
    const stage = await mkdtemp(join(sandbox, "zstage-"));
    await writeFile(join(stage, "hello.txt"), "hi");
    const archive = join(sandbox, "clean.zip");
    await run(["zip", "-q", archive, "hello.txt"], stage);

    const dest = join(sandbox, "zdest");
    const { extractArchive } = await import("./pipeline-archive");
    await extractArchive(archive, dest);
    expect(existsSync(join(dest, "hello.txt"))).toBe(true);
  });
});

describe("FIX 1 — nested-archive extraction failures throw", () => {
  it("throws when a nested .tar.gz is corrupt/truncated", async () => {
    // Outer archive contains a *corrupt* inner .tar.gz — `tar xzf` on
    // the inner must fail, and that failure must propagate.
    const stage = await mkdtemp(join(sandbox, "nstage-"));
    await writeFile(join(stage, "inner.tar.gz"), "this is not a gzip archive");
    const archive = join(sandbox, "outer.tar.gz");
    await run(["tar", "czf", archive, "-C", stage, "."]);

    const dest = join(sandbox, "ndest");
    const { extractArchive } = await import("./pipeline-archive");
    await expect(extractArchive(archive, dest)).rejects.toThrow();
  });
});

describe("FIX 2 — path traversal / symlink escape rejected", () => {
  it("rejects a tar entry with a ../ traversal path", async () => {
    const stage = await mkdtemp(join(sandbox, "tstage-"));
    await writeFile(join(stage, "escape.txt"), "pwned");
    const archive = join(sandbox, "traversal.tar.gz");
    // Store the member literally as `../escape.txt`.
    await run([
      "tar", "czf", archive, "-C", stage,
      "--transform", "s|^|../|",
      "escape.txt",
    ]);

    const dest = join(sandbox, "tdest");
    const { extractArchive } = await import("./pipeline-archive");
    await expect(extractArchive(archive, dest)).rejects.toThrow(/\.\.|traversal|escape|outside/i);
    // Nothing landed in dest's parent.
    expect(existsSync(join(sandbox, "escape.txt"))).toBe(false);
  });

  it("rejects a tar entry containing a symlink that escapes dest", async () => {
    // GNU tar happily extracts `evil -> ../../outside`; a follow-up
    // write through it would escape. The extractor must reject it.
    const stage = await mkdtemp(join(sandbox, "symstage-"));
    await symlink("../../outside", join(stage, "evil"));
    const archive = join(sandbox, "symlink.tar.gz");
    await run(["tar", "czf", archive, "-C", stage, "evil"]);

    const dest = join(sandbox, "symdest");
    const { extractArchive } = await import("./pipeline-archive");
    await expect(extractArchive(archive, dest)).rejects.toThrow(/symlink|\.\.|outside|escape/i);
  });

  it("rejects a zip entry with a ../ traversal path", async () => {
    const stage = await mkdtemp(join(sandbox, "ztstage-"));
    const deep = join(stage, "deep");
    await mkdir(deep, { recursive: true });
    await writeFile(join(stage, "zip-escape.txt"), "pwned");
    const archive = join(sandbox, "ztraversal.zip");
    // Zip stores the member as `../zip-escape.txt` (relative to deep/).
    await run(["zip", "-q", archive, "../zip-escape.txt"], deep);

    const dest = join(sandbox, "ztdest");
    const { extractArchive } = await import("./pipeline-archive");
    await expect(extractArchive(archive, dest)).rejects.toThrow(/\.\.|traversal|escape|outside/i);
  });
});
