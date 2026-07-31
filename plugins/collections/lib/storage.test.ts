// Real-disk I/O against a per-test temp XDG_CONFIG_HOME. See backups.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginStoragePath } from "@loadout/plugin-storage";
import { listBackups } from "./backups";
import {
  COLLECTIONS_SCHEMA_VERSION,
  defaultConfig,
  validateConfig,
} from "./config";
import type { CollectionsConfig } from "./config";
import { loadConfig, restoreBackup, saveConfig, saveWithBackup } from "./storage";

let tempDir: string;
let prevXdg: string | undefined;

beforeEach(() => {
  prevXdg = process.env.XDG_CONFIG_HOME;
  tempDir = mkdtempSync(join(tmpdir(), "collections-storage-"));
  process.env.XDG_CONFIG_HOME = tempDir;
});

afterEach(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  rmSync(tempDir, { recursive: true, force: true });
});

const T = (iso: string) => Date.parse(iso);
const CONFIG_PATH = () => pluginStoragePath("collections");

function writeStored(value: unknown): void {
  const path = CONFIG_PATH();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

function readStored(): CollectionsConfig {
  return JSON.parse(readFileSync(CONFIG_PATH(), "utf-8")) as CollectionsConfig;
}

function renamedTab(label: string): CollectionsConfig {
  const base = defaultConfig();
  return { ...base, collections: [{ ...base.tabs[0]!, label }, ...base.tabs.slice(1)] };
}

describe("loadConfig — first run", () => {
  it("seeds defaults and says so", async () => {
    const result = await loadConfig();
    expect(result.seeded).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.readOnly).toBe(false);
    expect(result.config.tabs.length).toBeGreaterThan(0);
  });

  it("persists the seed, so the second load is not a first run", async () => {
    await loadConfig();
    expect(existsSync(CONFIG_PATH())).toBe(true);
    expect((await loadConfig()).seeded).toBe(false);
  });

  it("does not take a pre-migration backup on a first run", async () => {
    await loadConfig(T("2026-07-30T10:00:00.000Z"));
    const backups = await listBackups();
    expect(backups.some((b) => b.reason === "pre-migration")).toBe(false);
  });
});

describe("loadConfig — normal load", () => {
  it("round-trips a saved config", async () => {
    await saveConfig(renamedTab("Renamed"));
    const result = await loadConfig();
    expect(result.config.tabs[0]!.label).toBe("Renamed");
    expect(result.warnings).toEqual([]);
    expect(result.seeded).toBe(false);
  });

  it("distinguishes an unparseable file from a first run", async () => {
    // Both surface as `{}` from readPluginStorage, but only one of them means
    // we are about to replace something the user may want back.
    writeStored("{ not json at all");
    const result = await loadConfig();
    expect(result.seeded).toBe(true);
    expect(result.config.tabs.length).toBeGreaterThan(0);
  });

  it("salvages a partly-broken config and reports what went", async () => {
    const base = defaultConfig();
    writeStored({ ...base, collections: [base.tabs[0], { label: "Broken" }] });

    const result = await loadConfig();
    expect(result.warnings.some((w) => w.includes("Broken"))).toBe(true);
    expect(validateConfig(result.config)).toEqual([]);
  });

  it("persists the salvaged shape so warnings don't reappear every boot", async () => {
    const base = defaultConfig();
    writeStored({ ...base, collections: [base.tabs[0], { label: "Broken" }] });

    await loadConfig();
    expect((await loadConfig()).warnings).toEqual([]);
  });

  it("never throws, whatever is on disk", async () => {
    for (const junk of ["{ broken", "[]", "null", '"a string"', "{}"]) {
      writeStored(junk);
      const result = await loadConfig();
      expect(result.config.tabs.length).toBeGreaterThan(0);
    }
  });
});

describe("loadConfig — a config from a newer build", () => {
  const future = () => ({
    ...defaultConfig(),
    schemaVersion: COLLECTIONS_SCHEMA_VERSION + 3,
  });

  it("is flagged read-only", async () => {
    writeStored(future());
    const result = await loadConfig();
    expect(result.readOnly).toBe(true);
    expect(result.warnings[0]).toContain("newer version of Loadout");
  });

  it("does NOT overwrite the file", async () => {
    // The user may simply have booted an older Loadout by accident.
    writeStored(future());
    await loadConfig();
    expect(readStored().schemaVersion).toBe(COLLECTIONS_SCHEMA_VERSION + 3);
  });

  it("still returns usable tabs so the plugin renders", async () => {
    writeStored(future());
    expect((await loadConfig()).config.tabs.length).toBeGreaterThan(0);
  });
});

describe("loadConfig — daily backup", () => {
  it("takes one periodic backup per calendar day", async () => {
    await saveConfig(defaultConfig());

    await loadConfig(T("2026-07-30T08:00:00.000Z"));
    await loadConfig(T("2026-07-30T20:00:00.000Z")); // same day
    let periodic = (await listBackups()).filter((b) => b.reason === "periodic");
    expect(periodic).toHaveLength(1);

    await loadConfig(T("2026-07-31T08:00:00.000Z")); // next day
    periodic = (await listBackups()).filter((b) => b.reason === "periodic");
    expect(periodic).toHaveLength(2);
  });

  it("prunes to the configured maximum", async () => {
    const config: CollectionsConfig = {
      ...defaultConfig(),
      settings: { ...defaultConfig().settings, maxBackups: 2 },
    };
    await saveConfig(config);
    for (let day = 1; day <= 5; day++) {
      await loadConfig(T(`2026-07-0${day}T00:00:00.000Z`));
    }
    expect((await listBackups()).length).toBeLessThanOrEqual(2);
  });
});

describe("saveConfig", () => {
  it("writes atomically, leaving no tmp file", async () => {
    await saveConfig(defaultConfig());
    const dir = join(CONFIG_PATH(), "..");
    const leftovers = (await import("node:fs")).readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("THROWS rather than persisting an invalid config", async () => {
    // This is the guarantee that the file on disk is always loadable, so the
    // guard is deliberately loud.
    const invalid = { ...defaultConfig(), collections: [{ label: "no id" }] } as never;
    await expect(saveConfig(invalid)).rejects.toThrow(/Refusing to save invalid/);
  });

  it("leaves the previous good config in place when it refuses", async () => {
    await saveConfig(renamedTab("Good"));
    const invalid = { ...defaultConfig(), collections: [{ label: "bad" }] } as never;
    await expect(saveConfig(invalid)).rejects.toThrow();
    expect(readStored().tabs[0]!.label).toBe("Good");
  });

  it("names the actual problems in the error, for the log", async () => {
    const invalid = { ...defaultConfig(), collections: [{ label: "" }] } as never;
    await expect(saveConfig(invalid)).rejects.toThrow(/missing an id/);
  });
});

describe("saveWithBackup", () => {
  it("snapshots the previous state under the given reason", async () => {
    const before = renamedTab("Before");
    await saveConfig(before);
    await saveWithBackup(renamedTab("After"), before, "pre-import", T("2026-07-30T10:00:00.000Z"));

    const backups = await listBackups();
    const backup = backups.find((b) => b.reason === "pre-import")!;
    expect(backup).toBeDefined();
    expect(backup.tabLabels[0]).toBe("Before");
    expect(readStored().tabs[0]!.label).toBe("After");
  });

  it("still throws if the save itself is invalid", async () => {
    const before = defaultConfig();
    const invalid = { ...before, collections: [{ label: "bad" }] } as never;
    await expect(saveWithBackup(invalid, before, "pre-import")).rejects.toThrow(
      /Refusing to save invalid/,
    );
  });
});

describe("restoreBackup", () => {
  it("restores a backup over the live config", async () => {
    const original = renamedTab("Original");
    await saveConfig(original);
    await saveWithBackup(renamedTab("Changed"), original, "manual", T("2026-07-30T10:00:00.000Z"));

    const backup = (await listBackups()).find((b) => b.reason === "manual")!;
    const result = await restoreBackup(backup.file, renamedTab("Changed"));

    expect(result.config.tabs[0]!.label).toBe("Original");
    expect(readStored().tabs[0]!.label).toBe("Original");
  });

  it("is itself undoable — it snapshots the state it replaced", async () => {
    // TabMaster's restore instead sets a "don't save until you reboot" flag
    // and asks the user to restart the machine. Making restore just another
    // atomic save removes the need for that ceremony.
    const original = renamedTab("Original");
    await saveConfig(original);
    await saveWithBackup(renamedTab("Changed"), original, "manual", T("2026-07-30T10:00:00.000Z"));

    const backup = (await listBackups()).find((b) => b.reason === "manual")!;
    await restoreBackup(backup.file, renamedTab("Changed"), T("2026-07-30T11:00:00.000Z"));

    const preRestore = (await listBackups()).find((b) => b.reason === "pre-restore")!;
    expect(preRestore).toBeDefined();
    expect(preRestore.tabLabels[0]).toBe("Changed");
  });

  it("propagates a user-facing error for a damaged backup", async () => {
    await expect(
      restoreBackup("2026-07-30T09-14-22-123Z-v1-manual.json", defaultConfig()),
    ).rejects.toThrow("That backup could no longer be found");
  });

  it("does not touch the live config when the restore fails", async () => {
    await saveConfig(renamedTab("Untouched"));
    await expect(restoreBackup("not-a-backup.json", defaultConfig())).rejects.toThrow();
    expect(readStored().tabs[0]!.label).toBe("Untouched");
  });
});
