import { describe, test, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateCustomDevice,
  readCustomDevice,
  writeCustomDevice,
  clearCustomDevice,
  migrateSeededBatteryMax,
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

  test("rejects non-ascending presets", () => {
    // Balanced below Silent, and Performance below Balanced — both break the
    // ascending order the platform_profile midpoint mapping assumes.
    expect(
      validateCustomDevice({
        ...VALID,
        profiles: { Silent: 25, Balanced: 20, Performance: 40 },
      }).ok,
    ).toBe(false);
    expect(
      validateCustomDevice({
        ...VALID,
        profiles: { Silent: 10, Balanced: 30, Performance: 25 },
      }).ok,
    ).toBe(false);
    // Equal adjacent presets are allowed (ascending, not strictly increasing).
    expect(
      validateCustomDevice({
        ...VALID,
        profiles: { Silent: 20, Balanced: 20, Performance: 40 },
      }).ok,
    ).toBe(true);
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

describe("optional battery max (issue #230)", () => {
  const base = {
    name: "X2 Mini Pro",
    minTdp: 5,
    maxTdp: 80,
    profiles: { Silent: 10, Balanced: 40, Performance: 80 },
  };

  it("defaults batteryMaxTdp to maxTdp when omitted", () => {
    const r = validateCustomDevice(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.device.batteryMaxTdp).toBe(80);
  });

  it("treats an empty string (blank form field) the same as omitted", () => {
    const r = validateCustomDevice({ ...base, batteryMaxTdp: "" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.device.batteryMaxTdp).toBe(80);
  });

  it("treats null (what the form now sends for blank) as omitted", () => {
    const r = validateCustomDevice({ ...base, batteryMaxTdp: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.device.batteryMaxTdp).toBe(80);
  });

  it("still honours an explicit battery max, and still validates it", () => {
    const ok = validateCustomDevice({ ...base, batteryMaxTdp: 40 });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.device.batteryMaxTdp).toBe(40);

    // Above max is still rejected — omitting is the escape hatch, not garbage.
    const bad = validateCustomDevice({ ...base, batteryMaxTdp: 100 });
    expect(bad.ok).toBe(false);

    const belowMin = validateCustomDevice({ ...base, batteryMaxTdp: 2 });
    expect(belowMin.ok).toBe(false);
  });
});

describe("one-time battery-max migration (issue #230)", () => {
  // Same tmpdir isolation the persistence block uses — these write storage,
  // and the real ~/.config/loadout/plugins is root-owned on a machine where
  // the backend service has run.
  let dir: string;
  let prevXdg: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "custom-device-migrate-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = dir;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    rmSync(dir, { recursive: true, force: true });
  });

  const seeded = {
    name: "X2 Mini Pro",
    minTdp: 5,
    maxTdp: 80,
    batteryMaxTdp: 28, // the generic-AMD default the old form pre-filled
    profiles: { Silent: 10, Balanced: 40, Performance: 80 },
  };

  it("clears a battery max that matches the detected default and sits below max", async () => {
    await writeCustomDevice(PLUGIN_ID, seeded);
    const from = await migrateSeededBatteryMax({
      pluginId: PLUGIN_ID,
      detectedBatteryMaxTdp: 28,
    });
    expect(from).toBe(28);
    const after = await readCustomDevice(PLUGIN_ID);
    // Cleared => defaults to maxTdp; the global 55W ceiling still applies.
    expect(after?.batteryMaxTdp).toBe(80);
  });

  it("runs only once, so a value re-entered afterwards is never touched", async () => {
    await writeCustomDevice(PLUGIN_ID, seeded);
    expect(
      await migrateSeededBatteryMax({ pluginId: PLUGIN_ID, detectedBatteryMaxTdp: 28 }),
    ).toBe(28);
    // The user decides they really did want 28 and sets it again.
    await writeCustomDevice(PLUGIN_ID, seeded);
    expect(
      await migrateSeededBatteryMax({ pluginId: PLUGIN_ID, detectedBatteryMaxTdp: 28 }),
    ).toBeNull();
    expect((await readCustomDevice(PLUGIN_ID))?.batteryMaxTdp).toBe(28);
  });

  it("leaves a value that does not match the detected default", async () => {
    await writeCustomDevice(PLUGIN_ID, { ...seeded, batteryMaxTdp: 40 });
    expect(
      await migrateSeededBatteryMax({ pluginId: PLUGIN_ID, detectedBatteryMaxTdp: 28 }),
    ).toBeNull();
    expect((await readCustomDevice(PLUGIN_ID))?.batteryMaxTdp).toBe(40);
  });

  it("leaves a battery max already equal to the device max", async () => {
    await writeCustomDevice(PLUGIN_ID, { ...seeded, batteryMaxTdp: 80 });
    expect(
      await migrateSeededBatteryMax({ pluginId: PLUGIN_ID, detectedBatteryMaxTdp: 80 }),
    ).toBeNull();
  });

  it("marks itself done even with no custom device saved", async () => {
    expect(
      await migrateSeededBatteryMax({ pluginId: PLUGIN_ID, detectedBatteryMaxTdp: 28 }),
    ).toBeNull();
    // A device saved later must not be retro-migrated.
    await writeCustomDevice(PLUGIN_ID, seeded);
    expect(
      await migrateSeededBatteryMax({ pluginId: PLUGIN_ID, detectedBatteryMaxTdp: 28 }),
    ).toBeNull();
    expect((await readCustomDevice(PLUGIN_ID))?.batteryMaxTdp).toBe(28);
  });
});
