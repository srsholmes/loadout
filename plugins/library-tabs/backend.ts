/**
 * `library-tabs` backend.
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
  readSteamLibrary,
  withSteamClient,
  type SteamLibrarySnapshot,
} from "@loadout/steam-cdp";
import { shortcutGameId64 } from "@loadout/vdf";
import type { LibraryTabsConfig } from "./lib/config";
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

const GAME_LIBRARY_SERVICE = "__core:game-library";
const PLAYTIME_PLUGIN = "playtime";

export default class LibraryTabsBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;
  log?: PluginLogger;
  callPlugin?: CallPlugin;

  private config: LibraryTabsConfig = defaultConfig();
  /** Warnings from the last load, replayed to the UI on first `getConfig`. */
  private loadWarnings: string[] = [];
  /** Set when the stored config came from a newer build — refuse all writes. */
  private readOnly = false;

  async onLoad(): Promise<void> {
    const result = await loadConfig();
    this._applyLoad(result);
    if (result.warnings.length > 0) {
      this.log?.warn(
        `[library-tabs] Loaded with warnings: ${result.warnings.join("; ")}`,
      );
    }
  }

  // ── Config ───────────────────────────────────────────────────────────

  async getConfig(): Promise<{
    config: LibraryTabsConfig;
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
  async setConfig(next: LibraryTabsConfig): Promise<LibraryTabsConfig> {
    this._assertWritable();
    await saveConfig(next); // throws on invalid; never persists junk
    this.config = next;
    this._broadcast();
    return this.config;
  }

  async setTabs(tabs: Tab[]): Promise<LibraryTabsConfig> {
    return this.setConfig({ ...this.config, tabs });
  }

  async reorderTabs(tabOrder: string[]): Promise<LibraryTabsConfig> {
    // Ignore ids we don't know, and append any tab the caller forgot, so a
    // stale UI ordering can never make a tab disappear.
    const known = new Set(this.config.tabs.map((t) => t.id));
    const ordered = tabOrder.filter((id) => known.has(id));
    for (const tab of this.config.tabs) {
      if (!ordered.includes(tab.id)) ordered.push(tab.id);
    }
    return this.setConfig({ ...this.config, tabOrder: ordered });
  }

  async createTabFromTemplate(templateId: string): Promise<LibraryTabsConfig> {
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

  async deleteTab(tabId: string): Promise<LibraryTabsConfig> {
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
      `[library-tabs] Steam library merged: ${merged.addedFromSteam} added, ` +
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
        `[library-tabs] Steam library unavailable: ${err instanceof Error ? err.message : err}`,
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
        `[library-tabs] Library scan unavailable: ${err instanceof Error ? err.message : err}`,
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
        `[library-tabs] Launch failed for ${appId}: ${err instanceof Error ? err.message : err}`,
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

  // ── Backups ──────────────────────────────────────────────────────────

  async listBackups(): Promise<BackupInfo[]> {
    return listBackups();
  }

  async createBackup(): Promise<BackupInfo> {
    return writeBackup(this.config, "manual");
  }

  async restoreBackupFile(file: string): Promise<LibraryTabsConfig> {
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
    config: LibraryTabsConfig;
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
