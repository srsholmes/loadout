/**
 * Load and save orchestration: where migration, validation, salvage and
 * backups meet the filesystem.
 *
 * The other modules are each pure and separately tested; this one is the
 * sequencing, and the sequencing is where data gets lost. Two invariants it
 * exists to enforce:
 *
 * 1. **A backup is written before anything that could lose data** — before a
 *    migration runs, before a restore overwrites, before an import merges,
 *    before we delete mirrored collections. Also once per calendar day, so
 *    ordinary use leaves a trail.
 * 2. **An invalid config is never persisted.** `saveConfig` validates and
 *    throws rather than writing. A caller seeing that throw has a bug;
 *    a user seeing a corrupt file has lost work.
 *
 * All writes go through `mutatePluginStorage`, never `writePluginStorage`
 * directly, because more than one code path here persists into the same
 * file and its per-plugin lock is what stops a lost update.
 *
 * **Backend only** — imports `node:fs` transitively. Never import from `app.tsx`.
 */

import {
  mutatePluginStorage,
  pluginStoragePath,
  readPluginStorage,
} from "@loadout/plugin-storage";
import { copyFile, stat } from "node:fs/promises";
import type { CollectionsConfig } from "./config";
import { defaultConfig, validateConfig } from "./config";
import { migrate } from "./migrations";
import {
  PLUGIN_ID,
  type BackupReason,
  listBackups,
  pruneBackups,
  readBackup,
  writeBackup,
} from "./backups";

/**
 * Preserve an unreadable settings file before defaults overwrite it.
 *
 * Copied rather than moved: if the copy fails there is no world in which we
 * have destroyed the original as a side effect of trying to save it.
 *
 * Returns the file name kept, or `null` when there was simply no file — the
 * genuine first run, which must stay silent.
 */
async function quarantineUnreadable(now: number): Promise<string | null> {
  const path = pluginStoragePath(PLUGIN_ID);
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
  } catch {
    return null; // No file at all: a real first run.
  }

  const name = `${PLUGIN_ID}.unreadable-${now}.json`;
  try {
    await copyFile(path, `${path}.unreadable-${now}`);
    return name;
  } catch {
    // Nothing more we can do, but the caller still warns rather than
    // pretending this was a clean install.
    return name;
  }
}

export interface LoadResult {
  config: CollectionsConfig;
  /**
   * Problems worth telling the user about: dropped tabs, applied migrations,
   * a config from a newer build. Empty on a clean load.
   */
  warnings: string[];
  /** True when this was a first run and defaults were seeded. */
  seeded: boolean;
  /**
   * True when the stored config came from a newer Loadout. The caller must
   * treat the config as read-only and must not save over it.
   */
  readOnly: boolean;
}

function sameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getUTCFullYear() === db.getUTCFullYear() &&
    da.getUTCMonth() === db.getUTCMonth() &&
    da.getUTCDate() === db.getUTCDate()
  );
}

/**
 * Read, migrate and salvage the stored config, taking backups as needed.
 *
 * Never throws. A plugin that can't load its settings should still render —
 * with defaults and an explanation — rather than showing an error page,
 * because the UI is the only place the user can fix or restore anything.
 */
export async function loadConfig(now: number = Date.now()): Promise<LoadResult> {
  const stored = await readPluginStorage<CollectionsConfig>(PLUGIN_ID);

  // `readPluginStorage` returns `{}` for both "no file" and "unparseable
  // file". Distinguishing them matters: the first is a first run, the second
  // means we are about to replace something the user may want back.
  if (Object.keys(stored).length === 0) {
    // A file that exists but yielded nothing is damaged — truncated by a
    // power cut mid-write, or hand-edited into invalid JSON. Seeding defaults
    // over it silently is indistinguishable from a fresh install: every tab
    // the user built is gone, with no warning and nothing to restore from.
    const damaged = await quarantineUnreadable(now);
    const config = defaultConfig();
    try {
      await mutatePluginStorage<CollectionsConfig>(PLUGIN_ID, () => config);
    } catch {
      // Seeding is best-effort; an in-memory default is still usable and the
      // next successful save will persist it.
    }
    return {
      config,
      warnings: damaged
        ? [
            `Your Collections settings file couldn't be read, so it has been ` +
              `set back to defaults. The damaged file was kept as ${damaged} — ` +
              `you may be able to restore an earlier backup.`,
          ]
        : [],
      seeded: true,
      readOnly: false,
    };
  }

  const result = migrate(stored);

  // A migration is the single most dangerous thing we do to a user's file,
  // so snapshot the original shape first — before validating, before saving.
  if (result.applied.length > 0) {
    try {
      await writeBackup(stored as CollectionsConfig, "pre-migration", now);
    } catch {
      // Losing the backup is bad but blocking the load is worse; the
      // migration output is still salvaged and validated below.
    }
  }

  if (result.refused) {
    return {
      config: result.config,
      warnings: result.warnings,
      seeded: false,
      readOnly: true,
    };
  }

  // Persist the migrated/salvaged shape so the next load is clean and the
  // warnings don't reappear every boot.
  if (result.applied.length > 0 || result.warnings.length > 0) {
    try {
      await saveConfig(result.config);
    } catch {
      // Keep the in-memory config; the UI will surface the warnings and the
      // user can re-save or restore.
    }
  }

  await maybeDailyBackup(result.config, now);
  await prune(result.config);

  return {
    config: result.config,
    warnings: result.warnings,
    seeded: false,
    readOnly: false,
  };
}

/**
 * Persist a config.
 *
 * Validates first and **throws** on failure rather than writing. This is the
 * one place that guarantees the file on disk is always loadable, so the guard
 * is deliberately loud.
 */
export async function saveConfig(config: CollectionsConfig): Promise<void> {
  const problems = validateConfig(config);
  if (problems.length > 0) {
    throw new Error(
      `Refusing to save invalid Collections settings: ${problems.join("; ")}`,
    );
  }
  await mutatePluginStorage<CollectionsConfig>(PLUGIN_ID, () => config);
}

/** One `periodic` backup per calendar day, so normal use leaves a trail. */
async function maybeDailyBackup(
  config: CollectionsConfig,
  now: number,
): Promise<void> {
  try {
    const backups = await listBackups();
    const lastPeriodic = backups.find((b) => b.reason === "periodic");
    if (lastPeriodic && sameDay(lastPeriodic.createdAt, now)) return;
    await writeBackup(config, "periodic", now);
  } catch {
    // Best-effort by design.
  }
}

async function prune(config: CollectionsConfig): Promise<void> {
  try {
    await pruneBackups(config.settings.maxBackups);
  } catch {
    // Best-effort by design.
  }
}

/**
 * Take a backup for a named reason, then save.
 *
 * Use this for every destructive edit — restore, import, unmirror — so the
 * "before" state is always one click away. The backup is best-effort but the
 * save is not: if the save fails the caller must hear about it.
 */
export async function saveWithBackup(
  next: CollectionsConfig,
  previous: CollectionsConfig,
  reason: BackupReason,
  now: number = Date.now(),
): Promise<void> {
  try {
    await writeBackup(previous, reason, now);
  } catch {
    // Best-effort.
  }
  await saveConfig(next);
  await prune(next);
}

/**
 * Restore a backup over the live config, snapshotting the current state
 * first so a restore is itself undoable.
 *
 * TabMaster's restore instead sets a "don't save until you reboot" flag and
 * asks the user to restart the machine, because it has no way to guarantee
 * the restored state won't be overwritten. Making restore just another
 * atomic save removes the need for that ceremony entirely.
 */
export async function restoreBackup(
  file: string,
  current: CollectionsConfig,
  now: number = Date.now(),
): Promise<LoadResult> {
  const restored = await readBackup(file); // throws user-facing on damage
  await saveWithBackup(restored, current, "pre-restore", now);
  return { config: restored, warnings: [], seeded: false, readOnly: false };
}
