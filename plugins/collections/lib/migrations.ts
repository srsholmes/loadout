/**
 * Schema migrations for the persisted config.
 *
 * Shipped at v1 with an **empty** migration map, on purpose. The machinery
 * is exercised by specs from the first release, so when v2 arrives it is a
 * data change rather than a scramble to invent a migration system while
 * users' tabs are already broken.
 *
 * The contract:
 * - `MIGRATIONS` is keyed by the version being migrated **from**. An entry
 *   under `1` upgrades a v1 file to v2.
 * - Migrations run in ascending order, each on the previous one's output, so
 *   a v1 file reaches v4 through 1→2→3→4 without anyone writing 1→4.
 * - A migration receives and returns a plain object. It must not throw for
 *   recoverable problems — push a sentence onto `warnings` instead. Throwing
 *   aborts the load and takes the user's tabs with it.
 * - A file from the *future* is refused rather than coerced. Silently
 *   dropping fields a newer build wrote is how you lose data on a downgrade;
 *   TabMaster does exactly that (its `removeUnknownTypes` deletes filters it
 *   doesn't recognise, so downgrading silently strips newer rules).
 *
 * Isomorphic: pure, no I/O.
 */

import type { CollectionsConfig } from "./config";
import {
  COLLECTIONS_SCHEMA_VERSION,
  coerceConfig,
  defaultConfig,
} from "./config";

export type Migration = (
  raw: Record<string, unknown>,
  warnings: string[],
) => Record<string, unknown>;

/**
 * Keyed by the version being migrated FROM.
 *
 * Empty at v1. When adding one, also add a spec asserting that a realistic
 * old-shape fixture survives it — not just that it runs.
 */
export const MIGRATIONS: Record<number, Migration> = {};

export interface MigrateResult {
  config: CollectionsConfig;
  /** Version detected in the input. */
  fromVersion: number;
  /** Versions whose migrations actually ran, in order. */
  applied: number[];
  /** Recoverable problems, for the UI. Never thrown. */
  warnings: string[];
  /**
   * True when the file was written by a newer build and we refused it.
   * The caller must NOT overwrite the file in this case — the user may
   * simply be booting an older Loadout by accident.
   */
  refused: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Bring a raw parsed config up to the current schema.
 *
 * Always returns a usable config. Callers check `refused` before writing
 * anything back, and surface `warnings` either way.
 */
export function migrate(raw: unknown): MigrateResult {
  const warnings: string[] = [];

  if (!isRecord(raw)) {
    return {
      config: defaultConfig(),
      fromVersion: 0,
      applied: [],
      warnings: ["The settings file was unreadable; starting from defaults"],
      refused: false,
    };
  }

  const fromVersion =
    typeof raw.schemaVersion === "number" && Number.isFinite(raw.schemaVersion)
      ? raw.schemaVersion
      : 0;

  if (fromVersion > COLLECTIONS_SCHEMA_VERSION) {
    // Refuse, don't coerce. Downgrading and silently stripping unknown fields
    // is how a user loses collections they can still see in a newer build.
    //
    // The future `schemaVersion` is put back deliberately: `coerceConfig`
    // stamps the current one, and keeping that would let a later write
    // silently downgrade the file it just refused to touch.
    const salvaged = coerceConfig(raw);
    return {
      config: { ...salvaged.config, schemaVersion: fromVersion },
      fromVersion,
      applied: [],
      warnings: [
        `These settings were written by a newer version of Loadout ` +
          `(schema ${fromVersion}, this build understands ` +
          `${COLLECTIONS_SCHEMA_VERSION}). They are shown read-only and ` +
          `will not be overwritten — update Loadout to edit them.`,
        ...salvaged.dropped,
      ],
      refused: true,
    };
  }

  if (fromVersion === 0) {
    warnings.push("The settings file had no version; treating it as the earliest format");
  }

  let current = raw;
  const applied: number[] = [];
  // Ascending, so a chain of migrations composes without anyone writing a
  // 1->4 shortcut that drifts out of sync with 1->2->3->4.
  for (const version of Object.keys(MIGRATIONS)
    .map(Number)
    .sort((a, b) => a - b)) {
    if (version < fromVersion) continue;
    if (version >= COLLECTIONS_SCHEMA_VERSION) break;
    current = MIGRATIONS[version]!(current, warnings);
    applied.push(version);
  }

  const salvaged = coerceConfig({
    ...current,
    schemaVersion: COLLECTIONS_SCHEMA_VERSION,
  });

  return {
    config: salvaged.config,
    fromVersion,
    applied,
    warnings: [...warnings, ...salvaged.dropped],
    refused: false,
  };
}
