import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assemblePackCss,
  collectInjectFiles,
  findUpstreamLicense,
  readThemeMeta,
  translateCss,
  writeThemeMeta,
  type ThemeMeta,
} from "./theme-pack";
import { _resetForTests as resetTranslations } from "./translations-cache";
import type { ThemePackManifest } from "./types";

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

describe("collectInjectFiles", () => {
  it("returns an empty list for a manifest with no inject or patches", () => {
    const manifest: ThemePackManifest = { name: "empty" };
    expect(collectInjectFiles(manifest)).toEqual([]);
  });

  it("returns the baseline inject map in declaration order", () => {
    const manifest: ThemePackManifest = {
      name: "baseline",
      inject: {
        "shared.css": ["SP"],
        "bpm.css": ["MainMenu"],
      },
    };
    const files = collectInjectFiles(manifest);
    expect(files).toEqual([
      { file: "shared.css", targets: ["SP"] },
      { file: "bpm.css", targets: ["MainMenu"] },
    ]);
  });

  it("falls back to the patch default when no variant is supplied", () => {
    const manifest: ThemePackManifest = {
      name: "withDefault",
      patches: {
        Intensity: {
          default: "Medium",
          values: {
            Low: { "low.css": ["SP"] },
            Medium: { "medium.css": ["SP"] },
            High: { "high.css": ["SP"] },
          },
        },
      },
    };
    const files = collectInjectFiles(manifest);
    expect(files).toEqual([{ file: "medium.css", targets: ["SP"] }]);
  });

  it("honors a caller-supplied variant override", () => {
    const manifest: ThemePackManifest = {
      name: "withOverride",
      patches: {
        Intensity: {
          default: "Medium",
          values: {
            Low: { "low.css": ["SP"] },
            Medium: { "medium.css": ["SP"] },
            High: { "high.css": ["SP"] },
          },
        },
      },
    };
    const files = collectInjectFiles(manifest, { Intensity: "High" });
    expect(files).toEqual([{ file: "high.css", targets: ["SP"] }]);
  });

  it("falls back to the first value if the default is missing", () => {
    const manifest: ThemePackManifest = {
      name: "missingDefault",
      patches: {
        Style: {
          // `default` points at a value that doesn't exist — pick the
          // first available so the pack still injects SOMETHING.
          default: "DoesNotExist",
          values: {
            First: { "first.css": ["SP"] },
            Second: { "second.css": ["SP"] },
          },
        },
      },
    };
    const files = collectInjectFiles(manifest);
    expect(files).toEqual([{ file: "first.css", targets: ["SP"] }]);
  });

  it("skips patches whose selected value is missing from the values map", () => {
    const manifest: ThemePackManifest = {
      name: "missingValue",
      inject: { "base.css": ["SP"] },
      patches: {
        Style: {
          default: "Default",
          values: { Default: { "style.css": ["SP"] } },
        },
      },
    };
    // Caller asks for "Nonexistent" — the patch is silently dropped,
    // base inject still applies.
    const files = collectInjectFiles(manifest, { Style: "Nonexistent" });
    expect(files).toEqual([{ file: "base.css", targets: ["SP"] }]);
  });

  it("concatenates baseline inject then each patch in manifest order", () => {
    const manifest: ThemePackManifest = {
      name: "combined",
      inject: { "base.css": ["SP"] },
      patches: {
        First: {
          default: "On",
          values: { On: { "first.css": ["SP"] } },
        },
        Second: {
          default: "On",
          values: { On: { "second.css": ["MainMenu"] } },
        },
      },
    };
    const files = collectInjectFiles(manifest);
    expect(files.map((f) => f.file)).toEqual(["base.css", "first.css", "second.css"]);
  });

  it("normalizes non-array target values to an empty array", () => {
    const manifest = {
      name: "weird",
      inject: { "x.css": "not-an-array" },
    } as unknown as ThemePackManifest;
    expect(collectInjectFiles(manifest)).toEqual([{ file: "x.css", targets: [] }]);
  });

  it("preserves CSS variable entries (`--foo`) verbatim", () => {
    // `assemblePackCss` treats `--foo` keys as CSS custom properties —
    // `collectInjectFiles` must surface them so the caller can route.
    const manifest: ThemePackManifest = {
      name: "vars",
      inject: { "--CGV-footer-height": ["40px", "SP"] },
    };
    expect(collectInjectFiles(manifest)).toEqual([
      { file: "--CGV-footer-height", targets: ["40px", "SP"] },
    ]);
  });
});

describe("translateCss", () => {
  it("returns the input unchanged when no translations are provided", () => {
    const css = ".SomeClass { color: red; }";
    expect(translateCss(css, new Map())).toBe(css);
  });

  it("replaces an obfuscated class name when the bounded match holds", () => {
    const translations = new Map([["_oldNameHashLong", "_newNameHashLong"]]);
    const css = ".foo ._oldNameHashLong { color: red; }";
    expect(translateCss(css, translations)).toBe(".foo ._newNameHashLong { color: red; }");
  });

  it("skips names shorter than 8 characters to avoid false matches", () => {
    // A 7-char name could collide with countless real CSS tokens —
    // the helper explicitly skips these.
    const translations = new Map([["_short", "_DANGER"]]);
    const css = "._short { color: red; }";
    expect(translateCss(css, translations)).toBe("._short { color: red; }");
  });

  it("respects word boundaries — does not match inside a longer token", () => {
    const translations = new Map([["_oldNameHashLong", "_NEW"]]);
    const css = "._oldNameHashLongExtra { color: red; }";
    // The trailing `Extra` makes the match a substring — must be left
    // alone or the rewrite corrupts the selector.
    expect(translateCss(css, translations)).toBe("._oldNameHashLongExtra { color: red; }");
  });

  it("sorts translations longest-first so shorter substrings don't pre-match", () => {
    // Both names match the CSS, but `_alpha` is a strict prefix of
    // `_alphaBetaGamma`. If we applied `_alphaXXX` first the longer
    // entry would no longer match. Longest-first prevents that.
    const translations = new Map([
      ["_alphaLong", "_short"],
      ["_alphaLongBetaGamma", "_BIG"],
    ]);
    const css = "._alphaLongBetaGamma { color: red; } ._alphaLong { color: blue; }";
    expect(translateCss(css, translations)).toBe(
      "._BIG { color: red; } ._short { color: blue; }",
    );
  });

  it("skips entries that do not appear in the CSS at all (cheap path)", () => {
    const translations = new Map([["_irrelevantHash", "_OOPS"]]);
    const css = ".real-class { color: red; }";
    expect(translateCss(css, translations)).toBe(css);
  });

  it("replaces every occurrence of a matching class", () => {
    const translations = new Map([["_oldNameHashLong", "_newNameHashLong"]]);
    const css = "._oldNameHashLong, ._oldNameHashLong:hover { color: red; }";
    expect(translateCss(css, translations)).toBe(
      "._newNameHashLong, ._newNameHashLong:hover { color: red; }",
    );
  });
});

describe("assemblePackCss", () => {
  beforeEach(() => {
    // Clear any module-level translations cache so assemblePackCss
    // is deterministic across these tests — translations are tested
    // directly via translateCss above.
    resetTranslations();
  });

  afterEach(() => {
    resetTranslations();
  });

  it("concatenates baseline CSS files with a /* filename */ banner", async () => {
    const dir = join(scratch, "pack");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "base.css"), ".x { color: red; }\n");
    await writeFile(join(dir, "extra.css"), ".y { color: blue; }\n");
    const manifest: ThemePackManifest = {
      name: "basic",
      inject: {
        "base.css": ["SP"],
        "extra.css": ["SP"],
      },
    };
    const css = await assemblePackCss(dir, manifest);
    expect(css).toContain("/* base.css */");
    expect(css).toContain(".x { color: red; }");
    expect(css).toContain("/* extra.css */");
    expect(css).toContain(".y { color: blue; }");
  });

  it("prepends `:root { … }` with CSS variable declarations", async () => {
    const dir = join(scratch, "pack");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "base.css"), ".x { color: red; }\n");
    const manifest: ThemePackManifest = {
      name: "withVars",
      inject: {
        "--my-var": ["10px", "SP"],
        "--another": ["#fff", "SP"],
        "base.css": ["SP"],
      },
    };
    const css = await assemblePackCss(dir, manifest);
    expect(css.startsWith(":root {")).toBe(true);
    expect(css).toContain("--my-var: 10px;");
    expect(css).toContain("--another: #fff;");
    expect(css).toContain(".x { color: red; }");
  });

  it("rejects directory traversal in inject paths", async () => {
    const dir = join(scratch, "pack");
    await mkdir(dir, { recursive: true });
    await writeFile(join(scratch, "secret.css"), "SECRET");
    const manifest: ThemePackManifest = {
      name: "evil",
      inject: { "../secret.css": ["SP"] },
    };
    const css = await assemblePackCss(dir, manifest);
    expect(css).not.toContain("SECRET");
  });

  it("warns on but does not throw for missing CSS files", async () => {
    const dir = join(scratch, "pack");
    await mkdir(dir, { recursive: true });
    const manifest: ThemePackManifest = {
      name: "missing",
      inject: { "absent.css": ["SP"] },
    };
    // Should resolve to an empty string, no throw.
    const css = await assemblePackCss(dir, manifest);
    expect(css).toBe("");
  });

  it("applies the selected variant CSS to the output", async () => {
    const dir = join(scratch, "pack");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "low.css"), ".intensity-low { }\n");
    await writeFile(join(dir, "high.css"), ".intensity-high { }\n");
    const manifest: ThemePackManifest = {
      name: "variant",
      patches: {
        Intensity: {
          default: "Low",
          values: {
            Low: { "low.css": ["SP"] },
            High: { "high.css": ["SP"] },
          },
        },
      },
    };
    const cssDefault = await assemblePackCss(dir, manifest);
    expect(cssDefault).toContain(".intensity-low");
    expect(cssDefault).not.toContain(".intensity-high");

    const cssOverride = await assemblePackCss(dir, manifest, { Intensity: "High" });
    expect(cssOverride).toContain(".intensity-high");
    expect(cssOverride).not.toContain(".intensity-low");
  });

  it("emits CSS variables even when no .css inject files are present", async () => {
    const dir = join(scratch, "pack");
    await mkdir(dir, { recursive: true });
    const manifest: ThemePackManifest = {
      name: "varsOnly",
      inject: { "--solo-var": ["42px", "SP"] },
    };
    const css = await assemblePackCss(dir, manifest);
    expect(css.startsWith(":root {")).toBe(true);
    expect(css).toContain("--solo-var: 42px;");
  });
});
