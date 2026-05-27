import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { atomicWriteJSON, atomicReadJSON } from "./atomic-write";

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "atomic-write-test-"));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("atomicWriteJSON / atomicReadJSON", () => {
  it("writes JSON then reads it back", async () => {
    const filePath = join(testDir, "data.json");
    const payload = { name: "test-plugin", version: 2, enabled: true };

    await atomicWriteJSON(filePath, payload);
    const result = await atomicReadJSON<typeof payload | null>(filePath, null);

    expect(result).toEqual(payload);
  });

  it("returns fallback when file does not exist", async () => {
    const filePath = join(testDir, "nonexistent.json");
    const fallback = { default: true };

    const result = await atomicReadJSON(filePath, fallback);

    expect(result).toEqual(fallback);
  });

  it("returns fallback when file contains corrupt JSON", async () => {
    const filePath = join(testDir, "corrupt.json");
    await Bun.write(filePath, "{not valid json!!! @@");

    const fallback = [1, 2, 3];
    const result = await atomicReadJSON(filePath, fallback);

    expect(result).toEqual(fallback);
  });

  it("creates parent directories recursively", async () => {
    const filePath = join(testDir, "a", "b", "c", "deep.json");
    const payload = { deep: true };

    await atomicWriteJSON(filePath, payload);
    const result = await atomicReadJSON<typeof payload | null>(filePath, null);

    expect(result).toEqual(payload);
  });

  it("does not corrupt the original file if write fails mid-way", async () => {
    const filePath = join(testDir, "safe.json");
    const original = { version: 1 };

    // Write the original file
    await atomicWriteJSON(filePath, original);

    // Simulate a failure by making the tmp path a directory so Bun.write
    // to that path will fail, preventing the rename from ever happening.
    const tmpPath = `${filePath}.tmp`;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(tmpPath, { recursive: true });
    // Put a file inside the dir so it's non-empty — this guarantees
    // Bun.write can't overwrite the dir path with a file.
    await Bun.write(join(tmpPath, "blocker"), "x");

    let threw = false;
    try {
      await atomicWriteJSON(filePath, { version: 2, bad: true });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // The original file must be untouched
    const contents = await Bun.file(filePath).text();
    expect(JSON.parse(contents)).toEqual(original);
  });

  it("overwrites an existing file atomically", async () => {
    const filePath = join(testDir, "overwrite.json");

    await atomicWriteJSON(filePath, { v: 1 });
    await atomicWriteJSON(filePath, { v: 2 });

    const result = await atomicReadJSON<{ v: number } | null>(filePath, null);
    expect(result).toEqual({ v: 2 });
  });

  it("handles writing null and primitive values", async () => {
    const filePath = join(testDir, "prim.json");

    await atomicWriteJSON(filePath, null);
    expect(await atomicReadJSON(filePath, "fallback")).toBeNull();

    await atomicWriteJSON(filePath, 42);
    expect(await atomicReadJSON(filePath, 0)).toBe(42);

    await atomicWriteJSON(filePath, "hello");
    expect(await atomicReadJSON(filePath, "")).toBe("hello");
  });
});
