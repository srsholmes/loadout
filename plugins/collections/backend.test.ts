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
  listCollections: async () => fakeCollections.map((c) => ({ ...c, appIds: [...c.appIds] })),
  createCollection: async () => ({ id: "uc-new", name: "n", appIds: [], isDynamic: false, isEditable: true }),
  setCollectionApps: async () => undefined,
  renameCollection: async () => undefined,
  deleteCollection: async () => true,
}));

const { default: CollectionsBackend } = await import("./backend");

let tempDir: string;
let prevXdg: string | undefined;

beforeEach(() => {
  steamUp = true;
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

async function loaded() {
  const backend = new CollectionsBackend();
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

describe("deleteCollection", () => {
  it("removes it from the config and the order", async () => {
    const backend = await loaded();
    await backend.createCollection("Backlog");
    const config = await backend.deleteCollection("backlog");
    expect(config.collections).toEqual([]);
    expect(config.collectionOrder).toEqual([]);
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
