/**
 * These functions delete the user's Steam collections, so the in-page programs
 * they build get tested rather than trusted.
 *
 * The programs are strings that only ever execute inside Steam, so each test
 * **runs** the generated source against a fake `collectionStore` — the same
 * approach as the webpack patcher's tests, and for the same reason: asserting
 * on the text of a generated program is how one passes its suite while doing
 * nothing at all.
 */

import { describe, expect, it } from "bun:test";
import {
  collectionsForApp,
  createCollection,
  deleteCollection,
  listCollections,
  renameCollection,
  setCollectionApps,
} from "./collections";
import { SteamClientUnreachableError, type SteamClient } from "./steam-client";

interface FakeCollection {
  m_strId?: string;
  m_strName?: string;
  m_setApps?: Set<number>;
  m_rgApps?: number[];
  allApps?: Array<{ appid: number }>;
  bIsDynamic?: boolean;
  m_filterSpec?: unknown;
  bIsEditable?: boolean;
  AddApps?: (apps: Array<{ appid: number }>) => void;
  RemoveApps?: (apps: Array<{ appid: number }>) => void;
}

function fakeStore(collections: FakeCollection[] = []) {
  const saved: FakeCollection[] = [];
  const deleted: string[] = [];
  const store = {
    userCollections: collections,
    GetCollection: (id: string) => collections.find((c) => c.m_strId === id),
    NewUnsavedCollection: (name: string, _b: null, apps: Array<{ appid: number }>) => {
      const made: FakeCollection = {
        m_strId: "uc-new",
        m_strName: name,
        m_setApps: new Set(apps.map((a) => a.appid)),
        bIsEditable: true,
      };
      collections.push(made);
      return made;
    },
    SaveCollection: async (c: FakeCollection) => void saved.push(c),
    // Takes an **id**, exactly as Steam does — it calls `BIsSystemCollectionId`
    // on the argument, so anything that isn't a string throws.
    DeleteCollection: async (id: unknown) => {
      if (typeof id !== "string") {
        throw new TypeError("e.startsWith is not a function");
      }
      const at = collections.findIndex((c) => c.m_strId === id);
      if (at === -1) return;
      deleted.push(id);
      collections.splice(at, 1);
    },
    GetCollectionListForAppID: (appId: number) =>
      collections.filter((c) => c.m_setApps?.has(appId)),
  };
  return { store, saved, deleted };
}

/** A client whose `_evaluateAsync` really evaluates, with `window` bound. */
function clientFor(win: Record<string, unknown>): SteamClient {
  return {
    _evaluateAsync: async (expr: string) =>
      await new Function("window", `return (${expr});`)(win),
  } as unknown as SteamClient;
}

function collection(over: Partial<FakeCollection> = {}): FakeCollection {
  return {
    m_strId: "uc-1",
    m_strName: "Backlog",
    m_setApps: new Set([10, 20]),
    bIsEditable: true,
    AddApps(apps) {
      for (const a of apps) this.m_setApps!.add(a.appid);
    },
    RemoveApps(apps) {
      for (const a of apps) this.m_setApps!.delete(a.appid);
    },
    ...over,
  };
}

describe("listCollections", () => {
  it("reads id, name and membership", async () => {
    const { store } = fakeStore([collection()]);
    expect(await listCollections(clientFor({ collectionStore: store }))).toEqual([
      { id: "uc-1", name: "Backlog", appIds: ["10", "20"], isDynamic: false, isEditable: true },
    ]);
  });

  it("falls back to m_rgApps, then allApps, for membership", async () => {
    // Steam exposes apps through several shapes. Under-reporting membership
    // makes a mirror re-add every game on the next sync.
    const { store: a } = fakeStore([collection({ m_setApps: undefined, m_rgApps: [1, 2] })]);
    expect((await listCollections(clientFor({ collectionStore: a })))[0]!.appIds).toEqual(["1", "2"]);

    const { store: b } = fakeStore([
      collection({ m_setApps: undefined, allApps: [{ appid: 7 }] }),
    ]);
    expect((await listCollections(clientFor({ collectionStore: b })))[0]!.appIds).toEqual(["7"]);
  });

  it("flags a filter-driven collection as dynamic", async () => {
    // The mirror refuses to write to these; mis-reporting one as editable is
    // how a sync ends up fighting Steam forever.
    const { store } = fakeStore([collection({ m_filterSpec: { tags: [1] } })]);
    expect((await listCollections(clientFor({ collectionStore: store })))[0]!.isDynamic).toBe(true);
  });

  it("throws a typed error when Steam's store isn't up", async () => {
    expect(listCollections(clientFor({}))).rejects.toBeInstanceOf(SteamClientUnreachableError);
  });
});

describe("createCollection", () => {
  it("creates, saves, and returns the new id", async () => {
    // Without SaveCollection the collection looks perfect and vanishes on the
    // next Steam restart.
    const { store, saved } = fakeStore([]);
    const made = await createCollection(clientFor({ collectionStore: store }), {
      name: "Backlog",
      appIds: ["10", "20"],
    });
    expect(made.id).toBe("uc-new");
    expect(made.appIds).toEqual(["10", "20"]);
    expect(saved).toHaveLength(1);
  });

  it("refuses a blank name before touching Steam", async () => {
    expect(createCollection(clientFor({}), { name: "  ", appIds: [] })).rejects.toThrow(/blank/);
  });

  it("survives a name full of quotes, backslashes and newlines", async () => {
    // Names are user input interpolated into a JS program.
    const nasty = 'He said "hi" \\ then\n</script> `back`';
    const { store } = fakeStore([]);
    const made = await createCollection(clientFor({ collectionStore: store }), {
      name: nasty,
      appIds: [],
    });
    expect(made.name).toBe(nasty);
  });

  it("reports a missing API rather than pretending it worked", async () => {
    expect(
      createCollection(clientFor({ collectionStore: { userCollections: [] } }), {
        name: "X",
        appIds: [],
      }),
    ).rejects.toBeInstanceOf(SteamClientUnreachableError);
  });
});

describe("setCollectionApps", () => {
  it("diffs against live membership to reach the target set", async () => {
    const target = collection({ m_setApps: new Set([10, 20]) });
    const { store, saved } = fakeStore([target]);
    await setCollectionApps(clientFor({ collectionStore: store }), {
      collectionId: "uc-1",
      appIds: ["10", "30"],
    });
    expect([...target.m_setApps!].sort()).toEqual([10, 30]);
    expect(saved).toHaveLength(1);
  });

  it("does not save when membership already matches", async () => {
    // Every save is a Steam Cloud round trip; a no-op sync must cost nothing.
    const { store, saved } = fakeStore([collection({ m_setApps: new Set([10, 20]) })]);
    await setCollectionApps(clientFor({ collectionStore: store }), {
      collectionId: "uc-1",
      appIds: ["20", "10"],
    });
    expect(saved).toHaveLength(0);
  });

  it("refuses a dynamic or non-editable collection", async () => {
    for (const over of [{ bIsDynamic: true }, { bIsEditable: false }]) {
      const { store } = fakeStore([collection(over)]);
      expect(
        setCollectionApps(clientFor({ collectionStore: store }), {
          collectionId: "uc-1",
          appIds: [],
        }),
      ).rejects.toThrow(/dynamic|editable/);
    }
  });

  it("reports an unknown id instead of silently doing nothing", async () => {
    const { store } = fakeStore([]);
    expect(
      setCollectionApps(clientFor({ collectionStore: store }), {
        collectionId: "uc-nope",
        appIds: [],
      }),
    ).rejects.toThrow(/no collection with id/);
  });

  it("cannot be made to execute code through the collection id", async () => {
    // Both error paths once interpolated the id raw while every other
    // interpolation was JSON.stringify'd. A crafted id ran in Steam's context;
    // a bare quote made the whole program a SyntaxError, so the write failed
    // silently. Reachable from a restored backup or a hand-edited config.
    const win: Record<string, unknown> = { collectionStore: fakeStore([]).store };
    expect(
      setCollectionApps(clientFor(win), {
        collectionId: 'x" + (window.PWNED = true) + "',
        appIds: [],
      }),
    ).rejects.toThrow(/no collection with id/);
    expect(win.PWNED).toBeUndefined();
  });

  it("survives an id containing a bare quote", async () => {
    const { store } = fakeStore([]);
    // A SyntaxError would surface as something other than our own message.
    expect(
      setCollectionApps(clientFor({ collectionStore: store }), {
        collectionId: 'uc-"',
        appIds: [],
      }),
    ).rejects.toThrow(/no collection with id/);
  });
});

describe("renameCollection", () => {
  it("renames in place, keeping the id the ledger holds", async () => {
    const { store, saved } = fakeStore([collection()]);
    const after = await renameCollection(clientFor({ collectionStore: store }), {
      collectionId: "uc-1",
      name: "Shelf",
    });
    expect(after.id).toBe("uc-1");
    expect(after.name).toBe("Shelf");
    expect(saved).toHaveLength(1);
  });

  it("refuses a blank name", async () => {
    expect(
      renameCollection(clientFor({}), { collectionId: "uc-1", name: " " }),
    ).rejects.toThrow(/blank/);
  });

  it("cannot be made to execute code through the collection id", async () => {
    const win: Record<string, unknown> = { collectionStore: fakeStore([]).store };
    expect(
      renameCollection(clientFor(win), {
        collectionId: 'x" + (window.PWNED = true) + "',
        name: "Shelf",
      }),
    ).rejects.toThrow(/no collection with id/);
    expect(win.PWNED).toBeUndefined();
  });
});

describe("deleteCollection", () => {
  it("deletes by id and says it did", async () => {
    const { store, deleted } = fakeStore([collection()]);
    expect(await deleteCollection(clientFor({ collectionStore: store }), { collectionId: "uc-1" })).toBe(true);
    expect(deleted).toEqual(["uc-1"]);
  });

  it("treats an already-absent collection as done, not as an error", async () => {
    // A ledger entry for something deleted on another machine must not wedge
    // every future sync.
    const { store, deleted } = fakeStore([collection()]);
    expect(
      await deleteCollection(clientFor({ collectionStore: store }), { collectionId: "uc-gone" }),
    ).toBe(false);
    expect(deleted).toEqual([]);
  });

  it("deletes only the id given, when two collections share a name", async () => {
    // The most dangerous operation here: identity is the id, never the name,
    // and two collections legitimately share one.
    const { store, deleted } = fakeStore([
      collection({ m_strId: "uc-1" }),
      collection({ m_strId: "uc-2" }),
    ]);
    await deleteCollection(clientFor({ collectionStore: store }), { collectionId: "uc-2" });
    expect(deleted).toEqual(["uc-2"]);
    expect(store.userCollections.map((c) => c.m_strId)).toEqual(["uc-1"]);
  });
});

describe("collectionsForApp", () => {
  it("reads Steam's own index, which is what the library renders from", async () => {
    const { store } = fakeStore([collection({ m_setApps: new Set([10]) })]);
    expect(await collectionsForApp(clientFor({ collectionStore: store }), { appId: 10 })).toEqual([
      "uc-1",
    ]);
  });

  it("rejects a non-numeric appId before building a program", async () => {
    expect(collectionsForApp(clientFor({}), { appId: "nope" })).rejects.toThrow(/invalid appId/);
  });
});
