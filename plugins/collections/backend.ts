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
  editCollectionApps,
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

/**
 * How long a screen will wait on Steam before showing what it can without it.
 * Well under the CDP client's own 30s ceiling: this bounds *perceived* hangs,
 * not correctness.
 */
const STEAM_READ_TIMEOUT_MS = 8000;

const GAME_LIBRARY_SERVICE = "__core:game-library";
const PLAYTIME_PLUGIN = "playtime";


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
  /**
   * Collections the plan deliberately refused to write, and why.
   *
   * These used to be computed and dropped, so a sync that wrote nothing
   * *because everything was blocked* reported "Already up to date" — the exact
   * shape of a success. The likeliest way to hit it is a managed collection
   * whose name is already taken by one EmuDeck made: the planner correctly
   * refuses to adopt it, and without this the user is never told.
   */
  blocked: Array<{ label: string; reason: string }>;
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
  /** Edits that would change what Steam should hold, counted. */
  private editSeq = 0;
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

  /**
   * Apply an edit to whatever the config is **when the lock is taken**.
   *
   * Every caller used to build its next config from `this.config` first and
   * hand the finished object to `setConfig`. With a prior mutation mid-write —
   * `saveConfig` is real disk I/O on an SD card — two RPCs arriving during it
   * both snapshotted the pre-mutation config, and the second erased the
   * first's collection while reporting success. The lock protected the ledger
   * and nothing else.
   */
  private async _editConfig(
    edit: (config: CollectionsConfig) => CollectionsConfig,
  ): Promise<CollectionsConfig> {
    return this._mutateConfig(async () => {
      const before = this.config;
      const next = edit(before);
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

  async setConfig(next: CollectionsConfig): Promise<CollectionsConfig> {
    this._assertWritable();
    // The ledger is backend-owned and never taken from the caller: the UI posts
    // config built from React state captured before the last sync's broadcast,
    // and honouring its copy would forget collections that exist.
    return this._editConfig(() => next);
  }

  async setCollections(collections: ManagedCollection[]): Promise<CollectionsConfig> {
    this._assertWritable();
    return this._editConfig((config) => ({ ...config, collections }));
  }

  /** A new, empty managed collection. Its rules match everything until edited. */
  async createCollection(label: string): Promise<CollectionsConfig> {
    this._assertWritable();
    const trimmed = label.trim() || "New collection";
    // The id is minted inside the lock as well: two creates racing on the same
    // name both read the same config beforehand and both minted `backlog`.
    return this._editConfig((config) => {
      const id = uniqueCollectionId(config, slugify(trimmed));
      const collection: ManagedCollection = {
        id,
        label: trimmed,
        root: { kind: "group", id: `${id}-root`, combinator: "all", children: [] },
        sort: [{ field: "sortAs", dir: "asc" }],
        limit: null,
        display: {
          tileWidth: config.settings.defaultTileWidth,
          showLabels: true,
          badges: [],
        },
        indeterminatePolicy: config.settings.indeterminatePolicy,
      };
      return {
        ...config,
        collections: [...config.collections, collection],
        collectionOrder: [...config.collectionOrder, id],
      };
    });
  }

  /** Rename a managed collection. Its Steam collection follows on next sync. */
  async renameCollection(id: string, label: string): Promise<CollectionsConfig> {
    this._assertWritable();
    const trimmed = label.trim();
    if (!trimmed) throw new Error("A collection needs a name");
    return this._editConfig((config) => ({
      ...config,
      collections: config.collections.map((c) => (c.id === id ? { ...c, label: trimmed } : c)),
    }));
  }

  /**
   * Delete a managed collection — and its Steam collection, now rather than
   * at the next sync.
   *
   * Syncing is deliberately deferred because it is a full library evaluation
   * plus a batch of Cloud writes. A delete is neither: it is one targeted
   * call. Leaving it to the next sync meant the collection vanished from the
   * plugin while Steam still listed it, which reads exactly like a delete that
   * did not work.
   *
   * If Steam can't be reached the ledger row is kept, so the next sync finds
   * an entry whose owner is gone and issues the delete then — the existing
   * path, unchanged.
   */
  async deleteCollection(id: string): Promise<CollectionsConfig> {
    this._assertWritable();
    const entry = this.config.mirror.ledger.entries.find((e) => e.managedId === id);

    const config = await this._editConfig((current) => ({
      ...current,
      collections: current.collections.filter((c) => c.id !== id),
      collectionOrder: current.collectionOrder.filter((x) => x !== id),
    }));
    if (!entry) return config;

    // Queued behind any sync in flight. A delete landing mid-sync used to
    // leave the ledger row rewritten by that sync's `applyToLedger` — an entry
    // with no owner *and* no Steam collection, which nothing then reclaims,
    // and which permanently hides any collection that reuses the id.
    const run = this.syncChain.then(
      () => withSteamClient((c) => deleteCollection(c, { collectionId: entry.steamCollectionId })),
      () => withSteamClient((c) => deleteCollection(c, { collectionId: entry.steamCollectionId })),
    );
    this.syncChain = run.catch(() => undefined);

    try {
      await run;
    } catch (err) {
      this.log?.warn(
        `[collections] Couldn't remove "${entry.steamName}" from Steam yet, ` +
          `leaving it for the next sync: ${err instanceof Error ? err.message : err}`,
      );
      return this.config;
    }

    await this._setMirrorState((mirror) => ({
      ...mirror,
      ledger: {
        ...mirror.ledger,
        entries: mirror.ledger.entries.filter((e) => e.managedId !== id),
      },
    }));
    return this.config;
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

  /**
   * Update the mirror state, deciding what it becomes **inside** the lock.
   *
   * It used to take a finished `mirror` object built by the caller. That is
   * fine when the caller snapshots and enqueues in one synchronous block, and
   * wrong for `_markSyncOwed`, which captures before its own disk write and
   * enqueues after it: a sync landing in that gap had its freshly-written
   * ledger overwritten by the pre-sync copy, orphaning a collection it had
   * just created in Steam. Taking an updater means the ledger is always the
   * one on disk right now.
   */
  private async _setMirrorState(
    update: (mirror: CollectionsConfig["mirror"]) => CollectionsConfig["mirror"],
  ): Promise<void> {
    await this._mutateConfig(async () => {
      // Read inside the lock: a `setConfig` that landed while the sync ran is
      // already applied, and its edits must survive.
      const next: CollectionsConfig = { ...this.config, mirror: update(this.config.mirror) };
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
    // Bumped synchronously, and read by `_syncOnce` to decide whether it may
    // clear the flag. The flag itself is persisted through the config chain, so
    // a sync reading it back can miss an edit that has already happened.
    this.editSeq += 1;
    if (after.mirror.pendingSync) return;
    void this._setMirrorState((mirror) => ({ ...mirror, pendingSync: true })).catch(() => {});
  }

  // ── The grid ─────────────────────────────────────────────────────────

    /**
   * Read Steam, but never wait on it indefinitely.
   *
   * Steam being *down* is already handled — `withSteamClient` throws and the
   * caller degrades. Steam being **slow** was not: a hung `Runtime.evaluate`
   * sits for the CDP client's own 30s ceiling, and the grid shows a bare
   * spinner for all of it. Seen in the wild as two `create: CDP
   * Runtime.evaluate timeout after 30000ms` failures in one sync.
   *
   * Thirty seconds of spinner is indistinguishable from a hang, so reads that
   * a screen is waiting on get a much shorter deadline and fall back to what
   * can be shown without Steam.
   */
  private async _readSteam<T>(fn: (client: SteamClient) => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        withSteamClient(fn),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Steam didn't answer within ${STEAM_READ_TIMEOUT_MS}ms`)),
            STEAM_READ_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

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
      const steamCollections = await this._readSteam((c) => listCollections(c));
      linked = sortLinked(
        linkedCollections({ steamCollections, ledger: this.config.mirror.ledger }),
      );
    } catch (err) {
      steamReachable = false;
      this.log?.warn(
        `[collections] Steam unreachable, showing managed only: ${err instanceof Error ? err.message : err}`,
      );
    }

    // Count what Steam can actually show, not what it stores. A collection
    // holding dead shortcut ids would otherwise read 222 on the card and 16
    // when opened — see `listGames` for where those ids come from.
    const known = new Set(snapshot.games.map((g) => g.appId));
    return {
      collections: [
        ...managed,
        ...linked.map((l) => {
          const live = l.appIds.filter((appId) => known.has(appId));
          return {
            id: l.id,
            label: l.name,
            count: live.length,
            previewAppIds: live.slice(0, 4),
            kind: "linked" as const,
            autoMaintained: l.isDynamic,
          };
        }),
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
  /**
   * The games in one collection, and — for a Steam one — what is in it that
   * Steam no longer knows about.
   *
   * A Steam collection stores bare appIds, and a **non-Steam shortcut's appid
   * is regenerated every time the shortcut is re-added**. Re-run EmuDeck or a
   * ROM manager and every id the collection holds for those entries becomes a
   * dead reference. Steam quietly ignores them; we used to list them as rows
   * named by the number, which is why a collection could read as 221 games
   * here and 16 in Steam.
   *
   * Measured on the dev device: "Recomp Hub" held 221 ids, 16 resolved, and
   * all 205 that did not were above 2^31 — the shortcut id range.
   */
  async listGames(id: string): Promise<{
    games: Array<{ appId: string; name: string }>;
    kind: "managed" | "linked";
    /** Ids in the Steam collection that no longer match anything installed. */
    staleAppIds: string[];
  }> {
    const snapshot = await this.getSnapshot();
    const nameOf = new Map(snapshot.games.map((g) => [g.appId, g.name] as const));
    const named = (appIds: readonly string[]) =>
      appIds.map((appId) => ({ appId, name: nameOf.get(appId) ?? appId }));

    const managed = this.config.collections.find((c) => c.id === id);
    if (managed) {
      const evalGames = buildEvalGames(snapshot.games);
      const matched = evaluateCollection(managed, evalGames, { now: Date.now() }).matched;
      // A managed collection's membership is computed from the library every
      // time, so it cannot hold a reference to something that is gone.
      return {
        games: matched.map((g) => ({ appId: g.appId, name: g.name })),
        kind: "managed",
        staleAppIds: [],
      };
    }

    const steamCollections = await this._readSteam((c) => listCollections(c));
    const found = steamCollections.find((c) => c.id === id);
    if (!found) throw new Error("That collection no longer exists");
    return {
      games: named(found.appIds.filter((appId) => nameOf.has(appId))),
      kind: "linked",
      staleAppIds: found.appIds.filter((appId) => !nameOf.has(appId)),
    };
  }

  // ── Editing a linked collection ──────────────────────────────────────
  //
  // These write straight to Steam rather than going through `planMirror`. A
  // linked collection has no rules and no ledger row, so there is nothing to
  // plan — and routing them through the planner would mean relaxing its
  // conflict guard, which is what stops us overwriting a collection we did
  // not create.

  /**
   * Drop the ids in a Steam collection that no longer resolve.
   *
   * Returns how many went, so the UI can report it rather than leaving the
   * user to count. Reads the collection again rather than trusting a list the
   * UI captured: this writes the *whole* membership, and doing that from a
   * stale copy is how you lose the entries somebody added in between.
   */
  async pruneLinked(id: string): Promise<{ removed: number; kept: number }> {
    this._assertWritable();
    // **One** library read, used both to decide what is stale and to decide
    // whether that decision can be trusted. Reading twice — once here, once
    // inside `listGames` — meant the guard interrogated a healthy snapshot
    // while the stale list came from a broken one, which is the exact
    // combination the guard exists to refuse.
    const snapshot = await this.getSnapshot();
    const steamCollections = await this._readSteam((c) => listCollections(c));
    const found = steamCollections.find((c) => c.id === id);
    if (!found) throw new Error("That collection no longer exists");

    const known = new Set(snapshot.games.map((g) => g.appId));
    const staleAppIds = found.appIds.filter((appId) => !known.has(appId));
    const live = found.appIds.filter((appId) => known.has(appId));
    if (staleAppIds.length === 0) return { removed: 0, kept: 0 };

    // "Stale" means *the library doesn't know this id* — which is only a safe
    // thing to act on when the library itself is trustworthy. Both sources
    // degrade to empty on failure, and a thin snapshot makes every ROM in an
    // EmuDeck collection look dead: 700 entries, none of them in the manifest
    // scan (shortcuts have no appmanifest), all of them "prunable". Confirming
    // that dialog would empty a collection somebody else built.
    // `appstore: "ok"` only means the call returned — Steam answers with an
    // empty list while its stores are still hydrating, and that reads as a
    // library where every owned-but-uninstalled game has vanished. Require
    // evidence the read carried something, not merely that it completed.
    if (snapshot.providers.appstore?.status !== "ok" || snapshot.games.length === 0) {
      throw new Error(
        "Steam's library isn't fully loaded, so this can't tell a dead entry from an unread one. Try again in a moment.",
      );
    }
    // Everything unknown and nothing known is what a broken read looks like,
    // not what a collection with some dead shortcuts looks like.
    if (live.length === 0) {
      throw new Error(
        "Every entry in this collection looks unreadable, which usually means the library is still loading rather than that they are all dead.",
      );
    }

    // A targeted removal, not a rewrite: the ids being dropped are precisely
    // the ones just judged dead, and nothing else in the collection is named.
    await withSteamClient((c) =>
      editCollectionApps(c, { collectionId: id, remove: staleAppIds }),
    );
    return { removed: staleAppIds.length, kept: live.length };
  }

  /**
   * Add or drop games in a Steam collection, as a **delta against what Steam
   * holds right now**.
   *
   * It used to take the whole membership from the UI, which was wrong twice
   * over. The UI's list has unresolvable ids filtered out of it, so removing
   * one game also deleted every dead entry — the same destruction the "Clean
   * up" button asks twice about, done silently. And the list is a snapshot: if
   * it was captured before `listGames` returned, or while the library was
   * degraded, writing it back truncated the collection to whatever the UI
   * happened to be showing.
   *
   * The delta goes all the way down: `editCollectionApps` names the ids to add
   * and remove rather than handing Steam a membership to converge on, so an
   * entry EmuDeck adds between our read and Steam's evaluate survives — and so
   * do the unresolvable ids the UI never saw.
   */
  async editLinked(
    id: string,
    { add = [], remove = [] }: { add?: string[]; remove?: string[] },
  ): Promise<{ count: number }> {
    this._assertWritable();
    if (add.length === 0 && remove.length === 0) throw new Error("Nothing to change");

    const info = await withSteamClient((c) =>
      editCollectionApps(c, { collectionId: id, add, remove }),
    );
    return { count: info.appIds.length };
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
    const { plan } = await this._buildMirrorPlan();
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
    const editsBefore = this.editSeq;

    let plan: MirrorPlan;
    let result: MirrorSyncResult;
    try {
      const built = await this._buildMirrorPlan();
      plan = built.plan;
      result = await withSteamClient(async (client) =>
        applyMirrorPlan({
          plan,
          ledger: built.ledger,
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

    await this._setMirrorState((mirror) => ({
      ...mirror,
      ledger: result.ledger,
      // Only clear the flag when everything landed. Steam dying *after* the
      // session connects makes each write fail individually, which the
      // executor collects rather than throws.
      //
      // And only when nothing was edited *while* we were writing: an edit that
      // landed mid-sync was never in this plan, so clearing its flag would
      // record it as synced and leave Steam quietly wrong until something
      // unrelated triggered another sync.
      pendingSync: result.failures.length > 0 || this.editSeq !== editsBefore,
    }));

    const { created, updated, renamed, deleted, failures } = result;
    if (failures.length > 0) {
      this.log?.warn(
        `[collections] Sync had ${failures.length} failure(s): ` +
          failures.map((f) => `${f.managedId}/${f.step}: ${f.message}`).join("; "),
      );
    }

    const labels = new Map(this.config.collections.map((c) => [c.id, c.label] as const));
    const blocked = [
      ...plan.conflicts.map((c) => ({
        label: labels.get(c.managedId) ?? c.name,
        reason: `Steam already has a collection called “${c.name}” with ${c.existingCount} games, and it isn't one of ours. Rename yours to sync it.`,
      })),
      ...plan.skipped.map((sk) => ({
        label: labels.get(sk.managedId) ?? sk.managedId,
        reason: sk.reason,
      })),
    ];

    return {
      summary: summarizePlan(plan),
      created,
      updated,
      renamed,
      deleted,
      failures,
      changes: await this._describeChanges(plan),
      blocked,
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
      await this._setMirrorState((mirror) => ({ ...mirror, pendingSync: true }));
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
  /**
   * The plan, built against **one** reading of the config.
   *
   * `this.config` used to be read twice here — once to evaluate, once to plan
   * — with two awaits in between, and this backend keeps serving RPCs across
   * them. A `setCollections` landing in that window paired the *new* rule tree
   * with the *old* evaluation: a collection that had no rules when we
   * evaluated (an empty tree matches the whole library) but has one by the
   * time we plan is no longer skipped, so the whole library gets written into
   * Steam under it. That is exactly the accident the `unbuilt` guard exists to
   * prevent, arriving through the back door.
   */
  private async _buildMirrorPlan(): Promise<{ plan: MirrorPlan; ledger: CollectionsConfig["mirror"]["ledger"] }> {
    const snapshot = await this.getSnapshot();
    const evalGames = buildEvalGames(snapshot.games);
    const now = Date.now();

    // One reading, used for both halves. Anything that lands after this point
    // belongs to the next sync, which `pendingSync` will ask for.
    const collections = this.config.collections;
    const ledger = this.config.mirror.ledger;
    const namePrefix = this.config.settings.namePrefix;

    const evaluated = new Map<string, string[]>();
    for (const c of collections) {
      evaluated.set(
        c.id,
        evaluateCollection(c, evalGames, { now }).matched.map((g) => g.appId),
      );
    }

    const steamCollections: SteamCollectionInfo[] = await withSteamClient((client) =>
      listCollections(client),
    );

    // The ledger travels with the plan. Applying against a second, later read
    // meant `applyToLedger` patched a ledger the plan was never built from.
    return { plan: planMirror({ collections, evaluated, ledger, steamCollections, namePrefix }), ledger };
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
