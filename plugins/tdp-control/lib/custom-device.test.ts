import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateCustomDevice,
  readCustomDevice,
  writeCustomDevice,
  clearCustomDevice,
  type CustomDevice,
} from "./custom-device";
import { readPluginStorage, writePluginStorage } from "@loadout/plugin-storage";

const PLUGIN_ID = "tdp-control-test";

const VALID: CustomDevice = {
  name: "My Handheld",
  minTdp: 5,
  maxTdp: 40,
  batteryMaxTdp: 30,
  profiles: { Silent: 10, Balanced: 20, Performance: 40 },
};

describe("validateCustomDevice", () => {
  test("accepts a well-formed device and trims the name", () => {
    const result = validateCustomDevice({ ...VALID, name: "  My Handheld  " });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.device.name).toBe("My Handheld");
  });

  test("rejects an empty name", () => {
    const result = validateCustomDevice({ ...VALID, name: "   " });
    expect(result).toEqual({ ok: false, error: "Device name is required" });
  });

  test("rejects non-whole watt values", () => {
    const result = validateCustomDevice({ ...VALID, maxTdp: 40.5 });
    expect(result.ok).toBe(false);
  });

  test("rejects min >= max", () => {
    const result = validateCustomDevice({ ...VALID, minTdp: 40, maxTdp: 40 });
    expect(result).toEqual({
      ok: false,
      error: "Min TDP must be less than Max TDP",
    });
  });

  test("rejects battery cap outside [min, max]", () => {
    expect(validateCustomDevice({ ...VALID, batteryMaxTdp: 50 }).ok).toBe(false);
    expect(validateCustomDevice({ ...VALID, batteryMaxTdp: 2 }).ok).toBe(false);
  });

  test("rejects a preset outside [min, max]", () => {
    const result = validateCustomDevice({
      ...VALID,
      profiles: { Silent: 10, Balanced: 20, Performance: 60 },
    });
    expect(result.ok).toBe(false);
  });

  test("rejects out-of-range absolute watts", () => {
    expect(validateCustomDevice({ ...VALID, maxTdp: 500 }).ok).toBe(false);
    expect(validateCustomDevice({ ...VALID, minTdp: 0 }).ok).toBe(false);
  });

  test("rejects missing profiles", () => {
    const { profiles, ...rest } = VALID;
    void profiles;
    expect(validateCustomDevice(rest).ok).toBe(false);
  });
});

describe("persistence", () => {
  let dir: string;
  let prevXdg: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "custom-device-test-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = dir;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    rmSync(dir, { recursive: true, force: true });
  });

  test("read returns null when nothing is stored", async () => {
    expect(await readCustomDevice(PLUGIN_ID)).toBeNull();
  });

  test("write then read round-trips the device", async () => {
    await writeCustomDevice(PLUGIN_ID, VALID);
    expect(await readCustomDevice(PLUGIN_ID)).toEqual(VALID);
  });

  test("write preserves co-tenant keys in the same file", async () => {
    await writePluginStorage(PLUGIN_ID, { defaultTdp: 15, profiles: [] });
    await writeCustomDevice(PLUGIN_ID, VALID);
    const raw = await readPluginStorage<Record<string, unknown>>(PLUGIN_ID);
    expect(raw.defaultTdp).toBe(15);
    expect(raw.customDevice).toEqual(VALID);
  });

  test("clear removes only the custom device key", async () => {
    await writePluginStorage(PLUGIN_ID, { defaultTdp: 15, profiles: [] });
    await writeCustomDevice(PLUGIN_ID, VALID);
    await clearCustomDevice(PLUGIN_ID);
    expect(await readCustomDevice(PLUGIN_ID)).toBeNull();
    const raw = await readPluginStorage<Record<string, unknown>>(PLUGIN_ID);
    expect(raw.defaultTdp).toBe(15);
    expect("customDevice" in raw).toBe(false);
  });

  test("read treats corrupt stored data as no custom device", async () => {
    await writePluginStorage(PLUGIN_ID, {
      customDevice: { name: "Bad", minTdp: 40, maxTdp: 10 },
    });
    expect(await readCustomDevice(PLUGIN_ID)).toBeNull();
  });
});
