import { describe, it, expect } from "bun:test";
import { resolveWithinDir } from "./path-confine";

describe("resolveWithinDir", () => {
  const base = "/games/foo";

  it("resolves a normal relative path under base", () => {
    expect(resolveWithinDir(base, "build/bin", "x")).toBe("/games/foo/build/bin");
  });

  it("allows the base dir itself", () => {
    expect(resolveWithinDir(base, ".", "x")).toBe("/games/foo");
  });

  it("rejects a `..` escape", () => {
    expect(() => resolveWithinDir(base, "../../etc/cron.d", "Mod installSubdir")).toThrow(
      /escapes the install directory/,
    );
  });

  it("rejects an absolute path outside base", () => {
    expect(() => resolveWithinDir(base, "/etc/passwd", "x")).toThrow(
      /escapes the install directory/,
    );
  });

  it("rejects a sibling-prefix escape (foobar vs foo)", () => {
    // `/games/foobar` shares the `/games/foo` string prefix but is NOT
    // under it — the segment-anchored check must reject it.
    expect(() => resolveWithinDir(base, "../foobar/x", "x")).toThrow(
      /escapes the install directory/,
    );
  });
});
