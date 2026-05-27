import type { PluginBackend, EmitPayload } from "@loadout/types";
import type {
  GameEntry, GameInfo, GameStatus, ModInfo, PersistedState,
  Settings, PipelineEvent,
} from "./lib/types";
import {
  loadState,
  updateSettings as updateStateSettings,
  updateInstalledGame,
  setRomPath,
  recordInstalledMod,
  pruneOrphanInstalledMods,
} from "./lib/state";
import {
  loadBundledRegistry,
  setupScriptPathFor,
  validateModEntry,
} from "./lib/registry";
import {
  installGame,
  latestReleaseTag,
  uninstallGame,
  updateGame,
} from "./lib/pipeline";
import {
  installMod,
  installModFromArchive,
  pruneStaleModStaging,
} from "./lib/mods";
import { isBuildEnvReady } from "./lib/build-env";
import { launchGame } from "./lib/launcher";
import { addToSteam, removeFromSteam } from "./lib/steam-shortcut";
import { applyArtwork, getCatalogArtUrl, getDetailHeroUrl } from "./lib/artwork";
import { getEffectivePlatformValue } from "./lib/platform";
import { pickRomFile } from "./lib/file-picker";
import { suggestRomsForTitle, type RomSuggestion } from "./lib/rom-suggest";

/**
 * Catalog display order. Headline franchises first, headline games
 * first within each group, then alphabetical.
 *
 * Zelda is on top because Twilight Princess (`dusklight`) is the
 * marquee newly-runnable port. Mario follows because Mario 64 has
 * the most-polished native + RT recipes (`sm64-decomp` /
 * `sm64-render96-rt`). Sonic third because it has solid coverage
 * across multiple eras (CD, Mania, 1&2, Unleashed). Everything else
 * lands in the alphabetical tail.
 *
 * `HEADLINE_IDS` is order-preserving: a game IS the example of
 * "what this plugin can do best for this franchise" when it leads
 * its tile group, and the relative order WITHIN the headline set
 * matters too — sm64-decomp (native HD, fast install) is the
 * recommended SM64 entry-point, so it ranks above sm64-render96-rt
 * (premium RT, heavy install). Add to the list when a new recipe
 * goes from "works" to "polished".
 */
/**
 * Allowlist of filesystem roots the `listDirectory` + `importModFromDisk`
 * RPCs may resolve under. The frontend's file browser legitimately
 * needs to navigate the user's `$HOME` (Downloads, .var, etc.) AND
 * external mount points where ROMs commonly live on a SteamDeck-like
 * setup. Everything else (`/etc`, `/root`, `/proc`) is refused so a
 * buggy or hostile caller can't read system files through the RPC.
 */
const FIXED_ALLOWED_ROOTS = [
  "/run/media", // Bazzite / SteamOS removable + secondary mounts
  "/mnt",       // generic Linux mount root
  "/media",     // Debian/Ubuntu mount root
  "/var/home",  // rpm-ostree home path on Silverblue / Bazzite
  "/tmp",       // test sandboxes + occasional debug imports
] as const;

function allowedRoots(): readonly string[] {
  const home = process.env.HOME;
  return home ? [...FIXED_ALLOWED_ROOTS, home] : FIXED_ALLOWED_ROOTS;
}

/** Returns the matched root prefix on success, null otherwise. */
function pathRootAllowed(absolute: string): string | null {
  for (const root of allowedRoots()) {
    if (absolute === root || absolute.startsWith(`${root}/`)) return root;
  }
  return null;
}

/** Render the allowed roots into the user-facing error message so
 *  the constant is the single source of truth — adding a root in
 *  one place updates every error site. */
function allowedRootsErrorPhrase(): string {
  return allowedRoots()
    .map((r) => (r === process.env.HOME ? "$HOME" : r))
    .join(", ");
}

/** Archive extensions the importModFromDisk RPC accepts. Limited to
 *  the formats `lib/pipeline-archive.ts:extractArchive` actually
 *  supports (zip / tar / tar.gz / tgz / appimage). Adding new
 *  extensions here without teaching the extractor first would
 *  surface a confusing "Unsupported archive format" error AFTER
 *  the path-gate accepted the file. */
const ALLOWED_ARCHIVE_EXTENSIONS = [
  ".zip", ".tar", ".tar.gz", ".tgz",
] as const;

function hasAllowedArchiveExtension(absolute: string): boolean {
  const lower = absolute.toLowerCase();
  return ALLOWED_ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

import { FRANCHISE_GROUPS, HEADLINE_IDS } from "./lib/ranking";

function franchiseRank(g: GameInfo): number {
  const tags = g.tags ?? [];
  for (const { tag, rank } of FRANCHISE_GROUPS) {
    if (tags.includes(tag)) return rank;
  }
  return FRANCHISE_GROUPS.length; // everything else
}

function compareForCatalog(a: GameInfo, b: GameInfo): number {
  const groupDiff = franchiseRank(a) - franchiseRank(b);
  if (groupDiff !== 0) return groupDiff;

  const aHead = HEADLINE_IDS.indexOf(a.id);
  const bHead = HEADLINE_IDS.indexOf(b.id);
  if (aHead !== bHead) {
    // Either both headline (lower index wins), or one of them is
    // (the headline one wins). -1 means "not in list" → sort last.
    if (aHead === -1) return 1;
    if (bHead === -1) return -1;
    return aHead - bHead;
  }

  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

export default class RecompBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;

  private state!: PersistedState;
  private registry: GameEntry[] = [];
  private operations = new Set<string>();

  async onLoad(): Promise<void> {
    this.state = await loadState();
    this.registry = loadBundledRegistry();
    // Drop any half-finished mod staging dirs from a previous boot.
    // Fire-and-forget — the prune is best-effort and shouldn't block
    // plugin startup.
    void pruneStaleModStaging();
    // Sweep `installedMods` state for entries whose mod id no longer
    // appears in the registry (a catalog rename or removal across a
    // plugin release). Keeps state.json clean without forcing the
    // user to do anything.
    const catalog = new Map<string, Set<string>>();
    for (const entry of this.registry) {
      if (entry.mods?.length) {
        catalog.set(entry.id, new Set(entry.mods.map((m) => m.id)));
      }
    }
    this.state = await pruneOrphanInstalledMods(this.state, catalog);
    console.log(
      `[recomp] Loaded: ${this.registry.length} games, ${Object.keys(this.state.games).length} installed`,
    );
  }

  // ── Registry ─────────────────────────────────────────────────────

  async getGames(): Promise<GameInfo[]> {
    return await this.mergeGamesWithState();
  }

  /**
   * Open a native file picker (zenity → kdialog) for the user to
   * select a ROM. `extensions` is a list of glob patterns the dialog
   * filters by (e.g. `["z64", "n64"]` for N64). Returns the selected
   * absolute path or null on cancel / picker missing.
   *
   * Used by the detail-view "Browse..." button next to the ROM-path
   * input. Dialog appears as its own gamescope window — the user
   * switches to it via the Steam button + dpad on Gaming Mode.
   */
  /**
   * Live readiness check for the build environment. Detail page
   * calls this on mount for any `build_from_source` entry so it can
   * render either:
   *  - "Ready: distrobox: recomp-build" (green), or
   *  - "Install distrobox + podman first: <one-line install command>"
   *    (red, with the per-distro install hint pre-filled).
   *
   * Per-game dep lists no longer surface here — the recipe owns its
   * own deps and installs them inside the container at install time
   * (idempotent, so the second install is fast).
   */
  async checkBuildEnv(id: string): Promise<{
    ok: boolean;
    label: string;
    missing: string[];
    installHint?: string;
    distroId?: string;
    hasRecipe: boolean;
  }> {
    const entry = this.registry.find((g) => g.id === id);
    const hasRecipe =
      !!entry &&
      entry.installType === "build_from_source" &&
      setupScriptPathFor(entry.id) !== null;
    const probe = await isBuildEnvReady();
    return {
      ok: probe.ok,
      label: probe.ok ? "distrobox: recomp-build" : "(not ready)",
      missing: probe.missing,
      installHint: probe.installHint,
      distroId: probe.distroId,
      hasRecipe,
    };
  }

  /**
   * Persist a user-picked ROM path for `gameId` so the detail page
   * can re-populate the input on next visit and the install
   * pipeline can use it for retries / updates without prompting
   * again. Pass `null` to forget the saved path (e.g. user cleared
   * the input). Returns the saved path (or null after removal) so
   * callers can confirm.
   */
  async setRomPath(
    gameId: string,
    path: string | null,
  ): Promise<string | null> {
    this.state = await setRomPath(this.state, gameId, path);
    return this.state.romPaths?.[gameId] ?? null;
  }

  /** Read the saved ROM path for `gameId`, or null if none. */
  async getRomPath(gameId: string): Promise<string | null> {
    return this.state.romPaths?.[gameId] ?? null;
  }

  async pickRomFile(extensions?: string[]): Promise<string | null> {
    console.log(
      `[recomp] pickRomFile RPC called with extensions=${JSON.stringify(extensions)}`,
    );
    const picked = await pickRomFile(extensions);
    console.log(
      `[recomp] pickRomFile returning: ${picked === null ? "null" : JSON.stringify(picked)}`,
    );
    return picked;
  }

  /**
   * Suggest ROM files for `gameId` by fuzzy-matching the game title
   * against filenames under `settings.romDirectory`. Detail page
   * calls this on mount when the game requires a ROM and no path is
   * yet saved, so the user gets one-click suggestions instead of
   * having to drill the file picker. Returns `[]` when:
   *   - the gameId isn't in the registry
   *   - no `romDirectory` configured in settings
   *   - the game doesn't declare ROM extensions to filter on
   *   - the directory walk finds nothing matching
   * Caller treats all of these as "fall through to manual entry".
   */
  async suggestRomFiles(gameId: string): Promise<RomSuggestion[]> {
    const entry = this.registry.find((g) => g.id === gameId);
    if (!entry) return [];
    const romDir = this.state.settings.romDirectory;
    if (!romDir) return [];
    const exts = entry.romInfo?.extensions ?? [];
    if (exts.length === 0) return [];
    try {
      return await suggestRomsForTitle(entry.name, romDir, exts);
    } catch (err) {
      console.warn(
        `[recomp] suggestRomFiles(${gameId}) failed:`,
        err instanceof Error ? err.message : err,
      );
      return [];
    }
  }

  /**
   * Read a directory for the in-overlay file browser. Returns folder
   * entries (dirs first, then files) with the resolved path so the
   * frontend can drive its breadcrumb. Path resolution:
   *   - "" or undefined → uses `settings.romDirectory` if set, else
   *     `$HOME` as the starting folder
   *   - "~" / "~/..." → expanded against $HOME
   *   - Anything else → resolved as absolute, must exist
   * Hidden entries (`.foo`) are filtered out — the user wants ROMs,
   * not config-dir noise.
   */
  async listDirectory(path?: string): Promise<{
    currentPath: string;
    parent: string | null;
    entries: { name: string; isDir: boolean }[];
  }> {
    const { readdir, stat } = await import("node:fs/promises");
    const { join, resolve, dirname } = await import("node:path");
    const home = process.env.HOME ?? "/home";

    let resolved: string;
    if (!path || path.length === 0) {
      resolved = this.state.settings.romDirectory ?? home;
    } else if (path === "~") {
      resolved = home;
    } else if (path.startsWith("~/")) {
      resolved = join(home, path.slice(2));
    } else {
      resolved = resolve(path);
    }

    // Refuse anything outside the user's home + standard mount points.
    // Defence-in-depth — the UI doesn't try to navigate `/etc`, but
    // the RPC is callable from anywhere with the WebSocket and we
    // don't want it to be a "read any path" primitive.
    if (!pathRootAllowed(resolved)) {
      throw new Error(
        `listDirectory: path '${resolved}' is outside the allowed roots (${allowedRootsErrorPhrase()}).`,
      );
    }

    const dirents = await readdir(resolved, { withFileTypes: true });
    const entries: { name: string; isDir: boolean }[] = [];
    for (const d of dirents) {
      if (d.name.startsWith(".")) continue;
      // Some setups expose symlinks/etc — stat to find out what they
      // resolve to so we don't show a "file" row that's actually a
      // dir the user can drill into.
      let isDir = d.isDirectory();
      if (!isDir && d.isSymbolicLink()) {
        try {
          isDir = (await stat(join(resolved, d.name))).isDirectory();
        } catch {
          continue;
        }
      }
      entries.push({ name: d.name, isDir });
    }
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const parent = resolved === "/" ? null : dirname(resolved);
    return { currentPath: resolved, parent, entries };
  }

  /**
   * Look up the SGDB capsule URL for a catalog entry. Each tile in
   * the browse grid fires this once on mount to populate its cover
   * art (installed games already have art via the loader-local
   * `/api/steam-grid/...` route; this fills in the uninstalled case).
   * Cached 24 h on disk so subsequent catalog opens are instant.
   * Returns null when no SGDB key is configured or no match exists.
   */
  async getCatalogArt(id: string): Promise<string | null> {
    const entry = this.registry.find((g) => g.id === id);
    if (!entry) return null;
    return getCatalogArtUrl(entry);
  }

  /**
   * Look up the SGDB landscape hero URL for a catalog entry. Used
   * by the detail page's hero banner. Null when no SGDB key or no
   * match; the frontend falls back to a flat gradient. Cached 24h
   * via the shared sgdb-art cache.
   */
  async getDetailHero(id: string): Promise<string | null> {
    const entry = this.registry.find((g) => g.id === id);
    if (!entry) return null;
    return getDetailHeroUrl(entry);
  }

  async getGameDetail(id: string): Promise<GameInfo | null> {
    const games = await this.mergeGamesWithState();
    return games.find((g) => g.id === id) ?? null;
  }

  // ── Pipeline ─────────────────────────────────────────────────────

  async installGame(id: string, romPath?: string): Promise<void> {
    const entry = this.registry.find((g) => g.id === id);
    if (!entry) throw new Error(`Game '${id}' not found in registry`);

    if (this.operations.has(id)) {
      throw new Error(`Operation already in progress for '${id}'`);
    }
    this.operations.add(id);

    // Resolve the ROM path: explicit arg wins, then any path the
    // user previously saved via `setRomPath`. Persist a freshly-
    // supplied arg so retries / updates don't prompt again.
    const effectiveRom = romPath ?? this.state.romPaths?.[id];
    if (romPath && this.state.romPaths?.[id] !== romPath) {
      this.state = await setRomPath(this.state, id, romPath);
    }

    try {
      this.state = await installGame(entry, this.state, effectiveRom, (event) => {
        this.emitPipelineEvent(event);
      });
      this.emit?.({
        event: "gameStatusChanged",
        data: { gameId: id, status: "installed" },
      });
    } finally {
      this.operations.delete(id);
    }
  }

  async updateGame(id: string): Promise<void> {
    const entry = this.registry.find((g) => g.id === id);
    if (!entry) throw new Error(`Game '${id}' not found in registry`);

    if (this.operations.has(id)) {
      throw new Error(`Operation already in progress for '${id}'`);
    }
    this.operations.add(id);

    try {
      this.state = await updateGame(entry, this.state, (event) => {
        this.emitPipelineEvent(event);
      });
      this.emit?.({
        event: "gameStatusChanged",
        data: { gameId: id, status: "installed" },
      });
    } finally {
      this.operations.delete(id);
    }
  }

  async uninstallGame(id: string): Promise<void> {
    if (this.operations.has(id)) {
      throw new Error(`Operation already in progress for '${id}'`);
    }
    this.operations.add(id);

    try {
      // Also remove the Steam shortcut so it doesn't dangle after the
      // files are gone.
      const existing = this.state.games[id];
      if (existing?.addedToSteam && existing.steamAppId != null) {
        await removeFromSteam(existing.steamAppId);
      }
      this.state = await uninstallGame(id, this.state);
      this.emit?.({
        event: "gameStatusChanged",
        data: { gameId: id, status: "available" },
      });
    } finally {
      this.operations.delete(id);
    }
  }

  /**
   * Repair path: re-add a previously-installed game to Steam (e.g.
   * after Steam ate the shortcut, or the user installed with
   * `autoAddToSteam: false`). Also re-applies artwork.
   */
  async addInstalledToSteam(id: string): Promise<void> {
    const entry = this.registry.find((g) => g.id === id);
    if (!entry) throw new Error(`Game '${id}' not found in registry`);
    const installed = this.state.games[id];
    if (!installed) throw new Error(`Game '${id}' is not installed`);

    const shortcut = await addToSteam(entry, installed);
    const updated = {
      ...installed,
      addedToSteam: true,
      steamAppId: shortcut.appId,
      steamGameId64: shortcut.gameId64,
    };
    this.state = await updateInstalledGame(this.state, id, updated);
    this.emit?.({
      event: "gameStatusChanged",
      data: { gameId: id, status: "installed" },
    });

    // Best-effort artwork; no throw on failure.
    try {
      await applyArtwork(entry, shortcut.appId);
    } catch (err) {
      console.warn(`[recomp] artwork apply failed for ${id}:`, err);
    }
  }

  // ── Launcher ─────────────────────────────────────────────────────

  async launchGame(id: string): Promise<void> {
    const entry = this.registry.find((g) => g.id === id);
    if (!entry) throw new Error(`Game '${id}' not found in registry`);

    const installed = this.state.games[id];
    if (!installed) throw new Error(`Game '${id}' is not installed`);

    await launchGame(entry, installed);
  }

  // ── Mods ─────────────────────────────────────────────────────────

  /**
   * Return the catalog of mods for `gameId`, enriched with per-mod
   * install state from `state.games[gameId].installedMods`. Returns
   * `[]` for games with no mod catalog or that aren't in the registry.
   */
  async getMods(gameId: string): Promise<ModInfo[]> {
    const entry = this.registry.find((g) => g.id === gameId);
    if (!entry?.mods?.length) return [];
    const installed = this.state.games[gameId]?.installedMods ?? {};
    return entry.mods.map((mod) => {
      const isInstalling = this.operations.has(modOpKey(gameId, mod.id));
      const record = installed[mod.id];
      const status = isInstalling
        ? ("installing" as const)
        : record
          ? ("installed" as const)
          : ("not_installed" as const);
      return {
        ...mod,
        status,
        installedAt: record?.installedAt,
        installedVersion: record?.version,
      };
    });
  }

  /**
   * Auto-install a `github-release` / `direct-url` mod. Rejects
   * manual-import (UI should never route a manual-import through
   * here — `importModFromDisk` is its path).
   */
  async installMod(gameId: string, modId: string): Promise<void> {
    const { entry, mod, installed } = this.resolveModContext(gameId, modId);
    if (mod.source.kind === "manual-import") {
      throw new Error(
        `Mod "${modId}" is manual-import — use the Import from disk button instead.`,
      );
    }
    const key = modOpKey(gameId, modId);
    if (this.operations.has(key)) {
      throw new Error(`Operation already in progress for mod '${modId}'`);
    }
    this.operations.add(key);
    try {
      const result = await installMod(entry, installed, mod, (event) =>
        this.emitPipelineEvent(event),
      );
      this.state = await recordInstalledMod(this.state, gameId, modId, {
        installedAt: result.installedAt,
        version: result.version,
        source: mod.source.kind,
      });
      this.emit?.({
        event: "gameStatusChanged",
        data: { gameId, status: "installed" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emitPipelineEvent({
        type: "error",
        gameId,
        stage: `mod:${modId}:install`,
        message,
      });
      throw err;
    } finally {
      this.operations.delete(key);
    }
  }

  /**
   * Import a `manual-import` mod from a user-picked local archive.
   * Mirrors `installMod` apart from skipping the download step.
   */
  async importModFromDisk(
    gameId: string,
    modId: string,
    filePath: string,
  ): Promise<void> {
    console.log(
      `[recomp] importModFromDisk gameId=${gameId} modId=${modId} filePath=${JSON.stringify(filePath)}`,
    );
    // Validate the user-supplied path BEFORE touching the mod state.
    // Frontend file browser limits the picker to allowed roots, but
    // the RPC itself is callable from any WebSocket client and we
    // don't want it to be a "read any file" primitive — the import
    // pipeline opens the file with `extractArchive`, which would
    // happily try to interpret `/etc/shadow` as a zip.
    //
    // We `realpath` the input before the gate fires so a symlink at
    // `~/Downloads/innocent.zip → /etc/shadow` is gated on the
    // CANONICAL `/etc/shadow` path, not the symlink home. Mirrors
    // `pipeline.ts:665-669` (exe-inside-cwd verifier) which does
    // the same dance for the same reason.
    const { resolve: resolvePath } = await import("node:path");
    const { realpath } = await import("node:fs/promises");
    let absolute: string;
    try {
      absolute = await realpath(resolvePath(filePath));
    } catch {
      // realpath fails on ENOENT — surface the not-found earlier
      // than `existsSync` inside the pipeline so the user sees a
      // single coherent error message.
      throw new Error(`importModFromDisk: file '${filePath}' not found.`);
    }
    if (!pathRootAllowed(absolute)) {
      throw new Error(
        `importModFromDisk: path '${absolute}' is outside the allowed roots (${allowedRootsErrorPhrase()}).`,
      );
    }
    if (!hasAllowedArchiveExtension(absolute)) {
      throw new Error(
        `importModFromDisk: '${absolute}' doesn't have a supported archive extension (${ALLOWED_ARCHIVE_EXTENSIONS.join(", ")}).`,
      );
    }
    const { entry, mod, installed } = this.resolveModContext(gameId, modId);
    if (mod.source.kind !== "manual-import") {
      throw new Error(
        `Mod "${modId}" is ${mod.source.kind} — use Install (auto-download) instead.`,
      );
    }
    const key = modOpKey(gameId, modId);
    if (this.operations.has(key)) {
      throw new Error(`Operation already in progress for mod '${modId}'`);
    }
    this.operations.add(key);
    try {
      const result = await installModFromArchive(
        entry,
        installed,
        mod,
        // Pass the realpath'd path so the rest of the pipeline
        // operates on the canonical location, not the symlink.
        absolute,
        (event) => this.emitPipelineEvent(event),
      );
      this.state = await recordInstalledMod(this.state, gameId, modId, {
        installedAt: result.installedAt,
        version: result.version,
        source: mod.source.kind,
      });
      this.emit?.({
        event: "gameStatusChanged",
        data: { gameId, status: "installed" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emitPipelineEvent({
        type: "error",
        gameId,
        stage: `mod:${modId}:install`,
        message,
      });
      throw err;
    } finally {
      this.operations.delete(key);
    }
  }

  /**
   * Resolve a mod's external URL (gamebanana page, MediaFire folder,
   * Drive file). Frontend hands the returned URL to
   * `useBackend("quick-links").call("launchUrl", url)` so the user's
   * configured browser shortcut opens it in Gaming Mode.
   *
   * Returns null when the mod doesn't declare an externalUrl. The
   * UI button is hidden when null.
   */
  async getModUrl(gameId: string, modId: string): Promise<string | null> {
    const { mod } = this.resolveModContext(gameId, modId, { allowUninstalled: true });
    return mod.externalUrl ?? null;
  }


  // ── Settings ─────────────────────────────────────────────────────

  async getSettings(): Promise<Settings> {
    return this.state.settings;
  }

  async updateSettings(settings: Partial<Settings>): Promise<void> {
    this.state = await updateStateSettings(this.state, settings);
  }

  // ── Internal ─────────────────────────────────────────────────────

  private async mergeGamesWithState(): Promise<GameInfo[]> {
    // Refresh "what's the actually-current upstream tag?" for every
    // installed game in parallel. Cached 6 h on disk, so the typical
    // call returns instantly — only stale entries pay a GitHub
    // round-trip. Bounded to installed games (not the whole 463-
    // entry catalogue) to stay well under GitHub's 60-req/h
    // unauthenticated rate limit.
    const installedRepos = Array.from(
      new Set(
        this.registry
          .filter((e) => this.state.games[e.id])
          .map((e) => e.repo),
      ),
    );
    const liveLatestByRepo = new Map<string, string>();
    await Promise.all(
      installedRepos.map(async (repo) => {
        const tag = await latestReleaseTag(repo);
        if (tag) liveLatestByRepo.set(repo, tag);
      }),
    );

    return this.registry.map((entry): GameInfo => {
      const installed = this.state.games[entry.id];
      // Windows-only releases count as "available" on Linux because
      // we register the shortcut with Proton as the compat tool;
      // Sonic Unleashed Recomp et al. ship .exe-only and just work
      // through Proton from a non-Steam shortcut.
      // build_from_source entries are available iff there's a recipe
      // shipped alongside the manifest (plugins/recomp/games/<id>/
      // setup.ts) AND the upstream repo is set. The recipe + recomp
      // distrobox handle everything else.
      // A game is installable iff:
      //   - prebuilt / rom_extract / toolchain: has a releaseAsset
      //     pattern AND a launchCommand on at least one platform
      //     (the asset gives us something to download; the launch
      //     command gives us something to wire up after). Catalog
      //     dumps occasionally include entries with one but not the
      //     other — those would 500 on install ("no launch command
      //     for X on this platform"), so flag them unavailable.
      //   - build_from_source: has a repo + a setup.ts recipe shipped
      //     alongside the manifest. The recipe handles launch wiring
      //     itself via sdk.declareLaunchCommand.
      const hasLaunchOnSomePlatform = (["linux", "windows", "macos"] as const)
        .some((p) => !!entry.launchCommand?.[p]);
      const hasNativeBuild =
        (!!getEffectivePlatformValue(entry.releaseAssets) &&
          hasLaunchOnSomePlatform) ||
        (entry.installType === "build_from_source" &&
          !!entry.repo &&
          setupScriptPathFor(entry.id) !== null);
      const isOperating = this.operations.has(entry.id);

      // Authoritative latest = whatever GitHub returned (cached);
      // the registry's `latestVersion` is only the fallback for when
      // we couldn't reach GitHub or the repo has no releases. Without
      // the live lookup the hand-curated registry goes stale every
      // time upstream cuts a release, leaving the Update badge
      // permanently lit (e.g. registry pinned `trx-1.4.2` while
      // upstream had moved to `trx-1.6`).
      const upstreamLatest =
        liveLatestByRepo.get(entry.repo) ?? entry.latestVersion;
      const hasUpdate =
        !!installed &&
        !!upstreamLatest &&
        upstreamLatest !== installed.installedVersion;

      let gameStatus: GameStatus;
      if (isOperating) {
        gameStatus = installed ? "updating" : "installing";
      } else if (entry.status === "in_progress") {
        gameStatus = "in_progress";
      } else if (!hasNativeBuild && entry.installType === "build_from_source") {
        gameStatus = "unavailable";
      } else if (installed) {
        gameStatus = hasUpdate ? "update_available" : "installed";
      } else if (!hasNativeBuild) {
        gameStatus = "unavailable";
      } else {
        gameStatus = "available";
      }

      return {
        ...entry,
        installedVersion: installed?.installedVersion,
        addedToSteam: installed?.addedToSteam ?? false,
        steamAppId: installed?.steamAppId,
        steamGameId64: installed?.steamGameId64,
        hasUpdate,
        gameStatus,
        hasNativeBuild,
      };
    }).sort(compareForCatalog);
  }

  private emitPipelineEvent(event: PipelineEvent): void {
    this.emit?.({ event: "pipelineEvent", data: event });
  }

  /**
   * Resolve the trio of `entry / mod / installed` for a mod RPC.
   *
   * Defaults to requiring the base game to be installed (mods overlay
   * an install; you can't drop textures into a directory that doesn't
   * exist yet). `allowUninstalled` short-circuits that check for
   * `getModUrl` — the "Open page" link is meaningful even when the
   * base game isn't installed yet, e.g. to read the mod's home page
   * before committing to an install.
   */
  private resolveModContext(
    gameId: string,
    modId: string,
    opts: { allowUninstalled?: boolean } = {},
  ): {
    entry: GameEntry;
    mod: ReturnType<typeof requireMod>;
    installed: PersistedState["games"][string];
  } {
    const entry = this.registry.find((g) => g.id === gameId);
    if (!entry) throw new Error(`Game '${gameId}' not found in registry`);
    const mod = requireMod(entry, modId);
    // Re-validate at install time so a runtime-mutated entry can't
    // sneak past the load-time check.
    const err = validateModEntry(gameId, mod);
    if (err) throw new Error(err);
    const installed = this.state.games[gameId];
    if (!installed && !opts.allowUninstalled) {
      throw new Error(
        `Install '${gameId}' first — mods can't be applied to a not-installed game.`,
      );
    }
    return { entry, mod, installed: installed ?? ({} as PersistedState["games"][string]) };
  }
}

function modOpKey(gameId: string, modId: string): string {
  return `mod:${gameId}:${modId}`;
}

function requireMod(entry: GameEntry, modId: string) {
  const mod = entry.mods?.find((m) => m.id === modId);
  if (!mod) {
    throw new Error(`Mod '${modId}' not found on game '${entry.id}'`);
  }
  return mod;
}
