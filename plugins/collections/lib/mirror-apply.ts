/**
 * Carrying out a {@link MirrorPlan}. [iso]
 *
 * The effects arrive as an injected {@link MirrorOps}, so the ordering rules —
 * which are the part that can corrupt a library — are testable without Steam
 * running. `backend.ts` supplies the CDP-backed implementation.
 *
 * Two properties this file exists to guarantee:
 *
 * 1. **Deletes run before creates.** Rename tab A to "Shelf" and tab B to "A"
 *    in one sitting and the sync must not try to create a second collection
 *    called "A" while the first still exists.
 * 2. **A failure is partial, never poisonous.** One collection failing must
 *    still let the rest sync, and the ledger must record exactly what landed —
 *    not what was planned. A ledger claiming a write that didn't happen makes
 *    the next run report phantom drift and "fix" it by deleting real games.
 */

import { applyToLedger, type MirrorPlan } from "./mirror";
import type { MirrorLedger } from "./types";

/** The Steam-side effects a sync needs. Mirrors `@loadout/steam-cdp`. */
export interface MirrorOps {
  create(args: {
    name: string;
    appIds: string[];
  }): Promise<{ collectionId: string; name: string }>;
  setApps(args: { collectionId: string; appIds: string[] }): Promise<void>;
  rename(args: { collectionId: string; name: string }): Promise<void>;
  remove(args: { collectionId: string }): Promise<void>;
}

export interface MirrorSyncResult {
  ledger: MirrorLedger;
  created: number;
  updated: number;
  renamed: number;
  deleted: number;
  /** Per-tab failures, with the sentence to show the user. */
  failures: Array<{ managedId: string; step: string; message: string }>;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Execute a plan. Never throws for a per-collection failure — those are
 * collected, because one unreachable collection must not abandon the other
 * nineteen.
 */
export async function applyMirrorPlan(args: {
  plan: MirrorPlan;
  ledger: MirrorLedger;
  ops: MirrorOps;
  now: number;
}): Promise<MirrorSyncResult> {
  const { plan, ledger, ops, now } = args;
  const written = new Map<string, { steamCollectionId: string; name: string; appIds: string[] }>();
  const failures: MirrorSyncResult["failures"] = [];
  let created = 0;
  let updated = 0;
  let renamed = 0;
  let deleted = 0;

  // Deletes first, so a name freed by this sync is available to a create in
  // the same sync.
  const deletedTabs = new Set<string>();
  for (const del of plan.deletes) {
    try {
      await ops.remove({ collectionId: del.steamCollectionId });
      deletedTabs.add(del.managedId);
      deleted++;
    } catch (err) {
      failures.push({ managedId: del.managedId, step: "delete", message: message(err) });
    }
  }

  // Renames next, for the same reason: "Backlog" must stop being "Backlog"
  // before another tab claims the name.
  for (const ren of plan.renames) {
    try {
      await ops.rename({ collectionId: ren.steamCollectionId, name: ren.to });
      renamed++;
    } catch (err) {
      failures.push({ managedId: ren.managedId, step: "rename", message: message(err) });
    }
  }

  for (const create of plan.creates) {
    try {
      const made = await ops.create({ name: create.name, appIds: create.appIds });
      written.set(create.managedId, {
        steamCollectionId: made.collectionId,
        name: made.name,
        appIds: create.appIds,
      });
      created++;
    } catch (err) {
      failures.push({ managedId: create.managedId, step: "create", message: message(err) });
    }
  }

  for (const update of plan.updates) {
    // Write the target set, not the diff. `setCollectionApps` recomputes the
    // add/remove in-page against live membership, so a plan built against a
    // slightly stale read still converges instead of leaving strays.
    try {
      await ops.setApps({ collectionId: update.steamCollectionId, appIds: update.appIds });
      written.set(update.managedId, {
        steamCollectionId: update.steamCollectionId,
        name: update.name,
        appIds: update.appIds,
      });
      updated++;
    } catch (err) {
      failures.push({ managedId: update.managedId, step: "update", message: message(err) });
    }
  }

  // A rename that succeeded on its own still has to reach the ledger, or the
  // next plan proposes it again forever.
  for (const ren of plan.renames) {
    if (written.has(ren.managedId)) continue;
    if (failures.some((f) => f.managedId === ren.managedId && f.step === "rename")) continue;
    const existing = ledger.entries.find((e) => e.managedId === ren.managedId);
    if (!existing) continue;
    written.set(ren.managedId, {
      steamCollectionId: ren.steamCollectionId,
      name: ren.to,
      appIds: existing.appIds,
    });
  }

  // Only tabs whose delete actually succeeded may be dropped from the ledger.
  // Forgetting a collection we failed to delete orphans it in Steam with no
  // record that it was ever ours.
  const effective: MirrorPlan = {
    ...plan,
    deletes: plan.deletes.filter((d) => deletedTabs.has(d.managedId)),
  };

  return {
    ledger: applyToLedger({ ledger, plan: effective, written, now }),
    created,
    updated,
    renamed,
    deleted,
    failures,
  };
}
