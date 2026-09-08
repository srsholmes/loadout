import type { PluginBackend, EmitPayload } from "@loadout/types";
import { runCode, runFull } from "@loadout/exec";
import { CDPClient, listCefTabs } from "@loadout/steam-cdp";
import { readPluginStorage, writePluginStorage } from "@loadout/plugin-storage";
import { cp, mkdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { isTargetTab } from "./lib/tab-matching";
import {
  buildInjectStyleExpression,
  buildMissingStylesExpression,
  buildRemoveStyleExpression,
  parseMissingStyles,
} from "./lib/injection-probe";
import type {
  CommunityThemeEntry,
  ThemeListEntry,
} from "./lib/types";
import {
  assemblePackCss,
  findUpstreamLicense,
  listInstalledPacks,
  locateThemeRoot,
  readManifest,
  summarizePatches,
  writeThemeMeta,
  type InstalledPack,
  type ThemeMeta,
} from "./lib/theme-pack";
import {
  ensureTranslations,
  getTranslationsStatus,
  refreshTranslations,
  type TranslationsStatus,
} from "./lib/translations-cache";
import {
  ensureCommunityThemes,
  getCommunityThemesSync,
  getCommunityThemesStatus,
  refreshCommunityThemes,
  type ThemesStatus,
} from "./lib/themes-cache";

/**
 * Theme Loader plugin backend.
 *
 * Connects to Steam's CEF debug port via Chrome DevTools Protocol,
 * discovers Big Picture Mode / SharedJSContext / QuickAccess tabs,
 * and injects/removes CSS themes at runtime.
 *
 * Themes are ThemeDB-format directories (manifest + CSS files +
 * optional patch variants) installed into
 * `~/.local/share/loadout/theme-loader/css-themes/`. The format is the
 * community standard used by themes published to deckthemes.com.
 *
 * The community theme directory is consumed live from
 * `api.deckthemes.com` via {@link "./lib/themes-cache"}; nothing is
 * bundled.
 */

interface CDPConnection {
  /**
   * CEF target id from `/json`. Discovery runs repeatedly, so the
   * connection list has to be matched against the current tab list by
   * something stable — titles are not unique (two `QuickAccess*` tabs
   * can be live at once) and the WebSocket URL embeds the same id.
   */
  id: string;
  /** Tab title at connect time. Logging only. */
  title: string;
  client: CDPClient;
}

const CDP_TIMEOUT_MS = 5000;
/** Cadence of the connection/injection health check. */
const HEALTH_INTERVAL_MS = 5000;
/**
 * How long after the plugin loads every health tick also verifies that
 * the CSS is really in the page.
 *
 * Sized for a cold boot: the service starts around login, and Steam can
 * take a couple of minutes to finish building its CEF tabs and settle
 * into Big Picture. That whole span is when tabs appear late and get
 * reloaded, so it is checked aggressively; afterwards the plugin backs
 * off to {@link STEADY_VERIFY_EVERY_TICKS}.
 */
const STARTUP_VERIFY_WINDOW_MS = 180_000;
/** Steady-state verification cadence, in health ticks (6 × 5 s = 30 s). */
const STEADY_VERIFY_EVERY_TICKS = 6;
/**
 * First delay before re-syncing class translations after a failure, then
 * doubling to {@link TRANSLATION_RETRY_MAX_MS}.
 *
 * Backoff matters here because the failure this recovers from — booting
 * before wifi associates — is indistinguishable from being permanently
 * offline, and `ensureTranslations` has no failure memory of its own: it
 * issues a fresh 30 s request every time it is called with no cache. An
 * offline Deck would otherwise hit a third-party API for the life of the
 * session.
 */
const TRANSLATION_RETRY_BASE_MS = 15_000;
const TRANSLATION_RETRY_MAX_MS = 15 * 60_000;

interface InjectedStyle {
  /** Unique ID for the injected <style> element */
  styleId: string;
}

const PLUGIN_ID = "theme-loader";
const DEBUG_PORT = 8080;
/** Where community theme packs are installed. */
const THEME_PACKS_DIR = join(homedir(), ".local/share/loadout/theme-loader/css-themes");

/** Shape persisted to plugin-storage. */
interface ThemeLoaderStorage {
  /** Persistent list of active theme IDs — survives service restarts. */
  activeThemes: string[];
  /** Persistent per-theme variant selections ({themeId: {patchName: value}}). */
  packVariants: Record<string, Record<string, string>>;
}

/** Strict ID pattern to prevent path traversal when installing community themes. */
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function safeStyleId(themeId: string): string {
  return `theme-loader-${themeId.replace(/[^a-zA-Z0-9-_]/g, "_")}`;
}

export default class ThemeLoaderBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;

  /** theme id -> InjectedStyle mapping for currently-active themes */
  private activeThemes = new Map<string, InjectedStyle>();
  /** CDP connections to Steam tabs */
  private connections: CDPConnection[] = [];
  /** Discovered/installed theme packs, keyed by id. */
  private installedPacks = new Map<string, InstalledPack>();
  /** Per-pack variant selections, keyed by pack id. */
  private packVariants: Record<string, Record<string, string>> = {};
  /** Whether we have an active connection to Steam */
  private connected = false;
  /** Health check interval */
  private healthInterval?: ReturnType<typeof setInterval>;
  /**
   * Guard against concurrent re-injection storms — the 5 s health
   * check can race with `onLoad`'s initial re-inject and with manual
   * `reconnect()` calls. Each path that wants to re-inject all
   * active themes folds into this single in-flight promise.
   */
  private inflightReinject: Promise<void> | null = null;
  /** Re-entrancy guard for `checkHealth` — its verification pass can
   *  outlast the 5 s tick that scheduled it. */
  private healthChecking = false;
  /** Health ticks since load, used to throttle steady-state verification. */
  private healthTicks = 0;
  /**
   * Origin of the startup verify window. Anchored on the FIRST successful
   * CEF connect, not on `onLoad`: the service starts at login, but Steam
   * may only be launched much later (or never, in desktop mode), and the
   * race this window exists for begins when Steam does.
   */
  private startupWindowFrom: number | null = null;
  /**
   * Set once `onUnload` has run. Every async step that resumes after an
   * await re-checks it — an in-flight verify pass would otherwise open
   * sockets into the array unload just cleared, and re-inject the CSS
   * unload just removed, leaving a disabled plugin's themes on screen
   * with no live instance able to remove them.
   */
  private disposed = false;
  /** In-flight `tryConnect`, so two passes can't both open a socket to
   *  the same tab — additive discovery would then keep both forever. */
  private inflightConnect: Promise<boolean> | null = null;
  /**
   * Set when CSS was assembled without the class-translation map, so
   * what is on screen may carry the authoring build's selectors.
   *
   * The DOM probe cannot see this — the `<style>` is present and full of
   * CSS, it just may not match — so the fact is carried forward and the
   * styles rebuilt once the map arrives.
   */
  private cssBuiltWithoutTranslations = false;
  /** Earliest time a translation re-sync may be attempted (backoff). */
  private translationRetryAt = 0;
  /** Current translation retry delay, doubling to {@link TRANSLATION_RETRY_MAX_MS}. */
  private translationRetryDelayMs = TRANSLATION_RETRY_BASE_MS;
  /** True while a background translation re-sync is running. */
  private translationRetryInflight = false;
  /** Last payload handed to `emit`, for change detection. */
  private lastEmitted: string | null = null;

  async onLoad(): Promise<void> {
    console.log("[theme-loader] Plugin loaded");
    this.disposed = false;
    this.startupWindowFrom = null;
    this.healthTicks = 0;
    await mkdir(THEME_PACKS_DIR, { recursive: true });
    await this.rescanPacks();
    await this.loadStateFromDisk();

    // Prime the class-translation cache. Restored themes must not be
    // injected ahead of it: pack CSS carries the obfuscated class names
    // of the Steam build it was authored against, and `assemblePackCss`
    // silently emits them untranslated when the map is missing. That
    // injects a `<style>` that is present but matches nothing — a theme
    // that looks to the user like it simply didn't load.
    //
    // At boot that is a live race, and one the injection usually wins:
    // connecting to CEF on localhost takes milliseconds, while the map
    // may need a network fetch on a Deck whose wifi hasn't associated
    // yet. So connect in parallel but gate the inject on the cache.
    const translationsSettled = ensureTranslations()
      .then(() => this.emitState())
      .catch(() => { /* status reflects the failure */ });

    // Try initial connection, but don't block if Steam isn't running.
    // Re-injection folds into `reinjectAllActiveThemes` so a parallel
    // health-check tick can't double-inject the same CSS.
    Promise.all([this.tryConnect(), translationsSettled]).then(async ([connected]) => {
      if (connected) {
        await this.reinjectAllActiveThemes();
        if (this.activeThemes.size > 0) {
          console.log(`[theme-loader] Re-injected ${this.activeThemes.size} active theme(s)`);
        }
      }
    }).catch(() => {
      console.log("[theme-loader] Steam CEF not available yet, will retry");
    });

    // Periodically check that we are still connected AND that the CSS
    // is still in the page — the initial inject above races Steam's own
    // startup, so it is verified rather than assumed. See `checkHealth`.
    this.healthInterval = setInterval(() => {
      // An unhandled rejection out of a timer would take down the whole
      // backend process, and this callback is the only place nothing is
      // waiting on the promise.
      this.checkHealth().catch((err) => {
        console.warn("[theme-loader] Health check failed:", err);
      });
    }, HEALTH_INTERVAL_MS);
  }

  async onUnload(): Promise<void> {
    // Set BEFORE the awaits below. A verify pass parked on a socket
    // connect or a pack read would otherwise resume afterwards, push into
    // the connection array this clears and re-inject the CSS this
    // removes — leaving an unloaded plugin's themes on screen, held open
    // by sockets no live instance can close.
    this.disposed = true;
    clearInterval(this.healthInterval);
    this.healthInterval = undefined;

    // Remove all injected CSS
    for (const [, injected] of this.activeThemes) {
      await this.removeFromAllTabs(injected.styleId);
    }

    this.closeAllConnections();
    this.connected = false;
    // Drop in-flight coalescing so a later onLoad on this instance can't
    // adopt a promise belonging to the previous lifetime.
    this.inflightReinject = null;
    this.inflightConnect = null;
    this.healthChecking = false;

    console.log("[theme-loader] Plugin unloaded");
  }

  // ─── RPC Methods — Themes ─────────────────────────────────────────

  /** Return all installed theme packs. */
  async getThemes(): Promise<ThemeListEntry[]> {
    await this.rescanPacks();
    const entries: ThemeListEntry[] = [];

    const communityEntries = getCommunityThemesSync() ?? [];
    for (const [id, pack] of this.installedPacks) {
      const communityEntry = communityEntries.find((e) => e.id === id);
      entries.push({
        id,
        name: pack.manifest.name ?? id,
        kind: "pack",
        active: this.activeThemes.has(id),
        thumbnailUrl: communityEntry?.thumbnailUrl ?? null,
        patches: summarizePatches(pack.manifest),
        variants: this.packVariants[id] ?? {},
        meta: pack.meta,
      });
    }

    return entries;
  }

  /** Enable a theme by id — injects its CSS into all targeted Steam tabs. */
  async enableTheme(id: string): Promise<{ success: boolean; error?: string; code?: string }> {
    if (this.activeThemes.has(id)) {
      return { success: true };
    }

    // All themes are pack-style now, so the class-translation map must
    // be ready before we inject — old selectors need to be rewritten to
    // the current Steam build before they'll match anything.
    const status = getTranslationsStatus();
    if (status.state !== "ready") {
      return {
        success: false,
        code: "translations-not-synced",
        error: status.lastError
          ? `Class translations not synced (${status.lastError}). Connect to the network and try again.`
          : "Class translations are still syncing. Try again in a moment.",
      };
    }

    const css = await this.loadThemeCss(id);
    if (css === null) {
      return { success: false, error: `Theme "${id}" not found` };
    }

    if (!this.connected) {
      const didConnect = await this.tryConnect();
      if (!didConnect) {
        return { success: false, error: "Not connected to Steam CEF. Is Steam running?" };
      }
    }

    const styleId = safeStyleId(id);
    try {
      await this.injectToAllTabs(styleId, css);
      this.activeThemes.set(id, { styleId });
      await this.saveStateToDisk();
      this.emitState();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  /** Disable a theme by id — removes its CSS from all targeted Steam tabs. */
  async disableTheme(id: string): Promise<{ success: boolean; error?: string }> {
    const injected = this.activeThemes.get(id);
    if (!injected) {
      return { success: true };
    }

    try {
      await this.removeFromAllTabs(injected.styleId);
      this.activeThemes.delete(id);
      await this.saveStateToDisk();
      this.emitState();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  /** Return list of currently active theme ids. */
  async getActiveThemes(): Promise<string[]> {
    return Array.from(this.activeThemes.keys());
  }

  /** Check if we're connected to Steam's CEF debug port. */
  async getStatus(): Promise<{ connected: boolean; tabCount: number; activeThemeCount: number }> {
    return {
      connected: this.connected,
      tabCount: this.connections.length,
      activeThemeCount: this.activeThemes.size,
    };
  }

  /** Manually trigger a reconnection attempt. */
  async reconnect(): Promise<{ success: boolean; error?: string }> {
    // Wait out any discovery already running, so clearing the list can't
    // race it into opening a duplicate socket per tab.
    await this.inflightConnect?.catch(() => false);
    this.closeAllConnections();
    this.connected = false;

    const didConnect = await this.tryConnect();
    if (didConnect) {
      // Re-inject all active themes via the shared in-flight guard
      // so this manual reconnect can't race with the 5 s health check.
      await this.reinjectAllActiveThemes();
      this.emitState();
      return { success: true };
    }
    return { success: false, error: "Could not connect to Steam CEF" };
  }

  // ─── RPC Methods — Class Translations ─────────────────────────────

  /** Current state of the class-translation cache. UI uses this to
   *  show a status badge and gate the Apply button for pack themes. */
  async getTranslationStatus(): Promise<TranslationsStatus> {
    return getTranslationsStatus();
  }

  /** Force a refresh of the class-translation cache from upstream. */
  async refreshTranslationCache(): Promise<TranslationsStatus> {
    const status = await refreshTranslations({ force: true });
    this.emitState();
    return status;
  }

  // ─── RPC Methods — Community Themes ───────────────────────────────

  /** List community themes from the live registry, with install status. */
  async listCommunityThemes(): Promise<(CommunityThemeEntry & { installed: boolean })[]> {
    await this.rescanPacks();
    const entries = await ensureCommunityThemes();
    return entries.map((e) => ({
      ...e,
      installed: this.installedPacks.has(e.id),
    }));
  }

  /** Current state of the community-themes registry sync. */
  async getCommunityThemesStatus(): Promise<ThemesStatus> {
    return getCommunityThemesStatus();
  }

  /** Force a refresh of the community-themes registry from upstream. */
  async refreshCommunityThemesCache(): Promise<ThemesStatus> {
    const status = await refreshCommunityThemes({ force: true });
    this.emitState();
    return status;
  }

  /**
   * Download and install a community theme. Fetches the zip from
   * deckthemes' blob endpoint, extracts, locates the theme root
   * (directory containing theme.json), and copies it to
   * `~/.local/share/loadout/theme-loader/css-themes/{id}/`.
   *
   * We always use `api.deckthemes.com/blobs/{downloadBlobId}` rather
   * than reaching into GitHub. The blob endpoint is the canonical
   * install source upstream maintains, and avoids the registry
   * needing per-theme GitHub-subdir/branch metadata.
   */
  async installCommunityTheme(
    id: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (!SAFE_ID.test(id)) {
      return { success: false, error: `Invalid theme id: "${id}"` };
    }

    const entries = await ensureCommunityThemes();
    const entry = entries.find((e) => e.id === id);
    if (!entry) {
      return { success: false, error: `Theme "${id}" not found in registry` };
    }

    const tempBase = join(tmpdir(), `loadout-theme-loader-${id}-${Date.now()}`);
    const extractDir = tempBase;
    const zipPath = `${tempBase}.zip`;

    try {
      console.log(`[theme-loader] Downloading ${entry.name} from api.deckthemes.com`);
      const response = await fetch(
        `https://api.deckthemes.com/blobs/${entry.downloadBlobId}`,
        { signal: AbortSignal.timeout(120_000) },
      );

      if (!response.ok) {
        return { success: false, error: `Download failed: HTTP ${response.status}` };
      }

      // Sanity cap: deckthemes blobs are tens of KB to a few MB; >50 MB is
      // either a hostile/buggy CDN response or the wrong asset, and we
      // shouldn't fill the user's disk to find out.
      const MAX_BLOB_BYTES = 50 * 1024 * 1024;
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (contentLength > MAX_BLOB_BYTES) {
        return {
          success: false,
          error: `Download too large: ${contentLength} bytes (max ${MAX_BLOB_BYTES})`,
        };
      }
      const buf = await response.arrayBuffer();
      if (buf.byteLength > MAX_BLOB_BYTES) {
        return {
          success: false,
          error: `Download too large: ${buf.byteLength} bytes (max ${MAX_BLOB_BYTES})`,
        };
      }
      await Bun.write(zipPath, buf);

      await mkdir(extractDir, { recursive: true });
      const { exitCode: unzipCode } = await runFull(["unzip", "-o", zipPath, "-d", extractDir]);
      if (unzipCode !== 0) {
        return { success: false, error: `Failed to extract zip` };
      }

      // The deckthemes blob is a flat zip with theme.json at the root or
      // inside a single top-level directory. Walk from the extract root
      // and let locateThemeRoot find the manifest.
      const themeRoot = await locateThemeRoot(extractDir);
      if (!themeRoot) {
        return { success: false, error: `Theme "${entry.name}" not found in downloaded archive` };
      }

      // Stage-then-swap install:
      //   1. Copy the new theme into `<targetDir>.new`.
      //   2. Atomically swap the old install out: rename existing
      //      `<targetDir>` → `<targetDir>.old`, then rename
      //      `<targetDir>.new` → `<targetDir>`.
      //   3. Delete `<targetDir>.old` once the swap is complete.
      //
      // If step 1 fails (disk full / EIO / bad cp), we clean up the
      // staging dir and leave the user's previous install untouched.
      // If step 2 fails after the .new dir is in place, the catch
      // block restores the .old dir back to targetDir so the user is
      // never left without a theme.
      const targetDir = join(THEME_PACKS_DIR, id);
      const stagingDir = `${targetDir}.new`;
      const backupDir = `${targetDir}.old`;
      await mkdir(THEME_PACKS_DIR, { recursive: true });

      // Clear any leftover staging / backup from a previous crashed
      // install so the swap below sees a clean slate.
      try { await rm(stagingDir, { recursive: true, force: true }); } catch { /* nothing to remove */ }
      try { await rm(backupDir, { recursive: true, force: true }); } catch { /* nothing to remove */ }

      try {
        await cp(themeRoot, stagingDir, { recursive: true });
      } catch (err) {
        // Staging copy failed — leave the old install untouched and
        // surface the error.
        try { await rm(stagingDir, { recursive: true, force: true }); } catch { /* transient FS */ }
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Install failed during copy: ${msg}` };
      }

      // Capture per-theme attribution into the staged dir BEFORE the
      // swap so the meta sidecar lands atomically with the rest of
      // the install.
      const license = await findUpstreamLicense(themeRoot, extractDir);
      const meta: ThemeMeta = {
        author: entry.author ?? null,
        description: entry.description ?? null,
        version: entry.version ?? null,
        sourceUrl: entry.githubUrl ?? null,
        license,
      };
      try {
        await writeThemeMeta(stagingDir, meta);
      } catch (err) {
        try { await rm(stagingDir, { recursive: true, force: true }); } catch { /* transient FS */ }
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Install failed writing metadata: ${msg}` };
      }

      // Atomic swap. `rename` is atomic on the same filesystem (we
      // stage under the same parent dir to guarantee this). On any
      // failure, attempt to restore the previous install from the
      // backup so the user is never left without a working theme.
      let hadOldInstall = false;
      try {
        try {
          await rename(targetDir, backupDir);
          hadOldInstall = true;
        } catch (err: unknown) {
          // ENOENT is fine — first install — but other errors are fatal.
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code !== "ENOENT") throw err;
        }
        await rename(stagingDir, targetDir);
      } catch (err) {
        // Swap failed. Try to restore the previous install if we
        // moved it out of the way.
        if (hadOldInstall) {
          try { await rename(backupDir, targetDir); } catch { /* best effort */ }
        }
        try { await rm(stagingDir, { recursive: true, force: true }); } catch { /* transient FS */ }
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Install failed during swap: ${msg}` };
      }

      // Swap succeeded — drop the backup. A failure here is harmless;
      // the new install is already live.
      try { await rm(backupDir, { recursive: true, force: true }); } catch { /* harmless leftover */ }

      await this.rescanPacks();
      this.emit?.({ event: "themesChanged", data: { themeId: id, kind: "installed" } });
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Install failed: ${msg}` };
    } finally {
      // Silent catches: cleanup paths may not exist if extraction
      // failed early (ENOENT). `force: true` already swallows that
      // path — the catch covers other transient FS errors which we
      // can't usefully recover from inside a finally block.
      try { await rm(extractDir, { recursive: true, force: true }); } catch { /* transient FS */ }
      try { await rm(zipPath, { force: true }); } catch { /* transient FS */ }
    }
  }

  /** Uninstall a community theme by removing its directory. */
  async uninstallCommunityTheme(
    id: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (!SAFE_ID.test(id)) {
      return { success: false, error: `Invalid theme id: "${id}"` };
    }

    const targetDir = join(THEME_PACKS_DIR, id);
    const resolvedTarget = resolve(targetDir);
    const resolvedBase = resolve(THEME_PACKS_DIR);
    if (!resolvedTarget.startsWith(resolvedBase + "/")) {
      return { success: false, error: "Invalid theme path" };
    }

    if (!this.installedPacks.has(id)) {
      return { success: false, error: `Theme "${id}" is not installed` };
    }

    // Disable if currently active
    if (this.activeThemes.has(id)) {
      await this.disableTheme(id);
    }

    try {
      await rm(targetDir, { recursive: true, force: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to remove pack: ${msg}` };
    }

    // Clean up persisted variants for the removed theme
    if (this.packVariants[id]) {
      delete this.packVariants[id];
      await this.saveStateToDisk();
    }

    await this.rescanPacks();
    this.emit?.({ event: "themesChanged", data: { themeId: id, kind: "uninstalled" } });
    return { success: true };
  }

  /** Change a variant selection on an installed theme pack. */
  async setThemePackVariant(
    id: string,
    patchName: string,
    value: string,
  ): Promise<{ success: boolean; error?: string }> {
    const pack = this.installedPacks.get(id);
    if (!pack) {
      return { success: false, error: `Theme "${id}" is not installed` };
    }
    const patch = pack.manifest.patches?.[patchName];
    if (!patch) {
      return { success: false, error: `Patch "${patchName}" not found` };
    }
    if (!patch.values || !(value in patch.values)) {
      return { success: false, error: `Value "${value}" not valid for "${patchName}"` };
    }

    // Snapshot prior value so we can revert in-memory state if the
    // disk write fails — otherwise the next restart silently shows
    // the OLD variant while the live UI thinks it has the new one.
    const prior = this.packVariants[id]?.[patchName];
    if (!this.packVariants[id]) this.packVariants[id] = {};
    this.packVariants[id][patchName] = value;
    try {
      await this.saveStateToDisk({ throwOnError: true });
    } catch (err) {
      // Roll back in-memory state to match disk.
      if (prior === undefined) {
        delete this.packVariants[id][patchName];
        if (Object.keys(this.packVariants[id]).length === 0) delete this.packVariants[id];
      } else {
        this.packVariants[id][patchName] = prior;
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to persist variant selection: ${msg}` };
    }

    // If the theme is currently active, re-inject with the new variant.
    // Replacing the InjectedStyle object (rather than mutating it) makes
    // object identity a revision marker: an injection that loaded its CSS
    // before this point can detect that it is now stale and stand down,
    // instead of overwriting the new variant with the old one.
    const injected = this.activeThemes.get(id);
    if (injected) {
      const fresh = { styleId: injected.styleId };
      this.activeThemes.set(id, fresh);
      const css = await this.loadThemeCss(id);
      if (css !== null && this.activeThemes.get(id) === fresh) {
        await this.injectToAllTabs(fresh.styleId, css);
      }
    }

    this.emit?.({ event: "themesChanged", data: { themeId: id, kind: "variant" } });
    return { success: true };
  }

  /**
   * Open the GitHub repo for an installed community theme in the user's
   * default browser via xdg-open.
   */
  async openThemeGithub(id: string): Promise<{ success: boolean; error?: string }> {
    const entries = (await ensureCommunityThemes());
    const entry = entries.find((e) => e.id === id);
    if (!entry?.githubUrl) {
      return { success: false, error: "No GitHub URL for this theme" };
    }
    await runCode(["xdg-open", entry.githubUrl]);
    return { success: true };
  }

  // ─── Internal Methods ─────────────────────────────────────────────

  private emitState() {
    const data = {
      connected: this.connected,
      activeThemes: Array.from(this.activeThemes.keys()),
      translations: getTranslationsStatus(),
    };
    this.lastEmitted = JSON.stringify(data);
    this.emit?.({ event: "stateChanged", data });
  }

  /**
   * Emit only when the payload actually moved.
   *
   * Compares the serialized payload rather than hand-picked fields, so a
   * field added to `emitState` can't silently go unemitted — and so a
   * field that ISN'T in the payload (connection count, say) can't cause
   * an emit no consumer can observe. Discovery runs on a timer now, so
   * both mistakes are cheap to make and expensive to keep.
   */
  private emitStateIfChanged() {
    const data = {
      connected: this.connected,
      activeThemes: Array.from(this.activeThemes.keys()),
      translations: getTranslationsStatus(),
    };
    if (JSON.stringify(data) === this.lastEmitted) return;
    this.emitState();
  }

  /** Rescan the install dir for theme packs. */
  private async rescanPacks(): Promise<void> {
    const packs = await listInstalledPacks(THEME_PACKS_DIR);
    this.installedPacks.clear();
    for (const pack of packs) {
      this.installedPacks.set(pack.id, pack);
    }
  }

  /**
   * Load the CSS to inject for a given theme id (community pack), or
   * `null` if no such pack is installed.
   *
   * Deliberately still returns CSS when the class-translation map is
   * missing, and records that it did. Refusing outright is tempting —
   * pack CSS carries the obfuscated class names of the build it was
   * authored against, and `assemblePackCss` leaves them alone without
   * the map — but the map only contains entries where a name actually
   * CHANGED (`buildMap` skips `variant === current`). A theme authored
   * against the current Steam build therefore needs no translation at
   * all, and neither do hand-authored packs or CSS-variable-only
   * patches. Those work perfectly offline, and refusing would break them
   * to protect the stale ones. Degraded beats absent; the flag lets
   * `verifyAndHealInjection` rebuild for real once the map lands.
   *
   * `enableTheme` keeps its own hard gate, as it always had — turning a
   * theme ON is a deliberate act that can be told to wait.
   */
  private async loadThemeCss(id: string): Promise<string | null> {
    const pack = this.installedPacks.get(id);
    if (!pack) return null;
    if (getTranslationsStatus().state !== "ready") {
      this.cssBuiltWithoutTranslations = true;
    }
    // Re-read the manifest in case the user edited it, then assemble
    const manifest = (await readManifest(pack.dir)) ?? pack.manifest;
    return assemblePackCss(pack.dir, manifest, this.packVariants[id] ?? {});
  }

  /**
   * Discover Steam's target CEF tabs and make sure we hold a live CDP
   * connection to each one.
   *
   * Additive on purpose. Steam brings its tabs up progressively: the
   * shared context exists long before the Big Picture window, and the
   * `MainMenu_uid<N>` / `QuickAccess` popups are created later still.
   * A discovery pass that ran while Steam was still assembling itself
   * used to be the last one — the tab list was captured once and any tab
   * born afterwards never received CSS, which is the "themes didn't
   * apply on boot" race. Re-running discovery now picks up the late
   * arrivals, and keeping the connections we already hold means doing so
   * doesn't disturb (or re-flash) the tabs that are already themed.
   *
   * Callers that want a hard rebuild — `reconnect()`, behind the UI's
   * "Reapply themes" button — close and clear `this.connections` first.
   *
   * Serialized through {@link inflightConnect}. Two passes running at
   * once would each compute "tabs I am not connected to" from the same
   * stale list and both open a socket to the same tab; because discovery
   * is now additive, both would then be kept on every later pass, and
   * every injection and probe for that tab would run twice for the life
   * of the session.
   */
  private tryConnect(): Promise<boolean> {
    if (this.inflightConnect) return this.inflightConnect;
    const run = this.doConnect();
    this.inflightConnect = run.finally(() => {
      this.inflightConnect = null;
    });
    return this.inflightConnect;
  }

  private async doConnect(): Promise<boolean> {
    try {
      const tabs = await listCefTabs({ debugPort: DEBUG_PORT, timeoutMs: 3000 });
      if (this.disposed) return false;
      const targetTabs = tabs.filter(isTargetTab);

      if (targetTabs.length === 0) {
        console.log("[theme-loader] No target tabs found among:", tabs.map((t) => t.title));
        // Every connection we hold points at a tab Steam is no longer
        // advertising. Leaving them in place would report a healthy
        // tabCount alongside `connected: false` and leak the sockets.
        this.closeAllConnections();
        this.connected = false;
        this.emitStateIfChanged();
        return false;
      }

      // Keep every connection that is still live AND still points at a
      // tab Steam is advertising; drop the rest. Silent catch: closing an
      // already-closed WS is a no-op we want.
      const targetIds = new Set(targetTabs.map((t) => t.id));
      const kept: CDPConnection[] = [];
      for (const conn of this.connections) {
        if (conn.client.connected && targetIds.has(conn.id)) {
          kept.push(conn);
          continue;
        }
        try { conn.client.close(); } catch { /* already closed */ }
      }
      this.connections = kept;

      const connectedIds = new Set(kept.map((c) => c.id));
      for (const tab of targetTabs) {
        if (!tab.webSocketDebuggerUrl) continue;
        if (connectedIds.has(tab.id)) continue;
        try {
          const conn = await this.openCDP({
            id: tab.id,
            title: tab.title,
            wsUrl: tab.webSocketDebuggerUrl,
          });
          // `onUnload` may have run during the connect. Close rather than
          // push: pushing would repopulate the array unload just cleared,
          // and nothing would ever close the socket again.
          if (this.disposed) {
            try { conn.client.close(); } catch { /* already closed */ }
            return false;
          }
          this.connections.push(conn);
          connectedIds.add(tab.id);
          console.log(`[theme-loader] Connected to tab: ${tab.title}`);
        } catch (err) {
          console.warn(`[theme-loader] Failed to connect to ${tab.title}:`, err);
        }
      }

      this.connected = this.connections.length > 0;
      if (this.connected && this.startupWindowFrom === null) {
        // Steam is up. The race this plugin exists to survive starts now.
        this.startupWindowFrom = Date.now();
      }
      this.emitStateIfChanged();
      return this.connected;
    } catch {
      this.connected = false;
      this.emitStateIfChanged();
      return false;
    }
  }

  /** Close and forget every CDP connection. */
  private closeAllConnections(): void {
    for (const conn of this.connections) {
      try { conn.client.close(); } catch { /* already closed */ }
    }
    this.connections = [];
  }

  private async openCDP(
    { id, title, wsUrl }: { id: string; title: string; wsUrl: string },
  ): Promise<CDPConnection> {
    const client = new CDPClient(wsUrl);
    await client.connect();
    return { id, title, client };
  }

  private cdpEvaluate(conn: CDPConnection, expression: string): Promise<unknown> {
    return conn.client.evaluate(expression, { timeoutMs: CDP_TIMEOUT_MS });
  }

  private async injectCSSToTab(conn: CDPConnection, styleId: string, css: string): Promise<void> {
    await this.cdpEvaluate(conn, buildInjectStyleExpression({ styleId, css }));
  }

  private async removeCSSFromTab(conn: CDPConnection, styleId: string): Promise<void> {
    await this.cdpEvaluate(conn, buildRemoveStyleExpression(styleId));
  }

  private async injectToAllTabs(styleId: string, css: string): Promise<void> {
    const failed: CDPConnection[] = [];

    for (const conn of [...this.connections]) {
      if (!conn.client.connected) {
        failed.push(conn);
        continue;
      }
      try {
        await this.injectCSSToTab(conn, styleId, css);
      } catch (err) {
        console.warn(`[theme-loader] Failed to inject to tab ${conn.title}:`, err);
        failed.push(conn);
      }
    }

    if (failed.length > 0) {
      const dead = new Set(failed);
      this.connections = this.connections.filter((c) => !dead.has(c));
      for (const conn of failed) {
        try { conn.client.close(); } catch { /* already closed */ }
      }
    }
    if (this.connections.length === 0) {
      this.connected = false;
    }
  }

  private async removeFromAllTabs(styleId: string): Promise<void> {
    for (const conn of this.connections) {
      if (!conn.client.connected) continue;
      try {
        await this.removeCSSFromTab(conn, styleId);
      } catch (err) {
        console.warn(`[theme-loader] Failed to remove style from tab:`, err);
      }
    }
  }

  private async checkHealth(): Promise<void> {
    // The verification pass awaits CDP round-trips, which can outlast the
    // 5 s tick on a busy Steam. Without this guard the ticks pile up and
    // each one issues its own re-injection.
    if (this.healthChecking) return;
    this.healthChecking = true;
    try {
      const alive = this.connections.filter((c) => c.client.connected);
      if (alive.length !== this.connections.length) {
        this.connections = alive;
        console.log(`[theme-loader] Pruned dead connections, ${alive.length} remaining`);
      }

      if (this.connections.length === 0) {
        const wasConnected = this.connected;
        this.connected = false;
        if (wasConnected) this.emitState();
        const didReconnect = await this.tryConnect();
        if (didReconnect) {
          // Everything is freshly connected, so a full re-inject already
          // does what verification would have asked for.
          await this.reinjectAllActiveThemes();
        }
        return;
      }

      // Connected is not the same as themed — see
      // `verifyAndHealInjection`. Check on every tick while Steam is
      // still coming up (that is where the race lives), then settle to
      // one pass every ~30 s to catch a later reload or a popup opening.
      this.healthTicks++;
      const startingUp =
        this.startupWindowFrom !== null &&
        Date.now() - this.startupWindowFrom < STARTUP_VERIFY_WINDOW_MS;
      if (startingUp || this.healthTicks % STEADY_VERIFY_EVERY_TICKS === 0) {
        await this.verifyAndHealInjection();
      }
    } finally {
      this.healthChecking = false;
    }
  }

  /**
   * Ask each connected tab whether our `<style>` elements are actually
   * present, and re-inject into the tabs that lost them.
   *
   * This exists because a live CDP socket is not evidence that the CSS
   * is live. Two things go wrong around boot, and both leave the socket
   * looking perfectly healthy:
   *
   * - Steam creates its tabs progressively, so a tab born after the
   *   initial discovery pass has never been injected into. The
   *   discovery inside {@link tryConnect} is additive, so calling it
   *   here adopts those tabs without touching the ones already themed.
   * - Steam reloads the documents it hosts during startup (and when Big
   *   Picture opens or closes), which wipes every injected `<style>`
   *   while keeping the CDP target alive.
   *
   * Healing is per tab and per style: a tab that still has its CSS is
   * left completely alone, so fixing a tab that came up late can't flash
   * the tabs that were fine. This is the automatic form of the
   * "Reapply themes" button users have been pressing by hand.
   */
  private async verifyAndHealInjection(): Promise<void> {
    if (this.disposed || this.activeThemes.size === 0) return;
    // A full re-inject is in flight and covers everything below.
    if (this.inflightReinject) return;

    // Adopt tabs Steam created after the last discovery pass. Failure is
    // fine — we still verify whatever connections we already hold.
    await this.tryConnect().catch(() => false);
    if (this.disposed) return;

    this.retryTranslationsInBackground();

    // The map arrived after we injected, so every tab may be carrying CSS
    // built against the wrong Steam build. The DOM probe below would call
    // all of it healthy — the styles are there, they just may not match —
    // so rebuild everything before falling through to it.
    if (this.cssBuiltWithoutTranslations && getTranslationsStatus().state === "ready") {
      console.log("[theme-loader] Class translations arrived late, rebuilding active themes");
      this.cssBuiltWithoutTranslations = false;
      await this.reinjectAllActiveThemes();
      this.emitStateIfChanged();
      return;
    }

    const byStyleId = new Map<string, string>();
    for (const [themeId, injected] of this.activeThemes) {
      byStyleId.set(injected.styleId, themeId);
    }
    const styleIds = Array.from(byStyleId.keys());

    for (const conn of [...this.connections]) {
      if (this.disposed) return;
      if (!conn.client.connected) continue;

      let missing: string[];
      try {
        const raw = await this.cdpEvaluate(conn, buildMissingStylesExpression(styleIds));
        missing = parseMissingStyles(raw, styleIds);
      } catch (err) {
        // Probe failed — leave it for the next tick rather than
        // re-injecting blind into a tab we can't read.
        console.warn(`[theme-loader] Could not verify styles in ${conn.title}:`, err);
        continue;
      }
      if (missing.length === 0) continue;

      console.log(
        `[theme-loader] ${conn.title}: ${missing.length} theme style(s) missing, re-injecting`,
      );
      for (const styleId of missing) {
        const themeId = byStyleId.get(styleId);
        if (!themeId) continue;
        const injected = this.activeThemes.get(themeId);
        if (!injected) continue;

        const css = await this.loadThemeCss(themeId);
        if (css === null) {
          // Active but no pack on disk — deleted out of band. Say so once
          // per pass rather than logging "re-injecting" every tick forever.
          console.warn(`[theme-loader] Active theme "${themeId}" has no installed pack; skipping`);
          continue;
        }
        // Re-check AFTER the awaits, not just before them: loading a
        // multi-file pack off an SD card is slow enough for the user to
        // have disabled the theme or changed its variant in the meantime.
        // Injecting then would resurrect CSS nothing can remove (disable
        // has already run and found nothing to remove), or overwrite a
        // fresh variant with the stale one this pass loaded.
        if (this.disposed || this.activeThemes.get(themeId) !== injected) continue;
        try {
          await this.injectCSSToTab(conn, styleId, css);
        } catch (err) {
          console.warn(`[theme-loader] Failed to re-inject ${themeId} into ${conn.title}:`, err);
        }
      }
    }
  }

  /**
   * Kick off a class-translation re-sync, at most one at a time and with
   * exponential backoff.
   *
   * Deliberately NOT awaited. `ensureTranslations` has no failure memory
   * — with no cache it issues a fresh request bounded only by its own
   * 30 s timeout — so awaiting it here would hold the `healthChecking`
   * guard for that long, and a network that black-holes rather than
   * refuses would disable dead-connection pruning and reconnection
   * entirely. The result is picked up by a later pass instead.
   */
  private retryTranslationsInBackground(): void {
    if (getTranslationsStatus().state === "ready") return;
    if (this.translationRetryInflight) return;
    if (Date.now() < this.translationRetryAt) return;

    this.translationRetryInflight = true;
    ensureTranslations()
      .catch(() => { /* status reflects the failure */ })
      .finally(() => {
        this.translationRetryInflight = false;
        if (getTranslationsStatus().state === "ready") {
          this.translationRetryDelayMs = TRANSLATION_RETRY_BASE_MS;
          this.emitStateIfChanged();
          return;
        }
        this.translationRetryAt = Date.now() + this.translationRetryDelayMs;
        this.translationRetryDelayMs = Math.min(
          this.translationRetryDelayMs * 2,
          TRANSLATION_RETRY_MAX_MS,
        );
        this.emitStateIfChanged();
      });
  }

  /**
   * Re-inject every currently-active theme into every connected tab.
   * Concurrent callers (initial onLoad, manual reconnect, and the
   * 5 s health check) fold into a single in-flight promise so a
   * reconnect mid-health-check doesn't fire the same CSS injection
   * twice.
   */
  private reinjectAllActiveThemes(): Promise<void> {
    if (this.inflightReinject) return this.inflightReinject;
    const run = (async () => {
      for (const [id, injected] of [...this.activeThemes]) {
        const css = await this.loadThemeCss(id);
        if (css === null) continue;
        // The loop awaits per theme and `injectToAllTabs` awaits per tab,
        // so a disable or variant change can land mid-pass. Identity of
        // the InjectedStyle is the revision marker — see
        // `setThemePackVariant`.
        if (this.disposed || this.activeThemes.get(id) !== injected) continue;
        await this.injectToAllTabs(injected.styleId, css);
      }
    })();
    this.inflightReinject = run.finally(() => {
      this.inflightReinject = null;
    });
    return this.inflightReinject;
  }

  /**
   * Load persisted active-theme list + per-pack variant selections from
   * `~/.config/loadout/plugins/theme-loader.json`. Storage layout is one
   * file per plugin keyed by plugin id (see `@loadout/plugin-storage`).
   */
  private async loadStateFromDisk(): Promise<void> {
    try {
      const { activeThemes = [], packVariants = {} } =
        await readPluginStorage<ThemeLoaderStorage>(PLUGIN_ID);
      this.packVariants = packVariants;
      for (const id of activeThemes) {
        this.activeThemes.set(id, { styleId: safeStyleId(id) });
      }
      if (activeThemes.length > 0) {
        console.log(`[theme-loader] Restored ${activeThemes.length} active theme(s) from disk`);
      }
    } catch {
      // No persisted state — start fresh
    }
  }

  /**
   * Persist active-theme list + per-pack variant selections.
   *
   * By default, fs errors are logged and swallowed (callers in
   * enable/disable/uninstall can't recover from a write failure
   * mid-flow). Pass `throwOnError: true` from callers that need to
   * roll back in-memory state if the disk write fails — currently
   * `setThemePackVariant`, where a silent failure leaves the UI
   * showing one variant while disk holds another.
   */
  private async saveStateToDisk(opts: { throwOnError?: boolean } = {}): Promise<void> {
    try {
      await writePluginStorage<ThemeLoaderStorage>(PLUGIN_ID, {
        activeThemes: Array.from(this.activeThemes.keys()),
        packVariants: this.packVariants,
      });
    } catch (err) {
      console.warn("[theme-loader] Failed to save state:", err);
      if (opts.throwOnError) throw err;
    }
  }
}
