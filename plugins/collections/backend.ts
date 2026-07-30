/**
 * `collections` backend.
 *
 * Owns persistence and the library snapshot; owns no rule logic at all. The
 * evaluator lives in `lib/` and runs **in the webview**, so switching tabs
 * and typing in the rule builder cost zero RPC round-trips — the whole
 * library is fetched once per change and filtered locally. That is what makes
 * a live match count on every keystroke affordable.
 *
 * The same evaluator is imported here (not duplicated) for the Phase-4 Steam
 * collection mirror, so a tab can never mean one thing on screen and another
 * in Steam.
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
  type SteamLibrarySnapshot,
} from "@loadout/steam-cdp";
import { shortcutGameId64 } from "@loadout/vdf";
import type { CollectionsConfig } from "./lib/config";
import type { Tab } from "./lib/types";
import { defaultConfig, uniqueTabId, validateConfig } from "./lib/config";
import {
  adaptLibrary,
  appStoreProviders,
  phase1Providers,
  type PlaytimeRow,
} from "./lib/adapt";
import { mergeSteamLibrary } from "./lib/merge-appstore";
import { type BackupInfo, listBackups, writeBackup } from "./lib/backups";
import {
  type LoadResult,
  loadConfig,
  restoreBackup,
  saveConfig,
  saveWithBackup,
} from "./lib/storage";
import { exportTabs, encodeShareString, importTabs } from "./lib/share";
import { findTemplate } from "./lib/templates";
import { buildEvalGames } from "./lib/facts";
import { evaluateTab } from "./lib/evaluate";
import { mirrorAffecting, planMirror, summarizePlan, type MirrorPlan } from "./lib/mirror";
import { applyMirrorPlan, type MirrorOps, type MirrorSyncResult } from "./lib/mirror-apply";

const GAME_LIBRARY_SERVICE = "__core:game-library";
const PLAYTIME_PLUGIN = "playtime";

/**
 * How long to wait for edits to settle before auto-syncing.
 *
 * A sync is a full library evaluation plus writes that reach Steam Cloud, and
 * the rule builder writes on every keystroke. Long enough to coalesce a burst
 * of edits, short enough that finishing a tab and switching to Steam finds it
 * already there.
 */
const AUTO_SYNC_DEBOUNCE_MS = 2500;

export default class CollectionsBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;
  log?: PluginLogger;
  callPlugin?: CallPlugin;

  private config: CollectionsConfig = defaultConfig();
  /** Warnings from the last load, replayed to the UI on first `getConfig`. */
  private loadWarnings: string[] = [];
  /** Set when the stored config came from a newer build — refuse all writes. */
  private readOnly = false;
  /** Pending debounced auto-sync, if any. */
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Serialises syncs. Three callers can start one — the manual RPC, the
   * debounce timer and the owed-sync retry on load — and none can see the
   * others. Two overlapping runs each create their own collection for the
   * same tab, and only the last to finish is recorded, so every overlap
   * leaks a collection that nothing can ever clean up.
   */
  private syncChain: Promise<unknown> = Promise.resolve();

  async onLoad(): Promise<void> {
    const result = await loadConfig();
    this._applyLoad(result);
    if (result.warnings.length > 0) {
      this.log?.warn(
        `[collections] Loaded with warnings: ${result.warnings.join("; ")}`,
      );
    }

    // A sync owed from a session where Steam was closed. Retried here rather
    // than on a timer: plugin load is the one moment we know Steam has just
    // had a chance to come up.
    if (this.config.mirror.autoSync && this.config.mirror.pendingSync) {
      void this.syncMirror().catch((err) => {
        this.log?.warn(
          `[collections] Owed sync still can't run: ${err instanceof Error ? err.message : err}`,
        );
      });
    }
  }

  async onUnload(): Promise<void> {
    // A debounced sync firing after the plugin is gone would write a config
    // the loader has already stopped tracking.
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = null;
  }

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
   * Replace the whole config. The UI holds the authoritative draft while the
   * user is editing, so a single setter beats a dozen fine-grained mutators —
   * and it means validation happens in exactly one place.
   */
  async setConfig(next: CollectionsConfig): Promise<CollectionsConfig> {
    this._assertWritable();
    const before = this.config;

    // The mirror ledger is **backend-owned** and never taken from the caller.
    //
    // The UI posts a whole config built from React state, captured before
    // whatever `configChanged` the last sync broadcast. Honouring the client's
    // copy meant flipping the Settings switch mid-sync reverted the ledger to
    // its pre-sync value while the collections it recorded still existed in
    // Steam. A ledger that has forgotten a collection can never delete it —
    // deletion requires a ledger entry — so the tab then conflicts with its
    // own orphan, permanently, and the stray is unreachable.
    const merged: CollectionsConfig = {
      ...next,
      mirror: {
        ...next.mirror,
        ledger: this.config.mirror.ledger,
        pendingSync: this.config.mirror.pendingSync,
      },
    };

    await saveConfig(merged); // throws on invalid; never persists junk
    this.config = merged;
    this._broadcast();
    this._maybeAutoSync(before, merged);
    return this.config;
  }

  /**
   * Persist backend-owned mirror state.
   *
   * Private on purpose: only a completed sync may say what the ledger holds,
   * so this is the one path allowed to write it.
   */
  private async _setMirrorState(mirror: CollectionsConfig["mirror"]): Promise<void> {
    const next: CollectionsConfig = { ...this.config, mirror };
    await saveConfig(next);
    this.config = next;
    this._broadcast();
  }

  /**
   * Queue a mirror sync when a change made one necessary.
   *
   * Deliberately fire-and-forget: a config write must not block on Steam, and
   * a Steam that is closed must not make renaming a tab fail.
   *
   * The recursion guard matters more than it looks. `syncMirror` persists the
   * ledger through this very method, so without a check on *what* changed,
   * every sync would schedule another one forever.
   */
  private _maybeAutoSync(before: CollectionsConfig, after: CollectionsConfig): void {
    if (!after.mirror.autoSync) return;
    if (!mirrorAffecting(before, after)) return;

    if (this.syncTimer) clearTimeout(this.syncTimer);
    // Coalesce: dragging a slider in the rule builder can write a dozen times
    // a second, and each sync is a full library evaluation plus Steam writes.
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.syncMirror().catch((err) => {
        this.log?.warn(
          `[collections] Auto-sync failed: ${err instanceof Error ? err.message : err}`,
        );
      });
    }, AUTO_SYNC_DEBOUNCE_MS);
  }

  async setTabs(tabs: Tab[]): Promise<CollectionsConfig> {
    return this.setConfig({ ...this.config, tabs });
  }

  async reorderTabs(tabOrder: string[]): Promise<CollectionsConfig> {
    // Ignore ids we don't know, and append any tab the caller forgot, so a
    // stale UI ordering can never make a tab disappear.
    const known = new Set(this.config.tabs.map((t) => t.id));
    const ordered = tabOrder.filter((id) => known.has(id));
    for (const tab of this.config.tabs) {
      if (!ordered.includes(tab.id)) ordered.push(tab.id);
    }
    return this.setConfig({ ...this.config, tabOrder: ordered });
  }

  async createTabFromTemplate(templateId: string): Promise<CollectionsConfig> {
    const template = findTemplate(templateId);
    if (!template) throw new Error(`Unknown template "${templateId}"`);
    const id = uniqueTabId(this.config, `${templateId}`);
    const tab = template.build(id);
    return this.setConfig({
      ...this.config,
      tabs: [...this.config.tabs, tab],
      tabOrder: [...this.config.tabOrder, id],
    });
  }

  async deleteTab(tabId: string): Promise<CollectionsConfig> {
    // Read-only is the stronger constraint, so it is reported first —
    // otherwise deleting a builtin from a read-only config explains the
    // builtin rule and leaves the user thinking a custom tab would work.
    this._assertWritable();
    const tab = this.config.tabs.find((t) => t.id === tabId);
    if (!tab) return this.config;
    if (tab.builtin !== undefined) {
      // Built-ins are hidden, never deleted — otherwise a user can lose a tab
      // this build defines and have no way to get it back.
      throw new Error("Built-in tabs can be hidden but not deleted");
    }
    return this.setConfig({
      ...this.config,
      tabs: this.config.tabs.filter((t) => t.id !== tabId),
      tabOrder: this.config.tabOrder.filter((id) => id !== tabId),
      defaultTabId: this.config.defaultTabId === tabId ? null : this.config.defaultTabId,
      profiles: this.config.profiles.map((p) => ({
        ...p,
        tabIds: p.tabIds.filter((id) => id !== tabId),
      })),
    });
  }

  // ── Library snapshot ─────────────────────────────────────────────────

  /**
   * The library as `GameMetadata`, plus per-provider health.
   *
   * Phase 1 assembles this from `__core:game-library` and the `playtime`
   * plugin; Phase 2 replaces the internals with `__core:game-metadata`
   * without changing this method's shape, so the UI needs no rework.
   */
  async getSnapshot(): Promise<GameMetadataSnapshot> {
    const games = await this._fetchGames();
    const playtime = await this._fetchPlaytime();
    const manifestGames = adaptLibrary(games, { playtime: playtime ?? undefined });

    // Steam's live view supplies the owned-but-not-installed half of the
    // library and most of the fields the manifest scan cannot know. When it is
    // unreachable we keep the manifest-only snapshot rather than failing: a
    // smaller honest library beats an error, and `providers` says which it is.
    const steam = await this._fetchSteamLibrary();
    if (!steam) {
      return {
        games: manifestGames,
        providers: phase1Providers(playtime !== null),
        generatedAt: Date.now(),
      };
    }

    const merged = mergeSteamLibrary(manifestGames, steam.entries);
    this.log?.info(
      `[collections] Steam library merged: ${merged.addedFromSteam} added, ` +
        `${merged.enriched} enriched (${steam.installedCount} installed)`,
    );

    return {
      games: merged.games,
      providers: appStoreProviders(playtime !== null),
      generatedAt: Date.now(),
    };
  }

  /**
   * Steam's live library over CDP, or `null` when Steam isn't reachable.
   *
   * `null` rather than a throw: Steam being closed is an ordinary state on a
   * handheld, and it must degrade the snapshot rather than break the plugin.
   */
  private async _fetchSteamLibrary(): Promise<SteamLibrarySnapshot | null> {
    try {
      return await withSteamClient((client) => readSteamLibrary(client));
    } catch (err) {
      this.log?.warn(
        `[collections] Steam library unavailable: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  private async _fetchGames(): Promise<GameInfo[]> {
    try {
      const games = await this.callPlugin?.(GAME_LIBRARY_SERVICE, "getGames");
      return Array.isArray(games) ? (games as GameInfo[]) : [];
    } catch (err) {
      this.log?.warn(
        `[collections] Library scan unavailable: ${err instanceof Error ? err.message : err}`,
      );
      return [];
    }
  }

  /**
   * Play time from the `playtime` plugin, or `null` when it isn't reachable.
   *
   * `null` is distinct from `[]`: an empty array means "the plugin is there
   * and you have played nothing", while `null` means "nobody can tell us".
   * The provider state derived from it is what stops a play-time rule
   * silently matching nothing when the user simply has the plugin disabled —
   * the exact class of bug that makes TabMaster's tabs mysteriously empty.
   */
  private async _fetchPlaytime(): Promise<PlaytimeRow[] | null> {
    try {
      const rows = await this.callPlugin?.(PLAYTIME_PLUGIN, "getSteamPlaytime");
      return Array.isArray(rows) ? (rows as PlaytimeRow[]) : null;
    } catch {
      // Disabled or absent. Not worth a warning — it's an optional source.
      return null;
    }
  }

  // ── Launching ────────────────────────────────────────────────────────

  /**
   * Ask Steam to launch a game.
   *
   * Dispatched through the running client's own URL handler rather than
   * `Bun.spawn(["steam", …])`, which would start a second Steam process that
   * often exits before delivering the URL.
   *
   * Non-Steam shortcuts are addressed by their 64-bit gameid, not the 32-bit
   * appid — `steam://rungameid/<appid>` silently does nothing for a shortcut.
   * `shortcutGameId64` derives it, so the snapshot doesn't have to carry it.
   */
  async launchGame(appId: string, source: "steam" | "shortcut"): Promise<void> {
    const numeric = Number(appId);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      throw new Error("That game can't be launched — its Steam id looks wrong");
    }
    const target =
      source === "shortcut" ? shortcutGameId64(numeric >>> 0) : appId;

    try {
      await withSteamClient((sc) =>
        sc.url.executeSteamURL(`steam://rungameid/${target}`),
      );
    } catch (err) {
      this.log?.warn(
        `[collections] Launch failed for ${appId}: ${err instanceof Error ? err.message : err}`,
      );
      throw new Error("Couldn't reach Steam to launch that game");
    }
  }

  /** Open a game's page in Steam, for games we can't or shouldn't launch. */
  async showGameInSteam(appId: string): Promise<void> {
    try {
      await withSteamClient((sc) =>
        sc.url.executeSteamURL(`steam://nav/games/details/${appId}`),
      );
    } catch {
      throw new Error("Couldn't reach Steam");
    }
  }

  // ── Steam collection mirror ──────────────────────────────────────────

  /**
   * What a sync would do, without doing any of it.
   *
   * The UI shows this before the user commits, because the writes are to
   * *their* Steam library and some of them delete things. Evaluation happens
   * here rather than in the webview so the plan can never be built from a tab
   * definition the backend hasn't got.
   */
  async previewMirror(): Promise<{
    plan: MirrorPlan;
    summary: string;
    tabLabels: Record<string, string>;
  }> {
    const plan = await this._buildMirrorPlan();
    return {
      plan,
      summary: summarizePlan(plan),
      // The plan speaks in tab ids; the UI needs names, and a tab named in a
      // `delete` no longer exists to look up.
      tabLabels: Object.fromEntries([
        ...this.config.tabs.map((t) => [t.id, t.label] as const),
        ...this.config.mirror.ledger.entries.map((e) => [e.tabId, e.collectionName] as const),
      ]),
    };
  }

  /**
   * Perform the sync and persist the resulting ledger.
   *
   * The ledger is saved even when some collections failed — it records what
   * actually landed, and losing that record is worse than an incomplete sync.
   */
  async syncMirror(): Promise<{
    summary: string;
    created: number;
    updated: number;
    renamed: number;
    deleted: number;
    failures: MirrorSyncResult["failures"];
  }> {
    // Queue behind any sync already in flight. Overlapping runs each plan
    // against the same pre-sync ledger, so both decide to *create* the same
    // tab's collection — leaving two in Steam with only the later one
    // recorded, and the other unreachable forever.
    const run = this.syncChain.then(
      () => this._syncMirrorOnce(),
      () => this._syncMirrorOnce(),
    );
    // The chain must not reject, or one failure poisons every later sync.
    this.syncChain = run.catch(() => undefined);
    return run;
  }

  private async _syncMirrorOnce(): Promise<{
    summary: string;
    created: number;
    updated: number;
    renamed: number;
    deleted: number;
    failures: MirrorSyncResult["failures"];
  }> {
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
      // Steam closed, or mid-restart. Remember that a sync is owed rather than
      // dropping it — on a handheld, editing tabs with Steam down is normal,
      // and silently never syncing is how the feature stops being trusted.
      await this._rememberPendingSync();
      throw err;
    }

    await this._setMirrorState({
      ...this.config.mirror,
      ledger: result.ledger,
      // Only clear the owed-sync flag when everything actually landed. Steam
      // dying *after* the session connects makes each op fail individually,
      // which the executor collects rather than throws — so a "successful"
      // sync that wrote nothing would otherwise cancel the retry forever.
      pendingSync: result.failures.length > 0,
    });

    const { created, updated, renamed, deleted, failures } = result;
    if (failures.length > 0) {
      this.log?.warn(
        `[collections] Mirror sync had ${failures.length} failure(s): ` +
          failures.map((f) => `${f.tabId}/${f.step}: ${f.message}`).join("; "),
      );
    }
    return { summary: summarizePlan(plan), created, updated, renamed, deleted, failures };
  }

  /** Record that a sync is owed, without letting that write fail the caller. */
  private async _rememberPendingSync(): Promise<void> {
    if (this.config.mirror.pendingSync) return;
    try {
      await this._setMirrorState({ ...this.config.mirror, pendingSync: true });
    } catch {
      // The original failure is the one worth reporting.
    }
  }

  /**
   * Evaluate every mirrored tab and diff against Steam.
   *
   * Deliberately uses the same `evaluateTab` the webview renders from — a
   * second implementation here is how a tab comes to mean one thing on screen
   * and another in Steam.
   */
  private async _buildMirrorPlan(): Promise<MirrorPlan> {
    const snapshot = await this.getSnapshot();
    const evalGames = buildEvalGames(snapshot.games);
    const now = Date.now();

    const evaluated = new Map<string, string[]>();
    for (const tab of this.config.tabs) {
      if (!tab.mirror.enabled) continue;
      const result = evaluateTab(tab, evalGames, { now });
      evaluated.set(
        tab.id,
        result.matched.map((g) => g.appId),
      );
    }

    const steamCollections = await withSteamClient((client) => listCollections(client));

    return planMirror({
      tabs: this.config.tabs,
      evaluated,
      ledger: this.config.mirror.ledger,
      steamCollections,
      namePrefix: this.config.settings.mirrorPrefix,
    });
  }

  // ── Backups ──────────────────────────────────────────────────────────

  async listBackups(): Promise<BackupInfo[]> {
    return listBackups();
  }

  async createBackup(): Promise<BackupInfo> {
    return writeBackup(this.config, "manual");
  }

  async restoreBackupFile(file: string): Promise<CollectionsConfig> {
    this._assertWritable();
    const result = await restoreBackup(file, this.config);
    this._applyLoad(result);
    this._broadcast();
    return this.config;
  }

  // ── Sharing ──────────────────────────────────────────────────────────

  async exportTab(tabId: string): Promise<string> {
    const tab = this.config.tabs.find((t) => t.id === tabId);
    if (!tab) throw new Error("That tab no longer exists");
    return encodeShareString(exportTabs([tab]));
  }

  async exportAllTabs(): Promise<string> {
    // Built-ins are defined by the build, not by the user, so exporting them
    // would only produce tabs the importer must reject.
    const custom = this.config.tabs.filter((t) => t.builtin === undefined);
    if (custom.length === 0) throw new Error("You have no custom tabs to export");
    return encodeShareString(exportTabs(custom));
  }

  /**
   * Merge a share code in. Additive, never destructive — and a backup is
   * taken first, so an unwanted import is one click from undone.
   */
  async importShareCode(code: string): Promise<{
    config: CollectionsConfig;
    added: string[];
    renamed: Array<[string, string]>;
    rejected: Array<{ label: string; reason: string }>;
  }> {
    this._assertWritable();
    const result = importTabs(this.config, code); // throws user-facing on bad input
    const problems = validateConfig(result.config);
    if (problems.length > 0) {
      throw new Error(`That share code produced invalid tabs: ${problems.join("; ")}`);
    }
    await saveWithBackup(result.config, this.config, "pre-import");
    this.config = result.config;
    this._broadcast();
    return { ...result, config: this.config };
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
