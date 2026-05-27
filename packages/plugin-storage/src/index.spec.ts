// Backend specs for @loadout/plugin-storage. Uses real disk I/O against a
// per-test temp dir set via XDG_CONFIG_HOME — we intentionally avoid
// `mock.module("fs/promises", …)` because that pattern leaks across files in
// `bun test` (see packages/exec/src/exec.spec.ts for the same workaround).
//
// Audit ref: Q-005 / R3.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "fs";
import { tmpdir, homedir } from "os";
import { join, dirname } from "path";

import {
  pluginStoragePath,
  readPluginStorage,
  writePluginStorage,
} from "./index";

let tempDir: string;
let prevXdg: string | undefined;

beforeEach(() => {
  prevXdg = process.env.XDG_CONFIG_HOME;
  tempDir = mkdtempSync(join(tmpdir(), "plugin-storage-spec-"));
  process.env.XDG_CONFIG_HOME = tempDir;
});

afterEach(() => {
  if (prevXdg === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = prevXdg;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe("pluginStoragePath", () => {
  it("honors XDG_CONFIG_HOME when set and falls back to ~/.config when not", () => {
    // XDG_CONFIG_HOME is set in beforeEach.
    expect(pluginStoragePath("my-plugin")).toBe(
      join(tempDir, "loadout", "plugins", "my-plugin.json"),
    );

    // Unset and verify the homedir fallback. Empty string also counts as
    // unset per the implementation (`xdg && xdg.length > 0`).
    delete process.env.XDG_CONFIG_HOME;
    expect(pluginStoragePath("my-plugin")).toBe(
      join(homedir(), ".config", "loadout", "plugins", "my-plugin.json"),
    );

    process.env.XDG_CONFIG_HOME = "";
    expect(pluginStoragePath("my-plugin")).toBe(
      join(homedir(), ".config", "loadout", "plugins", "my-plugin.json"),
    );
  });
});

describe("readPluginStorage", () => {
  it("returns {} when the file doesn't exist", async () => {
    const data = await readPluginStorage("missing-plugin");
    expect(data).toEqual({});
  });

  it("returns {} when the file exists but is invalid JSON", async () => {
    const path = pluginStoragePath("broken-plugin");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{not valid json", "utf8");

    const data = await readPluginStorage("broken-plugin");
    expect(data).toEqual({});
  });

  it("returns {} when the file is valid JSON but isn't an object", async () => {
    // Each non-object JSON value should be coerced to {}.
    const cases: Array<[string, string]> = [
      ["array", "[]"],
      ["null", "null"],
      ["number", "42"],
      ["string", '"hello"'],
    ];

    for (const [name, payload] of cases) {
      const pluginId = `non-object-${name}`;
      const path = pluginStoragePath(pluginId);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, payload, "utf8");

      const data = await readPluginStorage(pluginId);
      expect(data).toEqual({});
    }
  });

  it("returns the parsed object for a valid JSON object on disk", async () => {
    interface Shape {
      foo: string;
      n: number;
      nested: { ok: boolean };
    }
    const stored: Shape = { foo: "bar", n: 7, nested: { ok: true } };
    const path = pluginStoragePath("good-plugin");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(stored), "utf8");

    const data = await readPluginStorage<Shape>("good-plugin");
    expect(data).toEqual(stored);
  });
});

describe("writePluginStorage", () => {
  it("creates the parent directory if missing", async () => {
    const path = pluginStoragePath("fresh-plugin");
    const parent = dirname(path);
    expect(existsSync(parent)).toBe(false);

    await writePluginStorage("fresh-plugin", { hello: "world" });

    expect(existsSync(parent)).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it("round-trips through readPluginStorage", async () => {
    interface State {
      bookmarks: string[];
      count: number;
    }
    const payload: State = { bookmarks: ["a", "b"], count: 2 };

    await writePluginStorage<State>("roundtrip", payload);
    const read = await readPluginStorage<State>("roundtrip");

    expect(read).toEqual(payload);
  });

  it("is atomic — the .tmp sidecar is gone after a successful write", async () => {
    const path = pluginStoragePath("atomic");
    await writePluginStorage("atomic", { v: 1 });

    // After success: real file exists, .tmp sidecar is cleaned up by rename.
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false);

    // And the parent directory contains exactly the final file, nothing else.
    const entries = readdirSync(dirname(path));
    expect(entries).toEqual(["atomic.json"]);

    // Sanity check the on-disk bytes are well-formed JSON we can parse back.
    const raw = readFileSync(path, "utf8");
    expect(JSON.parse(raw)).toEqual({ v: 1 });
  });

  it("overwrites an existing file's contents (not merges)", async () => {
    interface State {
      a?: number;
      b?: number;
    }
    await writePluginStorage<State>("overwrite", { a: 1, b: 2 });
    await writePluginStorage<State>("overwrite", { a: 99 });

    const read = await readPluginStorage<State>("overwrite");
    expect(read).toEqual({ a: 99 });
    expect(read.b).toBeUndefined();
  });
});
