// Real-disk I/O against a per-test temp XDG_CONFIG_HOME. See lib/backups.test.ts
// for why fs is not mocked.

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMethod } from "@loadout/types";

/**
 * Steam over CDP, faked. Without this the tests pass or fail depending on
 * whether Steam happens to be running on the machine.
 */
let steamUp = true;
/** Steam answers, but never in time. */
let hangSteam = false;
let fakeCollections: Array<{
  id: string;
  name: string;
  appIds: string[];
  isDynamic: boolean;
  isEditable: boolean;
}> = [];

mock.module("@loadout/steam-cdp", () => ({
  withSteamClient: async (fn: (client: unknown) => unknown) => {
    if (!steamUp) throw new Error("Steam is not running (test stub)");
    return fn({});
  },
  readSteamLibrary: async () => ({ entries: [], installedCount: 0, resolvedTagCount: 0 }),
  listCollections: async () => {
    if (hangSteam) await new Promise((r) => setTimeout(r, 20_000));
    return fakeCollections.map((c) => ({ ...c, appIds: [...c.appIds] }));
  },
  // Stateful, so a test can ask what Steam ended up holding. A fake that
  // accepts every call and remembers nothing cannot tell "wrote it" from
  // "thought about writing it".
  createCollection: async (_c: unknown, { name }: { name: string }) => {
    const made = { id: `uc-${fakeCollections.length + 1}`, name, appIds: [], isDynamic: false, isEditable: true };
    fakeCollections.push(made);
    return { ...made };
  },
  setCollectionApps: async (_c: unknown, { collectionId, appIds }: { collectionId: string; appIds: string[] }) => {
    const found = fakeCollections.find((c) => c.id === collectionId);
    if (found) found.appIds = [...appIds];
  },
  renameCollection: async (_c: unknown, { collectionId, name }: { collectionId: string; name: string }) => {
    const found = fakeCollections.find((c) => c.id === collectionId);
    if (found) found.name = name;
  },
  deleteCollection: async (_c: unknown, { collectionId }: { collectionId: string }) => {
    // Steam's own implementation calls `.startsWith` on this, so anything but
    // a string throws there. Passing the whole object was a real bug that 22
    // tests missed because the fake accepted either shape.
    if (typeof collectionId !== "string") throw new Error("collectionId must be a string");
    const at = fakeCollections.findIndex((c) => c.id === collectionId);
    if (at >= 0) fakeCollections.splice(at, 1);
    return at >= 0;
  },
}));

const { default: CollectionsBackend } = await import("./backend");

let tempDir: string;
let prevXdg: string | undefined;

beforeEach(() => {
  steamUp = true;
  hangSteam = false;
  fakeCollections = [];
  prevXdg = process.env.XDG_CONFIG_HOME;
  tempDir = mkdtempSync(join(tmpdir(), "collections-backend-"));
  process.env.XDG_CONFIG_HOME = tempDir;
});

afterEach(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  rmSync(tempDir, { recursive: true, force: true });
});

/**
 * A library for the backend to resolve appIds against. Supplied the way the
 * real one is — through `callPlugin` to the game-library service — so
 * `listGames` and the rule engine see it exactly as they would on a device.
 */
function libraryOf(games: Array<{ appId: string; name: string }>) {
  return async (_plugin: string, method: string) =>
    method === "getGames"
      ? games.map((g) => ({
          appId: g.appId,
          name: g.name,
          sizeOnDisk: 0,
          headerUrl: "",
          capsuleUrl: "",
          installed: true,
          source: "steam",
          tags: [],
        }))
      : null;
}

async function loaded(games: Array<{ appId: string; name: string }> = []) {
  const backend = new CollectionsBackend();
  (backend as unknown as { callPlugin: unknown }).callPlugin = libraryOf(games);
  await backend.onLoad();
  return backend;
}

function steamCollection(over: Partial<(typeof fakeCollections)[number]> = {}) {
  return { id: "uc-1", name: "Mine", appIds: ["10"], isDynamic: false, isEditable: true, ...over };
}

describe("RPC surface", () => {
  it("exposes the methods the UI calls, and hides the private ones", () => {
    const backend = new CollectionsBackend();
    for (const name of ["getConfig", "listAll", "listGames", "createCollection", "syncMirror"]) {
      expect(resolveMethod({ instance: backend, name })).toBeTruthy();
    }
    for (const name of ["_buildMirrorPlan", "_setMirrorState", "_assertWritable"]) {
      expect(resolveMethod({ instance: backend, name })).toBeFalsy();
    }
  });
});

describe("entries Steam can no longer resolve", () => {
  // A Steam collection stores bare appIds, and a non-Steam shortcut's appid is
  // regenerated every time the shortcut is re-added. Re-run EmuDeck or a ROM
  // manager and every id the collection holds for those entries goes dead.
  // Measured on the dev device: "Recomp Hub" held 221 ids, 16 resolved, and
  // all 205 that did not were above 2^31 — the shortcut id range.
  const withDeadIds = () => {
    fakeCollections = [
      {
        id: "uc-rh",
        name: "Recomp Hub",
        appIds: ["620", "2924527325", "3541813501"],
        isDynamic: false,
        isEditable: true,
      },
    ];
  };

  it("counts only the live ones on the grid card", async () => {
    // Otherwise a collection reads 222 on the card and 16 when opened, which
    // is the discrepancy this whole thing is about.
    withDeadIds();
    const backend = await loaded([{ appId: "620", name: "Portal 2" }]);
    const card = (await backend.listAll()).collections.find((c) => c.id === "uc-rh");
    expect(card?.count).toBe(1);
    expect(card?.previewAppIds).toEqual(["620"]);
  });

  it("lists the games it can resolve, and counts the rest separately", async () => {
    // They used to be listed as rows named by the number, which is why a
    // collection could read as 221 games here and 16 in Steam.
    withDeadIds();
    const backend = await loaded([{ appId: "620", name: "Portal 2" }]);
    const result = await backend.listGames("uc-rh");
    expect(result.games.map((g) => g.appId)).toEqual(["620"]);
    expect(result.staleAppIds).toEqual(["2924527325", "3541813501"]);
  });

  it("prunes them on request, keeping everything real", async () => {
    withDeadIds();
    const backend = await loaded([{ appId: "620", name: "Portal 2" }]);
    const result = await backend.pruneLinked("uc-rh");
    expect(result).toEqual({ removed: 2, kept: 1 });
    expect(fakeCollections[0]!.appIds).toEqual(["620"]);
  });

  it("does nothing when there is nothing dead", async () => {
    fakeCollections = [
      { id: "uc-rh", name: "Recomp Hub", appIds: ["620"], isDynamic: false, isEditable: true },
    ];
    const backend = await loaded([{ appId: "620", name: "Portal 2" }]);
    expect(await backend.pruneLinked("uc-rh")).toEqual({ removed: 0, kept: 0 });
    expect(fakeCollections[0]!.appIds).toEqual(["620"]);
  });

  it("never reports stale entries for a collection built from rules", async () => {
    // Its membership is computed from the library every time, so it cannot
    // hold a reference to something that is gone.
    const backend = await loaded();
    await backend.createCollection("Backlog");
    expect((await backend.listGames("backlog")).staleAppIds).toEqual([]);
  });
});

describe("Steam being slow", () => {
  it("shows the managed half rather than waiting on a hung Steam", async () => {
    // Steam being *down* was always handled. Steam being slow was not: a hung
    // Runtime.evaluate sits for the CDP client's own 30s ceiling, and the grid
    // shows a bare spinner for all of it — seen in the wild as two
    // "CDP Runtime.evaluate timeout after 30000ms" failures in one sync.
    const backend = await loaded();
    await backend.createCollection("Backlog");

    hangSteam = true;
    const t0 = Date.now();
    const result = await backend.listAll();
    hangSteam = false;

    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(result.steamReachable).toBe(false);
    expect(result.collections.map((c) => c.label)).toEqual(["Backlog"]);
  }, 30_000);
});

describe("listAll — the grid", () => {
  it("lists the collections already in Steam", async () => {
    // The point of the rework: EmuDeck's ROM sets were invisible before.
    fakeCollections = [
      steamCollection({ id: "srm-1", name: "Sega Genesis", appIds: ["1", "2", "3"] }),
      steamCollection({ id: "srm-2", name: "Nintendo 64", appIds: ["4"] }),
    ];
    const { collections, steamReachable } = await (await loaded()).listAll();

    expect(steamReachable).toBe(true);
    expect(collections.map((c) => c.label)).toEqual(["Sega Genesis", "Nintendo 64"]);
    expect(collections.every((c) => c.kind === "linked")).toBe(true);
  });

  it("puts the fullest first", async () => {
    fakeCollections = [
      steamCollection({ id: "a", name: "Small", appIds: ["1"] }),
      steamCollection({ id: "b", name: "Big", appIds: ["1", "2", "3"] }),
    ];
    const { collections } = await (await loaded()).listAll();
    expect(collections.map((c) => c.label)).toEqual(["Big", "Small"]);
  });

  it("hides Steam's own library filters", async () => {
    // `uncategorized` and friends are filters Steam already surfaces; listing
    // them would put a second "Installed" beside Steam's.
    fakeCollections = [
      steamCollection({ id: "uncategorized", name: "Uncategorized", isEditable: false }),
      steamCollection(),
    ];
    const { collections } = await (await loaded()).listAll();
    expect(collections.map((c) => c.id)).toEqual(["uc-1"]);
  });

  it("still shows managed collections when Steam is down", async () => {
    // A smaller honest grid beats an error page, and `steamReachable` is how
    // the UI explains the short list rather than looking like it lost them.
    const backend = await loaded();
    await backend.createCollection("Backlog");
    steamUp = false;

    const { collections, steamReachable } = await backend.listAll();
    expect(steamReachable).toBe(false);
    expect(collections.map((c) => c.kind)).toEqual(["managed"]);
  });

  it("marks a managed collection as self-maintaining", async () => {
    // The card says so because rules can drop a game without warning, and
    // silence is what makes that jarring.
    const backend = await loaded();
    await backend.createCollection("Backlog");
    const { collections } = await backend.listAll();
    expect(collections[0]!.autoMaintained).toBe(true);
  });
});

describe("createCollection", () => {
  it("gives a readable id derived from the name", async () => {
    const backend = await loaded();
    const config = await backend.createCollection("Never Played!");
    expect(config.collections[0]!.id).toBe("never-played");
    expect(config.collections[0]!.label).toBe("Never Played!");
  });

  it("does not let two collections share an id", async () => {
    // Two with one id breaks the ledger as well as React keys — the ledger
    // would not know which one owns the Steam collection.
    const backend = await loaded();
    await backend.createCollection("Backlog");
    const config = await backend.createCollection("Backlog");
    expect(config.collections.map((c) => c.id)).toEqual(["backlog", "backlog-2"]);
  });

  it("starts empty rather than matching nothing", async () => {
    // An empty `all` group is vacuously true, so a new collection shows the
    // whole library — the right starting point for narrowing it down.
    const backend = await loaded();
    const config = await backend.createCollection("New");
    expect(config.collections[0]!.root.children).toEqual([]);
  });
});

describe("editing never syncs on its own", () => {
  // A sync is a full library evaluation plus Steam Cloud writes, on a
  // single-threaded backend. Doing it a couple of seconds after every edit ran
  // it *while the user was still working*, so every RPC the UI issued queued
  // behind it — indistinguishable, from the front, from a frozen plugin. Five
  // identical collections got made that way, one per impatient press.
  it("records that Steam is behind rather than writing to it", async () => {
    const backend = await loaded();
    await backend.setConfig({
      ...(await backend.getConfig()).config,
      mirror: { ...(await backend.getConfig()).config.mirror, autoSync: true },
    });

    await backend.createCollection("Backlog");
    // Long enough that the old debounce would have fired twice over.
    await new Promise((r) => setTimeout(r, 60));

    const { config } = await backend.getConfig();
    expect(config.mirror.pendingSync).toBe(true);
    // Nothing reached Steam: the fake would be holding a collection if it had.
    expect(fakeCollections).toEqual([]);
  });

  it("leaves the flag alone when the change can't affect Steam", async () => {
    const backend = await loaded();
    const { config } = await backend.getConfig();
    await backend.setConfig(config);
    expect((await backend.getConfig()).config.mirror.pendingSync).toBe(false);
  });

  it("still writes when asked to", async () => {
    // The manual path is the whole point of the above: the work is the same,
    // it just happens when nobody is waiting on it.
    const backend = await loaded();
    await backend.createCollection("Backlog");
    await backend.setCollections([
      {
        ...(await backend.getConfig()).config.collections[0]!,
        root: {
          kind: "group",
          id: "backlog-root",
          combinator: "all",
          children: [{ id: "r1", kind: "installed" }],
        },
      },
    ]);

    const report = await backend.syncMirror();
    expect(report.created).toBe(1);
    expect((await backend.getConfig()).config.mirror.pendingSync).toBe(false);
  });
});

describe("deleteCollection", () => {
  it("removes it from the config and the order", async () => {
    const backend = await loaded();
    await backend.createCollection("Backlog");
    const config = await backend.deleteCollection("backlog");
    expect(config.collections).toEqual([]);
    expect(config.collectionOrder).toEqual([]);
  });

  /** A managed collection that has been mirrored into Steam. */
  async function mirrored(backend: Awaited<ReturnType<typeof loaded>>) {
    await backend.createCollection("Backlog");
    const { config } = await backend.getConfig();
    await backend.setCollections([
      {
        ...config.collections[0]!,
        root: {
          kind: "group",
          id: "backlog-root",
          combinator: "all",
          children: [{ id: "r1", kind: "installed" }],
        },
      },
    ]);
    await backend.syncMirror();
  }

  it("removes it from Steam straight away, not at the next sync", async () => {
    // Syncing is deferred because it is a full library evaluation plus a
    // batch of writes. A delete is one targeted call, and leaving it to the
    // next sync meant the collection vanished from the plugin while Steam
    // still listed it — which reads exactly like a delete that did not work.
    const backend = await loaded();
    await mirrored(backend);
    expect(fakeCollections).toHaveLength(1);

    await backend.deleteCollection("backlog");
    expect(fakeCollections).toHaveLength(0);
    expect((await backend.getConfig()).config.mirror.ledger.entries).toEqual([]);
  });

  it("keeps the ledger row when Steam can't be reached, so the sync finishes it", async () => {
    const backend = await loaded();
    await mirrored(backend);

    steamUp = false;
    await backend.deleteCollection("backlog");
    const { config } = await backend.getConfig();
    expect(config.collections).toEqual([]);
    // The row outlives the collection on purpose: that is what tells the next
    // sync there is a Steam collection with no owner left to delete.
    expect(config.mirror.ledger.entries.map((e) => e.managedId)).toEqual(["backlog"]);

    steamUp = true;
    const report = await backend.syncMirror();
    expect(report.deleted).toBe(1);
    expect(fakeCollections).toHaveLength(0);
  });
});

describe("the ledger is backend-owned", () => {
  it("ignores a ledger supplied by the client", async () => {
    // The UI posts config built from React state captured before the last
    // sync's broadcast; honouring its copy would forget collections that
    // exist, and a forgotten collection can never be cleaned up.
    const backend = await loaded();
    const { config } = await backend.getConfig();
    const forged = {
      ...config,
      mirror: {
        ...config.mirror,
        ledger: {
          version: 1 as const,
          entries: [
            { managedId: "x", steamCollectionId: "uc-x", steamName: "X", appIds: [], lastSyncedAt: 1 },
          ],
        },
      },
    };
    const after = await backend.setConfig(forged);
    expect(after.mirror.ledger.entries).toEqual([]);
  });
});
