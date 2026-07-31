/**
 * `collections` backend.
 *
 * Owns persistence, the library snapshot, and the Steam reads/writes. It owns
 * no rule logic: the evaluator lives in `lib/` and runs **in the webview**, so
 * switching collections and typing in the rule builder cost zero RPC round
 * trips. The whole library is fetched once per change and filtered locally,
 * which is what makes a live match count on every keystroke affordable.
 *
 * The same evaluator is imported here (not duplicated) for the Steam sync, so
 * a collection can never mean one thing on screen and another in Steam.
 *
 * Every public method is an RPC endpoint; `_`-prefixed members are private
 * (see `resolveMethod` in `packages/types/src/plugin.ts`).
 */

import type {
  CallPlugin,
  EmitPayload,
  GameInfo,
  GameMetadataSnapshot,
  PluginBackend,
  PluginLogger,
} from "@loadout/types";
import {
  createCollection,
  deleteCollection,
  listCollections,
  readSteamLibrary,
  renameCollection,
  setCollectionApps,
  withSteamClient,
  type SteamClient,
  type SteamCollectionInfo,
  type SteamLibrarySnapshot,
} from "@loadout/steam-cdp";
import type { CollectionsConfig } from "./lib/config";
import type { ManagedCollection } from "./lib/types";
import { defaultConfig, orderedCollections, uniqueCollectionId } from "./lib/config";
import { adaptLibrary, appStoreProviders, phase1Providers, type PlaytimeRow } from "./lib/adapt";
import { mergeSteamLibrary } from "./lib/merge-appstore";
import { type LoadResult, loadConfig, saveConfig } from "./lib/storage";
import { buildEvalGames } from "./lib/facts";
import { evaluateCollection } from "./lib/evaluate";
import { linkedCollections, sortLinked, type LinkedCollection } from "./lib/linked";
import { mirrorAffecting, planMirror, summarizePlan, type MirrorPlan } from "./lib/mirror";
import { applyMirrorPlan, type MirrorOps, type MirrorSyncResult } from "./lib/mirror-apply";

const GAME_LIBRARY_SERVICE = "__core:game-library";
const PLAYTIME_PLUGIN = "playtime";

/**
 * How long to wait for edits to settle before syncing.
 *
 * A sync is a full library evaluation plus writes that reach Steam Cloud, and
 * the rule builder writes on every keystroke. Long enough to coalesce a burst
 * of edits, short enough that finishing a collection and switching to Steam
 * finds it already there.
 */

/** What a sync did to one collection, for reporting it back. */
export interface SyncChange {
  label: string;
  kind: "created" | "updated" | "deleted";
  /** Up to five names, so the report reads as prose rather than a dump. */
  added: string[];
  removed: string[];
  addedCount: number;
  removedCount: number;
}

export interface SyncReport {
  summary: string;
  created: number;
  updated: number;
  renamed: number;
  deleted: number;
  failures: MirrorSyncResult["failures"];
  changes: SyncChange[];
}

/** One card on the grid, whichever kind it is. */
export interface CollectionSummary {
  id: string;
  label: string;
  count: number;
  /** First few appIds, for the card's preview art. */
  previewAppIds: string[];
  kind: "managed" | "linked";
  /** Managed: rules maintain it. Linked+dynamic: Steam maintains it. */
  autoMaintained: boolean;
}

export default class CollectionsBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;
  log?: PluginLogger;
  callPlugin?: CallPlugin;

  private config: CollectionsConfig = defaultConfig();
  private loadWarnings: string[] = [];
  /** Set when the stored config came from a newer build — refuse all writes. */
  private readOnly = false;
  /**
   * Serialises syncs. Three callers can start one — the RPC, the debounce
   * timer, and the owed-sync retry on load — and none can see the others. Two
   * overlapping runs each create their own Steam collection for the same
   * managed one, and only the last is recorded, so every overlap leaks a
   * collection nothing can clean up.
   */
  private syncChain: Promise<unknown> = Promise.resolve();
  /**
   * Serialises config writes. A write is read-modify-write across an `await`,
   * so two interleave: a sync finishing inside `setConfig`'s window would
   * build its next config from the pre-edit value and write it last, losing
   * the user's edit from memory and from disk.
   */
  private configChain: Promise<unknown> = Promise.resolve();

  async onLoad(): Promise<void> {
    const result = await loadConfig();
    this._applyLoad(result);
    if (result.warnings.length > 0) {
      this.log?.warn(`[collections] Loaded with warnings: ${result.warnings.join("; ")}`);
    }

    // A sync owed from a session where Steam was closed. Retried here rather
    // than on a timer: plugin load is the one moment we know Steam has just
    // had a chance to come up.
    if (this.config.mirror.autoSync && this.config.mirror.pendingSync) {
      // Load is the one automatic sync left, and it is safe here precisely
      // because nothing is on screen waiting for this backend yet.
      void this.syncMirror().catch((err) => {
        this.log?.warn(
          `[collections] Owed sync still can't run: ${err instanceof Error ? err.message : err}`,
        );
      });
    }
  }

  async onUnload(): Promise<void> {}

  // ── Config ───────────────────────────────────────────────────────────

  async getConfig(): Promise<{
    config: CollectionsConfig;
    warnings: string[];
    readOnly: boolean;
  }> {
    // Warnings are handed over once and cleared: they describe a load event,
    // not a persistent state, so re-showing them on every poll would nag.
    const warnings = this.loadWarnings;
    this.loadWarnings = [];
    return { config: this.config, warnings, readOnly: this.readOnly };
  }

  async setConfig(next: CollectionsConfig): Promise<CollectionsConfig> {
    this._assertWritable();
    return this._mutateConfig(async () => {
      const before = this.config;
      // The ledger is backend-owned and never taken from the caller: the UI
      // posts config built from React state captured before the last sync's
      // broadcast, and honouring its copy would forget collections that exist.
      const merged: CollectionsConfig = {
        ...next,
        mirror: {
          ...next.mirror,
          ledger: before.mirror.ledger,
          pendingSync: before.mirror.pendingSync,
        },
      };
      await saveConfig(merged); // throws on invalid; never persists junk
      this.config = merged;
      this._broadcast();
      this._markSyncOwed(before, merged);
      return this.config;
    });
  }

  async setCollections(collections: ManagedCollection[]): Promise<CollectionsConfig> {
    return this.setConfig({ ...this.config, collections });
  }

  /** A new, empty managed collection. Its rules match everything until edited. */
  async createCollection(label: string): Promise<CollectionsConfig> {
    this._assertWritable();
    const trimmed = label.trim() || "New collection";
    const id = uniqueCollectionId(this.config, slugify(trimmed));
    const collection: ManagedCollection = {
      id,
      label: trimmed,
      root: { kind: "group", id: `${id}-root`, combinator: "all", children: [] },
      sort: [{ field: "sortAs", dir: "asc" }],
      limit: null,
      display: {
        tileWidth: this.config.settings.defaultTileWidth,
        showLabels: true,
        badges: [],
      },
      indeterminatePolicy: this.config.settings.indeterminatePolicy,
    };
    return this.setConfig({
      ...this.config,
      collections: [...this.config.collections, collection],
      collectionOrder: [...this.config.collectionOrder, id],
    });
  }

  /** Rename a managed collection. Its Steam collection follows on next sync. */
  async renameCollection(id: string, label: string): Promise<CollectionsConfig> {
    this._assertWritable();
    const trimmed = label.trim();
    if (!trimmed) throw new Error("A collection needs a name");
    return this.setConfig({
      ...this.config,
      collections: this.config.collections.map((c) =>
        c.id === id ? { ...c, label: trimmed } : c,
      ),
    });
  }

  async deleteCollection(id: string): Promise<CollectionsConfig> {
    this._assertWritable();
    return this.setConfig({
      ...this.config,
      collections: this.config.collections.filter((c) => c.id !== id),
      collectionOrder: this.config.collectionOrder.filter((x) => x !== id),
    });
  }

  private _mutateConfig<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.configChain.then(fn, fn);
    // The chain must never reject, or one failed write poisons every later one.
    this.configChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async _setMirrorState(mirror: CollectionsConfig["mirror"]): Promise<void> {
    await this._mutateConfig(async () => {
      // Read inside the lock: a `setConfig` that landed while the sync ran is
      // already applied, and its edits must survive.
      const next: CollectionsConfig = { ...this.config, mirror };
      await saveConfig(next);
      this.config = next;
      this._broadcast();
    });
  }

  /**
   * Record that Steam is now behind, rather than syncing on the spot.
   *
   * It used to sync a couple of seconds after any edit. A sync is a full
   * library evaluation plus Steam Cloud writes, and this backend is
   * single-threaded — so it ran *while the user was still working*, and every
   * RPC the UI issued queued behind it. From the front that looks like the
   * plugin has frozen: a press does nothing, so you press again. That is
   * exactly how five identical collections got made.
   *
   * Syncing is now something that happens when nobody is waiting on it —
   * when you leave the plugin, or when you ask for it — so the work is the
   * same but it is never in your way.
   */
  private _markSyncOwed(before: CollectionsConfig, after: CollectionsConfig): void {
    if (!mirrorAffecting(before, after)) return;
    if (after.mirror.pendingSync) return;
    void this._setMirrorState({ ...after.mirror, pendingSync: true }).catch(() => {});
  }

  // ── The grid ─────────────────────────────────────────────────────────

  /**
   * Every collection worth showing: the ones this plugin maintains, and the
   * ones already in Steam.
   *
   * Linked collections are read live rather than stored, so a collection made
   * in EmuDeck five minutes ago appears without the plugin knowing anything
   * about it. When Steam is unreachable the managed half still renders — a
   * smaller honest grid beats an error page.
   */
  async listAll(): Promise<{ collections: CollectionSummary[]; steamReachable: boolean }> {
    const snapshot = await this.getSnapshot();
    const evalGames = buildEvalGames(snapshot.games);
    const now = Date.now();

    const managed: CollectionSummary[] = orderedCollections(this.config).map((c) => {
      const matched = evaluateCollection(c, evalGames, { now }).matched;
      return {
        id: c.id,
        label: c.label,
        count: matched.length,
        previewAppIds: matched.slice(0, 4).map((g) => g.appId),
        kind: "managed" as const,
        autoMaintained: true,
      };
    });

    let linked: LinkedCollection[] = [];
    let steamReachable = true;
    try {
      const steamCollections = await withSteamClient((c) => listCollections(c));
      linked = sortLinked(
        linkedCollections({ steamCollections, ledger: this.config.mirror.ledger }),
      );
    } catch (err) {
      steamReachable = false;
      this.log?.warn(
        `[collections] Steam unreachable, showing managed only: ${err instanceof Error ? err.message : err}`,
      );
    }

    return {
      collections: [
        ...managed,
        ...linked.map((l) => ({
          id: l.id,
          label: l.name,
          count: l.appIds.length,
          previewAppIds: l.appIds.slice(0, 4),
          kind: "linked" as const,
          autoMaintained: l.isDynamic,
        })),
      ],
      steamReachable,
    };
  }

  /**
   * The games in one collection — computed for managed, read from Steam for
   * linked.
   *
   * Names come back with the ids. A linked collection is just a list of
   * appIds; resolving them here rather than in the webview means one lookup
   * against the snapshot we already built, and the alternative is a grid of
   * bare numbers.
   */
  async listGames(
    id: string,
  ): Promise<{ games: Array<{ appId: string; name: string }>; kind: "managed" | "linked" }> {
    const snapshot = await this.getSnapshot();
    const nameOf = new Map(snapshot.games.map((g) => [g.appId, g.name] as const));
    const named = (appIds: readonly string[]) =>
      appIds.map((appId) => ({ appId, name: nameOf.get(appId) ?? appId }));

    const managed = this.config.collections.find((c) => c.id === id);
    if (managed) {
      const evalGames = buildEvalGames(snapshot.games);
      const matched = evaluateCollection(managed, evalGames, { now: Date.now() }).matched;
      return { games: matched.map((g) => ({ appId: g.appId, name: g.name })), kind: "managed" };
    }

    const steamCollections = await withSteamClient((c) => listCollections(c));
    const found = steamCollections.find((c) => c.id === id);
    if (!found) throw new Error("That collection no longer exists");
    return { games: named(found.appIds), kind: "linked" };
  }

  // ── Editing a linked collection ──────────────────────────────────────
  //
  // These write straight to Steam rather than going through `planMirror`. A
  // linked collection has no rules and no ledger row, so there is nothing to
  // plan — and routing them through the planner would mean relaxing its
  // conflict guard, which is what stops us overwriting a collection we did
  // not create.

  async setLinkedApps(id: string, appIds: string[]): Promise<void> {
    this._assertWritable();
    await withSteamClient((c) => setCollectionApps(c, { collectionId: id, appIds }));
  }

  async renameLinked(id: string, name: string): Promise<void> {
    this._assertWritable();
    await withSteamClient((c) => renameCollection(c, { collectionId: id, name }));
  }

  async deleteLinked(id: string): Promise<boolean> {
    this._assertWritable();
    return withSteamClient((c) => deleteCollection(c, { collectionId: id }));
  }

  // ── Library snapshot ─────────────────────────────────────────────────

  async getSnapshot(): Promise<GameMetadataSnapshot> {
    const games = await this._fetchGames();
    const playtime = await this._fetchPlaytime();
    const manifestGames = adaptLibrary(games, { playtime: playtime ?? undefined });

    const steam = await this._fetchSteamLibrary();
    if (!steam) {
      return {
        games: manifestGames,
        providers: phase1Providers(playtime !== null),
        generatedAt: Date.now(),
      };
    }

    const merged = mergeSteamLibrary(manifestGames, steam.entries);
    return {
      games: merged.games,
      providers: appStoreProviders(playtime !== null),
      generatedAt: Date.now(),
    };
  }

  private async _fetchSteamLibrary(): Promise<SteamLibrarySnapshot | null> {
    try {
      return await withSteamClient((client) => readSteamLibrary(client));
    } catch {
      // Steam being closed is an ordinary state on a handheld: degrade the
      // snapshot rather than breaking the plugin.
      return null;
    }
  }

  private async _fetchGames(): Promise<GameInfo[]> {
    try {
      const games = await this.callPlugin?.(GAME_LIBRARY_SERVICE, "getGames");
      return Array.isArray(games) ? (games as GameInfo[]) : [];
    } catch {
      return [];
    }
  }

  private async _fetchPlaytime(): Promise<PlaytimeRow[] | null> {
    try {
      const rows = await this.callPlugin?.(PLAYTIME_PLUGIN, "getSteamPlaytime");
      return Array.isArray(rows) ? (rows as PlaytimeRow[]) : null;
    } catch {
      // Disabled or absent — an optional source, not worth a warning.
      return null;
    }
  }

  async showGameInSteam(appId: string): Promise<void> {
    try {
      await withSteamClient((sc) => sc.url.executeSteamURL(`steam://nav/games/details/${appId}`));
    } catch {
      throw new Error("Couldn't reach Steam");
    }
  }

  // ── Sync ─────────────────────────────────────────────────────────────

  async previewMirror(): Promise<{
    plan: MirrorPlan;
    summary: string;
    labels: Record<string, string>;
  }> {
    const plan = await this._buildMirrorPlan();
    return {
      plan,
      summary: summarizePlan(plan),
      // The plan speaks in ids; the UI needs names, and one named in a delete
      // no longer exists to look up.
      labels: Object.fromEntries([
        ...this.config.collections.map((c) => [c.id, c.label] as const),
        ...this.config.mirror.ledger.entries.map((e) => [e.managedId, e.steamName] as const),
      ]),
    };
  }

  async syncMirror(): Promise<SyncReport> {
    const run = this.syncChain.then(
      () => this._syncOnce(),
      () => this._syncOnce(),
    );
    this.syncChain = run.catch(() => undefined);
    return run;
  }

  private async _syncOnce(): Promise<SyncReport> {
    this._assertWritable();

    let plan: MirrorPlan;
    let result: MirrorSyncResult;
    try {
      plan = await this._buildMirrorPlan();
      result = await withSteamClient(async (client) =>
        applyMirrorPlan({
          plan,
          ledger: this.config.mirror.ledger,
          ops: mirrorOps(client),
          now: Date.now(),
        }),
      );
    } catch (err) {
      // Editing with Steam down is normal on a handheld; remember the sync is
      // owed rather than dropping it.
      await this._rememberPendingSync();
      throw err;
    }

    await this._setMirrorState({
      ...this.config.mirror,
      ledger: result.ledger,
      // Only clear the flag when everything landed. Steam dying *after* the
      // session connects makes each write fail individually, which the
      // executor collects rather than throws.
      pendingSync: result.failures.length > 0,
    });

    const { created, updated, renamed, deleted, failures } = result;
    if (failures.length > 0) {
      this.log?.warn(
        `[collections] Sync had ${failures.length} failure(s): ` +
          failures.map((f) => `${f.managedId}/${f.step}: ${f.message}`).join("; "),
      );
    }

    return {
      summary: summarizePlan(plan),
      created,
      updated,
      renamed,
      deleted,
      failures,
      changes: await this._describeChanges(plan),
    };
  }

  /**
   * What the sync actually did to each collection, in words.
   *
   * `planMirror` already computes these add/remove sets and they were thrown
   * away. Surfacing them is the whole answer to "why did that game disappear":
   * a rules-driven collection dropping a game is correct, and only feels
   * arbitrary when it happens in silence.
   */
  private async _describeChanges(plan: MirrorPlan): Promise<SyncChange[]> {
    const label = new Map(this.config.collections.map((c) => [c.id, c.label] as const));
    const changes: SyncChange[] = [];

    // Only resolve names if something actually moved — this is a full library
    // read, and most syncs are no-ops.
    const needsNames = plan.updates.some((u) => u.add.length + u.remove.length > 0);
    const nameOf = needsNames
      ? new Map((await this.getSnapshot()).games.map((g) => [g.appId, g.name] as const))
      : new Map<string, string>();
    const names = (ids: readonly string[]) =>
      ids.slice(0, 5).map((id) => nameOf.get(id) ?? id);

    for (const c of plan.creates) {
      changes.push({
        label: label.get(c.managedId) ?? c.name,
        kind: "created",
        added: [],
        removed: [],
        addedCount: c.appIds.length,
        removedCount: 0,
      });
    }
    for (const u of plan.updates) {
      if (u.add.length === 0 && u.remove.length === 0) continue;
      changes.push({
        label: label.get(u.managedId) ?? u.name,
        kind: "updated",
        added: names(u.add),
        removed: names(u.remove),
        addedCount: u.add.length,
        removedCount: u.remove.length,
      });
    }
    for (const d of plan.deletes) {
      changes.push({
        label: d.name,
        kind: "deleted",
        added: [],
        removed: [],
        addedCount: 0,
        removedCount: 0,
      });
    }
    return changes;
  }

  private async _rememberPendingSync(): Promise<void> {
    if (this.config.mirror.pendingSync) return;
    try {
      await this._setMirrorState({ ...this.config.mirror, pendingSync: true });
    } catch {
      // The original failure is the one worth reporting.
    }
  }

  /**
   * Evaluate every managed collection and diff against Steam.
   *
   * Uses the same `evaluateCollection` the webview renders from — a second
   * implementation here is how a collection comes to mean one thing on screen
   * and another in Steam.
   */
  private async _buildMirrorPlan(): Promise<MirrorPlan> {
    const snapshot = await this.getSnapshot();
    const evalGames = buildEvalGames(snapshot.games);
    const now = Date.now();

    const evaluated = new Map<string, string[]>();
    for (const c of this.config.collections) {
      evaluated.set(
        c.id,
        evaluateCollection(c, evalGames, { now }).matched.map((g) => g.appId),
      );
    }

    const steamCollections: SteamCollectionInfo[] = await withSteamClient((client) =>
      listCollections(client),
    );

    return planMirror({
      collections: this.config.collections,
      evaluated,
      ledger: this.config.mirror.ledger,
      steamCollections,
      namePrefix: this.config.settings.namePrefix,
    });
  }

  // ── Internals ────────────────────────────────────────────────────────

  private _applyLoad(result: LoadResult): void {
    this.config = result.config;
    this.loadWarnings = result.warnings;
    this.readOnly = result.readOnly;
  }

  private _assertWritable(): void {
    if (this.readOnly) {
      throw new Error(
        "These settings were written by a newer version of Loadout and can't be changed. " +
          "Update Loadout, or restore a backup.",
      );
    }
  }

  private _broadcast(): void {
    this.emit?.({ event: "configChanged", data: this.config });
  }
}

/** A readable, collision-resistant id from a user-typed label. */
function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "collection";
}

/**
 * The CDP-backed effects, bound to one Steam session.
 *
 * Separate from the class so `applyMirrorPlan`'s sequencing can be tested
 * against a recording double — the ordering rules are what protect the user's
 * collections, and they should not need a running Steam to verify.
 */
function mirrorOps(client: SteamClient): MirrorOps {
  return {
    async create({ name, appIds }) {
      const made = await createCollection(client, { name, appIds });
      return { collectionId: made.id, name: made.name };
    },
    async setApps({ collectionId, appIds }) {
      await setCollectionApps(client, { collectionId, appIds });
    },
    async rename({ collectionId, name }) {
      await renameCollection(client, { collectionId, name });
    },
    async remove({ collectionId }) {
      await deleteCollection(client, { collectionId });
    },
  };
}
