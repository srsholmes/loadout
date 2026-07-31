import { afterEach, describe, expect, it } from "bun:test";
import { MIGRATIONS, migrate } from "./migrations";
import {
  COLLECTIONS_SCHEMA_VERSION,
  defaultConfig,
  validateConfig,
} from "./config";

/** Restore the real (empty) map after any test that installs a fake. */
const ORIGINAL_KEYS = Object.keys(MIGRATIONS);
afterEach(() => {
  for (const key of Object.keys(MIGRATIONS)) {
    if (!ORIGINAL_KEYS.includes(key)) delete MIGRATIONS[Number(key)];
  }
});

describe("migrate — v1 baseline", () => {
  it("ships with no migrations, since v1 is the first schema", () => {
    expect(Object.keys(MIGRATIONS)).toEqual([]);
  });

  it("is a no-op on a current config", () => {
    const config = defaultConfig();
    const result = migrate(config);
    expect(result.applied).toEqual([]);
    expect(result.fromVersion).toBe(COLLECTIONS_SCHEMA_VERSION);
    expect(result.refused).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.config.collections.map((t) => t.id)).toEqual(config.collections.map((t) => t.id));
  });

  it("always returns something that validates", () => {
    for (const input of [null, {}, "junk", defaultConfig(), { schemaVersion: 1 }]) {
      expect(validateConfig(migrate(input).config)).toEqual([]);
    }
  });
});

describe("migrate — unreadable and unversioned input", () => {
  it("falls back to defaults for a non-object, and says so", () => {
    const result = migrate("not a config");
    expect(result.fromVersion).toBe(0);
    expect(result.warnings[0]).toContain("unreadable");
    expect(result.config.collections).toHaveLength(defaultConfig().collections.length);
  });

  it("treats a missing version as the earliest format, and warns", () => {
    const { schemaVersion: _drop, ...noVersion } = defaultConfig();
    const result = migrate(noVersion);
    expect(result.fromVersion).toBe(0);
    expect(result.warnings.some((w) => /no version/i.test(w))).toBe(true);
    expect(result.refused).toBe(false);
  });

  it("stamps the current version onto the output", () => {
    const { schemaVersion: _drop, ...noVersion } = defaultConfig();
    expect(migrate(noVersion).config.schemaVersion).toBe(COLLECTIONS_SCHEMA_VERSION);
  });
});

describe("migrate — a config from the future", () => {
  const future = { ...defaultConfig(), schemaVersion: COLLECTIONS_SCHEMA_VERSION + 3 };

  it("refuses rather than coercing", () => {
    // Silently stripping fields a newer build wrote is how a downgrade eats
    // your tabs. TabMaster does exactly that: removeUnknownTypes deletes
    // filters it doesn't recognise.
    const result = migrate(future);
    expect(result.refused).toBe(true);
    expect(result.applied).toEqual([]);
  });

  it("explains the situation in terms the user can act on", () => {
    const result = migrate(future);
    expect(result.warnings[0]).toContain("newer version of Loadout");
    expect(result.warnings[0]).toContain("will not be overwritten");
    expect(result.warnings[0]).toContain("update Loadout");
  });

  it("still returns a usable config so the plugin renders read-only", () => {
    const result = migrate(future);
    expect(Array.isArray(result.config.collections)).toBe(true);
    // It deliberately keeps the future schemaVersion — the config genuinely
    // came from a newer build and we must not pretend otherwise — so the
    // only thing `validateConfig` should object to is the version itself.
    const problems = validateConfig(result.config);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("newer version of Loadout");
  });

  it("keeps the future version, so a later write can't silently downgrade it", () => {
    expect(migrate(future).config.schemaVersion).toBe(future.schemaVersion);
  });
});

describe("migrate — the chain", () => {
  it("runs a migration below the current version, and records it", () => {
    // What the old test claimed to check — ascending order — cannot be
    // exercised while `COLLECTIONS_SCHEMA_VERSION` is 1, because only
    // version 0 is below it and one migration has no order. It installed
    // MIGRATIONS[1..3], ran nothing, and asserted `[]`, so deleting the sort
    // (or the loop) broke nothing. This asserts what the loop can actually
    // do today; add the ordering case with the second real migration.
    const order: number[] = [];
    MIGRATIONS[0] = (raw) => {
      order.push(0);
      return raw;
    };

    const result = migrate({ ...defaultConfig(), schemaVersion: 0 });
    expect(order).toEqual([0]);
    expect(result.applied).toEqual([0]);
  });

  it("does not run a migration at or above the current version", () => {
    // A migration numbered for the *current* schema describes a step this
    // build has already taken; running it would apply it twice.
    let ran = false;
    MIGRATIONS[COLLECTIONS_SCHEMA_VERSION] = (raw) => {
      ran = true;
      return raw;
    };

    const result = migrate({ ...defaultConfig(), schemaVersion: 0 });
    expect(ran).toBe(false);
    expect(result.applied).not.toContain(COLLECTIONS_SCHEMA_VERSION);
  });

  it("skips migrations older than the file's own version", () => {
    let ran = false;
    MIGRATIONS[0] = (raw) => {
      ran = true;
      return raw;
    };
    migrate({ ...defaultConfig(), schemaVersion: COLLECTIONS_SCHEMA_VERSION });
    expect(ran).toBe(false);
  });

  it("threads warnings out of a migration instead of throwing", () => {
    // A migration that hits a recoverable problem must report it, not abort
    // the load and take the user's tabs with it.
    MIGRATIONS[0] = (raw, warnings) => {
      warnings.push("Renamed a legacy filter");
      return raw;
    };
    const { schemaVersion: _drop, ...v0 } = defaultConfig();
    const result = migrate(v0);
    expect(result.applied).toEqual([0]);
    expect(result.warnings).toContain("Renamed a legacy filter");
  });

  it("passes each migration the previous one's output", () => {
    MIGRATIONS[0] = (raw) => ({ ...raw, collectionOrder: ["from-migration"] });
    const { schemaVersion: _drop, ...v0 } = defaultConfig();
    expect(migrate(v0).config.collectionOrder).toEqual([]);
  });

  it("salvages a migration's output rather than trusting it blindly", () => {
    // A buggy migration must not be able to persist an invalid config.
    MIGRATIONS[0] = (raw) => ({ ...raw, collections: [{ nonsense: true }] });
    const { schemaVersion: _drop, ...v0 } = defaultConfig();
    const result = migrate(v0);
    expect(validateConfig(result.config)).toEqual([]);
    expect(result.warnings.some((w) => /malformed/i.test(w))).toBe(true);
  });
});
