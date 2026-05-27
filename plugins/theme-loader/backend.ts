import type { PluginBackend, EmitPayload } from "@loadout/types";
import { runCode, runFull } from "@loadout/exec";
import { CDPClient } from "@loadout/steam-cdp";
import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
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
 * `~/.local/share/loadout/css-themes/`. The format is the
 * community standard used by themes published to deckthemes.com.
 *
 * The community theme directory is consumed live from
 * `api.deckthemes.com` via {@link "./lib/themes-cache"}; nothing is
 * bundled.
 */

interface CEFTab {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
  type: string;
}

interface CDPConnection {
  client: CDPClient;
}

const CDP_TIMEOUT_MS = 5000;

interface InjectedStyle {
  /** Unique ID for the injected <style> element */
  styleId: string;
}

const DEBUG_PORT = 8080;
const DATA_DIR = join(homedir(), ".config", "loadout", "theme-loader");
/** Where community theme packs are installed. */
const THEME_PACKS_DIR = join(homedir(), ".local/share/loadout/css-themes");
/** Persistent per-theme variant selections ({themeId: {patchName: value}}). */
const VARIANTS_PATH = join(DATA_DIR, "pack-variants.json");
/** Persistent list of active theme IDs — survives service restarts. */
const ACTIVE_THEMES_PATH = join(DATA_DIR, "active-themes.json");

/** Tab titles / URL patterns we target for CSS injection */
const TARGET_TAB_PATTERNS = [
  // SharedJSContext / SP
  { titleMatch: ["SharedJSContext", "Steam Shared Context presented by Valve\u2122", "Steam", "SP"] },
  // Big Picture Mode shell \u2014 mostly empty in current Steam; the visible
  // BPM UI now lives in the MainMenu_uid2 popup tab below.
  { titleMatch: ["Steam Big Picture Mode"] },
  // BPM main menu popup \u2014 where the actual visible BPM UI renders.
  // Without this, themes that style BPM appear to do nothing because
  // their CSS attaches to the empty parent shell. The MainMenu_uid2
  // popup is created per session, hence the prefix match.
  { titlePrefix: "MainMenu" },
  // QuickAccess (matches QuickAccess and QuickAccess_uid2 popup)
  { titlePrefix: "QuickAccess" },
];

function isTargetTab(tab: CEFTab): boolean {
  for (const pattern of TARGET_TAB_PATTERNS) {
    if ("titleMatch" in pattern && pattern.titleMatch?.includes(tab.title)) return true;
    if ("titlePrefix" in pattern && pattern.titlePrefix && tab.title.startsWith(pattern.titlePrefix)) return true;
  }
  return false;
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
  private healthInterval?: Timer;

  async onLoad(): Promise<void> {
    console.log("[theme-loader] Plugin loaded");
    await mkdir(DATA_DIR, { recursive: true });
    await mkdir(THEME_PACKS_DIR, { recursive: true });
    await this.rescanPacks();
    await this.loadVariantsFromDisk();
    await this.loadActiveThemesFromDisk();

    // Prime the class-translation cache in the background. Themes
    // wait for this before applying.
    ensureTranslations()
      .then(() => this.emitState())
      .catch(() => { /* status reflects the failure */ });

    // Try initial connection, but don't block if Steam isn't running
    this.tryConnect().then(async (connected) => {
      if (connected) {
        // Re-inject persisted active themes
        for (const [id, injected] of this.activeThemes) {
          const css = await this.loadThemeCss(id);
          if (css !== null) {
            await this.injectToAllTabs(injected.styleId, css);
            console.log(`[theme-loader] Re-injected theme: ${id}`);
          }
        }
      }
    }).catch(() => {
      console.log("[theme-loader] Steam CEF not available yet, will retry");
    });

    // Periodically check connection health
    this.healthInterval = setInterval(() => {
      this.checkHealth();
    }, 5000);
  }

  async onUnload(): Promise<void> {
    clearInterval(this.healthInterval);

    // Remove all injected CSS
    for (const [, injected] of this.activeThemes) {
      await this.removeFromAllTabs(injected.styleId);
    }

    // Close all CDP connections. Silent catch: `ws.close()` may throw if
    // the socket is already CLOSING/CLOSED — harmless on unload.
    for (const conn of this.connections) {
      try { conn.client.close(); } catch {}
    }
    this.connections = [];
    this.connected = false;

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
      await this.saveActiveThemesToDisk();
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
      await this.saveActiveThemesToDisk();
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
    // Silent catch: closing an already-closed WS is a no-op we want.
    for (const conn of this.connections) {
      try { conn.client.close(); } catch {}
    }
    this.connections = [];
    this.connected = false;

    const didConnect = await this.tryConnect();
    if (didConnect) {
      // Re-inject all active themes
      for (const [id, injected] of this.activeThemes) {
        const css = await this.loadThemeCss(id);
        if (css !== null) {
          await this.injectToAllTabs(injected.styleId, css);
        }
      }
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
   * `~/.local/share/loadout/css-themes/{id}/`.
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

    const tempBase = join(tmpdir(), `loadout-css-${id}-${Date.now()}`);
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

      // Copy to the install dir under the canonical id so we can
      // look it up again later. Remove any previous install first.
      const targetDir = join(THEME_PACKS_DIR, id);
      try { await rm(targetDir, { recursive: true, force: true }); } catch {}
      await mkdir(THEME_PACKS_DIR, { recursive: true });
      await cp(themeRoot, targetDir, { recursive: true });

      // Capture per-theme attribution: the upstream LICENSE (typically
      // at the repo root, above the theme subdir) plus author/source
      // metadata from the community registry. Stored alongside
      // `theme.json` so it survives uninstall/reinstall and is
      // surfaced in the UI for license display.
      const license = await findUpstreamLicense(themeRoot, extractDir);
      const meta: ThemeMeta = {
        author: entry.author ?? null,
        description: entry.description ?? null,
        version: entry.version ?? null,
        sourceUrl: entry.githubUrl ?? null,
        license,
      };
      await writeThemeMeta(targetDir, meta);

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
      try { await rm(extractDir, { recursive: true, force: true }); } catch {}
      try { await rm(zipPath, { force: true }); } catch {}
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
      await this.saveVariantsToDisk();
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

    if (!this.packVariants[id]) this.packVariants[id] = {};
    this.packVariants[id][patchName] = value;
    await this.saveVariantsToDisk();

    // If the theme is currently active, re-inject with the new variant
    if (this.activeThemes.has(id)) {
      const css = await this.loadThemeCss(id);
      const injected = this.activeThemes.get(id);
      if (css !== null && injected) {
        await this.injectToAllTabs(injected.styleId, css);
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
    this.emit?.({
      event: "stateChanged",
      data: {
        connected: this.connected,
        activeThemes: Array.from(this.activeThemes.keys()),
        translations: getTranslationsStatus(),
      },
    });
  }

  /** Rescan the install dir for theme packs. */
  private async rescanPacks(): Promise<void> {
    const packs = await listInstalledPacks(THEME_PACKS_DIR);
    this.installedPacks.clear();
    for (const pack of packs) {
      this.installedPacks.set(pack.id, pack);
    }
  }

  /** Load the CSS to inject for a given theme id (community pack). */
  private async loadThemeCss(id: string): Promise<string | null> {
    const pack = this.installedPacks.get(id);
    if (pack) {
      // Re-read the manifest in case the user edited it, then assemble
      const manifest = (await readManifest(pack.dir)) ?? pack.manifest;
      return assemblePackCss(pack.dir, manifest, this.packVariants[id] ?? {});
    }
    return null;
  }

  private async tryConnect(): Promise<boolean> {
    try {
      const res = await fetch(`http://localhost:${DEBUG_PORT}/json`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`/json returned ${res.status}`);

      const tabs = (await res.json()) as CEFTab[];
      const targetTabs = tabs.filter(isTargetTab);

      if (targetTabs.length === 0) {
        console.log("[theme-loader] No target tabs found among:", tabs.map((t) => t.title));
        this.connected = false;
        return false;
      }

      // Silent catch: closing an already-closed WS is a no-op we want.
      for (const conn of this.connections) {
        try { conn.client.close(); } catch {}
      }
      this.connections = [];

      for (const tab of targetTabs) {
        if (!tab.webSocketDebuggerUrl) continue;
        try {
          const conn = await this.openCDP(tab.webSocketDebuggerUrl);
          this.connections.push(conn);
          console.log(`[theme-loader] Connected to tab: ${tab.title}`);
        } catch (err) {
          console.warn(`[theme-loader] Failed to connect to ${tab.title}:`, err);
        }
      }

      this.connected = this.connections.length > 0;
      this.emitState();
      return this.connected;
    } catch {
      this.connected = false;
      return false;
    }
  }

  private async openCDP(wsUrl: string): Promise<CDPConnection> {
    const client = new CDPClient(wsUrl);
    await client.connect();
    return { client };
  }

  private cdpEvaluate(conn: CDPConnection, expression: string): Promise<unknown> {
    return conn.client.evaluate(expression, { timeoutMs: CDP_TIMEOUT_MS });
  }

  private async injectCSSToTab(conn: CDPConnection, styleId: string, css: string): Promise<void> {
    const escapedCSS = css.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");
    const js = `
      (function() {
        let existing = document.getElementById("${styleId}");
        if (existing) existing.remove();

        let style = document.createElement("style");
        style.id = "${styleId}";
        style.classList.add("theme-loader-style");
        style.dataset.steamLoaderPlugin = "theme-loader";
        document.head.appendChild(style);
        style.textContent = \`${escapedCSS}\`;
      })()
    `;

    await this.cdpEvaluate(conn, js);
  }

  private async removeCSSFromTab(conn: CDPConnection, styleId: string): Promise<void> {
    const js = `
      (function() {
        let el = document.getElementById("${styleId}");
        if (el) el.parentNode.removeChild(el);
      })()
    `;
    await this.cdpEvaluate(conn, js);
  }

  private async injectToAllTabs(styleId: string, css: string): Promise<void> {
    const liveConnections: CDPConnection[] = [];

    for (const conn of this.connections) {
      if (!conn.client.connected) continue;
      try {
        await this.injectCSSToTab(conn, styleId, css);
        liveConnections.push(conn);
      } catch (err) {
        console.warn(`[theme-loader] Failed to inject to tab:`, err);
      }
    }

    this.connections = liveConnections;
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
        for (const [id, injected] of this.activeThemes) {
          const css = await this.loadThemeCss(id);
          if (css !== null) {
            await this.injectToAllTabs(injected.styleId, css);
          }
        }
      }
    }
  }

  private async loadVariantsFromDisk(): Promise<void> {
    try {
      const file = Bun.file(VARIANTS_PATH);
      if (await file.exists()) {
        this.packVariants = JSON.parse(await file.text()) as Record<
          string,
          Record<string, string>
        >;
      }
    } catch {
      this.packVariants = {};
    }
  }

  private async saveVariantsToDisk(): Promise<void> {
    try {
      await mkdir(DATA_DIR, { recursive: true });
      await Bun.write(VARIANTS_PATH, JSON.stringify(this.packVariants, null, 2));
    } catch (err) {
      console.warn("[theme-loader] Failed to save variant selections:", err);
    }
  }

  private async loadActiveThemesFromDisk(): Promise<void> {
    try {
      const file = Bun.file(ACTIVE_THEMES_PATH);
      if (await file.exists()) {
        const ids = JSON.parse(await file.text()) as string[];
        for (const id of ids) {
          this.activeThemes.set(id, { styleId: safeStyleId(id) });
        }
        console.log(`[theme-loader] Restored ${ids.length} active theme(s) from disk`);
      }
    } catch {
      // No persisted state — start fresh
    }
  }

  private async saveActiveThemesToDisk(): Promise<void> {
    try {
      await mkdir(DATA_DIR, { recursive: true });
      const ids = Array.from(this.activeThemes.keys());
      await Bun.write(ACTIVE_THEMES_PATH, JSON.stringify(ids, null, 2));
    } catch (err) {
      console.warn("[theme-loader] Failed to save active themes:", err);
    }
  }
}
