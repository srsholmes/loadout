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
  /**
   * Heartbeat that snapshots `activeSession` to disk every 60 s so a
   * crash mid-session doesn't lose the whole thing. Previously we only
   * persisted on game-exit, so any crash truncated the session to
   * "never happened" — and the historical orphan-recovery path used a
   * fake 1-minute clamp that silently lied about real session length.
   */
  private heartbeatInterval?: Timer;
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

    // Heartbeat: persist an `activeSession` snapshot to `pendingActive`
    // every 60 s so a crash mid-session loses at most ~60 s of play
    // time. The UI keeps its own 1 s local tick for the elapsed counter
    // so we don't need a sessionUpdate emit on this cadence — emits
    // only fire on session boundaries (start / exit).
    this.heartbeatInterval = setInterval(() => {
      this._heartbeat().catch((err) =>
        console.warn("[playtime] Heartbeat failed:", err),
      );
    }, 60_000);

    console.log("[playtime] Plugin loaded, awaiting game-detection broadcasts");
  }

  async onUnload(): Promise<void> {
    clearInterval(this.heartbeatInterval);

    if (this.activeSession) {
      this.activeSession.endTime = Date.now();
      this.data.sessions.push(this.activeSession);
      this.activeSession = null;
      this.data.pendingActive = null;
      await this._saveData();
    }

    console.log("[playtime] Plugin unloaded");
  }

  private async _heartbeat(): Promise<void> {
    if (!this.activeSession) return;
    // Don't mutate activeSession.endTime (it stays null in-memory to
    // mark "still running"); snapshot a finalised copy into the file.
    this.data.pendingActive = {
      ...this.activeSession,
      endTime: Date.now(),
    };
    await this._saveData();
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
      this.data.pendingActive = null;
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
    // First snapshot for crash recovery — without this a crash within
    // the first 60 s (before the heartbeat fires) loses the session
    // entirely.
    this.data.pendingActive = {
      ...this.activeSession,
      endTime: Date.now(),
    };
    await this._saveData();
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
    this.data.pendingActive = null;
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
      // Parallelise the per-manifest reads — sequential awaits add up on
      // spinning rust or slow USB SD cards.
      const results = await Promise.all(
        entries
          .filter((e) => e.startsWith("appmanifest_") && e.endsWith(".acf"))
          .map(async (entry) => {
            try {
              const content = await readFile(
                join(this.steamAppsPath, entry),
                "utf-8",
              );
              const appIdMatch = content.match(/"appid"\s+"(\d+)"/);
              const nameMatch = content.match(/"name"\s+"([^"]+)"/);
              return appIdMatch && nameMatch
                ? ([appIdMatch[1], nameMatch[1]] as const)
                : null;
            } catch {
              return null;
            }
          }),
      );
      for (const pair of results) {
        if (pair) this.appManifests.set(pair[0], pair[1]);
      }
      console.log(`[playtime] Loaded ${this.appManifests.size} game manifests`);
    } catch {
      console.warn("[playtime] Could not read Steam app manifests");
    }
  }

  /** Load persisted playtime data from disk. */
  private async _loadData(): Promise<void> {
    const loaded = await readPluginData<PlaytimeData>(this.dataPath, {
      sessions: [],
    });
    this.data = loaded;

    // Crash recovery: a `pendingActive` snapshot is an orphan from a
    // backend crash mid-session. Its endTime is from the last heartbeat
    // (≤ 60 s before the crash), so it's a close approximation of when
    // the user actually stopped. Promote it into `sessions` and clear.
    if (this.data.pendingActive) {
      console.log(
        `[playtime] Recovered orphaned session: ${this.data.pendingActive.gameName} ` +
          `(${this.data.pendingActive.appId}, ` +
          `${Math.round(((this.data.pendingActive.endTime ?? this.data.pendingActive.startTime) - this.data.pendingActive.startTime) / 60_000)}m)`,
      );
      this.data.sessions.push(this.data.pendingActive);
      this.data.pendingActive = null;
    }

    // Defensive: drop anything with endTime=null from older data. The
    // previous schema's 1-minute clamp silently lied; better to drop
    // these than carry the wrong number forward.
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter((s) => s.endTime !== null);
    if (this.data.sessions.length !== before) {
      console.warn(
        `[playtime] Dropped ${before - this.data.sessions.length} legacy null-endTime session(s)`,
      );
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
