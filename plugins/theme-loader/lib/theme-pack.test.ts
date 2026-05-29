import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findUpstreamLicense,
  readThemeMeta,
  writeThemeMeta,
  type ThemeMeta,
} from "./theme-pack";

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "theme-loader-pack-"));
});

afterEach(async () => {
  try { await rm(scratch, { recursive: true, force: true }); } catch { /* nothing to remove */ }
});

describe("findUpstreamLicense", () => {
  it("returns null when no license is present", async () => {
    const themeRoot = join(scratch, "theme");
    await mkdir(themeRoot, { recursive: true });
    expect(await findUpstreamLicense(themeRoot, scratch)).toBeNull();
  });

  it("finds a LICENSE file at the theme directory itself", async () => {
    const themeRoot = join(scratch, "theme");
    await mkdir(themeRoot, { recursive: true });
    await writeFile(join(themeRoot, "LICENSE"), "MIT License\n…");
    const found = await findUpstreamLicense(themeRoot, scratch);
    expect(found?.fileName).toBe("LICENSE");
    expect(found?.content.startsWith("MIT")).toBe(true);
  });

  it("walks up to the ceiling to find a LICENSE at the repo root", async () => {
    // simulate {repo}-{branch}/{themeSubdir}
    const repoRoot = join(scratch, "MyRepo-main");
    const themeRoot = join(repoRoot, "RoundTheme");
    await mkdir(themeRoot, { recursive: true });
    await writeFile(join(repoRoot, "LICENSE.md"), "Apache-2.0 …");
    const found = await findUpstreamLicense(themeRoot, scratch);
    expect(found?.fileName).toBe("LICENSE.md");
    expect(found?.content.startsWith("Apache-2.0")).toBe(true);
  });

  it("recognises COPYING and LICENCE alternatives", async () => {
    const themeRoot = join(scratch, "theme");
    await mkdir(themeRoot, { recursive: true });
    await writeFile(join(themeRoot, "COPYING"), "GPL");
    const found = await findUpstreamLicense(themeRoot, scratch);
    expect(found?.fileName).toBe("COPYING");
  });

  it("truncates very large license files to 4 KB", async () => {
    const themeRoot = join(scratch, "theme");
    await mkdir(themeRoot, { recursive: true });
    const big = "x".repeat(10 * 1024);
    await writeFile(join(themeRoot, "LICENSE"), big);
    const found = await findUpstreamLicense(themeRoot, scratch);
    expect(found?.content.length).toBe(4 * 1024);
  });
});

describe("theme meta sidecar", () => {
  it("round-trips through writeThemeMeta / readThemeMeta", async () => {
    const dir = join(scratch, "theme");
    await mkdir(dir, { recursive: true });
    const meta: ThemeMeta = {
      author: "EMERALD#0874",
      description: "Round corners",
      version: "v2.7",
      sourceUrl: "https://github.com/EMERALD0874/Steam-Deck-Themes",
      license: { fileName: "LICENSE", content: "MIT" },
    };
    await writeThemeMeta(dir, meta);
    const got = await readThemeMeta(dir);
    expect(got).toEqual(meta);
  });

  it("returns null when no sidecar is present", async () => {
    const dir = join(scratch, "empty");
    await mkdir(dir, { recursive: true });
    expect(await readThemeMeta(dir)).toBeNull();
  });
});
