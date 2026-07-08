import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSavedTdp, writeSavedTdp } from "./saved-tdp";
import { readPluginStorage, writePluginStorage } from "@loadout/plugin-storage";

const PLUGIN_ID = "tdp-control-test";

describe("saved-tdp persistence", () => {
  let dir: string;
  let prevXdg: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "saved-tdp-test-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = dir;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    rmSync(dir, { recursive: true, force: true });
  });

  test("read returns null when nothing is stored", async () => {
    expect(await readSavedTdp(PLUGIN_ID)).toBeNull();
  });

  test("write then read round-trips the value", async () => {
    await writeSavedTdp(PLUGIN_ID, 22);
    expect(await readSavedTdp(PLUGIN_ID)).toBe(22);
  });

  test("write rounds fractional watts", async () => {
    await writeSavedTdp(PLUGIN_ID, 17.6);
    expect(await readSavedTdp(PLUGIN_ID)).toBe(18);
  });

  test("write preserves co-tenant keys in the same file", async () => {
    await writePluginStorage(PLUGIN_ID, { defaultTdp: 15, profiles: [] });
    await writeSavedTdp(PLUGIN_ID, 30);
    const raw = await readPluginStorage<Record<string, unknown>>(PLUGIN_ID);
    expect(raw.defaultTdp).toBe(15);
    expect(raw.manualTdp).toBe(30);
  });

  test("read treats a non-number as nothing stored", async () => {
    await writePluginStorage(PLUGIN_ID, { manualTdp: "twenty" });
    expect(await readSavedTdp(PLUGIN_ID)).toBeNull();
  });

  test("read rejects out-of-range values", async () => {
    await writePluginStorage(PLUGIN_ID, { manualTdp: 0 });
    expect(await readSavedTdp(PLUGIN_ID)).toBeNull();
    await writePluginStorage(PLUGIN_ID, { manualTdp: 9999 });
    expect(await readSavedTdp(PLUGIN_ID)).toBeNull();
  });
});
