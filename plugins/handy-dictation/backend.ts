import type { PluginBackend, EmitPayload } from "@loadout/types";
import { commandExists, run, spawn } from "@loadout/exec";
import { homedir } from "os";
import { join } from "path";
import { mkdir, rm, chmod, rename, open } from "fs/promises";

const DATA_DIR = join(homedir(), ".local/share/loadout/handy-dictation");
const BIN_DIR = join(DATA_DIR, "bin");
const APPIMAGE_PATH = join(BIN_DIR, "Handy.AppImage");
const CONFIG_PATH = join(DATA_DIR, "config.json");

// Handy stores its settings here (Tauri app-data dir for its bundle id).
// We read this to detect whether the user has completed first-time setup
// (mic + model chosen) from Handy's own GUI. Handy's CLI doesn't expose
// model installs, so we don't try to enumerate models — that's on Handy.
const HANDY_DATA_DIR = join(homedir(), ".local/share/com.pais.handy");
const HANDY_SETTINGS_PATH = join(HANDY_DATA_DIR, "settings_store.json");

const HANDY_RELEASES_API =
  "https://api.github.com/repos/cjpais/Handy/releases/latest";

interface HandyRelease {
  tag_name: string;
  assets: Array<{ name: string; browser_download_url: string }>;
}

interface HandyConfig {
  /** Launch Handy with --start-hidden so its window never pops up in gaming mode. */
  startHidden: boolean;
  /** Auto-launch Handy when the plugin (and therefore the overlay) loads. */
  autostartOnLoad: boolean;
}

/**
 * Snapshot of the bits of Handy's own settings we surface read-only so the
 * user can confirm they picked a mic + model before leaving Desktop Mode.
 */
interface HandySettings {
  microphone: string | null;
  model: string | null;
  /** True once Handy has a non-empty mic + model — safe to trigger in gaming mode. */
  configured: boolean;
}

interface HandyStatus {
  installed: boolean;
  appImagePath: string | null;
  installedVersion: string | null;
  running: boolean;
  setupComplete: boolean;
  missingSystemDeps: string[];
  settings: HandySettings;
}

const DEFAULT_CONFIG: HandyConfig = {
  startHidden: true,
  autostartOnLoad: false,
};

/**
 * Handy Dictation — thin wrapper around Handy (https://github.com/cjpais/Handy).
 *
 * Handy is a free, offline, open-source speech-to-text app. This plugin
 * downloads the official AppImage, runs it in the background (hidden so it
 * stays out of the way in gaming mode), and drives transcription via Handy's
 * `--toggle-transcription` CLI flag. Handy itself handles mic capture,
 * on-device transcription, and injecting text into the focused field.
 */
export default class HandyDictationBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;

  private config: HandyConfig = { ...DEFAULT_CONFIG };
  private appImagePath: string | null = null;
  private installedVersion: string | null = null;
  private handyProc: ReturnType<typeof spawn> | null = null;
  private installing = false;

  async onLoad(): Promise<void> {
    console.log("[handy-dictation] Plugin loaded (Handy wrapper)");
    await mkdir(DATA_DIR, { recursive: true });
    await mkdir(BIN_DIR, { recursive: true });
    await this._loadConfig();
    this.appImagePath = await this._findAppImage();
    if (this.appImagePath && this.config.autostartOnLoad) {
      await this.startHandy();
    }
  }

  async onUnload(): Promise<void> {
    await this._stopHandy();
    console.log("[handy-dictation] Plugin unloaded");
  }

  // ------------------------------------------------------------------
  // RPC: Status + config
  // ------------------------------------------------------------------

  async getStatus(): Promise<HandyStatus> {
    if (!this.appImagePath) {
      this.appImagePath = await this._findAppImage();
    }
    if (this.handyProc && this.handyProc.exitCode !== null) {
      this.handyProc = null;
    }
    const missingSystemDeps = await this._checkSystemDeps();
    const settings = await this._readHandySettings();
    // Handy frequently starts from the user's desktop autostart (or a
    // previous login session), so "did we spawn it?" isn't enough. Probe
    // the process table too.
    const running = this.handyProc !== null || (await this._isHandyRunning());
    return {
      installed: this.appImagePath !== null,
      appImagePath: this.appImagePath,
      installedVersion: this.installedVersion,
      running,
      setupComplete:
        this.appImagePath !== null &&
        missingSystemDeps.length === 0 &&
        settings.configured,
      missingSystemDeps,
      settings,
    };
  }

  async getConfig(): Promise<HandyConfig> {
    return { ...this.config };
  }

  async updateConfig(
    partial: Partial<HandyConfig>,
  ): Promise<{ success: boolean }> {
    if (typeof partial.startHidden === "boolean") {
      this.config.startHidden = partial.startHidden;
    }
    if (typeof partial.autostartOnLoad === "boolean") {
      this.config.autostartOnLoad = partial.autostartOnLoad;
    }
    await this._saveConfig();
    this.emit?.({ event: "configChanged", data: this.config });
    return { success: true };
  }

  /**
   * Launch Handy visibly so the user can run its first-time setup
   * (pick microphone + model). Meant to be triggered from Desktop Mode —
   * under Gamescope the window will be stuck offscreen.
   *
   * If Handy is already running hidden, we stop it first so the relaunch
   * actually surfaces the window.
   */
  async launchHandyGui(): Promise<{ success: boolean; error?: string }> {
    if (!this.appImagePath) {
      return { success: false, error: "Handy is not installed" };
    }
    // Stop any Handy instance — ours OR one started by the desktop autostart
    // with --start-hidden. Otherwise Handy's single-instance lock eats our
    // new spawn and the user sees nothing.
    if (this.handyProc || (await this._isHandyRunning())) {
      await this._stopHandy();
    }
    try {
      this.handyProc = spawn([this.appImagePath], {
        stdout: "ignore",
        stderr: "ignore",
      });
      this.handyProc.exited.then(() => {
        this.handyProc = null;
        this.emit?.({ event: "statusChanged", data: { running: false } });
      });
      this.emit?.({ event: "statusChanged", data: { running: true } });
      return { success: true };
    } catch (err) {
      this.handyProc = null;
      return { success: false, error: String(err) };
    }
  }

  // ------------------------------------------------------------------
  // RPC: Install / uninstall
  // ------------------------------------------------------------------

  async installHandy(): Promise<{
    success: boolean;
    error?: string;
    version?: string;
  }> {
    if (this.installing) {
      return { success: false, error: "Install already in progress" };
    }
    this.installing = true;

    this.emit?.({
      event: "setupProgress",
      data: { phase: "install", status: "Fetching latest release..." },
    });

    try {
      const release = await this._fetchLatestRelease();
      if (!release.ok) {
        return { success: false, error: release.error };
      }

      const asset = this._selectAsset(release.data);
      if (!asset) {
        return {
          success: false,
          error: `No AppImage for ${this._wantedArch()} in ${release.data.tag_name}`,
        };
      }

      this.emit?.({
        event: "setupProgress",
        data: {
          phase: "install",
          status: `Downloading ${asset.name}...`,
          percent: 0,
        },
      });

      const download = await this._downloadAppImage({
        url: asset.browser_download_url,
        displayName: asset.name,
      });
      if (!download.ok) {
        return { success: false, error: download.error };
      }

      this.appImagePath = APPIMAGE_PATH;
      this.installedVersion = release.data.tag_name;
      await this._saveConfig();

      this.emit?.({
        event: "setupProgress",
        data: { phase: "install", status: "Done", percent: 100 },
      });
      this.emit?.({ event: "statusChanged", data: await this.getStatus() });

      return { success: true, version: release.data.tag_name };
    } catch (err) {
      return { success: false, error: String(err) };
    } finally {
      this.installing = false;
    }
  }

  async uninstallHandy(): Promise<{ success: boolean; error?: string }> {
    await this._stopHandy();
    try {
      await rm(APPIMAGE_PATH, { force: true });
      this.appImagePath = null;
      this.installedVersion = null;
      await this._saveConfig();
      this.emit?.({ event: "statusChanged", data: await this.getStatus() });
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  // ------------------------------------------------------------------
  // RPC: Process lifecycle
  // ------------------------------------------------------------------

  async startHandy(): Promise<{ success: boolean; error?: string }> {
    if (this.handyProc) {
      return { success: false, error: "Handy already running" };
    }
    if (!this.appImagePath) {
      return { success: false, error: "Handy is not installed" };
    }
    // If Handy is already running (started by the desktop autostart, a
    // previous session, etc.), don't double-launch — Handy's single-
    // instance lock would just kill the new process. Treat it as success.
    if (await this._isHandyRunning()) {
      this.emit?.({ event: "statusChanged", data: { running: true } });
      return { success: true };
    }
    try {
      const args = [this.appImagePath];
      if (this.config.startHidden) args.push("--start-hidden");
      this.handyProc = spawn(args, {
        stdout: "ignore",
        stderr: "ignore",
      });
      this.handyProc.exited.then(() => {
        this.handyProc = null;
        this.emit?.({ event: "statusChanged", data: { running: false } });
      });
      this.emit?.({ event: "statusChanged", data: { running: true } });
      return { success: true };
    } catch (err) {
      this.handyProc = null;
      return { success: false, error: String(err) };
    }
  }

  async stopHandy(): Promise<{ success: boolean }> {
    return this._stopHandy();
  }

  // ------------------------------------------------------------------
  // RPC: Dictation (drive Handy via its CLI flags)
  // ------------------------------------------------------------------

  async toggleDictation(): Promise<{ success: boolean; error?: string }> {
    if (!this.appImagePath) {
      return { success: false, error: "Handy is not installed" };
    }
    if (!this.handyProc) {
      const started = await this.startHandy();
      if (!started.success) return started;
      // Give Handy a moment to bind its single-instance IPC before we
      // immediately fire a CLI command at it.
      await Bun.sleep(500);
    }
    try {
      const { exitCode } = await run([
        this.appImagePath,
        "--toggle-transcription",
      ]);
      if (exitCode !== 0) {
        return {
          success: false,
          error: `Handy --toggle-transcription exited ${exitCode}`,
        };
      }
      this.emit?.({ event: "dictationToggled", data: {} });
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  private async _findAppImage(): Promise<string | null> {
    if (await Bun.file(APPIMAGE_PATH).exists()) return APPIMAGE_PATH;
    // Users who installed Handy via their package manager may have `handy`
    // (or the AppImage) already on PATH — let them use that.
    if (await commandExists("handy")) return "handy";
    if (await commandExists("Handy")) return "Handy";
    return null;
  }

  private _wantedArch(): "amd64" | "aarch64" {
    return process.arch === "arm64" ? "aarch64" : "amd64";
  }

  private _selectAsset(
    release: HandyRelease,
  ): { name: string; browser_download_url: string } | undefined {
    const arch = this._wantedArch();
    return release.assets.find((a) => a.name.endsWith(`_${arch}.AppImage`));
  }

  private async _fetchLatestRelease(): Promise<
    { ok: true; data: HandyRelease } | { ok: false; error: string }
  > {
    try {
      const res = await fetch(HANDY_RELEASES_API, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "loadout-handy-dictation",
        },
      });
      if (!res.ok) {
        return { ok: false, error: `GitHub API: HTTP ${res.status}` };
      }
      const data = (await res.json()) as HandyRelease;
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: `GitHub API fetch failed: ${String(err)}` };
    }
  }

  private async _downloadAppImage({
    url,
    displayName,
  }: {
    url: string;
    displayName: string;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    const tmp = APPIMAGE_PATH + ".tmp";
    try {
      const res = await fetch(url);
      if (!res.ok) {
        return { ok: false, error: `Download failed: HTTP ${res.status}` };
      }

      const total = Number(res.headers.get("content-length") ?? 0);
      const reader = res.body?.getReader();
      if (!reader) return { ok: false, error: "No response body" };

      const fh = await open(tmp, "w");
      let received = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await fh.write(value);
          received += value.length;
          if (total > 0) {
            const percent = Math.round((received / total) * 100);
            this.emit?.({
              event: "setupProgress",
              data: {
                phase: "install",
                status: `Downloading ${displayName}... ${percent}%`,
                percent,
              },
            });
          }
        }
      } finally {
        await fh.close();
      }

      await rm(APPIMAGE_PATH, { force: true }).catch(() => {});
      await rename(tmp, APPIMAGE_PATH);
      await chmod(APPIMAGE_PATH, 0o755);
      return { ok: true };
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      return { ok: false, error: String(err) };
    }
  }

  /**
   * Read Handy's own settings_store.json (written by its GUI) so we can
   * show the user what they configured — mic, model, whether first-time
   * setup is done — without asking them to re-enter anything. Returns
   * a null/empty snapshot if the file doesn't exist yet.
   */
  private async _readHandySettings(): Promise<HandySettings> {
    const empty: HandySettings = {
      microphone: null,
      model: null,
      configured: false,
    };
    try {
      const file = Bun.file(HANDY_SETTINGS_PATH);
      if (!(await file.exists())) return empty;
      const raw = (await file.json()) as {
        settings?: {
          selected_microphone?: string | null;
          selected_model?: string | null;
        };
      };
      const mic = raw.settings?.selected_microphone ?? null;
      const model = raw.settings?.selected_model ?? null;
      return {
        microphone: mic,
        model,
        configured: !!mic && !!model,
      };
    } catch (err) {
      console.warn("[handy-dictation] failed to read Handy settings:", err);
      return empty;
    }
  }

  private async _checkSystemDeps(): Promise<string[]> {
    // Handy injects transcribed text via a typing tool. If none is available,
    // Handy can still transcribe but text won't land in the focused field.
    const hasTyping =
      (await commandExists("wtype")) ||
      (await commandExists("xdotool")) ||
      (await commandExists("dotool"));
    const missing: string[] = [];
    if (!hasTyping) missing.push("wtype, xdotool, or dotool");
    return missing;
  }

  private async _stopHandy(): Promise<{ success: boolean }> {
    const hadOwnProc = this.handyProc !== null;
    // Stop our own child first if we own one. The proc's exited.then
    // handler emits statusChanged({running: false}) for us.
    if (this.handyProc) {
      const proc = this.handyProc;
      proc.kill("SIGTERM");
      // Audit F-019: Handy can wedge during shutdown (e.g. mid-transcription
      // with the whisper model still loaded). Wait up to 5s on SIGTERM,
      // then SIGKILL so the plugin never blocks the loader on a stuck
      // child.
      const SIGKILL_TIMEOUT_MS = 5000;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<"timeout">((resolve) => {
        killTimer = setTimeout(() => resolve("timeout"), SIGKILL_TIMEOUT_MS);
      });
      const result = await Promise.race([
        proc.exited.then(() => "exited" as const),
        timeout,
      ]);
      if (killTimer) clearTimeout(killTimer);
      if (result === "timeout") {
        console.warn(
          "[handy-dictation] SIGTERM ignored after 5s — sending SIGKILL",
        );
        try {
          proc.kill("SIGKILL");
        } catch (err) {
          // Already gone between the timeout firing and the kill call.
          console.warn("[handy-dictation] SIGKILL throw (process gone?):", err);
        }
        await proc.exited;
      }
      this.handyProc = null;
    }
    // Kill any externally-launched Handy too (desktop autostart, previous
    // session). pkill is best-effort — succeed if no processes existed.
    if (await this._isHandyRunning()) {
      try {
        await run(["pkill", "-TERM", "-x", "handy"]);
      } catch {
        /* non-fatal */
      }
      // Give it a moment to release the single-instance lock.
      await Bun.sleep(200);
      // We killed an external Handy — nobody else is going to emit this.
      this.emit?.({ event: "statusChanged", data: { running: false } });
    } else if (!hadOwnProc) {
      // Stop with nothing to stop — still emit so UI polls resync.
      this.emit?.({ event: "statusChanged", data: { running: false } });
    }
    return { success: true };
  }

  /**
   * Check the process table for a live Handy instance. Catches instances
   * started outside this plugin (KDE/GNOME autostart, previous shell
   * invocation, etc.) so the UI status badge reflects reality.
   */
  private async _isHandyRunning(): Promise<boolean> {
    if (!(await commandExists("pgrep"))) return false;
    try {
      // `pgrep -x handy` matches the unpacked inner binary; the AppImage
      // wrapper forks it on every launch, so this is the stable name.
      const { exitCode } = await run(["pgrep", "-x", "handy"]);
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  private async _loadConfig(): Promise<void> {
    try {
      const file = Bun.file(CONFIG_PATH);
      if (await file.exists()) {
        const data = (await file.json()) as Partial<HandyConfig> & {
          installedVersion?: string;
        };
        if (typeof data.startHidden === "boolean") {
          this.config.startHidden = data.startHidden;
        }
        if (typeof data.autostartOnLoad === "boolean") {
          this.config.autostartOnLoad = data.autostartOnLoad;
        }
        if (typeof data.installedVersion === "string") {
          this.installedVersion = data.installedVersion;
        }
      }
    } catch {
      // Use defaults
    }
  }

  private async _saveConfig(): Promise<void> {
    try {
      await Bun.write(
        CONFIG_PATH,
        JSON.stringify(
          { ...this.config, installedVersion: this.installedVersion },
          null,
          2,
        ),
      );
    } catch (err) {
      console.error("[handy-dictation] Failed to save config:", err);
    }
  }
}
