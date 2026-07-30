/**
 * Tier C — the mirror against a real Steam, with real writes.
 *
 * Everything else about the mirror is verified without hardware: the planner
 * is pure, the executor takes injected effects, and `mirror-agreement.test.ts`
 * runs the whole loop against a Map. What none of that can prove is the part
 * that only Steam knows:
 *
 *   - that `SaveCollection` actually persisted, rather than leaving a
 *     collection that looks perfect and vanishes on restart;
 *   - that Steam's **own index** — `GetCollectionListForAppID`, which the
 *     library UI renders from — picks the collection up. A collection that
 *     exists but isn't indexed is invisible to the user, which is the entire
 *     thing we are trying to achieve.
 *
 * Gated behind `LOADOUT_LIVE_WRITES=1`. Read the destructive-risk register in
 * the plan first: this creates and deletes collections on the signed-in
 * account, and Steam Cloud syncs them to the user's other machines before
 * cleanup runs. That is unavoidable and is the price of testing this at all.
 *
 * Safety, in order of how much damage it prevents:
 *
 *   1. Only ids **created by this process** are ever deleted. Never by name.
 *   2. Every name carries a per-run random `zzz-loadout-livetest-` prefix.
 *   3. A precondition fails — with an instruction, not an auto-delete — if any
 *      collection already carries the prefix.
 *   4. `afterAll` diffs the *entire* collection list against the snapshot taken
 *      before the first write. Not "ours is gone": *nothing else moved*.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  collectionsForApp,
  createCollection,
  deleteCollection,
  listCollections,
  readSteamLibrary,
  renameCollection,
  setCollectionApps,
  withSteamClient,
  type SteamCollectionInfo,
} from "@loadout/steam-cdp";
import {
  LIVE_TEST_PREFIX,
  acquireLiveLock,
  liveTestCollectionName,
  requireSteam,
  requireWrites,
  skipAllowed,
} from "./steam-guard";

/** Ids this run created. The only ids it is ever allowed to delete. */
const created = new Set<string>();
let release: (() => Promise<void>) | null = null;
let before: SteamCollectionInfo[] = [];
let sampleAppIds: string[] = [];
let active = false;

/** A stable, order-independent description of a collection, for the diff. */
function fingerprint(c: SteamCollectionInfo): string {
  return JSON.stringify({
    id: c.id,
    name: c.name,
    appIds: [...c.appIds].sort(),
    isDynamic: c.isDynamic,
  });
}

function snapshotOf(list: SteamCollectionInfo[]): Map<string, string> {
  return new Map(list.map((c) => [c.id, fingerprint(c)] as const));
}

beforeAll(async () => {
  if (skipAllowed()) return;
  requireWrites();
  await requireSteam();
  release = await acquireLiveLock();

  before = await withSteamClient((client) => listCollections(client));

  // Leftovers from an interrupted run. Deleting them automatically is exactly
  // the behaviour this suite exists to prove we never have, so it stops and
  // tells the operator instead.
  const strays = before.filter((c) => c.name.startsWith(LIVE_TEST_PREFIX));
  if (strays.length > 0) {
    throw new Error(
      `Found ${strays.length} leftover test collection(s) from an interrupted run:\n` +
        strays.map((c) => `  ${c.id}  ${c.name}`).join("\n") +
        "\n\nDelete them in Steam, then re-run. This suite will not delete " +
        "collections it did not create.",
    );
  }

  const library = await withSteamClient((client) => readSteamLibrary(client));
  // Real appIds, because Steam's index silently ignores ids it doesn't own —
  // a made-up id would make every assertion here vacuously pass.
  sampleAppIds = library.entries.slice(0, 3).map((e) => e.appId);
  expect(sampleAppIds.length).toBe(3);
  active = true;
});

afterAll(async () => {
  try {
    if (!active) return;

    for (const id of created) {
      await withSteamClient((client) => deleteCollection(client, { collectionId: id }));
    }

    // The collateral-damage check. Anything in here means this suite touched
    // something it had no business touching, and the operator needs to know
    // before they trust the mirror with their library.
    const after = await withSteamClient((client) => listCollections(client));
    const beforeMap = snapshotOf(before);
    const afterMap = snapshotOf(after);

    const added = [...afterMap.keys()].filter((id) => !beforeMap.has(id));
    const removed = [...beforeMap.keys()].filter((id) => !afterMap.has(id));
    const changed = [...beforeMap.entries()]
      .filter(([id, fp]) => afterMap.has(id) && afterMap.get(id) !== fp)
      .map(([id]) => id);

    expect({ added, removed, changed }).toEqual({ added: [], removed: [], changed: [] });
  } finally {
    await release?.();
  }
});

describe("mirror round-trip against real Steam", () => {
  it("creates a collection that Steam's own index can see", async () => {
    if (skipAllowed()) return;
    const name = liveTestCollectionName("create");

    const made = await withSteamClient((client) =>
      createCollection(client, { name, appIds: sampleAppIds.slice(0, 2) }),
    );
    created.add(made.id);

    expect(made.name).toBe(name);
    expect([...made.appIds].sort()).toEqual([...sampleAppIds.slice(0, 2)].sort());

    // The assertion that matters: Steam's library UI renders from this index,
    // not from `userCollections`. A collection missing here is one the user
    // cannot see, however correct it looks to us.
    const indexed = await withSteamClient((client) =>
      collectionsForApp(client, { appId: sampleAppIds[0]! }),
    );
    expect(indexed).toContain(made.id);
  });

  it("survives a fresh session — it was saved, not just made", async () => {
    if (skipAllowed()) return;
    const name = liveTestCollectionName("persist");

    const made = await withSteamClient((client) =>
      createCollection(client, { name, appIds: [sampleAppIds[0]!] }),
    );
    created.add(made.id);

    // A separate `withSteamClient` call: a new CDP session, a new read. An
    // unsaved collection lives in the page's memory and would still be there
    // for a same-session read, which is why that read proves nothing.
    const reread = await withSteamClient((client) => listCollections(client));
    const found = reread.find((c) => c.id === made.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe(name);
    expect(found!.appIds).toEqual([sampleAppIds[0]!]);
  });

  it("replaces membership rather than only ever adding to it", async () => {
    if (skipAllowed()) return;
    // `addAppToCollection` — the pre-existing helper — can only add. A mirror
    // that cannot remove would grow forever as rules narrow.
    const made = await withSteamClient((client) =>
      createCollection(client, {
        name: liveTestCollectionName("replace"),
        appIds: sampleAppIds,
      }),
    );
    created.add(made.id);

    const target = [sampleAppIds[2]!];
    await withSteamClient((client) =>
      setCollectionApps(client, { collectionId: made.id, appIds: target }),
    );

    const reread = await withSteamClient((client) => listCollections(client));
    expect(reread.find((c) => c.id === made.id)!.appIds).toEqual(target);

    // And the removed app no longer lists it — Steam's index kept up.
    const indexed = await withSteamClient((client) =>
      collectionsForApp(client, { appId: sampleAppIds[0]! }),
    );
    expect(indexed).not.toContain(made.id);
  });

  it("renames in place, keeping the id the ledger holds", async () => {
    if (skipAllowed()) return;
    const made = await withSteamClient((client) =>
      createCollection(client, {
        name: liveTestCollectionName("before-rename"),
        appIds: [sampleAppIds[0]!],
      }),
    );
    created.add(made.id);

    const renamed = liveTestCollectionName("after-rename");
    await withSteamClient((client) =>
      renameCollection(client, { collectionId: made.id, name: renamed }),
    );

    const reread = await withSteamClient((client) => listCollections(client));
    const found = reread.find((c) => c.id === made.id);
    // A rename that re-created the collection would orphan the one our ledger
    // points at, and the next sync would create a third.
    expect(found).toBeDefined();
    expect(found!.name).toBe(renamed);
    expect(found!.appIds).toEqual([sampleAppIds[0]!]);
    expect(reread.filter((c) => c.name.startsWith(LIVE_TEST_PREFIX)).length).toBe(created.size);
  });

  it("deletes by id, and the app stops listing it", async () => {
    if (skipAllowed()) return;
    const made = await withSteamClient((client) =>
      createCollection(client, {
        name: liveTestCollectionName("delete"),
        appIds: [sampleAppIds[1]!],
      }),
    );

    const gone = await withSteamClient((client) =>
      deleteCollection(client, { collectionId: made.id }),
    );
    expect(gone).toBe(true);

    const indexed = await withSteamClient((client) =>
      collectionsForApp(client, { appId: sampleAppIds[1]! }),
    );
    expect(indexed).not.toContain(made.id);
  });

  it("reports an already-absent collection as done, not as an error", async () => {
    if (skipAllowed()) return;
    // A ledger entry for a collection deleted on another machine must not
    // wedge every future sync.
    const gone = await withSteamClient((client) =>
      deleteCollection(client, { collectionId: "uc-does-not-exist-0000" }),
    );
    expect(gone).toBe(false);
  });

  it("refuses to write to one of Steam's dynamic collections", async () => {
    if (skipAllowed()) return;
    const all = await withSteamClient((client) => listCollections(client));
    const dynamic = all.find((c) => c.isDynamic);
    if (!dynamic) return; // account has none; nothing to assert

    await expect(
      withSteamClient((client) =>
        setCollectionApps(client, { collectionId: dynamic.id, appIds: [] }),
      ),
    ).rejects.toThrow(/dynamic|editable/);
  });
});
