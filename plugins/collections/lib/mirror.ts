/**
 * What syncing the mirror *would* do.
 *
 * This is the whole reason a collection built here appears in Steam's own UI
 * without patching Steam. TabMaster injects itself into the library's React
 * tree by hot-swapping the `useMemo` dispatcher; when that breaks, the library
 * becomes unreachable and users report rebooting nineteen times. We write real
 * Steam collections instead, which Steam renders natively and which survive us
 * being uninstalled.
 *
 * The planner is **pure and CDP-free** for two reasons. It is the part that can
 * destroy user data — a wrong id here deletes a collection someone spent an
 * evening curating — so it must be exhaustively testable without a Steam. And
 * the UI needs to show a dry run *before* anything is written, which is only
 * possible if planning and executing are separate steps.
 *
 * Identity comes from the ledger, never from a collection's name. Names are the
 * user's; matching on them would let a collection called "Backlog" quietly take
 * over one the user made by hand years ago.
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
  /**
   * Managed ids whose rules this build cannot actually evaluate — a rule
   * reading a fact no resolver supplies.
   *
   * Such a rule returns `indeterminate`, which the default policy counts as a
   * match, so the collection quietly matches the **whole library**. Writing
   * that to Steam is the same accident `unbuilt` exists to prevent, reached by
   * a different door: the rule looks built, and the membership looks huge
   * because it is.
   */
  unevaluable?: ReadonlySet<string>;
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
  const {
    collections,
    evaluated,
    ledger,
    steamCollections,
    namePrefix = "",
    unevaluable = new Set<string>(),
  } = args;
  const plan = emptyPlan();

  const steamById = new Map(steamCollections.map((c) => [c.id, c]));
  const ledgerByManaged = new Map(ledger.entries.map((e) => [e.managedId, e]));
  const managedById = new Map(collections.map((c) => [c.id, c]));

  /**
   * A collection with no rules matches the whole library, which is never what
   * anybody wants written into Steam — and it is exactly what an accidental
   * "New" produces before a single rule has been added.
   *
   * Measured on a real device: three such collections had been created and
   * auto-synced, putting three 2500-app collections into Steam and making both
   * Steam and the grid crawl. Skipping them is the difference between a stray
   * press costing nothing and costing 2500 Cloud writes.
   *
   * Skipped, not deleted: an existing Steam collection is left exactly as it
   * is, so removing the last rule from something you already mirrored never
   * silently destroys it. Deleting the collection here is still the way to
   * remove it from Steam.
   */
  const unbuilt = (collection: ManagedCollection) => collection.root.children.length === 0;

  /**
   * Why this collection must not be written, or null if it may be.
   *
   * `mirrored` changes what the refusal is *about*. For a collection Steam has
   * never seen, refusing prevents the accident. For one already in Steam —
   * mirrored by an earlier build that had no such guard, so its Steam
   * collection is the whole library right now — refusing only stops it getting
   * worse, and saying "would put your whole library in Steam" describes a
   * thing that has already happened. Say what is actually true, and what to do
   * about it: this planner never deletes on the user's behalf.
   */
  const refuse = (collection: ManagedCollection, mirrored: boolean): string | null => {
    if (unbuilt(collection)) {
      return mirrored
        ? `"${collection.label}" has no rules, so it is left exactly as it is in Steam. ` +
            `Add a rule to sync it, or delete it to remove it from Steam.`
        : `"${collection.label}" has no rules yet, so it would match your whole library.`;
    }
    if (unevaluable.has(collection.id)) {
      const why =
        `"${collection.label}" has a rule this build can't check, and an unchecked rule ` +
        `matches every game.`;
      return mirrored
        ? `${why} Its Steam collection is left as it is — which may be your whole library, ` +
            `if it was synced before. Delete it, or change the rule.`
        : `${why} Syncing it would put your whole library in Steam.`;
    }
    return null;
  };

  // Two passes, because a create has to know what the renames will free.
  // Swapping two collections' names is otherwise reported as a conflict
  // forever: the new one's name is held by a collection that is, in this very
  // plan, about to stop using it.
  //
  // Pass 1 — collections we already own a Steam collection for.
  for (const collection of collections) {
    const entry = ledgerByManaged.get(collection.id);
    if (!entry) continue;
    const refusal = refuse(collection, true);
    if (refusal) {
      plan.skipped.push({ managedId: collection.id, reason: refusal });
      continue;
    }

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
    const refusal = refuse(collection, false);
    if (refusal) {
      plan.skipped.push({ managedId: collection.id, reason: refusal });
      continue;
    }

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
 * Compared as a **projection**, which means the field list is a whitelist, not
 * a default. A new membership-affecting field on {@link ManagedCollection} —
 * an exclude list, a per-collection cap — would not mark a sync owed until
 * somebody remembered to add it, and Steam then goes silently stale, which is
 * the failure users can't see. {@link COLLECTION_FIELDS} is what stops that
 * being a matter of remembering.
 *
 * Being too eager costs a redundant sync; being too lazy costs correctness, so
 * when in doubt, classify the field as `membership`.
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
  settings: { namePrefix: string };
  mirror: { autoSync: boolean };
}

/**
 * Every field of a managed collection, classified by whether changing it can
 * change what Steam ends up holding.
 *
 * Keyed on `keyof ManagedCollection` and **in a compiled module**, not a test:
 * `tsconfig.json` excludes `*.test.ts`, so the same map in a spec file would
 * never be typechecked and a new field would sail past it. Here, adding one to
 * the type fails the build until somebody classifies it — which is the whole
 * point, since the alternative failure is silent and lands on the user's Steam
 * library.
 */
const COLLECTION_FIELDS: Record<keyof ManagedCollection, "membership" | "cosmetic"> = {
  id: "membership",
  // The name reaches Steam, so a rename is a sync-worthy change.
  label: "membership",
  root: "membership",
  sort: "membership",
  limit: "membership",
  manualOrder: "membership",
  indeterminatePolicy: "membership",
  display: "cosmetic",
  icon: "cosmetic",
};

const MEMBERSHIP_FIELDS = (Object.keys(COLLECTION_FIELDS) as Array<keyof ManagedCollection>).filter(
  (key) => COLLECTION_FIELDS[key] === "membership",
);

function project(config: MirrorRelevantConfig) {
  return {
    // Derived from the classification rather than restating it: two lists that
    // have to agree eventually don't.
    collections: config.collections.map((c) =>
      Object.fromEntries(MEMBERSHIP_FIELDS.map((key) => [key, c[key]])),
    ),
    // Whitelists and blacklists live here, so they change membership.
    overrides: config.gameOverrides,
    prefix: config.settings.namePrefix,
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
