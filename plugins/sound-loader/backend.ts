import type { PluginBackend, EmitPayload } from "@loadout/types";
import { runFull } from "@loadout/exec";
import {
  readPluginStorage,
  writePluginStorage,
} from "@loadout/plugin-storage";
import { readdir, mkdir, cp, rm } from "node:fs/promises";
import { join, extname, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  AudioSteamInjector,
  stagePackFiles,
  clearStagedFiles,
} from "./lib/steam-injector";
import {
  ensureCommunityPacks,
  getCommunityPacksStatus,
  refreshCommunityPacks,
  type PacksStatus,
} from "./lib/sounds-cache";
import type { CommunityPackEntry } from "./lib/types";

const PLUGIN_ID = "sound-loader";

/** Sound event keys supported by the sound engine. */
const SOUND_EVENTS = [
  "nav",
  "select",
  "back",
  "toggleOn",
  "toggleOff",
  "sliderUp",
  "error",
  "sideMenuIn",
  "sideMenuOut",
  "tabTransition",
] as const;

type SoundEvent = (typeof SOUND_EVENTS)[number];

interface PackManifest {
  name: string;
  author: string;
  description: string;
  version: string;
  mappings: Partial<Record<SoundEvent, string | string[]>>;
  ignore?: SoundEvent[];
}

interface SoundPackInfo {
  /** Directory name — used as the pack ID */
  id: string;
  name: string;
  author: string;
  description: string;
  version: string;
  /** Which sound events this pack provides */
  mappedEvents: SoundEvent[];
  /** Which sound events this pack explicitly ignores */
  ignoredEvents: SoundEvent[];
}

interface SoundLoaderConfig {
  /** Active pack ID. null = "default" (Steam sounds), "synthesized" = Web Audio fallback */
  activePack: string | null;
  /** Whether to apply the active pack's sounds to the overlay UI */
  useInOverlay: boolean;
  /** Whether to apply the active pack's sounds to Steam's Big Picture / Gaming Mode UI */
  useInSteam: boolean;
}

/** Per-installed-pack attribution captured from the deckthemes registry. */
interface PackMeta {
  id: string;
  author: string | null;
  description: string | null;
  version: string | null;
  sourceUrl: string | null;
}

/** Mapping from Decky AudioLoader filenames to our abstract event names. */
const DECKY_TO_LOADOUT: Record<string, string> = {
  "deck_ui_misc_10.wav": "nav",
  "deck_ui_navigation.wav": "nav",
  "deck_ui_default_activation.wav": "select",
  "deck_ui_hide_modal.wav": "back",
  "deck_ui_switch_toggle_on.wav": "toggleOn",
  "deck_ui_switch_toggle_off.wav": "toggleOff",
  "deck_ui_slider_up.wav": "sliderUp",
  "confirmation_negative.wav": "error",
  "deck_ui_side_menu_fly_in.wav": "sideMenuIn",
  "deck_ui_side_menu_fly_out.wav": "sideMenuOut",
  "deck_ui_tab_transition_01.wav": "tabTransition",
};

interface CommunityPackInfo extends CommunityPackEntry {
  installed: boolean;
}

/**
 * Strict ID pattern to prevent path traversal when installing community packs.
 * Pack ids are deckthemes uuids — letters, digits, dashes, dots, underscores only.
 */
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

// Resolve $HOME lazily so tests can override via process.env.HOME between
// runs. homedir() on macOS resolves via /etc/passwd and ignores $HOME, so
// reading the env var directly is the only portable way to sandbox paths.
const HOME = () => process.env.HOME ?? homedir();
const SOUND_PACKS_DIR = () => join(HOME(), ".local/share/loadout/sound-packs");
const VALID_EXTENSIONS = new Set([".wav", ".mp3", ".ogg"]);

/**
 * Sound Loader plugin backend.
 *
 * Discovers sound packs from ~/.local/share/loadout/sound-packs/, serves
 * audio file data to the frontend, and persists the active pack
 * selection via `@loadout/plugin-storage`.
 *
 * The community pack directory is consumed live from
 * `api.deckthemes.com/themes/legacy/audio` via {@link "./lib/sounds-cache"};
 * nothing is bundled. Pack zips are downloaded from the canonical
 * `api.deckthemes.com/blobs/<id>` URL.
 */
export default class SoundLoaderBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;

  private config: SoundLoaderConfig = { activePack: null, useInOverlay: false, useInSteam: false };
  private packsCache: Map<string, { manifest: PackManifest; dir: string }> = new Map();
  private steamInjector?: AudioSteamInjector;

  async onLoad(): Promise<void> {
    console.log("[sound-loader] Plugin loaded");

    // Ensure the sound-packs directory exists
    try {
      await mkdir(SOUND_PACKS_DIR(), { recursive: true });
    } catch {
      // Directory may already exist
    }

    // Load persisted config
    await this._loadConfig();

    // Initial scan
    await this._scanPacks();

    console.log(`[sound-loader] Found ${this.packsCache.size} sound pack(s), active: ${this.config.activePack ?? "default"}`);

    // Prime the community-pack registry in the background; the UI surfaces
    // status separately and will gate its list rendering on this.
    ensureCommunityPacks().catch(() => { /* status reflects the failure */ });

    this.steamInjector = new AudioSteamInjector((msg, level = "info") => {
      const tag = "[sound-loader:steam]";
      if (level === "error") console.error(`${tag} ${msg}`);
      else if (level === "warn") console.warn(`${tag} ${msg}`);
      else console.log(`${tag} ${msg}`);
    });

    // Best-effort: apply persisted Steam state at startup. Failures are surfaced
    // as `steamError` events; the user can retry via the UI's Reconnect button.
    void this._applySteamState();
  }

  async onUnload(): Promise<void> {
    await this.steamInjector?.stop();
  }

  // --- RPC Methods ---

  /** List all available sound packs */
  async listPacks(): Promise<SoundPackInfo[]> {
    await this._scanPacks();

    const packs: SoundPackInfo[] = [];
    for (const [id, { manifest }] of this.packsCache) {
      packs.push({
        id,
        name: manifest.name,
        author: manifest.author,
        description: manifest.description,
        version: manifest.version,
        mappedEvents: Object.keys(manifest.mappings).filter(
          (k) => SOUND_EVENTS.includes(k as SoundEvent),
        ) as SoundEvent[],
        ignoredEvents: (manifest.ignore ?? []).filter(
          (k) => SOUND_EVENTS.includes(k),
        ),
      });
    }
    return packs;
  }

  /** Get the currently active pack ID */
  async getActivePack(): Promise<string | null> {
    return this.config.activePack;
  }

  /** Set the active pack. null = default (Steam sounds), "synthesized" = Web Audio fallback */
  async setActivePack(packId: string | null): Promise<{ success: boolean; error?: string }> {
    // Validate pack exists (unless it's a built-in option)
    if (packId !== null && packId !== "synthesized") {
      if (!this.packsCache.has(packId)) {
        // Re-scan in case a new pack was installed
        await this._scanPacks();
        if (!this.packsCache.has(packId)) {
          return { success: false, error: `Sound pack "${packId}" not found` };
        }
      }
    }

    this.config.activePack = packId;
    await this._saveConfig();

    this.emit?.({ event: "activePackChanged", data: { activePack: packId } });
    void this._applySteamState();
    return { success: true };
  }

  /** Get whether the active pack should also apply to overlay UI sounds */
  async getUseInOverlay(): Promise<boolean> {
    return this.config.useInOverlay;
  }

  /** Set whether the active pack should also apply to overlay UI sounds */
  async setUseInOverlay(value: boolean): Promise<{ success: boolean }> {
    this.config.useInOverlay = value;
    await this._saveConfig();
    this.emit?.({ event: "useInOverlayChanged", data: { useInOverlay: value } });
    return { success: true };
  }

  /** Get whether the active pack should also apply to Steam's Big Picture UI sounds */
  async getUseInSteam(): Promise<boolean> {
    return this.config.useInSteam;
  }

  /** Set whether the active pack should also apply to Steam's Big Picture UI sounds */
  async setUseInSteam(value: boolean): Promise<{ success: boolean }> {
    this.config.useInSteam = value;
    await this._saveConfig();
    this.emit?.({ event: "useInSteamChanged", data: { useInSteam: value } });
    void this._applySteamState();
    return { success: true };
  }

  /** Force a reconnect attempt to Steam's CEF — used by the UI's Reconnect button. */
  async reconnectSteam(): Promise<{ success: boolean; error?: string }> {
    if (!this.steamInjector) return { success: false, error: "injector not initialized" };
    await this.steamInjector.stop();
    this.steamInjector = new AudioSteamInjector((msg, level = "info") => {
      const tag = "[sound-loader:steam]";
      if (level === "error") console.error(`${tag} ${msg}`);
      else if (level === "warn") console.warn(`${tag} ${msg}`);
      else console.log(`${tag} ${msg}`);
    });
    await this._applySteamState();
    return { success: true };
  }

  /**
   * Get the sound mappings for the active pack.
   * Returns a map of sound event -> base64-encoded audio data.
   * For "default" (null) or "synthesized", returns empty mappings
   * (the frontend handles those modes without custom audio data).
   */
  async getActivePackMappings(): Promise<{
    packId: string | null;
    mappings: Record<string, { data: string; mimeType: string } | { files: Array<{ data: string; mimeType: string }> }>;
    ignore: string[];
  }> {
    const packId = this.config.activePack;

    // Built-in modes don't need audio data
    if (packId === null || packId === "synthesized") {
      return { packId, mappings: {}, ignore: [] };
    }

    const entry = this.packsCache.get(packId);
    if (!entry) {
      return { packId: null, mappings: {}, ignore: [] };
    }

    const mappings: Record<string, { data: string; mimeType: string } | { files: Array<{ data: string; mimeType: string }> }> = {};

    for (const [event, fileOrFiles] of Object.entries(entry.manifest.mappings)) {
      if (!SOUND_EVENTS.includes(event as SoundEvent)) continue;

      const files = Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles];
      const loaded: Array<{ data: string; mimeType: string }> = [];

      for (const filename of files) {
        const audioData = await this._readAudioFile(entry.dir, filename);
        if (audioData) {
          loaded.push(audioData);
        }
      }

      if (loaded.length === 1) {
        mappings[event] = loaded[0];
      } else if (loaded.length > 1) {
        mappings[event] = { files: loaded };
      }
    }

    return {
      packId,
      mappings,
      ignore: entry.manifest.ignore ?? [],
    };
  }

  /**
   * Read a single sound file from a pack.
   * Returns base64-encoded audio data with MIME type.
   */
  async getSoundFile(
    packId: string,
    filename: string,
  ): Promise<{ data: string; mimeType: string } | { error: string }> {
    const entry = this.packsCache.get(packId);
    if (!entry) {
      return { error: `Sound pack "${packId}" not found` };
    }

    const audioData = await this._readAudioFile(entry.dir, filename);
    if (!audioData) {
      return { error: `Audio file "${filename}" not found in pack "${packId}"` };
    }

    return audioData;
  }

  /**
   * Preview a specific sound event from a pack.
   * Returns the audio data needed to play it on the frontend.
   */
  async previewSound(
    packId: string,
    event: string,
  ): Promise<{ data: string; mimeType: string } | { error: string }> {
    const entry = this.packsCache.get(packId);
    if (!entry) {
      return { error: `Sound pack "${packId}" not found` };
    }

    const fileOrFiles = entry.manifest.mappings[event as SoundEvent];
    if (!fileOrFiles) {
      return { error: `Sound event "${event}" not mapped in pack "${packId}"` };
    }

    // If multiple files, pick a random one (matching SDH-AudioLoader behavior)
    const files = Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles];
    const filename = files[Math.floor(Math.random() * files.length)];

    const audioData = await this._readAudioFile(entry.dir, filename);
    if (!audioData) {
      return { error: `Audio file "${filename}" not found` };
    }

    return audioData;
  }

  // --- Community Packs RPC Methods ---

  /** List community packs from the live registry, annotated with install status. */
  async listCommunityPacks(): Promise<CommunityPackInfo[]> {
    const registry = await ensureCommunityPacks();

    let installedDirs: Set<string>;
    try {
      const entries = await readdir(SOUND_PACKS_DIR());
      installedDirs = new Set(entries);
    } catch {
      installedDirs = new Set();
    }

    return registry.map((entry) => ({
      ...entry,
      installed: installedDirs.has(entry.id),
    }));
  }

  /** Current state of the community-packs registry sync. */
  async getCommunityPacksStatus(): Promise<PacksStatus> {
    return getCommunityPacksStatus();
  }

  /** Force a refresh of the community-packs registry from upstream. */
  async refreshCommunityPacksCache(): Promise<PacksStatus> {
    return refreshCommunityPacks({ force: true });
  }

  /**
   * Download and install a community pack from the deckthemes blob CDN.
   *
   * Always uses `api.deckthemes.com/blobs/<download_url id>` rather than
   * reaching into GitHub. The blob endpoint is the canonical install
   * source upstream maintains, and avoids per-pack GitHub-subdir/branch
   * metadata.
   */
  async installCommunityPack(
    id: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (!SAFE_ID.test(id)) {
      return { success: false, error: `Invalid pack id: "${id}"` };
    }

    const registry = await ensureCommunityPacks();
    const pack = registry.find((p) => p.id === id);
    if (!pack) {
      return { success: false, error: `Pack "${id}" not found in community registry` };
    }

    const tempBase = join(tmpdir(), `loadout-pack-${id}-${Date.now()}`);
    const extractDir = tempBase;
    const zipPath = `${tempBase}.zip`;

    try {
      console.log(`[sound-loader] Downloading ${pack.name} from api.deckthemes.com`);
      const response = await fetch(pack.downloadUrl, {
        signal: AbortSignal.timeout(120_000),
      });

      if (!response.ok) {
        return { success: false, error: `Download failed: HTTP ${response.status}` };
      }

      // Sanity cap: deckthemes audio blobs are typically a few MB; >50 MB is
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

      // Extract
      await mkdir(extractDir, { recursive: true });
      const { stderr, exitCode } = await runFull([
        "unzip",
        "-o",
        zipPath,
        "-d",
        extractDir,
      ]);
      if (exitCode !== 0) {
        return { success: false, error: `Failed to extract zip: ${stderr}` };
      }

      // The blob is a flat zip with audio files at the root or inside a
      // single top-level directory. Locate the directory holding the
      // pack contents.
      const packSourceDir = await this._locatePackRoot(extractDir);
      if (!packSourceDir) {
        return { success: false, error: `No audio files found in archive for "${pack.name}"` };
      }

      // Find audio files in the pack directory
      const packFiles = await readdir(packSourceDir);
      const audioFiles = packFiles.filter((f) =>
        VALID_EXTENSIONS.has(extname(f).toLowerCase()),
      );

      // Generate our pack.json by mapping Decky filenames to our events
      const mappings: Partial<Record<SoundEvent, string | string[]>> = {};

      // Check if there's an existing Decky pack.json with custom mappings
      const deckyManifestPath = join(packSourceDir, "pack.json");
      let deckyMappings: Record<string, string> | null = null;
      try {
        const deckyFile = Bun.file(deckyManifestPath);
        if (await deckyFile.exists()) {
          const deckyManifest = await deckyFile.json() as Record<string, unknown>;
          if (deckyManifest.mappings && typeof deckyManifest.mappings === "object") {
            deckyMappings = deckyManifest.mappings as Record<string, string>;
          }
        }
      } catch {
        // No Decky manifest or invalid — that's fine, use filename matching
      }

      // Build mappings: for each Decky filename, figure out which actual file it maps to
      for (const [deckyFilename, ourEvent] of Object.entries(DECKY_TO_LOADOUT)) {
        let actualFilename: string | null = null;

        if (deckyMappings && deckyFilename in deckyMappings) {
          // The Decky pack.json remaps this filename to a custom file
          const customFile = deckyMappings[deckyFilename];
          if (audioFiles.includes(customFile)) {
            actualFilename = customFile;
          }
        }

        if (!actualFilename) {
          // Direct match: the Decky filename itself exists in the pack
          if (audioFiles.includes(deckyFilename)) {
            actualFilename = deckyFilename;
          }
        }

        if (actualFilename) {
          const event = ourEvent as SoundEvent;
          const existing = mappings[event];
          if (existing) {
            // Multiple Decky files map to the same event — collect as array
            if (Array.isArray(existing)) {
              if (!existing.includes(actualFilename)) {
                existing.push(actualFilename);
              }
            } else if (existing !== actualFilename) {
              mappings[event] = [existing, actualFilename];
            }
          } else {
            mappings[event] = actualFilename;
          }
        }
      }

      // Also pick up any audio files that don't match Decky names
      // but were mapped via the Decky pack.json's reverse mappings
      if (deckyMappings) {
        for (const [deckyFilename, customFile] of Object.entries(deckyMappings)) {
          const ourEvent = DECKY_TO_LOADOUT[deckyFilename];
          if (!ourEvent) continue;
          const event = ourEvent as SoundEvent;
          if (mappings[event]) continue; // Already mapped
          if (audioFiles.includes(customFile)) {
            mappings[event] = customFile;
          }
        }
      }

      // Write our pack.json manifest
      const manifest: PackManifest = {
        name: pack.name,
        author: pack.author,
        description: pack.description,
        version: pack.version || "1.0.0",
        mappings,
        ignore: [],
      };

      await Bun.write(
        join(packSourceDir, "pack.json"),
        JSON.stringify(manifest, null, 2),
      );

      // Capture per-pack attribution: registry metadata (author, source URL,
      // version, description). Stored alongside `pack.json` so it survives
      // uninstall/reinstall and can be surfaced in the UI for license display.
      const meta: PackMeta = {
        id: pack.id,
        author: pack.author || null,
        description: pack.description || null,
        version: pack.version || null,
        sourceUrl: pack.githubUrl,
      };
      await Bun.write(
        join(packSourceDir, "pack-meta.json"),
        JSON.stringify(meta, null, 2),
      );

      // Ensure target directory exists
      await mkdir(SOUND_PACKS_DIR(), { recursive: true });

      // Copy pack to sound-packs directory (keyed by pack id)
      const targetDir = join(SOUND_PACKS_DIR(), id);

      // Remove existing if present
      try {
        await rm(targetDir, { recursive: true, force: true });
      } catch {
        // May not exist
      }

      await cp(packSourceDir, targetDir, { recursive: true });

      // Refresh the packs cache
      await this._scanPacks();

      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Install failed: ${msg}` };
    } finally {
      // Clean up temp files
      try {
        await rm(tempBase, { recursive: true, force: true });
        await rm(tempBase + ".zip", { force: true });
      } catch {
        // Best-effort cleanup
      }
    }
  }

  /** Uninstall a community pack by removing its directory. */
  async uninstallCommunityPack(
    id: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (!SAFE_ID.test(id)) {
      return { success: false, error: `Invalid pack id: "${id}"` };
    }

    const targetDir = join(SOUND_PACKS_DIR(), id);

    // Verify the resolved path is within SOUND_PACKS_DIR (prevent traversal)
    const resolvedTarget = resolve(targetDir);
    const resolvedBase = resolve(SOUND_PACKS_DIR());
    if (!resolvedTarget.startsWith(resolvedBase + "/")) {
      return { success: false, error: "Invalid pack path" };
    }

    try {
      // Check it exists
      const entries = await readdir(targetDir);
      if (!entries) {
        return { success: false, error: `Pack "${id}" is not installed` };
      }
    } catch {
      return { success: false, error: `Pack "${id}" is not installed` };
    }

    try {
      await rm(targetDir, { recursive: true, force: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to remove pack: ${msg}` };
    }

    // If this was the active pack, reset to default
    if (this.config.activePack === id) {
      this.config.activePack = null;
      await this._saveConfig();
      this.emit?.({ event: "activePackChanged", data: { activePack: null } });
      void this._applySteamState();
    }

    // Refresh the packs cache
    await this._scanPacks();

    return { success: true };
  }

  // --- Private helpers ---

  /**
   * Single choke point that reconciles the live Steam-side state with config.
   * Called whenever activePack, useInSteam, or pack inventory changes.
   *
   * Failures emit a `steamError` event for the UI to surface and do NOT throw —
   * the health check inside the injector will retry connection drops automatically.
   */
  private async _applySteamState(): Promise<void> {
    const injector = this.steamInjector;
    if (!injector) return;

    const { activePack, useInSteam } = this.config;
    const noOverride = !useInSteam || !activePack || activePack === "synthesized";

    if (noOverride) {
      await clearStagedFiles();
      await injector.removeOverrides();
      this.emit?.({ event: "steamError", data: { error: null } });
      return;
    }

    const entry = this.packsCache.get(activePack);
    if (!entry) {
      this.emit?.({ event: "steamError", data: { error: `Active pack "${activePack}" not loaded` } });
      return;
    }

    const conn = await injector.tryConnect();
    if (!conn.ok) {
      console.warn(`[sound-loader:steam] connect failed: ${conn.error}`);
      this.emit?.({ event: "steamError", data: { error: conn.error } });
      return;
    }

    // Wire reload + health monitor. Re-injection of the hook+map is what the
    // monitor invokes — it reuses this same _applySteamState path.
    injector.startMonitor(() => this._applySteamState());

    const inj = await injector.injectHook();
    if (!inj.ok) {
      console.warn(`[sound-loader:steam] injectHook failed: ${inj.error}`);
      this.emit?.({ event: "steamError", data: { error: inj.error } });
      return;
    }

    let map: Record<string, string>;
    try {
      map = await stagePackFiles({ manifest: entry.manifest, dir: entry.dir }, DECKY_TO_LOADOUT);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[sound-loader:steam] stagePackFiles failed: ${msg}`);
      this.emit?.({ event: "steamError", data: { error: `Could not write to Steam sounds dir: ${msg}` } });
      return;
    }
    const refresh = await injector.refreshOverrides(map);
    if (!refresh.ok) {
      console.warn(`[sound-loader:steam] refreshOverrides failed: ${refresh.error}`);
      this.emit?.({ event: "steamError", data: { error: refresh.error } });
      return;
    }
    console.log(`[sound-loader:steam] applied ${Object.keys(map).length} overrides for pack "${activePack}"`);

    // Clear any stale error.
    this.emit?.({ event: "steamError", data: { error: null } });
  }

  /** Scan the sound-packs directory for valid packs */
  private async _scanPacks(): Promise<void> {
    this.packsCache.clear();

    let entries: string[];
    try {
      entries = await readdir(SOUND_PACKS_DIR());
    } catch {
      return;
    }

    for (const entry of entries) {
      const packDir = join(SOUND_PACKS_DIR(), entry);
      const manifestPath = join(packDir, "pack.json");

      try {
        const file = Bun.file(manifestPath);
        if (!(await file.exists())) continue;

        const manifest = (await file.json()) as PackManifest;

        // Basic validation
        if (!manifest.name || !manifest.mappings) {
          console.warn(`[sound-loader] Skipping ${entry}: invalid pack.json (missing name or mappings)`);
          continue;
        }

        // Fill in defaults
        manifest.author = manifest.author ?? "Unknown";
        manifest.description = manifest.description ?? "";
        manifest.version = manifest.version ?? "0.0.0";
        manifest.ignore = manifest.ignore ?? [];

        this.packsCache.set(entry, { manifest, dir: packDir });
      } catch (err) {
        console.warn(`[sound-loader] Skipping ${entry}: failed to read pack.json:`, err);
      }
    }
  }

  /**
   * Find the directory inside a freshly-extracted blob zip that contains
   * the pack's audio files. Looks at the extract root first, then any
   * single top-level subdirectory (typical "ProjectName-branch/" wrapper).
   */
  private async _locatePackRoot(extractDir: string): Promise<string | null> {
    const hasAudio = async (dir: string): Promise<boolean> => {
      try {
        const files = await readdir(dir);
        return files.some((f) => VALID_EXTENSIONS.has(extname(f).toLowerCase()));
      } catch {
        return false;
      }
    };

    if (await hasAudio(extractDir)) return extractDir;

    let topLevel: string[];
    try {
      topLevel = await readdir(extractDir);
    } catch {
      return null;
    }

    for (const entry of topLevel) {
      const candidate = join(extractDir, entry);
      if (await hasAudio(candidate)) return candidate;
    }
    return null;
  }

  /** Read an audio file and return its base64-encoded data with MIME type */
  private async _readAudioFile(
    packDir: string,
    filename: string,
  ): Promise<{ data: string; mimeType: string } | null> {
    // Security: prevent directory traversal
    if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
      console.warn(`[sound-loader] Rejected suspicious filename: ${filename}`);
      return null;
    }

    const ext = extname(filename).toLowerCase();
    if (!VALID_EXTENSIONS.has(ext)) {
      console.warn(`[sound-loader] Rejected unsupported extension: ${ext}`);
      return null;
    }

    const filePath = join(packDir, filename);
    try {
      const file = Bun.file(filePath);
      if (!(await file.exists())) return null;

      const buffer = await file.arrayBuffer();
      const base64 = Buffer.from(buffer).toString("base64");

      const mimeTypes: Record<string, string> = {
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".ogg": "audio/ogg",
      };

      return {
        data: base64,
        mimeType: mimeTypes[ext] ?? "application/octet-stream",
      };
    } catch {
      return null;
    }
  }

  /** Load persisted config via @loadout/plugin-storage. */
  private async _loadConfig(): Promise<void> {
    try {
      const loaded = await readPluginStorage<SoundLoaderConfig>(PLUGIN_ID);
      this.config = {
        activePack: loaded.activePack ?? null,
        useInOverlay: loaded.useInOverlay ?? false,
        useInSteam: loaded.useInSteam ?? false,
      };
    } catch {
      // Use defaults
    }
  }

  /** Persist config via @loadout/plugin-storage. */
  private async _saveConfig(): Promise<void> {
    try {
      await writePluginStorage<SoundLoaderConfig>(PLUGIN_ID, this.config);
    } catch (err) {
      console.error("[sound-loader] Failed to save config:", err);
    }
  }
}
