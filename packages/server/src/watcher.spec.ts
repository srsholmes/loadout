import { describe, it, expect } from "bun:test";
import { sep } from "node:path";
import { shouldIgnore } from "./watcher";

describe("shouldIgnore", () => {
  it("ignores null filenames", () => {
    expect(shouldIgnore(null)).toBe(true);
  });

  it("ignores .cache, .build, node_modules at top level", () => {
    expect(shouldIgnore(".cache")).toBe(true);
    expect(shouldIgnore(".build")).toBe(true);
    expect(shouldIgnore("node_modules")).toBe(true);
  });

  it("ignores nested .cache / .build / node_modules", () => {
    expect(shouldIgnore(`sub${sep}.cache${sep}foo`)).toBe(true);
    expect(shouldIgnore(`sub${sep}.build${sep}out.js`)).toBe(true);
    expect(shouldIgnore(`sub${sep}node_modules${sep}pkg`)).toBe(true);
  });

  it("passes through source file changes", () => {
    expect(shouldIgnore("app.tsx")).toBe(false);
    expect(shouldIgnore("backend.ts")).toBe(false);
    expect(shouldIgnore(`src${sep}index.ts`)).toBe(false);
  });
});
