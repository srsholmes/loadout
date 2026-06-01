import { describe, it, expect } from "bun:test";
import { parseProgressLine, parseAuthUrl, EPIC_LOGIN_URL } from "./legendary";

describe("parseProgressLine", () => {
  it("extracts the percentage from a DLManager log line", () => {
    expect(parseProgressLine("[DLManager] INFO: = Progress: 12.34%, ETA: 00:05:12")).toBe(12.34);
  });

  it("handles the simpler 'Progress: 12.3% (123/1000 MiB)' format", () => {
    expect(parseProgressLine("Progress: 12.3% (123/1000 MiB)")).toBeCloseTo(12.3);
  });

  it("returns null for non-progress lines", () => {
    expect(parseProgressLine("[CLI] Some other log line")).toBeNull();
    expect(parseProgressLine("")).toBeNull();
  });

  it("clamps overshoot values down to 100 — defends against drift in legendary's printf", () => {
    expect(parseProgressLine("Progress: 142%")).toBe(100);
  });
});

describe("parseAuthUrl", () => {
  it("plucks the legendary.gl/epiclogin URL out of stdout", () => {
    const stdout =
      "Please login via the epic web login: https://legendary.gl/epiclogin\n";
    expect(parseAuthUrl(stdout)).toBe("https://legendary.gl/epiclogin");
  });

  it("falls back to the canonical URL when stdout doesn't contain one", () => {
    expect(parseAuthUrl("legendary did not print a URL today")).toBe(EPIC_LOGIN_URL);
  });
});
