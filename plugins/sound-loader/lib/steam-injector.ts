/**
 * Steam-side sound injection lifecycle.
 *
 * Connects to Steam's CEF debug port (`localhost:8080`), opens a CDP
 * WebSocket against the SharedJSContext tab, injects the audio hook
 * (`STEAM_HOOK_SCRIPT`) and pushes an override map. Handles:
 *   - Steam not running (caller retries via health check)
 *   - Page reloads (Ctrl+R) — re-inject after webpack is ready
 *   - WebSocket drops — health check reconnects
 */
import { CDPClient } from "@loadout/steam-cdp";
import { findSharedJSContext } from "@loadout/injector";
import { homedir } from "node:os";
import { join, extname, dirname, basename } from "node:path";
import { mkdir, cp, rm, readdir, lstat, stat, unlink } from "node:fs/promises";
import { STEAM_HOOK_SCRIPT } from "./steam-hook";

const DEBUG_PORT = 8080;
const CONNECT_TIMEOUT_MS = 3000;
const HEALTH_INTERVAL_MS = 5000;
const WEBPACK_READY_POLL_MS = 100;
const WEBPACK_READY_TIMEOUT_MS = 5000;

export const STEAM_SOUNDS_CUSTOM_DIR = join(
  homedir(),
  ".local/share/Steam/steamui/sounds_custom/loadout",
);

export interface PackEntry {
  manifest: {
    mappings: Record<string, string | string[] | undefined>;
  };
  dir: string;
}

export type Logger = (msg: string, level?: "info" | "warn" | "error") => void;

export interface InjectResult {
  ok: boolean;
  error?: string;
}

export class AudioSteamInjector {
  private cdp: CDPClient | null = null;
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private reloadUnsubscribe: (() => void) | null = null;
  private log: Logger;
  private onReinject: (() => void | Promise<void>) | null = null;

  constructor(log: Logger) {
    this.log = log;
  }

  /** Idempotent — connects to SharedJSContext if not already connected. */
  async tryConnect(): Promise<InjectResult> {
    if (this.cdp?.connected) return { ok: true };

    let tab;
    try {
      tab = await findSharedJSContext({
        debugPort: DEBUG_PORT,
        timeout: CONNECT_TIMEOUT_MS,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Steam not reachable: ${msg}` };
    }

    const cdp = new CDPClient(tab.webSocketDebuggerUrl);
    try {
      await cdp.connect();
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      cdp.close();
      return { ok: false, error: `CDP connect failed: ${msg}` };
    }

    this.cdp = cdp;
    this.log(`Connected to SharedJSContext`);
    return { ok: true };
  }

  /** Inject the hook IIFE. Reads back __SL_AUDIO_HOOK_ERROR__ to detect find failures. */
  async injectHook(): Promise<InjectResult> {
    if (!this.cdp?.connected) return { ok: false, error: "not connected" };

    // Wait for webpack cache to be populated — frameNavigated fires too early.
    const ready = await this.waitForWebpack();
    if (!ready) return { ok: false, error: "webpack cache not ready after 5s" };

    try {
      await this.cdp.evaluate(STEAM_HOOK_SCRIPT);
      const err = (await this.cdp.evaluate(
        "window.__SL_AUDIO_HOOK_ERROR__ || null",
      )) as string | null;
      if (err) return { ok: false, error: err };
      this.log(`Hook installed`);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `injectHook eval failed: ${msg}` };
    }
  }

  /** Push (or replace) the override map without re-running the find/patch logic. */
  async refreshOverrides(map: Record<string, string>): Promise<InjectResult> {
    if (!this.cdp?.connected) return { ok: false, error: "not connected" };
    try {
      const json = JSON.stringify(map);
      await this.cdp.evaluate(`window.__SL_AUDIO_OVERRIDES__ = ${json}`);
      const count = Object.keys(map).length;
      this.log(`Overrides: ${count} entries`);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `refreshOverrides eval failed: ${msg}` };
    }
  }

  /** Best-effort: tell the page to restore the original PlayAudioURL. */
  async removeOverrides(): Promise<void> {
    if (!this.cdp?.connected) return;
    try {
      await this.cdp.evaluate(
        "(window.__SL_AUDIO_UNPATCH__ && window.__SL_AUDIO_UNPATCH__())",
      );
      this.log(`Hook removed`);
    } catch (err) {
      this.log(
        `removeOverrides failed: ${err instanceof Error ? err.message : err}`,
        "warn",
      );
    }
  }

  /**
   * Subscribe to page navigations + start the health-check timer.
   * `onReinject` is called after a reconnect/reload completes — caller
   * should re-run `injectHook` + `refreshOverrides` with current state.
   */
  startMonitor(onReinject: () => void | Promise<void>): void {
    this.onReinject = onReinject;
    this.setupReloadHandler();
    this.startHealthCheck();
  }

  /** Stop monitoring + close the CDP connection. Best-effort cleanup. */
  async stop(): Promise<void> {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
    this.reloadUnsubscribe?.();
    this.reloadUnsubscribe = null;
    await this.removeOverrides();
    this.cdp?.close();
    this.cdp = null;
  }

  // -- Private --

  private setupReloadHandler(): void {
    if (!this.cdp) return;
    this.reloadUnsubscribe?.();
    this.reloadUnsubscribe = this.cdp.on("Page.frameNavigated", (params) => {
      const frame = params.frame as { parentId?: string } | undefined;
      // Top-frame navigations only — ignore iframes.
      if (frame && !frame.parentId) {
        this.log(`Page reloaded, re-injecting...`);
        // Defer to the next tick — let CDP finish its message pump.
        void Promise.resolve().then(() => this.onReinject?.());
      }
    });
  }

  private startHealthCheck(): void {
    if (this.healthInterval) clearInterval(this.healthInterval);
    this.healthInterval = setInterval(() => {
      void this.healthTick();
    }, HEALTH_INTERVAL_MS);
  }

  private async healthTick(): Promise<void> {
    if (this.cdp?.connected) return;
    // Connection dropped — try to re-establish.
    this.log(`Health check: connection lost, reconnecting...`, "warn");
    this.cdp?.close();
    this.cdp = null;
    const result = await this.tryConnect();
    if (result.ok) {
      this.setupReloadHandler();
      await this.onReinject?.();
    }
  }

  private async waitForWebpack(): Promise<boolean> {
    if (!this.cdp?.connected) return false;
    const deadline = Date.now() + WEBPACK_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const ready = await this.cdp.hasGlobalVar("webpackChunksteamui");
        if (ready) return true;
      } catch {
        return false;
      }
      await new Promise((r) => setTimeout(r, WEBPACK_READY_POLL_MS));
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// File staging — copy active pack's WAVs into Steam's sounds_custom dir
// so Steam can serve them via https://steamloopback.host/sounds_custom/...
// ---------------------------------------------------------------------------

/**
 * Reclaim the `sounds_custom` parent if Decky/AudioLoader left a dangling
 * symlink behind. Without this, `mkdir(stagingDir, { recursive: true })`
 * fails with ENOENT because Bun's recursive mkdir follows symlinks
 * before checking the target — a broken `sounds_custom -> ~/homebrew/sounds`
 * (typical Decky uninstall residue) breaks the entire chain.
 *
 * Behaviour:
 *   - Real directory at `sounds_custom`: leave it alone.
 *   - Symlink to a directory that exists: leave it alone (Decky still
 *     installed, sharing the staging area is fine).
 *   - Symlink to a missing target: unlink and replace with a real dir.
 *   - File at `sounds_custom`: bail (not safe to delete user data).
 */
export async function reclaimStagingParent(stagingDir: string): Promise<void> {
  const parent = dirname(stagingDir);
  let info: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    info = await lstat(parent);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    throw err;
  }
  if (!info.isSymbolicLink()) return;

  let targetExists = false;
  try {
    await stat(parent);
    targetExists = true;
  } catch {
    targetExists = false;
  }
  if (targetExists) return;

  await unlink(parent);
}

/**
 * Ensure the staging directory exists and is writable. Reclaims a broken
 * `sounds_custom` symlink (Decky leftover) before creating the loadout
 * subdirectory, since Bun's `mkdir(..., { recursive: true })` follows symlinks
 * eagerly and fails ENOENT on a dangling target.
 */
export async function prepareStagingDir(stagingDir: string): Promise<void> {
  await reclaimStagingParent(stagingDir);
  await mkdir(stagingDir, { recursive: true });
}

/** Build the `https://steamloopback.host/...` URL for a staged file under
 *  `sounds_custom/<bucket>/<filename>`, where bucket is derived from the
 *  staging directory name (always `loadout` in production). */
function loopbackUrlFor(stagingDir: string, filename: string): string {
  const bucket = basename(stagingDir);
  return `https://steamloopback.host/sounds_custom/${bucket}/${encodeURIComponent(filename)}`;
}

/**
 * Copy each event's audio file from the pack into Steam's sounds_custom dir,
 * renaming to the canonical Decky filename (the keys the hook looks up).
 *
 * Returns a map of `deckyFilename -> https://steamloopback.host/...` URL,
 * suitable for `refreshOverrides`.
 *
 * Multi-file packs (events mapped to an array of files) pick the first file
 * deterministically in v1. Per-play randomization is deferred (see plan).
 *
 * `stagingDir` is exposed for tests; production callers use the default.
 */
export async function stagePackFiles(
  entry: PackEntry,
  deckyToSteamLoader: Record<string, string>,
  stagingDir: string = STEAM_SOUNDS_CUSTOM_DIR,
): Promise<Record<string, string>> {
  await clearStagedFiles(stagingDir);
  await prepareStagingDir(stagingDir);

  const map: Record<string, string> = {};

  for (const [event, fileOrFiles] of Object.entries(entry.manifest.mappings)) {
    if (!fileOrFiles) continue;
    const files = Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles];
    if (files.length === 0) continue;
    const sourceFilename = files[0];
    const ext = extname(sourceFilename).toLowerCase();
    if (![".wav", ".mp3", ".ogg"].includes(ext)) continue;

    // Find every Decky filename that maps to this event.
    const deckyNames = Object.entries(deckyToSteamLoader)
      .filter(([, ev]) => ev === event)
      .map(([decky]) => decky);
    if (deckyNames.length === 0) continue;

    const stagedName = deckyNames[0];
    const sourcePath = join(entry.dir, sourceFilename);
    const targetPath = join(stagingDir, stagedName);

    try {
      await cp(sourcePath, targetPath);
    } catch {
      continue;
    }

    const url = loopbackUrlFor(stagingDir, stagedName);
    // All Decky filenames that map to this event get the same staged URL.
    for (const name of deckyNames) {
      map[name] = url;
    }
  }

  return map;
}

/** Remove the entire staging directory (best-effort). */
export async function clearStagedFiles(stagingDir: string = STEAM_SOUNDS_CUSTOM_DIR): Promise<void> {
  try {
    await rm(stagingDir, { recursive: true, force: true });
  } catch {
    // Directory may not exist
  }
}

/** True if the staging directory exists and contains files (debug helper). */
export async function listStagedFiles(stagingDir: string = STEAM_SOUNDS_CUSTOM_DIR): Promise<string[]> {
  try {
    return await readdir(stagingDir);
  } catch {
    return [];
  }
}
