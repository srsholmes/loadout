/**
 * What syncing the mirror *would* do. [iso]
 *
 * This is the whole reason tabs can appear in Steam's own UI without patching
 * Steam. TabMaster injects itself into the library's React tree by hot-swapping
 * the `useMemo` dispatcher; when that breaks, the library becomes unreachable
 * and users report rebooting nineteen times. We write real Steam collections
 * instead, which Steam renders natively and which survive us being uninstalled.
 *
 * The planner is **pure and CDP-free** for two reasons. It is the part that can
 * destroy user data — a wrong id here deletes a collection someone spent an
 * evening curating — so it must be exhaustively testable without a Steam. And
 * the UI needs to show a dry run *before* anything is written, which is only
 * possible if planning and executing are separate steps.
 *
 * Identity comes from the ledger, never from a collection's name. Names are the
 * user's; matching on them would let a tab called "Backlog" quietly take over a
 * collection the user made by hand years ago.
 */

import type { MirrorLedger, MirrorLedgerEntry, ManagedCollection } from "./types";

/** A Steam collection as `collectionStore` reports it. */
export interface SteamCollection {
  id: string;
  name: string;
  appIds: string[];
  /** Tag/filter-driven. Steam owns the contents; we must never write to one. */
  isDynamic: boolean;
  isEditable: boolean;
}

export interface MirrorPlan {
  creates: Array<{ managedId: string; name: string; appIds: string[] }>;
  updates: Array<{
    managedId: string;
    steamCollectionId: string;
    name: string;
    /** The membership to end up with. This is what gets written. */
    appIds: string[];
    /** `add`/`remove` are for the dry run to describe; they are not the write. */
    add: string[];
    remove: string[];
  }>;
  renames: Array<{
    managedId: string;
    steamCollectionId: string;
    from: string;
    to: string;
  }>;
  deletes: Array<{
    managedId: string;
    steamCollectionId: string;
    name: string;
    /**
     * Only one reason remains. Every managed collection syncs, so the sole way
     * to reach a delete is to remove the collection here — the old
     * "mirror-disabled" path went away with the per-collection opt-in.
     */
    reason: "collection-deleted";
  }>;
  /** Our target name is taken by a collection that isn't ours. Needs consent. */
  conflicts: Array<{
    managedId: string;
    name: string;
    existingCollectionId: string;
    existingCount: number;
  }>;
  /** Our collection changed in Steam since we last wrote it. */
  drifted: Array<{
    managedId: string;
    steamCollectionId: string;
    unexpectedAdds: string[];
    unexpectedRemoves: string[];
  }>;
  /** The ledger points at a collection Steam no longer has. */
  orphaned: Array<{ managedId: string; steamCollectionId: string }>;
  /** Collections already in the right state. */
  noops: string[];
  /** Collections we refuse to touch, with a sentence explaining why. */
  skipped: Array<{ managedId: string; reason: string }>;
}

export interface PlanMirrorArgs {
  collections: readonly ManagedCollection[];
  /** managedId -> the appIds that collection currently matches, post-cap. */
  evaluated: ReadonlyMap<string, readonly string[]>;
  ledger: MirrorLedger;
  steamCollections: readonly SteamCollection[];
  /** Optional prefix for the collection name. Empty by default. */
  namePrefix?: string;
}

function emptyPlan(): MirrorPlan {
  return {
    creates: [],
    updates: [],
    renames: [],
    deletes: [],
    conflicts: [],
    drifted: [],
    orphaned: [],
    noops: [],
    skipped: [],
  };
}

/** Set difference, order-stable. */
function without(from: readonly string[], remove: ReadonlySet<string>): string[] {
  return from.filter((id) => !remove.has(id));
}

/**
 * The Steam collection name a managed collection takes.
 *
 * Straight from `label`. The previous model carried a separate
 * `mirror.collectionName`, which let the two drift — so renaming a collection
 * here silently failed to rename it in Steam.
 */
export function collectionNameFor(
  collection: ManagedCollection,
  namePrefix = "",
): string {
  return `${namePrefix}${collection.label.trim()}`;
}

/**
 * Work out the writes a sync would perform. Performs none of them.
 *
 * Ordering note for the executor: run `deletes` before `creates`, so renaming
 * a collection and reusing the old name in the same sync doesn't collide.
 */
export function planMirror(args: PlanMirrorArgs): MirrorPlan {
  const { collections, evaluated, ledger, steamCollections, namePrefix = "" } = args;
  const plan = emptyPlan();

  const steamById = new Map(steamCollections.map((c) => [c.id, c]));
  const ledgerByManaged = new Map(ledger.entries.map((e) => [e.managedId, e]));
  const managedById = new Map(collections.map((c) => [c.id, c]));

  // Two passes, because a create has to know what the renames will free.
  // Swapping two collections' names is otherwise reported as a conflict
  // forever: the new one's name is held by a collection that is, in this very
  // plan, about to stop using it.
  //
  // Pass 1 — collections we already own a Steam collection for.
  for (const collection of collections) {
    const entry = ledgerByManaged.get(collection.id);
    if (!entry) continue;

    const wanted = [...(evaluated.get(collection.id) ?? [])];
    const name = collectionNameFor(collection, namePrefix);
    // `steam*` throughout: both sides are called "collection" now, and the
    // one place that must never be confused is the one that issues deletes.
    const steam = steamById.get(entry.steamCollectionId);
    if (!steam) {
      // We have a ledger entry but Steam has no such collection — deleted on
      // another machine, or Cloud lost it. Re-create rather than guess.
      plan.orphaned.push({
        managedId: collection.id,
        steamCollectionId: entry.steamCollectionId,
      });
      plan.creates.push({ managedId: collection.id, name, appIds: wanted });
      continue;
    }

    if (steam.isDynamic || !steam.isEditable) {
      // Steam owns a dynamic collection's contents; writing to one either fails
      // or fights Steam forever.
      plan.skipped.push({
        managedId: collection.id,
        reason: `"${steam.name}" is a dynamic Steam collection, so its contents can't be set.`,
      });
      continue;
    }

    // Did it change in Steam since we last wrote it? Compare against what WE
    // wrote, not against what the rules now match — otherwise every rule edit
    // looks like user drift.
    const lastWritten = new Set(entry.appIds);
    const live = new Set(steam.appIds);
    const unexpectedAdds = steam.appIds.filter((id) => !lastWritten.has(id));
    const unexpectedRemoves = entry.appIds.filter((id) => !live.has(id));
    if (unexpectedAdds.length > 0 || unexpectedRemoves.length > 0) {
      plan.drifted.push({
        managedId: collection.id,
        steamCollectionId: entry.steamCollectionId,
        unexpectedAdds,
        unexpectedRemoves,
      });
    }

    if (steam.name !== name) {
      plan.renames.push({
        managedId: collection.id,
        steamCollectionId: entry.steamCollectionId,
        from: steam.name,
        to: name,
      });
    }

    const add = without(wanted, live);
    const remove = without(steam.appIds, new Set(wanted));
    if (add.length === 0 && remove.length === 0) {
      if (steam.name === name) plan.noops.push(collection.id);
      continue;
    }

    plan.updates.push({
      managedId: collection.id,
      steamCollectionId: entry.steamCollectionId,
      name,
      appIds: wanted,
      add,
      remove,
    });
  }

  // ── Ledger rows whose collection no longer exists here ──────────────
  for (const entry of ledger.entries) {
    // Every managed collection syncs, so the only way to reach a delete is
    // for the collection to have been removed from this plugin.
    if (managedById.has(entry.managedId)) continue;

    // Only ever delete a collection whose id we recorded ourselves. One we
    // did not create is never deleted, full stop.
    if (!steamById.has(entry.steamCollectionId)) continue;

    plan.deletes.push({
      managedId: entry.managedId,
      steamCollectionId: entry.steamCollectionId,
      name: entry.steamName,
      reason: "collection-deleted",
    });
  }

  // Which names are still spoken for once the deletes and renames above have
  // run — the executor performs them first for exactly this reason.
  const takenAfterPlan = new Map(steamCollections.map((c) => [c.name, c] as const));
  for (const del of plan.deletes) takenAfterPlan.delete(del.name);
  for (const ren of plan.renames) takenAfterPlan.delete(ren.from);
  for (const ren of plan.renames) {
    const steam = steamById.get(ren.steamCollectionId);
    if (steam) takenAfterPlan.set(ren.to, steam);
  }

  // Pass 2 — collections with no Steam collection yet.
  for (const collection of collections) {
    if (ledgerByManaged.has(collection.id)) continue;

    const wanted = [...(evaluated.get(collection.id) ?? [])];
    const name = collectionNameFor(collection, namePrefix);

    // Adopting a same-named collection we did not create would silently
    // replace whatever the user had in it.
    const clash = takenAfterPlan.get(name);
    if (clash) {
      plan.conflicts.push({
        managedId: collection.id,
        name,
        existingCollectionId: clash.id,
        existingCount: clash.appIds.length,
      });
      continue;
    }

    plan.creates.push({ managedId: collection.id, name, appIds: wanted });
    // Two brand-new collections asking for the same name is a conflict between
    // them, not a free pass for whichever is second.
    takenAfterPlan.set(name, {
      id: `(pending:${collection.id})`,
      name,
      appIds: wanted,
      isDynamic: false,
      isEditable: true,
    });
  }

  return plan;
}

/**
 * Would this config change alter what the mirror should contain?
 *
 * Auto-sync hangs off this. Two things make it necessary rather than nice:
 * a sync is a full library evaluation plus writes to Steam Cloud, so running
 * one because the user hid a tab would be waste; and `syncMirror` persists its
 * ledger through the same config setter that triggers auto-sync, so without a
 * check on *what* changed the mirror would sync itself in a loop forever.
 *
 * Compared as a projection rather than field-by-field, so a new field on `Tab`
 * is included by default. Being too eager here costs a redundant sync; being
 * too lazy leaves Steam silently stale, which is the failure users can't see.
 */
export function mirrorAffecting(
  before: MirrorRelevantConfig,
  after: MirrorRelevantConfig,
): boolean {
  return JSON.stringify(project(before)) !== JSON.stringify(project(after));
}

/** The parts of the plugin config a mirror sync actually reads. */
export interface MirrorRelevantConfig {
  collections: readonly ManagedCollection[];
  gameOverrides: Record<string, unknown>;
  settings: { mirrorPrefix: string };
  mirror: { autoSync: boolean };
}

function project(config: MirrorRelevantConfig) {
  return {
    collections: config.collections.map((c) => ({
      id: c.id,
      // The name reaches Steam, so a rename is a sync-worthy change.
      label: c.label,
      root: c.root,
      sort: c.sort,
      limit: c.limit,
      manualOrder: c.manualOrder,
      policy: c.indeterminatePolicy,
    })),
    // Whitelists and blacklists live here, so they change membership.
    overrides: config.gameOverrides,
    prefix: config.settings.mirrorPrefix,
    autoSync: config.mirror.autoSync,
  };
}


/** Does this plan write anything? Used to keep "Sync" honest when it wouldn't. */
export function planIsEmpty(plan: MirrorPlan): boolean {
  return (
    plan.creates.length === 0 &&
    plan.updates.length === 0 &&
    plan.renames.length === 0 &&
    plan.deletes.length === 0
  );
}

/** One-line summary for the dry run: "create 2, update 3, delete 1". */
export function summarizePlan(plan: MirrorPlan): string {
  const parts: string[] = [];
  if (plan.creates.length) parts.push(`create ${plan.creates.length}`);
  if (plan.updates.length) parts.push(`update ${plan.updates.length}`);
  if (plan.renames.length) parts.push(`rename ${plan.renames.length}`);
  if (plan.deletes.length) parts.push(`delete ${plan.deletes.length}`);
  if (parts.length === 0) return "Everything is already in sync";
  return `Sync will ${parts.join(", ")}`;
}

/** Apply a completed sync to the ledger. Pure; the caller persists it. */
export function applyToLedger(args: {
  ledger: MirrorLedger;
  plan: MirrorPlan;
  /** managedId -> the appIds actually written, and where they went. */
  written: ReadonlyMap<
    string,
    { steamCollectionId: string; name: string; appIds: string[] }
  >;
  now: number;
}): MirrorLedger {
  const { ledger, plan, written, now } = args;
  const deleted = new Set(plan.deletes.map((d) => d.managedId));

  const entries: MirrorLedgerEntry[] = ledger.entries
    .filter((e) => !deleted.has(e.managedId))
    .map((e) => {
      const update = written.get(e.managedId);
      return update
        ? {
            managedId: e.managedId,
            steamCollectionId: update.steamCollectionId,
            steamName: update.name,
            appIds: update.appIds,
            lastSyncedAt: now,
          }
        : e;
    });

  const known = new Set(entries.map((e) => e.managedId));
  for (const [managedId, update] of written) {
    if (known.has(managedId)) continue;
    entries.push({
      managedId,
      steamCollectionId: update.steamCollectionId,
      steamName: update.name,
      appIds: update.appIds,
      lastSyncedAt: now,
    });
  }

  return { version: 1, entries };
}
