import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rm, mkdtemp, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  pluginStoragePath,
  readPluginStorage,
  writePluginStorage,
} from "./plugin-storage";

// ---------------------------------------------------------------------------
// Inlined plugin-storage: path resolution + atomic disk round-trip. We
// point XDG_CONFIG_HOME at a temp dir so the JSON file lands somewhere
// disposable.
// ---------------------------------------------------------------------------

describe("plugin storage (inlined)", () => {
  let tmp: string;
  let prevXdg: string | undefined;

  beforeEach(async () => {
    prevXdg = process.env.XDG_CONFIG_HOME;
    tmp = await mkdtemp(join(tmpdir(), "loadout-fan-control-"));
    process.env.XDG_CONFIG_HOME = tmp;
  });

  afterEach(async () => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    await rm(tmp, { recursive: true, force: true });
  });

  it("pluginStoragePath lands under <XDG>/loadout/plugins/<id>.json", () => {
    expect(pluginStoragePath("fan-control")).toBe(
      join(tmp, "loadout", "plugins", "fan-control.json"),
    );
  });

  it("returns {} when the file is missing", async () => {
    expect(await readPluginStorage("fan-control")).toEqual({});
  });

  it("returns {} when the file holds a non-object (array)", async () => {
    await writePluginStorage("fan-control", [1, 2, 3] as unknown as object);
    expect(await readPluginStorage("fan-control")).toEqual({});
  });

  it("write then read round-trips an object", async () => {
    await writePluginStorage("fan-control", { perGameEnabled: true, foo: 1 });
    expect(await readPluginStorage("fan-control")).toEqual({
      perGameEnabled: true,
      foo: 1,
    });
    // Atomic write leaves no .tmp behind.
    const raw = await readFile(
      join(tmp, "loadout", "plugins", "fan-control.json"),
      "utf8",
    );
    expect(JSON.parse(raw)).toEqual({ perGameEnabled: true, foo: 1 });
  });
});
