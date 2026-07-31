import { describe, expect, it } from "bun:test";
import {
  COLLECTIONS_SCHEMA_VERSION,
  coerceConfig,
  defaultConfig,
  orderedCollections,
  uniqueCollectionId,
  validateConfig,
  type CollectionsConfig,
  type ManagedCollection,
} from "./config";

function managed(over: Partial<ManagedCollection> = {}): ManagedCollection {
  return {
    id: "backlog",
    label: "Backlog",
    root: { kind: "group", id: "g", combinator: "all", children: [] },
    sort: [],
    limit: null,
    display: { tileWidth: 150, showLabels: true, badges: [] },
    indeterminatePolicy: "pass",
    ...over,
  } as ManagedCollection;
}

function configWith(collections: ManagedCollection[]): CollectionsConfig {
  return {
    ...defaultConfig(),
    collections,
    collectionOrder: collections.map((c) => c.id),
  };
}

describe("defaultConfig", () => {
  it("starts with no collections at all", () => {
    // Deliberate. The five old built-ins were Steam's own library filters,
    // which Steam already provides — recreating them put a second "All" beside
    // Steam's. The grid is not empty in practice: it lists what Steam has.
    const c = defaultConfig();
    expect(c.collections).toEqual([]);
    expect(c.collectionOrder).toEqual([]);
    expect(c.mirror.ledger.entries).toEqual([]);
  });

  it("validates", () => {
    expect(validateConfig(defaultConfig())).toEqual([]);
  });

  it("does not sync until asked", () => {
    // Writing to someone's Steam library on first launch, before they have
    // made a single collection, would be a genuinely bad surprise.
    expect(defaultConfig().mirror.autoSync).toBe(false);
  });
});

describe("validateConfig", () => {
  it("accepts a well-formed config", () => {
    expect(validateConfig(configWith([managed()]))).toEqual([]);
  });

  it("rejects a file from a newer build rather than coercing it", () => {
    const problems = validateConfig({
      ...defaultConfig(),
      schemaVersion: COLLECTIONS_SCHEMA_VERSION + 1,
    });
    expect(problems.join(" ")).toMatch(/newer version of Loadout/);
  });

  it("names a duplicate id, which breaks the ledger as well as React", () => {
    const problems = validateConfig(configWith([managed(), managed({ label: "Other" })]));
    expect(problems.join(" ")).toMatch(/share the id "backlog"/);
  });

  it("catches a malformed rule tree", () => {
    const problems = validateConfig(
      configWith([managed({ root: { kind: "group", id: "g" } as never })]),
    );
    expect(problems.join(" ")).toMatch(/children must be a list/);
  });

  it("catches a rule tree nested absurdly deep", () => {
    let root: unknown = { kind: "installed", id: "leaf" };
    for (let i = 0; i < 12; i++) {
      root = { kind: "group", id: `g${i}`, combinator: "all", children: [root] };
    }
    const problems = validateConfig(configWith([managed({ root: root as never })]));
    expect(problems.join(" ")).toMatch(/nested too deeply/);
  });
});

describe("coerceConfig — salvage", () => {
  it("keeps the good collections and reports the bad one", () => {
    // One malformed collection must not cost the user the other nineteen.
    const { config, dropped } = coerceConfig({
      ...defaultConfig(),
      collections: [managed(), { id: "broken" }, managed({ id: "b", label: "B" })],
      collectionOrder: ["backlog", "broken", "b"],
    });
    expect(config.collections.map((c) => c.id)).toEqual(["backlog", "b"]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatch(/could not be loaded/);
  });

  it("drops a duplicate id rather than letting two collections claim one", () => {
    const { config, dropped } = coerceConfig({
      ...defaultConfig(),
      collections: [managed(), managed({ label: "Second" })],
    });
    expect(config.collections).toHaveLength(1);
    expect(dropped[0]).toMatch(/reused an existing id/);
  });

  it("returns defaults for something that isn't a config at all", () => {
    const { config, dropped } = coerceConfig("nonsense");
    expect(config.collections).toEqual([]);
    expect(dropped).toHaveLength(1);
  });

  it("appends collections missing from the order, and drops unknown ids", () => {
    const { config } = coerceConfig({
      ...defaultConfig(),
      collections: [managed(), managed({ id: "b", label: "B" })],
      collectionOrder: ["ghost", "b"],
    });
    expect(config.collectionOrder).toEqual(["b", "backlog"]);
  });

  it("keeps a well-formed ledger row", () => {
    const entry = {
      managedId: "backlog",
      steamCollectionId: "uc-1",
      steamName: "Backlog",
      appIds: ["10"],
      lastSyncedAt: 1,
    };
    const { config, dropped } = coerceConfig({
      ...defaultConfig(),
      collections: [managed()],
      mirror: { autoSync: true, pendingSync: false, ledger: { version: 1, entries: [entry] } },
    });
    expect(config.mirror.ledger.entries).toEqual([entry]);
    expect(dropped).toEqual([]);
  });

  it("warns loudly when a ledger row is malformed", () => {
    // Losing a row orphans a real Steam collection: nothing records that it is
    // ours, so it can never be updated or cleaned up again.
    const { config, dropped } = coerceConfig({
      ...defaultConfig(),
      mirror: {
        autoSync: false,
        pendingSync: false,
        ledger: { version: 1, entries: [{ managedId: "x" }] },
      },
    });
    expect(config.mirror.ledger.entries).toEqual([]);
    expect(dropped.join(" ")).toMatch(/no longer be updated/);
  });
});

describe("orderedCollections", () => {
  it("follows the explicit order", () => {
    const a = managed({ id: "a", label: "A" });
    const b = managed({ id: "b", label: "B" });
    const config = { ...configWith([a, b]), collectionOrder: ["b", "a"] };
    expect(orderedCollections(config).map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("appends anything the order forgot, so a collection can never vanish", () => {
    const a = managed({ id: "a", label: "A" });
    const b = managed({ id: "b", label: "B" });
    const config = { ...configWith([a, b]), collectionOrder: ["b"] };
    expect(orderedCollections(config).map((c) => c.id)).toEqual(["b", "a"]);
  });
});

describe("uniqueCollectionId", () => {
  it("returns the base when it is free", () => {
    expect(uniqueCollectionId(defaultConfig(), "backlog")).toBe("backlog");
  });

  it("suffixes until it finds a gap", () => {
    const config = configWith([managed(), managed({ id: "backlog-2", label: "B2" })]);
    expect(uniqueCollectionId(config, "backlog")).toBe("backlog-3");
  });
});
