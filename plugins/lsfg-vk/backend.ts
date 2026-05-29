import type { PluginBackend, EmitPayload, PluginLogger } from "@loadout/types";
import { run, runFull, commandExists, spawn } from "@loadout/exec";
import {
  readPluginStorage,
  writePluginStorage,
} from "@loadout/plugin-storage";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  mkdir,
  rm,
  readFile,
  writeFile,
  chmod,
  stat,
  readdir,
} from "node:fs/promises";

import { renderTomlConfig, renderWrapperScript } from "./lib/render-config";
import type { LsfgSettings, PersistedStore } from "./lib/types";
import { DEFAULTS, PLUGIN_ID, PROFILE, WRAPPER_TOKEN } from "./lib/constants";

// Honor $HOME if set so tests can sandbox paths via env override.
// `homedir()` on macOS resolves via /etc/passwd and ignores $HOME.
// Read lazily on each call so a test can swap $HOME between sandbox cycles
// without needing to re-import this module (the ESM module map is cached
// in modern Bun and `delete require.cache[…]` no longer evicts it).
const HOME = () => process.env.HOME ?? homedir();
const LIB_DIR = () => join(HOME(), ".local/lib");
const VULKAN_LAYERS_DIR = () =>
  join(HOME(), ".local/share/vulkan/implicit_layer.d");
const TOML_DIR = () => join(HOME(), ".config/lsfg-vk");
const TOML_PATH = () => join(TOML_DIR(), "conf.toml");
const WRAPPER_PATH = () => join(HOME(), "lsfg");
const SO_PATH = () => join(LIB_DIR(), "liblsfg-vk.so");
const LAYER_JSON_PATH = () =>
  join(VULKAN_LAYERS_DIR(), "VkLayer_LS_frame_generation.json");
const STEAM_DEFAULT_DLL = () =>
  join(
    HOME(),
    ".local/share/Steam/steamapps/common/Lossless Scaling/Lossless.dll",
  );

const RELEASES_API =
  "https://api.github.com/repos/PancakeTAS/lsfg-vk/releases/latest";
/** Asset filename in the GitHub release — layer-only, ~700 KB. */
const ASSET_NAME = "lsfg-vk_noui.zip";

interface InstallStatus {
  installed: boolean;
  layerSoExists: boolean;
  layerJsonExists: boolean;
  wrapperExists: boolean;
  /** Absolute filesystem path to the wrapper script (e.g. `/home/u/lsfg`). */
  wrapperPath: string;
  /** Tilde-form token to put into Steam launch options (e.g. `~/lsfg`). */
  wrapperToken: string;
  layerSoPath: string;
  layerJsonPath: string;
  tomlPath: string;
}

interface DllStatus {
  found: boolean;
  path: string | null;
  isCustom: boolean;
}

interface FullStatus {
  install: InstallStatus;
  dll: DllStatus;
  settings: LsfgSettings;
  customDllPath: string | null;
  /** Single launch-option string the user copies into Steam. */
  launchOptions: string;
}

/**
 * LSFG-VK plugin backend.
 *
 * Ports the install/configure flow from xXJSONDeruloXx/decky-lsfg-vk:
 * downloads `lsfg-vk_noui.zip` from PancakeTAS/lsfg-vk GitHub releases,
 * lays the Vulkan layer into `~/.local/{lib,share/vulkan/implicit_layer.d}/`,
 * writes the TOML config the layer reads at `~/.config/lsfg-vk/conf.toml`,
 * and generates a `~/lsfg` wrapper script that exports `LSFG_PROCESS` so
 * the layer matches its profile. Steam launch option is `~/lsfg %command%`.
 */
export default class LsfgVkBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;
  log?: PluginLogger;

  private settings: LsfgSettings = { ...DEFAULTS };
  private customDllPath: string | null = null;

  async onLoad(): Promise<void> {
    await this._loadStore();
  }

  async onUnload(): Promise<void> {
    /* nothing to tear down */
  }

  // ── Status ──────────────────────────────────────────────────────

  async getStatus(): Promise<FullStatus> {
    const [install, dll] = await Promise.all([
      this._getInstallStatus(),
      this._getDllStatus(),
    ]);
    return {
      install,
      dll,
      settings: { ...this.settings },
      customDllPath: this.customDllPath,
      launchOptions: `${WRAPPER_TOKEN} %command%`,
    };
  }

  async getSettings(): Promise<LsfgSettings> {
    return { ...this.settings };
  }

  async getLaunchOptionsString(): Promise<string> {
    return `${WRAPPER_TOKEN} %command%`;
  }

  /**
   * Write `text` to the system clipboard via `wl-copy` (Wayland) or
   * `xclip` (X11). Routed through the host because `navigator.clipboard`
   * is undefined inside the CEF webview (no secure context).
   */
  async copyToClipboard(
    text: string,
  ): Promise<{ success: boolean; error?: string }> {
    const candidates: Array<{ cmd: string[]; tool: string }> = [
      { cmd: ["wl-copy"], tool: "wl-copy" },
      { cmd: ["xclip", "-selection", "clipboard"], tool: "xclip" },
    ];

    for (const { cmd, tool } of candidates) {
      if (!(await commandExists(cmd[0]))) continue;
      try {
        const { stderr, exitCode } = await runFull(cmd, { stdin: text });
        if (exitCode === 0) return { success: true };
        console.warn(
          `[lsfg-vk] ${tool} exit ${exitCode}: ${stderr.trim()}`,
        );
      } catch (err) {
        console.warn(`[lsfg-vk] ${tool} failed: ${err}`);
      }
    }

    return {
      success: false,
      error:
        "No working clipboard tool found. Install wl-clipboard (Wayland) or xclip (X11).",
    };
  }

  // ── Install / Uninstall ─────────────────────────────────────────

  async install(): Promise<{ success: boolean; version?: string; error?: string }> {
    try {
      this._progress("Resolving release…");
      const { downloadUrl, version } = await this._resolveLatestNoUiAsset();

      this._progress(`Downloading lsfg-vk ${version}…`);
      const zipPath = await this._downloadAsset(downloadUrl);

      this._progress("Extracting…");
      const extractDir = await this._extractZip(zipPath);

      this._progress("Installing layer files…");
      await this._installLayerFiles(extractDir);

      this._progress("Writing config…");
      await this._writeTomlConfig();
      await this._writeWrapperScript();

      // Cleanup temp dirs (zip + extracted tree).
      await rm(zipPath, { force: true });
      await rm(extractDir, { recursive: true, force: true });

      this._progress(`Installed v${version}`, { done: true });
      this.emit?.({ event: "installChanged", data: { installed: true, version } });
      return { success: true, version };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.log?.error(`install failed: ${error}`);
      this._progress(`Install failed: ${error}`, { done: true, error: true });
      return { success: false, error };
    }
  }

  /** Remove the layer .so, layer JSON, and wrapper script. Preserves the TOML so a re-install restores user tweaks. */
  async uninstall(): Promise<{ success: boolean; error?: string }> {
    try {
      await Promise.all([
        rm(SO_PATH(), { force: true }),
        rm(LAYER_JSON_PATH(), { force: true }),
        rm(WRAPPER_PATH(), { force: true }),
      ]);
      this.emit?.({ event: "installChanged", data: { installed: false } });
      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, error };
    }
  }

  // ── Settings ────────────────────────────────────────────────────

  async updateSettings(updates: Partial<LsfgSettings>): Promise<LsfgSettings> {
    Object.assign(this.settings, updates);
    await this._persistStore();
    // Regenerate TOML + wrapper if the layer is installed; otherwise we'll
    // write them at install time using the stored settings.
    if (await this._fileExists(SO_PATH())) {
      await this._writeTomlConfig();
      await this._writeWrapperScript();
    }
    this.emit?.({ event: "settingsChanged", data: this.settings });
    return { ...this.settings };
  }

  // ── DLL path ────────────────────────────────────────────────────

  async setCustomDllPath(path: string): Promise<DllStatus> {
    this.customDllPath = path.trim() || null;
    await this._persistStore();
    if (await this._fileExists(SO_PATH())) {
      await this._writeTomlConfig();
    }
    const status = await this._getDllStatus();
    this.emit?.({ event: "dllChanged", data: status });
    return status;
  }

  async clearCustomDllPath(): Promise<DllStatus> {
    this.customDllPath = null;
    await this._persistStore();
    if (await this._fileExists(SO_PATH())) {
      await this._writeTomlConfig();
    }
    const status = await this._getDllStatus();
    this.emit?.({ event: "dllChanged", data: status });
    return status;
  }

  // ── Diagnostics ─────────────────────────────────────────────────

  /**
   * Run `vulkaninfo --summary` and grep for the lsfg-vk layer name. This is
   * the canonical "is the implicit layer actually getting picked up by the
   * Vulkan loader?" check — independent of whether any game is running.
   * If `vulkaninfo` is missing we flag that separately so the UI can tell
   * the user to install vulkan-tools.
   */
  async runVulkanCheck(): Promise<{
    available: boolean;
    layerLoaded: boolean;
    jsonExists: boolean;
    excerpt: string;
  }> {
    const jsonExists = await this._fileExists(LAYER_JSON_PATH());
    if (!(await commandExists("vulkaninfo"))) {
      return {
        available: false,
        layerLoaded: false,
        jsonExists,
        excerpt:
          "vulkaninfo not found. Install the vulkan-tools package (Bazzite: rpm-ostree install vulkan-tools).",
      };
    }
    const { stdout, stderr } = await runFull(["vulkaninfo", "--summary"]);
    const combined = `${stdout}\n${stderr}`;
    const matches = combined
      .split("\n")
      .filter((l) => /lsfg|frame_generation/i.test(l))
      .slice(0, 10);
    return {
      available: true,
      layerLoaded: matches.length > 0,
      jsonExists,
      excerpt: matches.length
        ? matches.join("\n")
        : "No lsfg-vk references in vulkaninfo. The layer JSON is on disk but the Vulkan loader is not picking it up — check VK_LAYER_PATH or sandboxed Steam runtime.",
    };
  }

  /**
   * Spawn `vkcube` with LSFG_PROCESS exported, so the user can see the
   * effective FPS in the title bar. We detach so the picker doesn't block
   * the RPC waiting for the user to close the window.
   */
  async launchVkcube(): Promise<{ success: boolean; pid?: number; error?: string }> {
    if (!(await commandExists("vkcube"))) {
      return {
        success: false,
        error:
          "vkcube not found. Install vulkan-tools (Bazzite: rpm-ostree install vulkan-tools).",
      };
    }
    try {
      // Long-lived child — vkcube outlives the RPC. Build env inline
      // so we can pass it to spawn directly.
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === "string") env[k] = v;
      }
      env.LSFG_PROCESS = PROFILE;
      if (this.settings.verbose_logging) {
        env.LSFG_LOG = "1";
        env.VK_LOADER_DEBUG = "layer";
      }
      const proc = spawn(["vkcube"], {
        env,
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      });
      proc.unref();
      return { success: true, pid: proc.pid };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ── Internals ───────────────────────────────────────────────────

  private async _getInstallStatus(): Promise<InstallStatus> {
    const [layerSoExists, layerJsonExists, wrapperExists] = await Promise.all([
      this._fileExists(SO_PATH()),
      this._fileExists(LAYER_JSON_PATH()),
      this._fileExists(WRAPPER_PATH()),
    ]);
    return {
      installed: layerSoExists && layerJsonExists && wrapperExists,
      layerSoExists,
      layerJsonExists,
      wrapperExists,
      wrapperPath: WRAPPER_PATH(),
      wrapperToken: WRAPPER_TOKEN,
      layerSoPath: SO_PATH(),
      layerJsonPath: LAYER_JSON_PATH(),
      tomlPath: TOML_PATH(),
    };
  }

  private async _getDllStatus(): Promise<DllStatus> {
    if (this.customDllPath) {
      const ok = await this._fileExists(this.customDllPath);
      return { found: ok, path: ok ? this.customDllPath : null, isCustom: true };
    }
    const steamDll = STEAM_DEFAULT_DLL();
    const ok = await this._fileExists(steamDll);
    return {
      found: ok,
      path: ok ? steamDll : null,
      isCustom: false,
    };
  }

  private _progress(
    message: string,
    extra: { done?: boolean; error?: boolean } = {},
  ): void {
    this.log?.info(`[install] ${message}`);
    this.emit?.({
      event: "installProgress",
      data: { message, ...extra },
    });
  }

  private async _resolveLatestNoUiAsset(): Promise<{
    downloadUrl: string;
    version: string;
  }> {
    const res = await fetch(RELEASES_API, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      throw new Error(`GitHub API ${res.status} ${res.statusText}`);
    }
    const release = (await res.json()) as {
      tag_name: string;
      assets: Array<{ name: string; browser_download_url: string }>;
    };
    const asset = release.assets.find((a) => a.name === ASSET_NAME);
    if (!asset) {
      throw new Error(
        `Release ${release.tag_name} does not include ${ASSET_NAME}`,
      );
    }
    return {
      downloadUrl: asset.browser_download_url,
      version: release.tag_name.replace(/^v/, ""),
    };
  }

  private async _downloadAsset(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download ${res.status} ${res.statusText}`);
    const zipPath = join(tmpdir(), `lsfg-vk-${Date.now()}.zip`);
    await Bun.write(zipPath, await res.arrayBuffer());
    return zipPath;
  }

  private async _extractZip(zipPath: string): Promise<string> {
    const extractDir = join(tmpdir(), `lsfg-vk-extract-${Date.now()}`);
    await mkdir(extractDir, { recursive: true });
    const { exitCode, stdout } = await run([
      "unzip",
      "-o",
      zipPath,
      "-d",
      extractDir,
    ]);
    if (exitCode !== 0) {
      throw new Error(`unzip failed (exit ${exitCode}): ${stdout}`);
    }
    return extractDir;
  }

  private async _installLayerFiles(extractDir: string): Promise<void> {
    await Promise.all([
      mkdir(LIB_DIR(), { recursive: true }),
      mkdir(VULKAN_LAYERS_DIR(), { recursive: true }),
    ]);

    // The noui zip extracts liblsfg-vk.so + VkLayer_LS_frame_generation.json
    // at the root. We tolerate a nested layout by walking the tree.
    const found = await this._findExtractedFiles(extractDir);
    if (!found.so) {
      throw new Error("liblsfg-vk.so not found in archive");
    }
    if (!found.json) {
      throw new Error("VkLayer_LS_frame_generation.json not found in archive");
    }

    await Bun.write(SO_PATH(), Bun.file(found.so));
    await chmod(SO_PATH(), 0o755);

    // Rewrite the layer JSON's library_path so it resolves against
    // ~/.local/share/vulkan/implicit_layer.d/ → ~/.local/lib/.
    const raw = await readFile(found.json, "utf8");
    const obj = JSON.parse(raw) as {
      layer?: { library_path?: string };
    };
    if (obj.layer && typeof obj.layer.library_path === "string") {
      obj.layer.library_path = "../../../lib/liblsfg-vk.so";
    }
    await writeFile(LAYER_JSON_PATH(), JSON.stringify(obj, null, 2));
  }

  private async _findExtractedFiles(
    dir: string,
  ): Promise<{ so: string | null; json: string | null }> {
    const queue: string[] = [dir];
    let so: string | null = null;
    let json: string | null = null;
    while (queue.length) {
      const cur = queue.shift()!;
      const entries = await readdir(cur, { withFileTypes: true });
      for (const e of entries) {
        const path = join(cur, e.name);
        if (e.isDirectory()) {
          queue.push(path);
        } else if (e.name === "liblsfg-vk.so") {
          so = path;
        } else if (e.name === "VkLayer_LS_frame_generation.json") {
          json = path;
        }
      }
    }
    return { so, json };
  }

  private async _writeTomlConfig(): Promise<void> {
    await mkdir(TOML_DIR(), { recursive: true });
    const dll = await this._resolveDllForToml();
    await writeFile(TOML_PATH(), renderTomlConfig(this.settings, dll));
  }

  private async _resolveDllForToml(): Promise<string> {
    const status = await this._getDllStatus();
    return status.path ?? STEAM_DEFAULT_DLL();
  }

  private async _writeWrapperScript(): Promise<void> {
    await writeFile(WRAPPER_PATH(), renderWrapperScript(this.settings));
    await chmod(WRAPPER_PATH(), 0o755);
  }

  private async _fileExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  private async _loadStore(): Promise<void> {
    try {
      const data = await readPluginStorage<PersistedStore>(PLUGIN_ID);
      if (data.settings) Object.assign(this.settings, data.settings);
      if (typeof data.customDllPath === "string") {
        this.customDllPath = data.customDllPath || null;
      }
    } catch (err) {
      this.log?.warn(`Failed to load store: ${err}`);
    }
  }

  private async _persistStore(): Promise<void> {
    try {
      const data: PersistedStore = {
        settings: this.settings,
        customDllPath: this.customDllPath ?? undefined,
      };
      await writePluginStorage<PersistedStore>(PLUGIN_ID, data);
    } catch (err) {
      this.log?.error(`Failed to persist store: ${err}`);
    }
  }
}
