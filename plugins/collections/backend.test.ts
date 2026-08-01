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
/**
 * Fail the next write to Steam, the way a live session dying mid-sync does.
 *
 * Without this the executor's per-write failure collection is unreachable:
 * `steamUp = false` throws before any op runs, so `result.failures` was `[]`
 * in every test and the "half the sync landed" branch had no coverage at all.
 */
let failNextWrite: string | null = null;
/** The library read comes back empty, as it does while Steam hydrates. */
let emptyLibrary = false;
/** Which Steam write primitive was last used — a whole-list write is a bug. */
let steamWrites: string[] = [];
/** Hold a write open so an edit can provably land mid-sync. */
let releaseWrite: (() => void) | null = null;
let holdWrite = false;
/** Hold the *read* open, to land an edit between evaluating and planning. */
let releaseSteamRead: (() => void) | null = null;
let hangSteamOnce = false;

/**
 * Wait until a latch has actually been reached, rather than sleeping and
 * hoping. A missed latch used to hang the test to the suite timeout instead of
 * saying what it was waiting for.
 */
async function until(what: string, ready: () => boolean, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
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
    if (hangSteamOnce) {
      hangSteamOnce = false;
      await new Promise<void>((resolve) => {
        releaseSteamRead = resolve;
      });
    }
    return fakeCollections.map((c) => ({ ...c, appIds: [...c.appIds] }));
  },
  // Stateful, so a test can ask what Steam ended up holding. A fake that
  // accepts every call and remembers nothing cannot tell "wrote it" from
  // "thought about writing it".
  createCollection: async (_c: unknown, { name, appIds = [] }: { name: string; appIds?: string[] }) => {
    if (failNextWrite === "create") {
      failNextWrite = null;
      throw new Error("Steam went away mid-write (test stub)");
    }
    if (holdWrite) {
      holdWrite = false;
      await new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
    }
    // Honour the membership it was handed. Dropping it meant every created
    // collection was empty in the fake, so a plan that created one holding the
    // wrong games looked identical to one that got it right.
    const made = {
      id: `uc-${fakeCollections.length + 1}`,
      name,
      appIds: [...appIds],
      isDynamic: false,
      isEditable: true,
    };
    fakeCollections.push(made);
    return { ...made };
  },
  // A true delta, like the real one: only the named ids move, so an entry the
  // caller never knew about — a dead shortcut id, or something EmuDeck added
  // in between — is left where it is.
  editCollectionApps: async (
    _c: unknown,
    { collectionId, add = [], remove = [] }: { collectionId: string; add?: string[]; remove?: string[] },
  ) => {
    steamWrites.push("editCollectionApps");
    if (failNextWrite === "setApps") {
      failNextWrite = null;
      throw new Error("Steam went away mid-write (test stub)");
    }
    if (holdWrite) {
      holdWrite = false;
      await new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
    }
    const found = fakeCollections.find((c) => c.id === collectionId);
    if (!found) throw new Error("no collection with id " + collectionId);
    const dropped = new Set(remove);
    const kept = found.appIds.filter((id) => !dropped.has(id));
    const present = new Set(kept);
    found.appIds = [...kept, ...add.filter((id) => !present.has(id))];
    return { ...found, appIds: [...found.appIds] };
  },
  setCollectionApps: async (_c: unknown, { collectionId, appIds }: { collectionId: string; appIds: string[] }) => {
    steamWrites.push("setCollectionApps");
    if (holdWrite) {
      holdWrite = false;
      await new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
    }
    if (failNextWrite === "setApps") {
      failNextWrite = null;
      throw new Error("Steam went away mid-write (test stub)");
    }
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
  failNextWrite = null;
  emptyLibrary = false;
  steamWrites = [];
  releaseWrite = null;
  holdWrite = false;
  releaseSteamRead = null;
  hangSteamOnce = false;
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
function libraryOf(games: Array<{ appId: string; name: string; source?: string }>) {
  return async (_plugin: string, method: string) =>
    method === "getGames"
      ? games.map((g) => ({
          appId: g.appId,
          name: g.name,
          sizeOnDisk: 0,
          headerUrl: "",
          capsuleUrl: "",
          installed: true,
          // Shortcuts matter: pruning refuses to drop shortcut-shaped ids
          // unless the library proves it has listed shortcuts at all.
          source: g.source ?? "steam",
          tags: [],
        }))
      : null;
}

async function loaded(games: Array<{ appId: string; name: string; source?: string }> = []) {
  const backend = new CollectionsBackend();
  (backend as unknown as { callPlugin: unknown }).callPlugin = (
    plugin: string,
    method: string,
  ) => libraryOf(emptyLibrary ? [] : games)(plugin, method);
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

  it("refuses to prune when Steam answered but the library came back empty", async () => {
    // `appstore: "ok"` only means the call returned. Steam answers with an
    // empty list while its stores hydrate, and every owned-but-uninstalled
    // game then looks dead. The old fake made *every* test run with a healthy
    // provider, so this guard could be deleted with the suite still green.
    withDeadIds();
    const backend = await loaded([]);
    await expect(backend.pruneLinked("uc-rh")).rejects.toThrow(/isn't fully loaded/);
    expect(fakeCollections[0]!.appIds).toHaveLength(3);
  });

  it("refuses to prune when the library can't vouch for the ids", async () => {
    // "Stale" means the library doesn't know the id, which is only safe to act
    // on when the library is trustworthy. Both sources degrade to empty on
    // failure, and a thin snapshot makes every ROM in an EmuDeck collection
    // look dead — shortcuts have no appmanifest. Confirming that dialog would
    // empty a collection somebody else built.
    // A library that answered with *something*, but nothing this collection
    // holds — the shape of a half-loaded read rather than a dead collection.
    // Ordinary ids, so the shortcut guard doesn't fire first.
    fakeCollections = [
      { id: "uc-rh", name: "Recomp Hub", appIds: ["10", "20"], isDynamic: false, isEditable: true },
    ];
    const backend = await loaded([{ appId: "999", name: "Something else" }]);
    await expect(backend.pruneLinked("uc-rh")).rejects.toThrow(/unreadable/);
    expect(fakeCollections[0]!.appIds).toHaveLength(2);
  });

  it("prunes them on request, naming the dead ids rather than rewriting the list", async () => {
    withDeadIds();
    const backend = await loaded([
      { appId: "620", name: "Portal 2" },
      { appId: "3000000001", name: "Some ROM", source: "shortcut" },
    ]);
    const result = await backend.pruneLinked("uc-rh");
    expect(result).toEqual({ removed: 2, kept: 1 });
    expect(fakeCollections[0]!.appIds).toEqual(["620"]);
    // A targeted removal, not a membership rewrite. Both land on the same
    // list here, so the primitive is the only thing that distinguishes them —
    // and a rewrite takes the collection's unresolvable ids with it, which is
    // exactly what this is meant to avoid.
    expect(steamWrites).toEqual(["editCollectionApps"]);
  });

  it("does nothing when there is nothing dead", async () => {
    fakeCollections = [
      { id: "uc-rh", name: "Recomp Hub", appIds: ["620"], isDynamic: false, isEditable: true },
    ];
    const backend = await loaded([{ appId: "620", name: "Portal 2" }]);
    expect(await backend.pruneLinked("uc-rh")).toEqual({ removed: 0, kept: 1 });
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

describe("editing a Steam collection by hand", () => {
  // It used to take the whole membership from the UI. That list has
  // unresolvable ids filtered out of it, so removing one game also deleted
  // every dead entry — the destruction the "Clean up" button asks twice about,
  // done silently — and a list captured while the library was degraded
  // truncated the collection to whatever the UI happened to be showing.
  const collectionOf = (appIds: string[]) => {
    fakeCollections = [
      { id: "uc-rh", name: "Recomp Hub", appIds, isDynamic: false, isEditable: true },
    ];
  };

  it("removes only what was asked for, leaving unresolvable ids alone", async () => {
    collectionOf(["620", "2924527325", "400"]);
    const backend = await loaded([
      { appId: "620", name: "Portal 2" },
      { appId: "400", name: "Portal" },
    ]);
    await backend.editLinked("uc-rh", { remove: ["620"] });
    expect(fakeCollections[0]!.appIds).toEqual(["2924527325", "400"]);
  });

  it("adds without rewriting what is already there", async () => {
    collectionOf(["620", "2924527325"]);
    const backend = await loaded([{ appId: "620", name: "Portal 2" }]);
    await backend.editLinked("uc-rh", { add: ["400"] });
    expect(fakeCollections[0]!.appIds).toEqual(["620", "2924527325", "400"]);
  });

  it("keeps what somebody else added while the write was in flight", async () => {
    // The window that matters is between our read and Steam applying the
    // write. The old version pushed its entry in *before* the read, which a
    // whole-membership write survived too — so it proved nothing about the
    // delta. Held open here, so the concurrent add genuinely interleaves.
    collectionOf(["620"]);
    const backend = await loaded([{ appId: "620", name: "Portal 2" }]);

    holdWrite = true;
    const editing = backend.editLinked("uc-rh", { add: ["400"] });
    await until("the edit's Steam write", () => releaseWrite !== null);
    fakeCollections[0]!.appIds.push("999999"); // EmuDeck, mid-write
    releaseWrite?.();
    await editing;

    expect(fakeCollections[0]!.appIds).toContain("999999");
    expect(fakeCollections[0]!.appIds).toContain("400");
    expect(fakeCollections[0]!.appIds).toContain("620");
    // Named explicitly: with only the *delta* fake honouring the latch, a
    // reverted `editLinked` finishes before the concurrent push and the
    // assertions above hold anyway. The primitive is the thing under test.
    expect(steamWrites).toEqual(["editCollectionApps"]);
  });

  it("won't add the same game twice", async () => {
    collectionOf(["620"]);
    const backend = await loaded([{ appId: "620", name: "Portal 2" }]);
    await backend.editLinked("uc-rh", { add: ["620"] });
    expect(fakeCollections[0]!.appIds).toEqual(["620"]);
  });

  it("refuses an empty edit rather than writing the membership back", async () => {
    collectionOf(["620"]);
    const backend = await loaded([{ appId: "620", name: "Portal 2" }]);
    await expect(backend.editLinked("uc-rh", {})).rejects.toThrow(/Nothing to change/);
  });
});

describe("a sync that writes nothing", () => {
  it("says which collections it refused, rather than 'already up to date'", async () => {
    // The planner correctly refuses to adopt a same-named collection it did
    // not create. Reporting that as a no-op is the shape of a success.
    const backend = await loaded([{ appId: "620", name: "Portal 2" }]);
    fakeCollections = [
      { id: "uc-emu", name: "Emulation", appIds: ["1"], isDynamic: false, isEditable: true },
    ];
    await backend.createCollection("Emulation");
    const { config } = await backend.getConfig();
    await backend.setCollections([
      {
        ...config.collections[0]!,
        root: {
          kind: "group",
          id: "emulation-root",
          combinator: "all",
          children: [{ id: "r1", kind: "installed" }],
        },
      },
    ]);

    const report = await backend.syncMirror();
    expect(report.created).toBe(0);
    expect(report.blocked).toHaveLength(1);
    expect(report.blocked[0]!.label).toBe("Emulation");
    expect(report.blocked[0]!.reason).toMatch(/already has a collection/);
  });

  it("names a collection with no rules as blocked rather than syncing it", async () => {
    const backend = await loaded([{ appId: "620", name: "Portal 2" }]);
    await backend.createCollection("Backlog");
    const report = await backend.syncMirror();
    expect(report.created).toBe(0);
    expect(report.blocked[0]!.reason).toMatch(/whole library/);
  });
});

describe("state the UI depends on", () => {
  // Each of these was changed in response to a review and shipped without a
  // test that fails when the change is reverted.

  it("keeps a ledger written mid-sync, rather than restoring the pre-sync one", async () => {
    // `_markSyncOwed` captures the mirror before its own disk write and
    // enqueues after it. Handing `_setMirrorState` a finished object let that
    // late write restore a ledger the sync had just replaced — orphaning the
    // collection it had created in Steam.
    const backend = await loaded([{ appId: "620", name: "Portal 2" }]);
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

    holdWrite = true;
    const syncing = backend.syncMirror();
    await until("the sync's Steam write", () => releaseWrite !== null);
    // Deliberately not awaited, so the edit's own "a sync is owed" write races
    // the sync's ledger write. This pins the invariant rather than proving the
    // ordering — the interleaving that used to clobber the ledger needs the
    // two writes to land in one specific order, which a test can't force here.
    // The fix (an updater, resolved inside the lock) makes the order moot.
    const editing = backend.createCollection("Made mid-sync");
    releaseWrite?.();
    await Promise.all([syncing, editing]);
    await new Promise((r) => setTimeout(r, 20));

    const after = (await backend.getConfig()).config.mirror.ledger.entries;
    expect(after.map((e) => e.managedId)).toContain("backlog");
  });

  it("reports the membership a created collection was given", async () => {
    // The fake used to drop `appIds` on create, so a plan that created a
    // collection holding the wrong games was indistinguishable from one that
    // got it right.
    const backend = await loaded([
      { appId: "620", name: "Portal 2" },
      { appId: "400", name: "Portal" },
    ]);
    await backend.createCollection("Installed");
    const { config } = await backend.getConfig();
    await backend.setCollections([
      {
        ...config.collections[0]!,
        root: {
          kind: "group",
          id: "installed-root",
          combinator: "all",
          children: [{ id: "r1", kind: "installed" }],
        },
      },
    ]);

    await backend.syncMirror();
    expect(fakeCollections[0]!.appIds.sort()).toEqual(["400", "620"]);
  });
});

describe("things happening at once", () => {
  /** A managed collection with one rule, ready to mirror. */
  async function ready(backend: Awaited<ReturnType<typeof loaded>>, label: string) {
    await backend.createCollection(label);
    const { config } = await backend.getConfig();
    const made = config.collections.find((c) => c.label === label)!;
    await backend.setCollections(
      config.collections.map((c) =>
        c.id === made.id
          ? {
              ...c,
              root: {
                kind: "group" as const,
                id: `${c.id}-root`,
                combinator: "all" as const,
                children: [{ id: "r1", kind: "installed" as const }],
              },
            }
          : c,
      ),
    );
    return made.id;
  }

  it("does not create the collection twice when two syncs overlap", async () => {
    // Every overlap used to be able to leak a Steam collection nothing could
    // clean up: two plans built from the same ledger, both seeing no entry.
    const backend = await loaded([{ appId: "620", name: "Portal 2" }]);
    await ready(backend, "Backlog");

    await Promise.all([backend.syncMirror(), backend.syncMirror()]);

    expect(fakeCollections.filter((c) => c.name === "Backlog")).toHaveLength(1);
    expect((await backend.getConfig()).config.mirror.ledger.entries).toHaveLength(1);
  });

  it("does not lose one edit to another that lands during it", async () => {
    // Both callers build their next config from `this.config` before taking
    // the lock; the second used to overwrite the first's collection.
    const backend = await loaded();
    await Promise.all([
      backend.createCollection("Backlog"),
      backend.createCollection("Shooters"),
    ]);
    const labels = (await backend.getConfig()).config.collections.map((c) => c.label);
    expect(labels.sort()).toEqual(["Backlog", "Shooters"]);
  });

  it("gives two collections made at once different ids", async () => {
    const backend = await loaded();
    await Promise.all([backend.createCollection("Backlog"), backend.createCollection("Backlog")]);
    const ids = (await backend.getConfig()).config.collections.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never pairs one reading of the rules with another reading of the config", async () => {
    // The plan used to read `this.config.collections` twice with awaits in
    // between: once to evaluate, once to plan. A rule saved in that window
    // paired the *new* tree with the *old* evaluation — and a collection with
    // no rules evaluates to the whole library, so it stopped being skipped and
    // went to Steam holding everything. Reverting the capture-once change must
    // fail here.
    const backend = await loaded([
      { appId: "620", name: "Portal 2" },
      { appId: "400", name: "Portal" },
      { appId: "500", name: "Left 4 Dead" },
    ]);
    await backend.createCollection("Backlog"); // no rules: matches everything
    const { config } = await backend.getConfig();
    const ruled = {
      ...config.collections[0]!,
      root: {
        kind: "group" as const,
        id: "backlog-root",
        combinator: "all" as const,
        children: [{ id: "r1", kind: "installed" as const, invert: true }],
      },
    };

    // The plan's Steam read is held open, so the rule save lands between the
    // evaluation and the planning — the exact window.
    hangSteamOnce = true;
    const syncing = backend.syncMirror();
    await until("the plan's Steam read", () => releaseSteamRead !== null);
    await backend.setCollections([ruled]);
    releaseSteamRead?.();
    await syncing;

    // Either it was skipped as rule-less, or it was written with the
    // membership its rules actually produce. What it must never be is present
    // in Steam holding the whole library.
    const written = fakeCollections.find((c) => c.name === "Backlog");
    expect(written?.appIds.length ?? 0).toBeLessThan(3);
  });

  it("keeps the sync owed when an edit lands while it is writing", async () => {
    // The edit was never in that plan. Clearing its flag records it as synced
    // and leaves Steam quietly wrong until something unrelated syncs again.
    const backend = await loaded([{ appId: "620", name: "Portal 2" }]);
    await ready(backend, "Backlog");

    // The write is held open, so the edit provably lands mid-sync rather than
    // whenever the scheduler happens to run it.
    holdWrite = true;
    const syncing = backend.syncMirror();
    await until("the sync's Steam write", () => releaseWrite !== null);
    await backend.createCollection("Made mid-sync");
    releaseWrite?.();
    await syncing;

    expect((await backend.getConfig()).config.mirror.pendingSync).toBe(true);
  });
});

describe("a sync against a library that didn't load", () => {
  // Both library sources degrade to empty on failure, and a sync rewrites
  // whole memberships — so a half-loaded library doesn't produce a smaller
  // sync, it empties every collection we own. Every sync test in this file
  // used to run in exactly that state without anyone noticing.
  it("refuses rather than emptying every mirrored collection", async () => {
    const backend = await loaded([{ appId: "620", name: "Portal 2" }]);
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
    expect(fakeCollections[0]!.appIds).toEqual(["620"]);

    // Now the library read comes back empty, the way it does while Steam is
    // still hydrating — the moment `onLoad`'s owed sync fires.
    emptyLibrary = true;
    await expect(backend.syncMirror()).rejects.toThrow(/library isn't loaded/);

    expect(fakeCollections[0]!.appIds).toEqual(["620"]);
    expect((await backend.getConfig()).config.mirror.pendingSync).toBe(true);
  });
});

describe("a collection whose rules this build can't check", () => {
  it("is refused rather than mirrored as the whole library", async () => {
    // An unresolvable fact evaluates to `indeterminate`, which the default
    // policy counts as a match — so the collection matches everything and,
    // without this, Steam gets a copy of the library.
    const backend = await loaded([
      { appId: "620", name: "Portal 2" },
      { appId: "400", name: "Portal" },
    ]);
    await backend.createCollection("Short games");
    const { config } = await backend.getConfig();
    await backend.setCollections([
      {
        ...config.collections[0]!,
        root: {
          kind: "group",
          id: "short-games-root",
          combinator: "all",
          children: [{ id: "r1", kind: "hltbMain", hours: { max: 10 } }],
        },
      },
    ]);

    const report = await backend.syncMirror();
    expect(report.created).toBe(0);
    expect(fakeCollections).toHaveLength(0);
    expect(report.blocked[0]!.reason).toMatch(/can't check/);
  });
});

describe("a sync that half lands", () => {
  it("keeps the flag raised so the rest is retried", async () => {
    const backend = await loaded([{ appId: "620", name: "Portal 2" }]);
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

    // A first sync creates rather than updates, so the create is the write to
    // break.
    failNextWrite = "create";
    const report = await backend.syncMirror();

    expect(report.failures.length).toBeGreaterThan(0);
    expect((await backend.getConfig()).config.mirror.pendingSync).toBe(true);
  });
});

describe("writing straight to a Steam collection", () => {
  // These bypass planMirror's conflict guard by design, which makes them the
  // one family of writes with nothing protecting them — and they had no tests.
  beforeEach(() => {
    fakeCollections = [
      { id: "uc-1", name: "Mine", appIds: ["10"], isDynamic: false, isEditable: true },
    ];
  });

  it("renames the collection in Steam", async () => {
    const backend = await loaded();
    await backend.renameLinked("uc-1", "Renamed");
    expect(fakeCollections[0]!.name).toBe("Renamed");
  });

  it("deletes the collection in Steam", async () => {
    const backend = await loaded();
    expect(await backend.deleteLinked("uc-1")).toBe(true);
    expect(fakeCollections).toHaveLength(0);
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
    const backend = await loaded([{ appId: "620", name: "Portal 2" }]);
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
    const backend = await loaded([{ appId: "620", name: "Portal 2" }]);
    await mirrored(backend);
    expect(fakeCollections).toHaveLength(1);

    await backend.deleteCollection("backlog");
    expect(fakeCollections).toHaveLength(0);
    expect((await backend.getConfig()).config.mirror.ledger.entries).toEqual([]);
  });

  it("keeps the ledger row when Steam can't be reached, so the sync finishes it", async () => {
    const backend = await loaded([{ appId: "620", name: "Portal 2" }]);
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
