import { describe, expect, it } from "bun:test";
import {
  applyToLedger,
  collectionNameFor,
  mirrorAffecting,
  planIsEmpty,
  planMirror,
  summarizePlan,
} from "./mirror";
import type { SteamCollection } from "./mirror";
import type { ManagedCollection, MirrorLedger } from "./types";

const NOW = 1_800_000_000_000;

function managed(overrides: Partial<ManagedCollection> = {}): ManagedCollection {
  return {
    id: "t1",
    label: "Backlog",
    // A rule by default: a collection with none matches the whole library and
    // is deliberately never mirrored, so an empty root here would silently
    // skip every case below.
    root: {
      kind: "group",
      id: "g",
      combinator: "all",
      children: [{ id: "r1", kind: "installed" }],
    },
    sort: [],
    limit: null,
    display: { tileWidth: 150, showLabels: true, badges: [] },
    indeterminatePolicy: "pass",
    ...overrides,
  } as ManagedCollection;
}

function collection(overrides: Partial<SteamCollection> = {}): SteamCollection {
  return {
    id: "uc-1",
    name: "Backlog",
    appIds: [],
    isDynamic: false,
    isEditable: true,
    ...overrides,
  };
}

function ledger(...entries: MirrorLedger["entries"]): MirrorLedger {
  return { version: 1, entries };
}

function entry(overrides: Partial<MirrorLedger["entries"][number]> = {}) {
  return {
    managedId: "t1",
    steamCollectionId: "uc-1",
    steamName: "Backlog",
    appIds: [] as string[],
    lastSyncedAt: NOW - 1000,
    ...overrides,
  };
}

function evaluated(pairs: Record<string, string[]>): Map<string, string[]> {
  return new Map(Object.entries(pairs));
}

describe("planMirror — first sync", () => {
  it("creates a collection for a tab that has never been mirrored", () => {
    const plan = planMirror({
      collections: [managed()],
      evaluated: evaluated({ t1: ["10", "20"] }),
      ledger: ledger(),
      steamCollections: [],
    });
    expect(plan.creates).toEqual([{ managedId: "t1", name: "Backlog", appIds: ["10", "20"] }]);
    expect(plan.updates).toHaveLength(0);
  });


  it("creates an empty collection rather than skipping a tab that matched nothing", () => {
    // Skipping would leave the user staring at a tab marked "mirrored" with no
    // collection in Steam, and no way to tell whether sync ran.
    const plan = planMirror({
      collections: [managed()],
      evaluated: evaluated({}),
      ledger: ledger(),
      steamCollections: [],
    });
    expect(plan.creates).toEqual([{ managedId: "t1", name: "Backlog", appIds: [] }]);
  });

  it("refuses to adopt a same-named collection it did not create", () => {
    // The destructive case. A user's hand-curated "Backlog" must not be
    // silently replaced by whatever our rules happen to match.
    const existing = collection({ id: "uc-99", name: "Backlog", appIds: ["1", "2", "3"] });
    const plan = planMirror({
      collections: [managed()],
      evaluated: evaluated({ t1: ["10"] }),
      ledger: ledger(),
      steamCollections: [existing],
    });
    expect(plan.creates).toHaveLength(0);
    expect(plan.updates).toHaveLength(0);
    expect(plan.conflicts).toEqual([
      { managedId: "t1", name: "Backlog", existingCollectionId: "uc-99", existingCount: 3 },
    ]);
  });
});

describe("planMirror — a collection with no rules", () => {
  const empty = () =>
    managed({ root: { kind: "group", id: "g", combinator: "all", children: [] } });

  it("is never created in Steam, whatever it matches", () => {
    // An empty rule tree matches the whole library. Measured on a real device:
    // three of these had been created by accident and auto-synced, putting
    // three 2500-app collections into Steam.
    const plan = planMirror({
      collections: [empty()],
      evaluated: new Map([["t1", ["1", "2", "3"]]]),
      ledger: ledger(),
      steamCollections: [],
    });
    expect(plan.creates).toEqual([]);
    expect(plan.skipped[0]?.managedId).toBe("t1");
    expect(plan.skipped[0]?.reason).toMatch(/whole library/);
  });

  it("leaves one already in Steam exactly as it is", () => {
    // Skipped rather than deleted: removing the last rule from something you
    // already mirrored must not silently destroy it.
    const plan = planMirror({
      collections: [empty()],
      evaluated: new Map([["t1", ["1", "2"]]]),
      ledger: ledger(entry({ appIds: ["1"] })),
      steamCollections: [collection({ appIds: ["1"] })],
    });
    expect(plan.updates).toEqual([]);
    expect(plan.deletes).toEqual([]);
    expect(plan.renames).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
  });

  it("still deletes it when the collection itself is removed", () => {
    // The escape hatch: deleting it here is how it leaves Steam.
    const plan = planMirror({
      collections: [],
      evaluated: new Map(),
      ledger: ledger(entry({ appIds: ["1"] })),
      steamCollections: [collection({ appIds: ["1"] })],
    });
    expect(plan.deletes).toHaveLength(1);
  });

  it("does not hold the name against a real collection", () => {
    // A skipped collection creates nothing, so its name is still free.
    const plan = planMirror({
      collections: [empty(), managed({ id: "t2", label: "Backlog" })],
      evaluated: new Map([["t2", ["1"]]]),
      ledger: ledger(),
      steamCollections: [],
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0]?.managedId).toBe("t2");
  });
});

describe("planMirror — steady state", () => {
  it("does nothing when the collection already matches", () => {
    const plan = planMirror({
      collections: [managed()],
      evaluated: evaluated({ t1: ["10", "20"] }),
      ledger: ledger(entry({ appIds: ["10", "20"] })),
      steamCollections: [collection({ appIds: ["10", "20"] })],
    });
    expect(planIsEmpty(plan)).toBe(true);
    expect(plan.noops).toEqual(["t1"]);
  });

  it("treats membership as a set, not a sequence", () => {
    // Steam does not preserve our insertion order; a reordered collection is
    // not a change and must not cause a write every single sync.
    const plan = planMirror({
      collections: [managed()],
      evaluated: evaluated({ t1: ["10", "20", "30"] }),
      ledger: ledger(entry({ appIds: ["30", "10", "20"] })),
      steamCollections: [collection({ appIds: ["20", "30", "10"] })],
    });
    expect(planIsEmpty(plan)).toBe(true);
  });

  it("computes the minimal add/remove for a changed rule", () => {
    const plan = planMirror({
      collections: [managed()],
      evaluated: evaluated({ t1: ["10", "30"] }),
      ledger: ledger(entry({ appIds: ["10", "20"] })),
      steamCollections: [collection({ appIds: ["10", "20"] })],
    });
    expect(plan.updates).toEqual([
      {
        managedId: "t1",
        steamCollectionId: "uc-1",
        name: "Backlog",
        appIds: ["10", "30"],
        add: ["30"],
        remove: ["20"],
      },
    ]);
  });
});

describe("planMirror — renames", () => {
  it("renames the collection when the tab is renamed", () => {
    const plan = planMirror({
      collections: [managed({ label: "Shelf" })],
      evaluated: evaluated({ t1: ["10"] }),
      ledger: ledger(entry({ appIds: ["10"] })),
      steamCollections: [collection({ name: "Backlog", appIds: ["10"] })],
    });
    expect(plan.renames).toEqual([
      { managedId: "t1", steamCollectionId: "uc-1", from: "Backlog", to: "Shelf" },
    ]);
    // A rename is not a re-create — the collection keeps its id and contents.
    expect(plan.creates).toHaveLength(0);
    expect(plan.noops).toHaveLength(0);
  });


  it("applies the configured prefix", () => {
    const plan = planMirror({
      collections: [managed()],
      evaluated: evaluated({ t1: [] }),
      ledger: ledger(),
      steamCollections: [],
      namePrefix: "▸ ",
    });
    expect(plan.creates[0]?.name).toBe("▸ Backlog");
  });

  it("lets a new tab claim a name this same sync is renaming away from", () => {
    // ManagedCollection `a` moves from "Backlog" to "Shelf"; new tab `b` wants "Backlog".
    // Reported as a conflict, this never resolves — the name is only ever
    // freed by the rename that the conflict is blocking.
    const plan = planMirror({
      collections: [
        managed({ id: "a", label: "Shelf" }),
        managed({ id: "b", label: "Backlog" }),
      ],
      evaluated: evaluated({ a: ["1"], b: ["2"] }),
      ledger: ledger(
        entry({ managedId: "a", steamCollectionId: "uc-a", steamName: "Backlog", appIds: ["1"] }),
      ),
      steamCollections: [collection({ id: "uc-a", name: "Backlog", appIds: ["1"] })],
    });
    expect(plan.conflicts).toHaveLength(0);
    expect(plan.renames).toHaveLength(1);
    expect(plan.creates).toEqual([{ managedId: "b", name: "Backlog", appIds: ["2"] }]);
  });

  it("lets a new tab claim a name this same sync is deleting", () => {
    const plan = planMirror({
      collections: [managed({ id: "b", label: "Backlog" })],
      evaluated: evaluated({ b: ["2"] }),
      ledger: ledger(entry({ managedId: "gone", steamCollectionId: "uc-a", steamName: "Backlog" })),
      steamCollections: [collection({ id: "uc-a", name: "Backlog" })],
    });
    expect(plan.conflicts).toHaveLength(0);
    expect(plan.deletes).toHaveLength(1);
    expect(plan.creates).toHaveLength(1);
  });

  it("reports two new tabs asking for the same name as a conflict", () => {
    // Not a free pass for whichever is second — that would create two
    // identically-named collections and the ledger could never tell them apart.
    const plan = planMirror({
      collections: [
        managed({ id: "a", label: "Same" }),
        managed({ id: "b", label: "Same" }),
      ],
      evaluated: evaluated({ a: ["1"], b: ["2"] }),
      ledger: ledger(),
      steamCollections: [],
    });
    expect(plan.creates.map((c) => c.managedId)).toEqual(["a"]);
    expect(plan.conflicts.map((c) => c.managedId)).toEqual(["b"]);
  });

  it("checks the conflict against the prefixed name", () => {
    // Prefixing exists precisely so our collections don't collide with the
    // user's; checking the unprefixed name would report phantom conflicts.
    const plan = planMirror({
      collections: [managed()],
      evaluated: evaluated({ t1: [] }),
      ledger: ledger(),
      steamCollections: [collection({ id: "uc-9", name: "Backlog" })],
      namePrefix: "▸ ",
    });
    expect(plan.conflicts).toHaveLength(0);
    expect(plan.creates).toHaveLength(1);
  });
});

describe("planMirror — deletion", () => {
  it("deletes the collection when ours is gone", () => {
    const plan = planMirror({
      collections: [],
      evaluated: evaluated({}),
      ledger: ledger(entry({ appIds: ["10"] })),
      steamCollections: [collection({ appIds: ["10"] })],
    });
    expect(plan.deletes).toEqual([
      { managedId: "t1", steamCollectionId: "uc-1", name: "Backlog", reason: "collection-deleted" },
    ]);
  });


  it("never deletes a collection whose id we did not record", () => {
    // The single most dangerous operation in the plugin. If the ledger and
    // Steam disagree, doing nothing is always correct.
    const plan = planMirror({
      collections: [],
      evaluated: evaluated({}),
      ledger: ledger(entry({ steamCollectionId: "uc-gone" })),
      steamCollections: [collection({ id: "uc-other", name: "Backlog", appIds: ["1"] })],
    });
    expect(plan.deletes).toHaveLength(0);
  });

  it("only ever names ids, never names, in a delete", () => {
    // Regression guard for the whole "match by name" family of bugs: two
    // collections share a name, and the id is what disambiguates them.
    const plan = planMirror({
      collections: [],
      evaluated: evaluated({}),
      ledger: ledger(entry({ steamCollectionId: "uc-1" })),
      steamCollections: [
        collection({ id: "uc-1", name: "Backlog" }),
        collection({ id: "uc-2", name: "Backlog" }),
      ],
    });
    expect(plan.deletes.map((d) => d.steamCollectionId)).toEqual(["uc-1"]);
  });
});

describe("planMirror — the world changed underneath us", () => {
  it("re-creates when Steam no longer has the collection", () => {
    const plan = planMirror({
      collections: [managed()],
      evaluated: evaluated({ t1: ["10"] }),
      ledger: ledger(entry({ steamCollectionId: "uc-vanished", appIds: ["10"] })),
      steamCollections: [],
    });
    expect(plan.orphaned).toEqual([{ managedId: "t1", steamCollectionId: "uc-vanished" }]);
    expect(plan.creates).toEqual([{ managedId: "t1", name: "Backlog", appIds: ["10"] }]);
  });

  it("reports apps the user added to our collection by hand", () => {
    const plan = planMirror({
      collections: [managed()],
      evaluated: evaluated({ t1: ["10"] }),
      ledger: ledger(entry({ appIds: ["10"] })),
      steamCollections: [collection({ appIds: ["10", "99"] })],
    });
    expect(plan.drifted).toEqual([
      { managedId: "t1", steamCollectionId: "uc-1", unexpectedAdds: ["99"], unexpectedRemoves: [] },
    ]);
    // Drift is reported, not tolerated: the sync still converges on the rules.
    expect(plan.updates[0]?.remove).toEqual(["99"]);
  });

  it("reports apps the user removed from our collection by hand", () => {
    const plan = planMirror({
      collections: [managed()],
      evaluated: evaluated({ t1: ["10", "20"] }),
      ledger: ledger(entry({ appIds: ["10", "20"] })),
      steamCollections: [collection({ appIds: ["10"] })],
    });
    expect(plan.drifted[0]?.unexpectedRemoves).toEqual(["20"]);
  });

  it("does not call a rule change drift", () => {
    // Drift compares against what WE last wrote. Comparing against what the
    // tab now matches would flag every rule edit as user interference and
    // bury the real signal.
    const plan = planMirror({
      collections: [managed()],
      evaluated: evaluated({ t1: ["10", "20", "30"] }),
      ledger: ledger(entry({ appIds: ["10"] })),
      steamCollections: [collection({ appIds: ["10"] })],
    });
    expect(plan.drifted).toHaveLength(0);
    expect(plan.updates[0]?.add).toEqual(["20", "30"]);
  });

  it("refuses to write to a dynamic Steam collection", () => {
    const plan = planMirror({
      collections: [managed()],
      evaluated: evaluated({ t1: ["10"] }),
      ledger: ledger(entry({ steamCollectionId: "type-games" })),
      steamCollections: [
        collection({ id: "type-games", name: "Backlog", isDynamic: true, appIds: ["1", "2"] }),
      ],
    });
    expect(planIsEmpty(plan)).toBe(true);
    expect(plan.skipped[0]?.managedId).toBe("t1");
    expect(plan.skipped[0]?.reason).toMatch(/dynamic/);
  });

  it("refuses to write to a non-editable collection", () => {
    const plan = planMirror({
      collections: [managed()],
      evaluated: evaluated({ t1: ["10"] }),
      ledger: ledger(entry()),
      steamCollections: [collection({ isEditable: false })],
    });
    expect(planIsEmpty(plan)).toBe(true);
    expect(plan.skipped).toHaveLength(1);
  });
});

describe("planMirror — several tabs at once", () => {
  it("plans each tab independently", () => {
    const plan = planMirror({
      collections: [
        managed({ id: "a", label: "A" }),
        managed({ id: "b", label: "B" }),
      ],
      evaluated: evaluated({ a: ["1"], b: ["2", "3"], c: ["4"] }),
      ledger: ledger(entry({ managedId: "b", steamCollectionId: "uc-b", steamName: "B", appIds: ["2"] })),
      steamCollections: [collection({ id: "uc-b", name: "B", appIds: ["2"] })],
    });
    expect(plan.creates.map((c) => c.managedId)).toEqual(["a"]);
    expect(plan.updates.map((u) => u.managedId)).toEqual(["b"]);
    expect(plan.deletes).toHaveLength(0);
  });

  it("lets two tabs mirror overlapping games", () => {
    // Collections are not partitions — the same game legitimately belongs to
    // "Deck Verified" and "Backlog" at once.
    const plan = planMirror({
      collections: [
        managed({ id: "a", label: "A" }),
        managed({ id: "b", label: "B" }),
      ],
      evaluated: evaluated({ a: ["1", "2"], b: ["2", "3"] }),
      ledger: ledger(),
      steamCollections: [],
    });
    expect(plan.creates.map((c) => c.appIds)).toEqual([
      ["1", "2"],
      ["2", "3"],
    ]);
  });
});

describe("summarizePlan", () => {
  it("says nothing needs doing when nothing does", () => {
    const plan = planMirror({
      collections: [],
      evaluated: evaluated({}),
      ledger: ledger(),
      steamCollections: [],
    });
    expect(summarizePlan(plan)).toBe("Everything is already in sync");
  });

  it("counts each kind of write", () => {
    const plan = planMirror({
      collections: [
        managed({ id: "a", label: "A" }),
        managed({ id: "b", label: "B2" }),
      ],
      evaluated: evaluated({ a: ["1"], b: ["2"] }),
      ledger: ledger(
        entry({ managedId: "b", steamCollectionId: "uc-b", steamName: "B", appIds: ["2"] }),
        entry({ managedId: "z", steamCollectionId: "uc-z", steamName: "Z" }),
      ),
      steamCollections: [collection({ id: "uc-b", name: "B", appIds: ["2"] }), collection({ id: "uc-z", name: "Z" })],
    });
    expect(summarizePlan(plan)).toBe("Sync will create 1, rename 1, delete 1");
  });
});

describe("applyToLedger", () => {
  it("records a newly created collection", () => {
    const plan = planMirror({
      collections: [managed()],
      evaluated: evaluated({ t1: ["10"] }),
      ledger: ledger(),
      steamCollections: [],
    });
    const next = applyToLedger({
      ledger: ledger(),
      plan,
      written: new Map([["t1", { steamCollectionId: "uc-new", name: "Backlog", appIds: ["10"] }]]),
      now: NOW,
    });
    expect(next.entries).toEqual([
      {
        managedId: "t1",
        steamCollectionId: "uc-new",
        steamName: "Backlog",
        appIds: ["10"],
        lastSyncedAt: NOW,
      },
    ]);
  });

  it("drops entries for collections that were deleted", () => {
    const before = ledger(entry());
    const plan = planMirror({
      collections: [],
      evaluated: evaluated({}),
      ledger: before,
      steamCollections: [collection()],
    });
    const next = applyToLedger({ ledger: before, plan, written: new Map(), now: NOW });
    expect(next.entries).toHaveLength(0);
  });

  it("leaves untouched tabs alone", () => {
    // A partial sync — one collection written, another failing — must not
    // rewrite the timestamp of an entry nothing happened to, or the next
    // drift check compares against the wrong snapshot.
    const before = ledger(
      entry({ managedId: "a", steamCollectionId: "uc-a", appIds: ["1"] }),
      entry({ managedId: "b", steamCollectionId: "uc-b", appIds: ["2"] }),
    );
    const plan = planMirror({
      collections: [managed({ id: "a" }), managed({ id: "b", label: "b".toUpperCase() })],
      evaluated: evaluated({ a: ["1"], b: ["2"] }),
      ledger: before,
      steamCollections: [
        collection({ id: "uc-a", appIds: ["1"] }),
        collection({ id: "uc-b", appIds: ["2"] }),
      ],
    });
    const next = applyToLedger({
      ledger: before,
      plan,
      written: new Map([["a", { steamCollectionId: "uc-a", name: "Backlog", appIds: ["1", "9"] }]]),
      now: NOW,
    });
    expect(next.entries.find((e) => e.managedId === "b")).toEqual(before.entries[1]!);
    expect(next.entries.find((e) => e.managedId === "a")?.appIds).toEqual(["1", "9"]);
  });

  it("re-points an entry when the collection was re-created", () => {
    const before = ledger(entry({ steamCollectionId: "uc-vanished" }));
    const plan = planMirror({
      collections: [managed()],
      evaluated: evaluated({ t1: ["10"] }),
      ledger: before,
      steamCollections: [],
    });
    const next = applyToLedger({
      ledger: before,
      plan,
      written: new Map([["t1", { steamCollectionId: "uc-fresh", name: "Backlog", appIds: ["10"] }]]),
      now: NOW,
    });
    expect(next.entries).toHaveLength(1);
    expect(next.entries[0]!.steamCollectionId).toBe("uc-fresh");
  });
});

describe("planMirror — settling", () => {
  it("reaches a fixed point after one sync", () => {
    // The property that matters most in the field: sync twice with nothing
    // else changing and the second run must be a no-op. Without it, every
    // periodic sync writes to Steam Cloud forever.
    const cols = [managed()];
    const ev = evaluated({ t1: ["10", "20"] });
    const first = planMirror({ collections: cols, evaluated: ev, ledger: ledger(), steamCollections: [] });
    expect(first.creates).toHaveLength(1);

    const afterLedger = applyToLedger({
      ledger: ledger(),
      plan: first,
      written: new Map([["t1", { steamCollectionId: "uc-new", name: "Backlog", appIds: ["10", "20"] }]]),
      now: NOW,
    });
    const afterSteam = [collection({ id: "uc-new", name: "Backlog", appIds: ["20", "10"] })];

    const second = planMirror({
      collections: cols,
      evaluated: ev,
      ledger: afterLedger,
      steamCollections: afterSteam,
    });
    expect(planIsEmpty(second)).toBe(true);
    expect(second.drifted).toHaveLength(0);
    expect(second.noops).toEqual(["t1"]);
  });
});

describe("mirrorAffecting — when auto-sync should fire", () => {
  function config(overrides: Partial<Parameters<typeof mirrorAffecting>[0]> = {}) {
    return {
      collections: [managed()],
      gameOverrides: {},
      settings: { namePrefix: "" },
      mirror: { autoSync: true },
      ...overrides,
    };
  }

  it("fires when a rule changes", () => {
    const after = config({
      collections: [
        managed({
          root: {
            kind: "group",
            id: "g",
            combinator: "all",
            children: [{ kind: "installed", id: "r", value: true }],
          } as ManagedCollection["root"],
        }),
      ],
    });
    expect(mirrorAffecting(config(), after)).toBe(true);
  });

  it("fires when a tab is renamed", () => {
    expect(mirrorAffecting(config(), config({ collections: [managed({ label: "Shelf" })] }))).toBe(true);
  });


  it("fires when a tab is added or removed", () => {
    expect(mirrorAffecting(config(), config({ collections: [] }))).toBe(true);
  });

  it("fires when the cap changes", () => {
    // `limit` decides which games survive, so it changes the collection.
    expect(mirrorAffecting(config(), config({ collections: [managed({ limit: 30 })] }))).toBe(true);
  });

  it("fires when a game override changes", () => {
    // Whitelists and blacklists live here and change membership directly.
    expect(
      mirrorAffecting(config(), config({ gameOverrides: { "440": { hidden: true } } })),
    ).toBe(
      true,
    );
  });

  it("fires when the collection-name prefix changes", () => {
    expect(mirrorAffecting(config(), config({ settings: { namePrefix: "▸ " } }))).toBe(true);
  });

  it("does NOT fire when only the ledger changed", () => {
    // The one that matters: `syncMirror` persists its ledger through the same
    // config setter that triggers auto-sync. Without this the mirror would
    // sync itself in a loop forever.
    expect(mirrorAffecting(config(), config())).toBe(false);
  });

  it("watches every field of a collection that could change its membership", () => {
    // The projection is a whitelist, and its doc comment used to claim the
    // opposite ("a new field is included by default"). A field added to
    // `ManagedCollection` and forgotten here means editing it never marks a
    // sync owed, and Steam goes quietly stale. Fail here rather than there.
    const watched = new Set([
      "id",
      "label",
      "root",
      "sort",
      "limit",
      "manualOrder",
      "indeterminatePolicy",
    ]);
    // Fields that genuinely cannot change what Steam holds.
    const cosmetic = new Set(["display", "icon"]);

    const sample = managed();
    for (const key of Object.keys(sample)) {
      expect(
        watched.has(key) || cosmetic.has(key),
        `\`${key}\` is neither watched by project() nor listed as cosmetic — ` +
          "if it can change membership, add it to the projection",
      ).toBe(true);
    }
  });

  it("does not fire when only the tile size changed", () => {
    const after = config({
      collections: [managed({ display: { tileWidth: 300, showLabels: false, badges: [] } })],
    });
    expect(mirrorAffecting(config(), after)).toBe(false);
  });
});
