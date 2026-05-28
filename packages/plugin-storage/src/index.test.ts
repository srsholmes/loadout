// Real-disk I/O against a per-test temp XDG_CONFIG_HOME. No mock.module on
// fs/promises — that pattern leaks across files in `bun test` (see
// docs/test-mock-contamination.md).

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";

import {
  loadoutConfigDir,
  pluginStoragePath,
  readPluginStorage,
  writePluginStorage,
} from "./index";

let tempDir: string;
let prevXdg: string | undefined;

beforeEach(() => {
  prevXdg = process.env.XDG_CONFIG_HOME;
  tempDir = mkdtempSync(join(tmpdir(), "plugin-storage-test-"));
  process.env.XDG_CONFIG_HOME = tempDir;
});

afterEach(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("loadoutConfigDir + pluginStoragePath", () => {
  it("honours XDG_CONFIG_HOME when set", () => {
    expect(loadoutConfigDir()).toBe(join(tempDir, "loadout"));
    expect(pluginStoragePath("my-plugin")).toBe(
      join(tempDir, "loadout", "plugins", "my-plugin.json"),
    );
  });

  it("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
    delete process.env.XDG_CONFIG_HOME;
    expect(pluginStoragePath("my-plugin")).toBe(
      join(homedir(), ".config", "loadout", "plugins", "my-plugin.json"),
    );
  });

  it("treats XDG_CONFIG_HOME='' as unset", () => {
    process.env.XDG_CONFIG_HOME = "";
    expect(pluginStoragePath("my-plugin")).toBe(
      join(homedir(), ".config", "loadout", "plugins", "my-plugin.json"),
    );
  });
});

describe("readPluginStorage", () => {
  it("returns {} when the file doesn't exist", async () => {
    expect(await readPluginStorage("missing-plugin")).toEqual({});
  });

  it("returns {} when the file is invalid JSON", async () => {
    const path = pluginStoragePath("broken-plugin");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{not valid json", "utf-8");
    expect(await readPluginStorage("broken-plugin")).toEqual({});
  });

  it("returns {} when the JSON top-level isn't an object", async () => {
    const cases: Array<[string, string]> = [
      ["array", "[1,2,3]"],
      ["null", "null"],
      ["number", "42"],
      ["string", '"hello"'],
    ];

    for (const [name, payload] of cases) {
      const pluginId = `non-object-${name}`;
      const path = pluginStoragePath(pluginId);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, payload, "utf-8");
      expect(await readPluginStorage(pluginId)).toEqual({});
    }
  });

  it("returns the parsed object for valid JSON on disk", async () => {
    interface Shape {
      foo: string;
      n: number;
      nested: { ok: boolean };
    }
    const stored: Shape = { foo: "bar", n: 7, nested: { ok: true } };
    const path = pluginStoragePath("good-plugin");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(stored), "utf-8");

    expect(await readPluginStorage<Shape>("good-plugin")).toEqual(stored);
  });
});

describe("writePluginStorage", () => {
  it("creates the parent directory on first write", async () => {
    const path = pluginStoragePath("fresh-plugin");
    expect(existsSync(dirname(path))).toBe(false);

    await writePluginStorage("fresh-plugin", { hello: "world" });

    expect(existsSync(dirname(path))).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it("round-trips through readPluginStorage", async () => {
    interface State {
      bookmarks: string[];
      count: number;
    }
    const payload: State = { bookmarks: ["a", "b"], count: 2 };

    await writePluginStorage<State>("roundtrip", payload);
    expect(await readPluginStorage<State>("roundtrip")).toEqual(payload);
  });

  it("is atomic — no .tmp sidecar after success, only the final file", async () => {
    const path = pluginStoragePath("atomic");
    await writePluginStorage("atomic", { v: 1 });

    expect(existsSync(path)).toBe(true);
    const entries = readdirSync(dirname(path));
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
    expect(entries).toEqual(["atomic.json"]);

    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ v: 1 });
  });

  it("overwrites — does not merge with existing contents", async () => {
    interface State {
      a?: number;
      b?: number;
    }
    await writePluginStorage<State>("overwrite", { a: 1, b: 2 });
    await writePluginStorage<State>("overwrite", { a: 99 });

    const out = await readPluginStorage<State>("overwrite");
    expect(out).toEqual({ a: 99 });
    expect(out.b).toBeUndefined();
  });

  it("uses unique tmp filenames so parallel writes don't clobber each other", async () => {
    // Two parallel writes must produce exactly one final file and no
    // .tmp residue. randomUUID() makes each write's tmp name unique;
    // POSIX rename keeps the final file atomic regardless of which write
    // wins the race.
    await Promise.all([
      writePluginStorage("parallel", { who: "a" }),
      writePluginStorage("parallel", { who: "b" }),
    ]);
    const dir = join(tempDir, "loadout", "plugins");
    const entries = readdirSync(dir);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
    expect(entries).toEqual(["parallel.json"]);

    const out = await readPluginStorage<{ who: string }>("parallel");
    expect(out.who).toBeDefined();
    expect(["a", "b"]).toContain(out.who as string);
  });
});
