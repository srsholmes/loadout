import type { PluginBackend, EmitPayload } from "@loadout/types";
import { getSteamAppsDir } from "@loadout/steam-paths";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type GameSession,
  type PlaytimeData,
  type Stats,
  type CurrentSession,
  computeStats,
} from "./lib/time";
import {
  pluginDataPath,
  ensurePluginDataDir,
  readPluginData,
  writePluginData,
} from "./lib/storage";

/**
 * PlayTime plugin backend.
 *
 * Tracks game sessions by subscribing to the loader's shared
 * `__core:game-detection` service. The loader broadcasts
 * `handleGameLaunch(appId, gameName)` / `handleGameExit(appId)` to every
 * plugin that exposes those methods (same surface that drives
 * per-game-profiles in tdp-control / fan-control / audio-mixer).
 *
 * Game names are still resolved from Steam app manifests when the
 * broadcast carries a missing or generic label.
 *
 * Persists playtime data to ~/.config/loadout/plugins/playtime.json.
 */
export default class PlaytimeBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;

  private readonly dataPath: string;
  private readonly steamAppsPath: string;
  private data: PlaytimeData = { sessions: [] };
  private appManifests = new Map<string, string>(); // appId -> game name
  private emitInterval?: Timer;
  private activeSession: GameSession | null = null;

  constructor() {
    this.dataPath = pluginDataPath("playtime");
    this.steamAppsPath = getSteamAppsDir();
  }

  async onLoad(): Promise<void> {
    console.log("[playtime] Plugin loading");

    await ensurePluginDataDir();
    await this._loadData();
    await this._loadManifests();

    // Emit sessionUpdate events every 30 seconds when a game is running
    // so the overlay's elapsed-time counter stays fresh without polling.
    this.emitInterval = setInterval(() => {
      if (this.activeSession) {
        this.emit?.({
          event: "sessionUpdate",
          data: this._buildCurrentSession(),
        });
      }
    }, 30_000);

    console.log("[playtime] Plugin loaded, awaiting game-detection broadcasts");
  }

  async onUnload(): Promise<void> {
    clearInterval(this.emitInterval);

    if (this.activeSession) {
      this.activeSession.endTime = Date.now();
      this.data.sessions.push(this.activeSession);
      this.activeSession = null;
      await this._saveData();
    }

    console.log("[playtime] Plugin unloaded");
  }

  // --- Game-detection broadcast hooks ---
  // The loader's GameDetectionService fans out `handleGameLaunch` /
  // `handleGameExit` to every plugin instance that implements them.

  async handleGameLaunch(appId: number, gameName: string): Promise<void> {
    if (typeof appId !== "number" || !Number.isFinite(appId)) return;
    const appIdStr = String(appId);
    const resolvedName =
      gameName && gameName.length > 0
        ? gameName
        : this.appManifests.get(appIdStr) ?? `Steam App ${appIdStr}`;

    // If a different game is already active, close it cleanly first.
    if (this.activeSession && this.activeSession.appId !== appIdStr) {
      this.activeSession.endTime = Date.now();
      this.data.sessions.push(this.activeSession);
      this.activeSession = null;
      await this._saveData();
    }

    // If the same game is somehow re-launched without an exit broadcast,
    // ignore the duplicate so we don't reset its startTime.
    if (this.activeSession && this.activeSession.appId === appIdStr) {
      return;
    }

    this.activeSession = {
      appId: appIdStr,
      gameName: resolvedName,
      startTime: Date.now(),
      endTime: null,
    };
    console.log(`[playtime] Game started: ${resolvedName} (${appIdStr})`);
    this.emit?.({
      event: "sessionUpdate",
      data: this._buildCurrentSession(),
    });
  }

  async handleGameExit(appId: number): Promise<void> {
    if (typeof appId !== "number" || !Number.isFinite(appId)) return;
    const appIdStr = String(appId);
    if (!this.activeSession || this.activeSession.appId !== appIdStr) {
      return;
    }
    console.log(`[playtime] Game ended: ${this.activeSession.gameName} (${appIdStr})`);
    this.activeSession.endTime = Date.now();
    this.data.sessions.push(this.activeSession);
    this.activeSession = null;
    await this._saveData();
    this.emit?.({
      event: "sessionUpdate",
      data: null,
    });
  }

  // --- Public RPC Methods ---

  /** Return playtime stats: today, this week, this month, all time, weekly breakdown. */
  async getStats(): Promise<Stats> {
    return computeStats(this.data.sessions, this.activeSession, Date.now());
  }

  /** Return recent game sessions, optionally filtered by appId. */
  async getGameSessions(appId?: string): Promise<GameSession[]> {
    let sessions = this.activeSession
      ? [...this.data.sessions, this.activeSession]
      : [...this.data.sessions];
    if (appId) {
      sessions = sessions.filter((s) => s.appId === appId);
    }
    // Return most recent 50 sessions
    return sessions.slice(-50).reverse();
  }

  /** Return the currently running game session, or null. */
  async getCurrentSession(): Promise<CurrentSession | null> {
    if (!this.activeSession) return null;
    return this._buildCurrentSession();
  }

  // --- Private Helpers ---

  private _buildCurrentSession(): CurrentSession {
    const s = this.activeSession!;
    return {
      appId: s.appId,
      gameName: s.gameName,
      startTime: s.startTime,
      elapsedMs: Date.now() - s.startTime,
    };
  }

  /** Load Steam app manifests to map appIds to game names. */
  private async _loadManifests(): Promise<void> {
    try {
      const entries = await readdir(this.steamAppsPath);
      for (const entry of entries) {
        if (!entry.startsWith("appmanifest_") || !entry.endsWith(".acf")) continue;
        try {
          const content = await readFile(join(this.steamAppsPath, entry), "utf-8");
          const appIdMatch = content.match(/"appid"\s+"(\d+)"/);
          const nameMatch = content.match(/"name"\s+"([^"]+)"/);
          if (appIdMatch && nameMatch) {
            this.appManifests.set(appIdMatch[1], nameMatch[1]);
          }
        } catch {
          // Skip unreadable manifests
        }
      }
      console.log(`[playtime] Loaded ${this.appManifests.size} game manifests`);
    } catch {
      console.warn("[playtime] Could not read Steam app manifests");
    }
  }

  /** Load persisted playtime data from disk. */
  private async _loadData(): Promise<void> {
    const loaded = await readPluginData<PlaytimeData>(this.dataPath, { sessions: [] });
    this.data = loaded;
    // Clean up: close any sessions that were left open (crash recovery)
    for (const s of this.data.sessions) {
      if (s.endTime === null) {
        s.endTime = s.startTime + 60_000; // Assume 1 minute for orphaned sessions
      }
    }
    console.log(`[playtime] Loaded ${this.data.sessions.length} historical sessions`);
  }

  /** Persist playtime data to disk. */
  private async _saveData(): Promise<void> {
    try {
      await writePluginData(this.dataPath, this.data);
    } catch (err) {
      console.warn("[playtime] Failed to save playtime data:", err);
    }
  }
}
