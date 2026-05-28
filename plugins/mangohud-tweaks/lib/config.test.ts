import { describe, it, expect } from "bun:test";
import {
  PRESETS,
  parseConfig,
  extractCommentLines,
  serializeConfig,
  findPreset,
} from "./config";

describe("parseConfig", () => {
  it("parses key=value pairs", () => {
    const text = ["fps=1", "gpu_stats=1", "cpu_temp=1"].join("\n");
    expect(parseConfig(text)).toEqual({
      fps: "1",
      gpu_stats: "1",
      cpu_temp: "1",
    });
  });

  it("skips comment and blank lines", () => {
    const text = [
      "# top comment",
      "",
      "  # indented comment",
      "fps=1",
    ].join("\n");
    expect(Object.keys(parseConfig(text))).toEqual(["fps"]);
  });

  it("trims whitespace around keys and values", () => {
    const text = "  fps = 1  ";
    expect(parseConfig(text)).toEqual({ fps: "1" });
  });

  it("uses the first = as the separator (preserves '=' in values)", () => {
    const text = "custom_label=foo=bar";
    expect(parseConfig(text)).toEqual({ custom_label: "foo=bar" });
  });

  it("drops lines without an = sign", () => {
    const text = ["fps=1", "garbage_line", "gpu_stats=1"].join("\n");
    expect(parseConfig(text)).toEqual({ fps: "1", gpu_stats: "1" });
  });

  it("returns an empty object for blank input", () => {
    expect(parseConfig("")).toEqual({});
  });
});

describe("extractCommentLines", () => {
  it("keeps comment lines and blank lines, drops key=value lines", () => {
    const text = [
      "# header comment",
      "",
      "fps=1",
      "# another comment",
      "gpu_stats=1",
    ].join("\n");
    expect(extractCommentLines(text)).toEqual([
      "# header comment",
      "",
      "# another comment",
    ]);
  });

  it("preserves the original order of comments and blanks", () => {
    const text = ["# a", "# b", "", "# c", "fps=1"].join("\n");
    expect(extractCommentLines(text)).toEqual(["# a", "# b", "", "# c"]);
  });

  it("returns empty array for blank input (one empty entry)", () => {
    // split("") yields [""] — a single blank line passes the filter.
    expect(extractCommentLines("")).toEqual([""]);
  });
});

describe("serializeConfig", () => {
  it("emits key=value lines in insertion order, with trailing newline", () => {
    const out = serializeConfig({ fps: "1", gpu_stats: "1" });
    expect(out).toBe("fps=1\ngpu_stats=1\n");
  });

  it("prepends preserved comments above the key=value block", () => {
    const out = serializeConfig({ fps: "1" }, ["# header", ""]);
    expect(out).toBe("# header\n\nfps=1\n");
  });

  it("handles an empty config (just the comments + newline)", () => {
    const out = serializeConfig({}, ["# only comments"]);
    expect(out).toBe("# only comments\n");
  });

  it("handles no comments and no config (one blank line)", () => {
    expect(serializeConfig({})).toBe("\n");
  });
});

describe("findPreset", () => {
  it("returns the preset for a valid name", () => {
    const p = findPreset("minimal");
    expect(p).toBeDefined();
    expect(p?.name).toBe("minimal");
    expect(p?.label).toBe("Minimal");
  });

  it("returns undefined for an unknown name", () => {
    expect(findPreset("nonexistent")).toBeUndefined();
  });

  it("matches every built-in preset name", () => {
    for (const name of ["minimal", "standard", "full", "battery", "off"]) {
      expect(findPreset(name)?.name).toBe(name);
    }
  });
});

describe("PRESETS contract", () => {
  it("ships all five expected presets", () => {
    expect(PRESETS.map((p) => p.name).sort()).toEqual(
      ["battery", "full", "minimal", "off", "standard"].sort(),
    );
  });

  it("'minimal' enables fps + fps_only", () => {
    const p = findPreset("minimal");
    expect(p?.config).toEqual({ fps: "1", fps_only: "1" });
  });

  it("'off' sets no_display=1", () => {
    const p = findPreset("off");
    expect(p?.config).toEqual({ no_display: "1" });
  });
});
