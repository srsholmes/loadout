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

import type { MirrorLedger, MirrorLedgerEntry, Tab } from "./types";

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
  creates: Array<{ tabId: string; name: string; appIds: string[] }>;
  updates: Array<{
    tabId: string;
    collectionId: string;
    name: string;
    /** The membership to end up with. This is what gets written. */
    appIds: string[];
    /** `add`/`remove` are for the dry run to describe; they are not the write. */
    add: string[];
    remove: string[];
  }>;
  renames: Array<{ tabId: string; collectionId: string; from: string; to: string }>;
  deletes: Array<{
    tabId: string;
    collectionId: string;
    name: string;
    reason: "tab-deleted" | "mirror-disabled";
  }>;
  /** Our target name is taken by a collection that isn't ours. Needs consent. */
  conflicts: Array<{
    tabId: string;
    name: string;
    existingCollectionId: string;
    existingCount: number;
  }>;
  /** Our collection changed in Steam since we last wrote it. */
  drifted: Array<{
    tabId: string;
    collectionId: string;
    unexpectedAdds: string[];
    unexpectedRemoves: string[];
  }>;
  /** The ledger points at a collection Steam no longer has. */
  orphaned: Array<{ tabId: string; collectionId: string }>;
  /** Tabs already in the right state. */
  noops: string[];
  /** Tabs we refuse to touch, with a sentence explaining why. */
  skipped: Array<{ tabId: string; reason: string }>;
}

export interface PlanMirrorArgs {
  tabs: readonly Tab[];
  /** tabId -> the appIds that tab currently matches, post-cap. */
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

/** The collection name a tab should mirror into. */
export function collectionNameFor(tab: Tab, namePrefix = ""): string {
  const base = tab.mirror.collectionName.trim() || tab.label;
  return `${namePrefix}${base}`;
}

/**
 * Work out the writes a sync would perform. Performs none of them.
 *
 * Ordering note for the executor: run `deletes` before `creates`, so renaming a
 * tab and reusing the old name in the same sync doesn't collide.
 */
export function planMirror(args: PlanMirrorArgs): MirrorPlan {
  const { tabs, evaluated, ledger, steamCollections, namePrefix = "" } = args;
  const plan = emptyPlan();

  const byId = new Map(steamCollections.map((c) => [c.id, c]));
  const ledgerByTab = new Map(ledger.entries.map((e) => [e.tabId, e]));
  const tabById = new Map(tabs.map((t) => [t.id, t]));

  const mirroring = tabs.filter((t) => t.mirror.enabled);

  // Two passes, because a create has to know what the renames will free.
  // Swapping two tabs' names is otherwise reported as a conflict forever: the
  // new tab's name is held by a collection that is, in this very plan, about
  // to stop using it.
  //
  // Pass 1 — tabs we already own a collection for.
  for (const tab of mirroring) {
    const entry = ledgerByTab.get(tab.id);
    if (!entry) continue;

    const wanted = [...(evaluated.get(tab.id) ?? [])];
    const name = collectionNameFor(tab, namePrefix);
    const collection = byId.get(entry.collectionId);
    if (!collection) {
      // We have a ledger entry but Steam has no such collection — deleted on
      // another machine, or Cloud lost it. Re-create rather than guess.
      plan.orphaned.push({ tabId: tab.id, collectionId: entry.collectionId });
      plan.creates.push({ tabId: tab.id, name, appIds: wanted });
      continue;
    }

    if (collection.isDynamic || !collection.isEditable) {
      // Steam owns a dynamic collection's contents; writing to one either fails
      // or fights Steam forever.
      plan.skipped.push({
        tabId: tab.id,
        reason: `"${collection.name}" is a dynamic Steam collection, so its contents can't be set.`,
      });
      continue;
    }

    // Did the collection change in Steam since we last wrote it? Compare
    // against what WE wrote, not against what the tab now matches — otherwise
    // every rule change looks like user drift.
    const lastWritten = new Set(entry.appIds);
    const live = new Set(collection.appIds);
    const unexpectedAdds = collection.appIds.filter((id) => !lastWritten.has(id));
    const unexpectedRemoves = entry.appIds.filter((id) => !live.has(id));
    if (unexpectedAdds.length > 0 || unexpectedRemoves.length > 0) {
      plan.drifted.push({
        tabId: tab.id,
        collectionId: entry.collectionId,
        unexpectedAdds,
        unexpectedRemoves,
      });
    }

    if (collection.name !== name) {
      plan.renames.push({
        tabId: tab.id,
        collectionId: entry.collectionId,
        from: collection.name,
        to: name,
      });
    }

    const add = without(wanted, live);
    const remove = without(collection.appIds, new Set(wanted));
    if (add.length === 0 && remove.length === 0) {
      if (collection.name === name) plan.noops.push(tab.id);
      continue;
    }

    plan.updates.push({
      tabId: tab.id,
      collectionId: entry.collectionId,
      name,
      appIds: wanted,
      add,
      remove,
    });
  }

  // ── Ledger entries with no tab wanting them ─────────────────────────
  for (const entry of ledger.entries) {
    const tab = tabById.get(entry.tabId);
    if (tab?.mirror.enabled) continue;

    // Only ever delete a collection whose id we recorded ourselves. A
    // collection we did not create is never deleted, full stop.
    if (!byId.has(entry.collectionId)) continue;

    plan.deletes.push({
      tabId: entry.tabId,
      collectionId: entry.collectionId,
      name: entry.collectionName,
      reason: tab ? "mirror-disabled" : "tab-deleted",
    });
  }

  // Which names are still spoken for once the deletes and renames above have
  // run — the executor performs them first for exactly this reason.
  const takenAfterPlan = new Map(steamCollections.map((c) => [c.name, c] as const));
  for (const del of plan.deletes) takenAfterPlan.delete(del.name);
  for (const ren of plan.renames) takenAfterPlan.delete(ren.from);
  for (const ren of plan.renames) {
    const collection = byId.get(ren.collectionId);
    if (collection) takenAfterPlan.set(ren.to, collection);
  }

  // Pass 2 — tabs with no collection yet.
  for (const tab of mirroring) {
    if (ledgerByTab.has(tab.id)) continue;

    const wanted = [...(evaluated.get(tab.id) ?? [])];
    const name = collectionNameFor(tab, namePrefix);

    // Adopting a same-named collection we did not create would silently
    // replace whatever the user had in it.
    const clash = takenAfterPlan.get(name);
    if (clash) {
      plan.conflicts.push({
        tabId: tab.id,
        name,
        existingCollectionId: clash.id,
        existingCount: clash.appIds.length,
      });
      continue;
    }

    plan.creates.push({ tabId: tab.id, name, appIds: wanted });
    // Two brand-new tabs asking for the same name is a conflict between them,
    // not a free pass for whichever is second.
    takenAfterPlan.set(name, { id: `(pending:${tab.id})`, name, appIds: wanted, isDynamic: false, isEditable: true });
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
  tabs: readonly Tab[];
  gameOverrides: Record<string, unknown>;
  settings: { mirrorPrefix: string };
  mirror: { autoSync: boolean };
}

function project(config: MirrorRelevantConfig) {
  return {
    // `visible` is deliberately absent: a concealed tab still evaluates and
    // still mirrors, so hiding one from the strip must not empty its
    // collection in Steam.
    tabs: config.tabs.map((t) => ({
      id: t.id,
      label: t.label,
      root: t.root,
      sort: t.sort,
      limit: t.limit,
      manualOrder: t.manualOrder,
      mirror: t.mirror,
      policy: t.indeterminatePolicy,
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
  /** tabId -> the appIds actually written, and the collection they went to. */
  written: ReadonlyMap<string, { collectionId: string; name: string; appIds: string[] }>;
  now: number;
}): MirrorLedger {
  const { ledger, plan, written, now } = args;
  const deleted = new Set(plan.deletes.map((d) => d.tabId));

  const entries: MirrorLedgerEntry[] = ledger.entries
    .filter((e) => !deleted.has(e.tabId))
    .map((e) => {
      const update = written.get(e.tabId);
      return update
        ? {
            tabId: e.tabId,
            collectionId: update.collectionId,
            collectionName: update.name,
            appIds: update.appIds,
            lastSyncedAt: now,
          }
        : e;
    });

  const known = new Set(entries.map((e) => e.tabId));
  for (const [tabId, update] of written) {
    if (known.has(tabId)) continue;
    entries.push({
      tabId,
      collectionId: update.collectionId,
      collectionName: update.name,
      appIds: update.appIds,
      lastSyncedAt: now,
    });
  }

  return { version: 1, entries };
}
