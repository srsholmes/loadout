import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCpuBoostPref, writeCpuBoostPref } from "./cpu-boost-pref";
import { readPluginStorage, writePluginStorage } from "@loadout/plugin-storage";

const PLUGIN_ID = "tdp-control-test";

describe("cpu-boost-pref persistence", () => {
  let dir: string;
  let prevXdg: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cpu-boost-pref-test-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = dir;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    rmSync(dir, { recursive: true, force: true });
  });

  test("read returns null when nothing is stored", async () => {
    expect(await readCpuBoostPref(PLUGIN_ID)).toBeNull();
  });

  test("write then read round-trips both states", async () => {
    await writeCpuBoostPref({ pluginId: PLUGIN_ID, enabled: true });
    expect(await readCpuBoostPref(PLUGIN_ID)).toBe(true);
    await writeCpuBoostPref({ pluginId: PLUGIN_ID, enabled: false });
    expect(await readCpuBoostPref(PLUGIN_ID)).toBe(false);
  });

  test("write preserves co-tenant keys in the same file", async () => {
    await writePluginStorage(PLUGIN_ID, { manualTdp: 30, defaultTdp: 15 });
    await writeCpuBoostPref({ pluginId: PLUGIN_ID, enabled: true });
    const raw = await readPluginStorage<Record<string, unknown>>(PLUGIN_ID);
    expect(raw.manualTdp).toBe(30);
    expect(raw.defaultTdp).toBe(15);
    expect(raw.cpuBoost).toBe(true);
  });

  test("read treats a non-boolean as nothing stored", async () => {
    await writePluginStorage(PLUGIN_ID, { cpuBoost: "yes" });
    expect(await readCpuBoostPref(PLUGIN_ID)).toBeNull();
    await writePluginStorage(PLUGIN_ID, { cpuBoost: 1 });
    expect(await readCpuBoostPref(PLUGIN_ID)).toBeNull();
  });
});
