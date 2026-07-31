import { describe, expect, it } from "bun:test";
import { applyMirrorPlan, type MirrorOps } from "./mirror-apply";
import { planMirror, type SteamCollection } from "./mirror";
import type { ManagedCollection, MirrorLedger } from "./types";

const NOW = 1_800_000_000_000;

function managed(overrides: Partial<ManagedCollection> = {}): ManagedCollection {
  return {
    id: "t1",
    label: "Backlog",
    // A rule by default: planMirror skips a collection with none, since an
    // empty tree matches the whole library.
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
  return { id: "uc-1", name: "Backlog", appIds: [], isDynamic: false, isEditable: true, ...overrides };
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

/** Records the call order, and can be told to fail a specific step. */
function recordingOps(fail: { step?: string; on?: string } = {}) {
  const calls: string[] = [];
  const boom = (step: string, key: string) => {
    if (fail.step === step && (fail.on === undefined || fail.on === key)) {
      throw new Error(`${step} exploded`);
    }
  };
  let next = 0;
  const ops: MirrorOps = {
    async create({ name, appIds }) {
      calls.push(`create:${name}`);
      boom("create", name);
      next++;
      return { collectionId: `uc-new-${next}`, name };
    },
    async setApps({ collectionId, appIds }) {
      calls.push(`setApps:${collectionId}:${appIds.join(",")}`);
      boom("setApps", collectionId);
    },
    async rename({ collectionId, name }) {
      calls.push(`rename:${collectionId}:${name}`);
      boom("rename", collectionId);
    },
    async remove({ collectionId }) {
      calls.push(`remove:${collectionId}`);
      boom("remove", collectionId);
    },
  };
  return { ops, calls };
}

describe("applyMirrorPlan — ordering", () => {
  it("deletes before it creates, so a freed name can be reused in one sync", async () => {
    // ManagedCollection "old" is gone; its collection was called "Shelf". ManagedCollection "new" now
    // wants "Shelf". Creating first would collide with a live collection.
    const plan = planMirror({
      collections: [managed({ id: "new", label: "Shelf" })],
      evaluated: new Map([["new", ["1"]]]),
      ledger: ledger(entry({ managedId: "old", steamCollectionId: "uc-old", steamName: "Shelf" })),
      steamCollections: [collection({ id: "uc-old", name: "Shelf" })],
    });
    expect(plan.deletes).toHaveLength(1);
    expect(plan.conflicts).toHaveLength(0);
    expect(plan.creates).toHaveLength(1);

    const { ops, calls } = recordingOps();
    await applyMirrorPlan({ plan, ledger: ledger(), ops, now: NOW });
    expect(calls).toEqual(["remove:uc-old", "create:Shelf"]);
  });

  it("renames before it creates", async () => {
    const plan = planMirror({
      collections: [
        managed({ id: "a", label: "Shelf" }),
        managed({ id: "b", label: "Backlog" }),
      ],
      evaluated: new Map([
        ["a", ["1"]],
        ["b", ["2"]],
      ]),
      ledger: ledger(entry({ managedId: "a", steamCollectionId: "uc-a", steamName: "Backlog", appIds: ["1"] })),
      steamCollections: [collection({ id: "uc-a", name: "Backlog", appIds: ["1"] })],
    });
    // "a" is renaming away from Backlog; "b" is claiming it.
    expect(plan.renames).toHaveLength(1);
    expect(plan.creates).toHaveLength(1);

    const { ops, calls } = recordingOps();
    await applyMirrorPlan({ plan, ledger: ledger(), ops, now: NOW });
    expect(calls.indexOf("rename:uc-a:Shelf")).toBeLessThan(calls.indexOf("create:Backlog"));
  });
});

describe("applyMirrorPlan — what gets written", () => {
  it("writes the target set, not the diff", async () => {
    // `setCollectionApps` recomputes add/remove in-page. Handing it the diff
    // would make a stale read leave strays behind forever.
    const plan = planMirror({
      collections: [managed()],
      evaluated: new Map([["t1", ["10", "30"]]]),
      ledger: ledger(entry({ appIds: ["10", "20"] })),
      steamCollections: [collection({ appIds: ["10", "20"] })],
    });
    const { ops, calls } = recordingOps();
    await applyMirrorPlan({ plan, ledger: ledger(entry({ appIds: ["10", "20"] })), ops, now: NOW });
    expect(calls).toEqual(["setApps:uc-1:10,30"]);
  });

  it("counts each kind of write", async () => {
    const plan = planMirror({
      collections: [managed({ id: "a", label: "A" })],
      evaluated: new Map([["a", ["1"]]]),
      ledger: ledger(entry({ managedId: "z", steamCollectionId: "uc-z", steamName: "Z" })),
      steamCollections: [collection({ id: "uc-z", name: "Z" })],
    });
    const { ops } = recordingOps();
    const result = await applyMirrorPlan({ plan, ledger: ledger(), ops, now: NOW });
    expect(result).toMatchObject({ created: 1, deleted: 1, updated: 0, renamed: 0 });
    expect(result.failures).toHaveLength(0);
  });
});

describe("applyMirrorPlan — partial failure", () => {
  it("keeps going after one collection fails", async () => {
    const plan = planMirror({
      collections: [
        managed({ id: "a", label: "A" }),
        managed({ id: "b", label: "B" }),
      ],
      evaluated: new Map([
        ["a", ["1"]],
        ["b", ["2"]],
      ]),
      ledger: ledger(),
      steamCollections: [],
    });
    const { ops } = recordingOps({ step: "create", on: "A" });
    const result = await applyMirrorPlan({ plan, ledger: ledger(), ops, now: NOW });

    expect(result.created).toBe(1);
    expect(result.failures).toEqual([{ managedId: "a", step: "create", message: "create exploded" }]);
    // Only the one that landed is recorded.
    expect(result.ledger.entries.map((e) => e.managedId)).toEqual(["b"]);
  });

  it("does not record a write that failed", async () => {
    // The bug this guards: a ledger claiming apps it never wrote makes the
    // next run see phantom drift and "correct" it by removing real games.
    const before = ledger(entry({ appIds: ["10", "20"] }));
    const plan = planMirror({
      collections: [managed()],
      evaluated: new Map([["t1", ["10", "30"]]]),
      ledger: before,
      steamCollections: [collection({ appIds: ["10", "20"] })],
    });
    const { ops } = recordingOps({ step: "setApps" });
    const result = await applyMirrorPlan({ plan, ledger: before, ops, now: NOW });

    expect(result.failures[0]?.step).toBe("update");
    expect(result.ledger.entries[0]).toEqual(before.entries[0]!);
  });

  it("keeps the ledger entry when a delete fails", async () => {
    // Forgetting a collection we could not delete orphans it in Steam with no
    // record that it was ever ours — nothing would ever clean it up.
    const before = ledger(entry({ managedId: "gone", steamCollectionId: "uc-1" }));
    const plan = planMirror({
      collections: [],
      evaluated: new Map(),
      ledger: before,
      steamCollections: [collection()],
    });
    const { ops } = recordingOps({ step: "remove" });
    const result = await applyMirrorPlan({ plan, ledger: before, ops, now: NOW });

    expect(result.deleted).toBe(0);
    expect(result.failures[0]?.step).toBe("delete");
    expect(result.ledger.entries).toHaveLength(1);
  });

  it("records a rename that succeeded on its own", async () => {
    // Without this the plan proposes the same rename on every sync forever.
    const before = ledger(entry({ appIds: ["10"] }));
    const plan = planMirror({
      collections: [managed({ label: "Shelf" })],
      evaluated: new Map([["t1", ["10"]]]),
      ledger: before,
      steamCollections: [collection({ name: "Backlog", appIds: ["10"] })],
    });
    expect(plan.renames).toHaveLength(1);
    expect(plan.updates).toHaveLength(0);

    const { ops } = recordingOps();
    const result = await applyMirrorPlan({ plan, ledger: before, ops, now: NOW });
    expect(result.ledger.entries[0]!.steamName).toBe("Shelf");
    expect(result.ledger.entries[0]!.appIds).toEqual(["10"]);

    // And the next plan is a no-op.
    const second = planMirror({
      collections: [managed({ label: "Shelf" })],
      evaluated: new Map([["t1", ["10"]]]),
      ledger: result.ledger,
      steamCollections: [collection({ name: "Shelf", appIds: ["10"] })],
    });
    expect(second.renames).toHaveLength(0);
    expect(second.noops).toEqual(["t1"]);
  });

  it("does not record a rename that failed", async () => {
    const before = ledger(entry({ appIds: ["10"] }));
    const plan = planMirror({
      collections: [managed({ label: "Shelf" })],
      evaluated: new Map([["t1", ["10"]]]),
      ledger: before,
      steamCollections: [collection({ name: "Backlog", appIds: ["10"] })],
    });
    const { ops } = recordingOps({ step: "rename" });
    const result = await applyMirrorPlan({ plan, ledger: before, ops, now: NOW });
    expect(result.ledger.entries[0]!.steamName).toBe("Backlog");
  });
});

describe("applyMirrorPlan — nothing to do", () => {
  it("touches Steam not at all for an empty plan", async () => {
    const plan = planMirror({
      collections: [managed()],
      evaluated: new Map([["t1", ["10"]]]),
      ledger: ledger(entry({ appIds: ["10"] })),
      steamCollections: [collection({ appIds: ["10"] })],
    });
    const { ops, calls } = recordingOps();
    const result = await applyMirrorPlan({ plan, ledger: ledger(entry({ appIds: ["10"] })), ops, now: NOW });
    expect(calls).toEqual([]);
    expect(result.ledger.entries[0]!.lastSyncedAt).toBe(NOW - 1000);
  });
});
