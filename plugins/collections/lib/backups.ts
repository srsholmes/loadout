/**
 * Timestamped config backups.
 *
 * `@loadout/plugin-storage` gives a plugin exactly one JSON file, which is
 * the right default but leaves no room for history. Backups therefore get
 * their own sibling directory:
 *
 *   ~/.config/loadout/plugins/collections.backups/
 *
 * Deliberately next to the live file rather than under `~/.cache`: cache
 * directories are things tools feel free to delete, and this is the one copy
 * of work a user may have spent hours on.
 *
 * Filenames sort lexically by time (`2026-07-30T09-14-22Z-v1-pre-migration.json`),
 * so listing is a `readdir` + `sort` with no metadata reads, and a directory
 * listing is human-browsable — someone can find and copy the right file by
 * hand without this plugin's help, which matters when the thing that broke is
 * this plugin.
 *
 * **Backend only** — imports `node:fs`. Never import from `app.tsx`.
 */

import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadoutConfigDir } from "@loadout/plugin-storage";
import type { CollectionsConfig } from "./config";
import { coerceConfig } from "./config";

export const PLUGIN_ID = "collections";

/**
 * Why a backup was taken. Every one of these is a moment where the next
 * action could plausibly lose data, which is the whole selection criterion.
 */
export type BackupReason =
  | "pre-migration"
  | "pre-restore"
  | "pre-import"
  | "pre-unmirror"
  | "manual"
  | "periodic";

export interface BackupInfo {
  /** Bare filename, not a path — the restore API takes this. */
  file: string;
  /** Epoch ms parsed from the filename. */
  createdAt: number;
  schemaVersion: number;
  reason: BackupReason;
  /** Tab count, so the restore list is identifiable without restoring. */
  tabCount: number;
  /** Tab names, for the expandable preview. */
  tabLabels: string[];
}

export function backupDir(): string {
  return join(loadoutConfigDir(), "plugins", `${PLUGIN_ID}.backups`);
}

/**
 * `2026-07-30T09-14-22-123Z-v1-pre-migration.json`
 *
 * Colons are illegal on some filesystems and awkward everywhere, so the ISO
 * string's `:` and `.` become `-`. Millisecond precision keeps two backups
 * taken in the same second from colliding.
 */
export function backupFilename(
  at: number,
  schemaVersion: number,
  reason: BackupReason,
): string {
  const stamp = new Date(at).toISOString().replace(/[:.]/g, "-");
  return `${stamp}-v${schemaVersion}-${reason}.json`;
}

const FILENAME_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-v(\d+)-([a-z-]+)\.json$/;

const REASONS = new Set<BackupReason>([
  "pre-migration", "pre-restore", "pre-import", "pre-unmirror", "manual",
  "periodic",
]);

/** Recover the metadata encoded in a filename, or null if it isn't ours. */
export function parseBackupFilename(
  file: string,
): { createdAt: number; schemaVersion: number; reason: BackupReason } | null {
  const match = FILENAME_RE.exec(file);
  if (!match) return null;
  const [, stamp, version, reason] = match;
  if (!REASONS.has(reason as BackupReason)) return null;

  // Undo the `:`/`.` substitution: 2026-07-30T09-14-22-123Z
  const iso = stamp!.replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    "$1T$2:$3:$4.$5Z",
  );
  const createdAt = Date.parse(iso);
  if (Number.isNaN(createdAt)) return null;

  return {
    createdAt,
    schemaVersion: Number(version),
    reason: reason as BackupReason,
  };
}

/**
 * Write a backup. Atomic (tmp + rename), same discipline as
 * `plugin-storage`, so an interrupted backup never leaves a half file that
 * later looks restorable.
 */
export async function writeBackup(
  config: CollectionsConfig,
  reason: BackupReason,
  at: number = Date.now(),
): Promise<BackupInfo> {
  const dir = backupDir();
  await mkdir(dir, { recursive: true });

  // A name the reader cannot parse is worse than no backup at all: the file
  // lands on disk, `listBackups` skips it, and `readBackup` refuses it.
  if (!Number.isInteger(config.schemaVersion) || config.schemaVersion < 0) {
    throw new Error(`Refusing to write a backup with schema version ${config.schemaVersion}`);
  }
  if (!Number.isFinite(at) || at < 0 || new Date(at).getUTCFullYear() > 9999) {
    throw new Error(`Refusing to write a backup timestamped ${at}`);
  }

  const file = backupFilename(at, config.schemaVersion, reason);
  const path = join(dir, file);
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", "utf-8");
  await rename(tmp, path);

  return {
    file,
    createdAt: at,
    schemaVersion: config.schemaVersion,
    reason,
    tabCount: config.tabs.length,
    tabLabels: config.tabs.map((t) => t.label),
  };
}

/**
 * Every backup, newest first.
 *
 * A file that can't be read or parsed is skipped rather than throwing — the
 * restore list must still render when one entry is damaged, since that is
 * precisely when someone needs it.
 */
export async function listBackups(): Promise<BackupInfo[]> {
  let files: string[];
  try {
    files = await readdir(backupDir());
  } catch {
    return []; // no backups yet
  }

  const out: BackupInfo[] = [];
  for (const file of files.sort().reverse()) {
    const meta = parseBackupFilename(file);
    if (!meta) continue;
    try {
      const raw = await readFile(join(backupDir(), file), "utf-8");
      const parsed = JSON.parse(raw) as { tabs?: Array<{ label?: unknown }> };
      const labels = Array.isArray(parsed.tabs)
        ? parsed.tabs
            .map((t) => (typeof t?.label === "string" ? t.label : null))
            .filter((l): l is string => l !== null)
        : [];
      out.push({ file, ...meta, tabCount: labels.length, tabLabels: labels });
    } catch {
      // Unreadable: still list it, so the user can see it exists and that
      // it isn't a candidate, rather than wondering where it went.
      out.push({ file, ...meta, tabCount: 0, tabLabels: [] });
    }
  }
  return out;
}

/**
 * Load a backup, salvaging as `coerceConfig` does.
 *
 * Throws a user-facing message when the file can't be read at all — the
 * caller is a restore button, and "that backup is damaged" is what the user
 * needs to hear.
 */
export async function readBackup(
  file: string,
): Promise<{ config: CollectionsConfig; dropped: string[] }> {
  if (parseBackupFilename(file) === null) {
    throw new Error("That isn't a Collections backup file");
  }
  let raw: string;
  try {
    raw = await readFile(join(backupDir(), file), "utf-8");
  } catch {
    throw new Error("That backup could no longer be found");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("That backup is damaged and couldn't be read");
  }
  const coerced = coerceConfig(parsed);
  return { config: coerced.config, dropped: coerced.dropped };
}

/**
 * Trim to `keep` newest, returning the filenames removed.
 *
 * One exception: the **oldest `pre-migration` backup is always kept**,
 * whatever its age. That file is the last copy of the config in its original
 * schema, so it's the only thing that can rescue a user from a migration
 * that turns out to have been lossy — exactly the case where every other
 * backup has already been rotated out by normal use.
 */
export async function pruneBackups(keep: number): Promise<string[]> {
  const all = await listBackups(); // newest first
  if (all.length <= keep) return [];

  const migrations = all.filter((b) => b.reason === "pre-migration");
  const protectedFile = migrations.at(-1)?.file; // oldest pre-migration

  const doomed = all
    .slice(keep)
    .filter((b) => b.file !== protectedFile);

  const removed: string[] = [];
  for (const backup of doomed) {
    try {
      await unlink(join(backupDir(), backup.file));
      removed.push(backup.file);
    } catch {
      // Losing a prune is harmless; refusing to boot over it is not.
    }
  }
  return removed;
}
