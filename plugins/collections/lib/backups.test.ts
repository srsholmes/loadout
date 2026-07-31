// Real-disk I/O against a per-test temp XDG_CONFIG_HOME, matching
// packages/plugin-storage/src/index.test.ts. No mock.module on fs/promises —
// that pattern leaks across files in `bun test` (docs/test-mock-contamination.md).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupDir,
  backupFilename,
  listBackups,
  parseBackupFilename,
  pruneBackups,
  readBackup,
  writeBackup,
} from "./backups";
import { defaultConfig, validateConfig } from "./config";
import type { CollectionsConfig } from "./config";

let tempDir: string;
let prevXdg: string | undefined;

beforeEach(() => {
  prevXdg = process.env.XDG_CONFIG_HOME;
  tempDir = mkdtempSync(join(tmpdir(), "collections-backups-"));
  process.env.XDG_CONFIG_HOME = tempDir;
});

afterEach(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  rmSync(tempDir, { recursive: true, force: true });
});

const T = (iso: string) => Date.parse(iso);

function configWithTabs(labels: string[]): CollectionsConfig {
  const base = defaultConfig();
  return {
    ...base,
    tabs: labels.map((label, i) => ({
      ...base.tabs[0]!,
      id: `t${i}`,
      label,
      builtin: undefined,
    })),
    tabOrder: labels.map((_, i) => `t${i}`),
  };
}

describe("backupDir", () => {
  it("sits next to the live config, not under a cache directory", () => {
    // Cache dirs are things tools feel free to delete; this may be the only
    // copy of hours of work.
    expect(backupDir()).toBe(
      join(tempDir, "loadout", "plugins", "collections.backups"),
    );
    expect(backupDir()).not.toContain(".cache");
  });
});

describe("backupFilename / parseBackupFilename", () => {
  it("round-trips", () => {
    const at = T("2026-07-30T09:14:22.123Z");
    const file = backupFilename(at, 1, "pre-migration");
    expect(file).toBe("2026-07-30T09-14-22-123Z-v1-pre-migration.json");
    expect(parseBackupFilename(file)).toEqual({
      createdAt: at,
      schemaVersion: 1,
      reason: "pre-migration",
    });
  });

  it("avoids colons, which are illegal on some filesystems", () => {
    expect(backupFilename(Date.now(), 1, "manual")).not.toContain(":");
  });

  it("sorts lexically in chronological order", () => {
    // Listing is then a readdir + sort with no metadata reads, and the
    // directory is browsable by hand.
    const files = [
      backupFilename(T("2026-07-30T09:14:22.000Z"), 1, "manual"),
      backupFilename(T("2025-01-01T00:00:00.000Z"), 1, "manual"),
      backupFilename(T("2026-07-30T09:14:23.000Z"), 1, "manual"),
    ];
    expect([...files].sort()).toEqual([files[1]!, files[0]!, files[2]!]);
  });

  it("keeps millisecond precision so same-second backups don't collide", () => {
    const a = backupFilename(T("2026-07-30T09:14:22.100Z"), 1, "manual");
    const b = backupFilename(T("2026-07-30T09:14:22.900Z"), 1, "manual");
    expect(a).not.toBe(b);
  });

  it("rejects filenames that aren't ours", () => {
    for (const bad of [
      "notes.json",
      "2026-07-30-v1-manual.json",
      "2026-07-30T09-14-22-123Z-v1-sabotage.json", // unknown reason
      "2026-07-30T09-14-22-123Z-vX-manual.json",
      "config.json",
    ]) {
      expect(parseBackupFilename(bad)).toBeNull();
    }
  });
});

describe("writeBackup", () => {
  it("creates the directory and writes the file", async () => {
    const info = await writeBackup(defaultConfig(), "manual", T("2026-07-30T10:00:00.000Z"));
    expect(existsSync(join(backupDir(), info.file))).toBe(true);
    expect(info.reason).toBe("manual");
    expect(info.tabCount).toBe(defaultConfig().tabs.length);
  });

  it("leaves no .tmp file behind, so an interrupted write can't look restorable", async () => {
    await writeBackup(defaultConfig(), "manual");
    expect(readdirSync(backupDir()).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("writes a config that reloads intact", async () => {
    const original = configWithTabs(["Alpha", "Beta"]);
    const info = await writeBackup(original, "manual");
    const { config: restored, dropped } = await readBackup(info.file);
    expect(dropped).toEqual([]);
    expect(restored.tabs.map((t) => t.label)).toEqual(["Alpha", "Beta"]);
    expect(validateConfig(restored)).toEqual([]);
  });
});

describe("listBackups", () => {
  it("returns nothing when no backups exist, rather than throwing", async () => {
    expect(await listBackups()).toEqual([]);
  });

  it("returns newest first", async () => {
    await writeBackup(defaultConfig(), "manual", T("2026-07-01T00:00:00.000Z"));
    await writeBackup(defaultConfig(), "manual", T("2026-07-03T00:00:00.000Z"));
    await writeBackup(defaultConfig(), "manual", T("2026-07-02T00:00:00.000Z"));

    const list = await listBackups();
    expect(list.map((b) => b.createdAt)).toEqual([
      T("2026-07-03T00:00:00.000Z"),
      T("2026-07-02T00:00:00.000Z"),
      T("2026-07-01T00:00:00.000Z"),
    ]);
  });

  it("carries tab names so a restore list is identifiable without restoring", async () => {
    await writeBackup(configWithTabs(["Backlog", "Deck Verified"]), "manual");
    const [info] = await listBackups();
    expect(info!.tabLabels).toEqual(["Backlog", "Deck Verified"]);
    expect(info!.tabCount).toBe(2);
  });

  it("ignores files that aren't backups", async () => {
    mkdirSync(backupDir(), { recursive: true });
    writeFileSync(join(backupDir(), "README.txt"), "hello");
    await writeBackup(defaultConfig(), "manual");
    expect(await listBackups()).toHaveLength(1);
  });

  it("still lists a damaged backup, so it doesn't silently vanish", async () => {
    // The moment a user needs this list is exactly when something is broken.
    const file = backupFilename(T("2026-07-30T10:00:00.000Z"), 1, "manual");
    mkdirSync(backupDir(), { recursive: true });
    writeFileSync(join(backupDir(), file), "{ not json");

    const list = await listBackups();
    expect(list).toHaveLength(1);
    expect(list[0]!.tabCount).toBe(0);
    expect(list[0]!.tabLabels).toEqual([]);
  });
});

describe("readBackup", () => {
  it("rejects a filename that isn't a backup", async () => {
    await expect(readBackup("../../etc/passwd")).rejects.toThrow(
      "That isn't a Collections backup file",
    );
  });

  it("refuses a path-traversal attempt via the filename", async () => {
    // The filename regex is the guard: only our exact shape parses.
    await expect(
      readBackup("../../../2026-07-30T09-14-22-123Z-v1-manual.json"),
    ).rejects.toThrow("isn't a Collections backup file");
  });

  it("reports a missing backup in words a user can act on", async () => {
    await expect(
      readBackup(backupFilename(T("2026-07-30T09:14:22.123Z"), 1, "manual")),
    ).rejects.toThrow("That backup could no longer be found");
  });

  it("reports a damaged backup rather than leaking a JSON error", async () => {
    const file = backupFilename(T("2026-07-30T10:00:00.000Z"), 1, "manual");
    mkdirSync(backupDir(), { recursive: true });
    writeFileSync(join(backupDir(), file), "{{{");
    await expect(readBackup(file)).rejects.toThrow(
      "That backup is damaged and couldn't be read",
    );
  });

  it("salvages a partially-bad backup instead of refusing it", async () => {
    const file = backupFilename(T("2026-07-30T10:00:00.000Z"), 1, "manual");
    mkdirSync(backupDir(), { recursive: true });
    const damaged = { ...defaultConfig(), tabs: [{ label: "Broken" }] };
    writeFileSync(join(backupDir(), file), JSON.stringify(damaged));

    const { config: restored, dropped } = await readBackup(file);
    expect(validateConfig(restored)).toEqual([]);
    // The salvage must be *reported*. These sentences exist so a restore that
    // quietly drops a hand-built tab cannot happen in silence; `readBackup`
    // used to discard them.
    expect(dropped.length).toBeGreaterThan(0);
  });
});

describe("pruneBackups", () => {
  async function seedManual(count: number, startDay = 1): Promise<void> {
    for (let i = 0; i < count; i++) {
      const day = String(startDay + i).padStart(2, "0");
      await writeBackup(defaultConfig(), "manual", T(`2026-07-${day}T00:00:00.000Z`));
    }
  }

  it("does nothing when under the cap", async () => {
    await seedManual(3);
    expect(await pruneBackups(5)).toEqual([]);
    expect(await listBackups()).toHaveLength(3);
  });

  it("keeps the newest N and removes the rest", async () => {
    await seedManual(5);
    const removed = await pruneBackups(2);
    expect(removed).toHaveLength(3);

    const left = await listBackups();
    expect(left).toHaveLength(2);
    expect(left.map((b) => b.createdAt)).toEqual([
      T("2026-07-05T00:00:00.000Z"),
      T("2026-07-04T00:00:00.000Z"),
    ]);
  });

  it("ALWAYS keeps the oldest pre-migration backup, however old", async () => {
    // That file is the last copy of the config in its original schema, so it
    // is the only thing that can rescue a user from a lossy migration —
    // exactly the case where normal use has rotated everything else out.
    await writeBackup(defaultConfig(), "pre-migration", T("2020-01-01T00:00:00.000Z"));
    await seedManual(5);

    await pruneBackups(2);
    const left = await listBackups();
    expect(left.some((b) => b.reason === "pre-migration")).toBe(true);
    expect(left).toHaveLength(3); // 2 newest + the protected one
  });

  it("protects only the OLDEST pre-migration backup, not every one", async () => {
    await writeBackup(defaultConfig(), "pre-migration", T("2020-01-01T00:00:00.000Z"));
    await writeBackup(defaultConfig(), "pre-migration", T("2021-01-01T00:00:00.000Z"));
    await seedManual(4);

    await pruneBackups(2);
    const left = await listBackups();
    const migrations = left.filter((b) => b.reason === "pre-migration");
    expect(migrations).toHaveLength(1);
    expect(migrations[0]!.createdAt).toBe(T("2020-01-01T00:00:00.000Z"));
  });

  it("actually deletes from disk", async () => {
    await seedManual(4);
    await pruneBackups(1);
    expect(readdirSync(backupDir()).filter((f) => f.endsWith(".json"))).toHaveLength(1);
  });
});

describe("writeBackup — a name the reader can parse", () => {
  it("refuses a config whose schema version isn't a number", async () => {
    // The name embeds the version raw, so NaN produced `…-vNaN-manual.json`,
    // which FILENAME_RE rejects. The file lands on disk, `listBackups` skips
    // it, and `readBackup` refuses it — a backup that exists and is
    // unreachable is worse than none.
    const bad = { ...defaultConfig(), schemaVersion: Number.NaN };
    await expect(writeBackup(bad, "manual")).rejects.toThrow(/schema version/);
  });

  it("refuses a timestamp that would produce an expanded year", async () => {
    // A year >= 10000 serialises as `+010000-01-01T…`, which the pattern also
    // rejects.
    await expect(
      writeBackup(defaultConfig(), "manual", Date.UTC(10000, 0, 1)),
    ).rejects.toThrow(/timestamped/);
  });

  it("still writes, and can read back, an ordinary backup", async () => {
    const info = await writeBackup(defaultConfig(), "manual", T("2026-07-30T09:14:22.123Z"));
    const { config } = await readBackup(info.file);
    expect(validateConfig(config)).toEqual([]);
  });
});
