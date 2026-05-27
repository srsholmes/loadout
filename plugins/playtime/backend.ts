import type { PluginBackend, EmitPayload } from "@loadout/types";
import { getSteamAppsDir } from "@loadout/steam-paths";
import { readdir, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// --- Types ---

interface GameSession {
  appId: string;
  gameName: string;
  startTime: number; // epoch ms
  endTime: number | null; // null = still running
}

interface PlaytimeData {
  sessions: GameSession[];
}

interface GameStats {
  appId: string;
  gameName: string;
  totalMs: number;
}

interface Stats {
  today: { totalMs: number; gamesPlayed: number; games: GameStats[] };
  week: { totalMs: number; gamesPlayed: number; games: GameStats[] };
  month: { totalMs: number; gamesPlayed: number; games: GameStats[] };
  allTime: { totalMs: number; gamesPlayed: number; games: GameStats[] };
  weeklyBreakdown: { day: string; totalMs: number }[];
}

interface CurrentSession {
  appId: string;
  gameName: string;
  startTime: number;
  elapsedMs: number;
}

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
 * Persists playtime data to a JSON file.
 */
export default class PlaytimeBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;

  private dataPath: string;
  private steamAppsPath: string;
  private data: PlaytimeData = { sessions: [] };
  private appManifests = new Map<string, string>(); // appId -> game name
  private emitInterval?: Timer;
  private activeSession: GameSession | null = null;

  constructor() {
    const home = homedir();
    this.dataPath = join(home, ".config", "loadout", "playtime.json");
    this.steamAppsPath = getSteamAppsDir();
  }

  async onLoad(): Promise<void> {
    console.log("[playtime] Plugin loading");

    // Ensure config directory exists
    const configDir = join(homedir(), ".config", "loadout");
    await mkdir(configDir, { recursive: true });

    // Load persisted data
    await this.loadData();

    // Load Steam app manifests for game name lookups
    await this.loadManifests();

    // Emit sessionUpdate events every 30 seconds when a game is running
    // so the overlay's elapsed-time counter stays fresh without polling.
    this.emitInterval = setInterval(() => {
      if (this.activeSession) {
        this.emit?.({
          event: "sessionUpdate",
          data: this.buildCurrentSession(),
        });
      }
    }, 30_000);

    console.log(
      "[playtime] Plugin loaded, awaiting game-detection broadcasts",
    );
  }

  async onUnload(): Promise<void> {
    clearInterval(this.emitInterval);

    // End any active session
    if (this.activeSession) {
      this.activeSession.endTime = Date.now();
      this.data.sessions.push(this.activeSession);
      this.activeSession = null;
      await this.saveData();
    }

    console.log("[playtime] Plugin unloaded");
  }

  // --- Game-detection broadcast hooks ---
  // The loader's GameDetectionService fans out `handleGameLaunch` /
  // `handleGameExit` to every plugin instance that implements them.
  // We use this in place of polling the process list for active games.

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
      await this.saveData();
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
      data: this.buildCurrentSession(),
    });
  }

  async handleGameExit(appId: number): Promise<void> {
    if (typeof appId !== "number" || !Number.isFinite(appId)) return;
    const appIdStr = String(appId);
    if (!this.activeSession || this.activeSession.appId !== appIdStr) {
      return;
    }
    console.log(
      `[playtime] Game ended: ${this.activeSession.gameName} (${appIdStr})`,
    );
    this.activeSession.endTime = Date.now();
    this.data.sessions.push(this.activeSession);
    this.activeSession = null;
    await this.saveData();
    this.emit?.({
      event: "sessionUpdate",
      data: null,
    });
  }

  // --- Public RPC Methods ---

  /** Return playtime stats: today, this week, this month, all time, weekly breakdown. */
  async getStats(): Promise<Stats> {
    const now = Date.now();
    const todayStart = startOfDay(now);
    const weekStart = startOfWeek(now);
    const monthStart = startOfMonth(now);

    const allSessions = this.getAllSessions();

    const todaySessions = allSessions.filter((s) => s.startTime >= todayStart || (s.endTime !== null && s.endTime >= todayStart));
    const weekSessions = allSessions.filter((s) => s.startTime >= weekStart || (s.endTime !== null && s.endTime >= weekStart));
    const monthSessions = allSessions.filter((s) => s.startTime >= monthStart || (s.endTime !== null && s.endTime >= monthStart));

    return {
      today: this.aggregateSessions(todaySessions, todayStart),
      week: this.aggregateSessions(weekSessions, weekStart),
      month: this.aggregateSessions(monthSessions, monthStart),
      allTime: this.aggregateSessions(allSessions, 0),
      weeklyBreakdown: this.getWeeklyBreakdown(now),
    };
  }

  /** Return recent game sessions, optionally filtered by appId. */
  async getGameSessions(appId?: string): Promise<GameSession[]> {
    let sessions = this.getAllSessions();
    if (appId) {
      sessions = sessions.filter((s) => s.appId === appId);
    }
    // Return most recent 50 sessions
    return sessions.slice(-50).reverse();
  }

  /** Return the currently running game session, or null. */
  async getCurrentSession(): Promise<CurrentSession | null> {
    if (!this.activeSession) return null;
    return this.buildCurrentSession();
  }

  // --- Private Helpers ---

  private buildCurrentSession(): CurrentSession {
    const s = this.activeSession!;
    return {
      appId: s.appId,
      gameName: s.gameName,
      startTime: s.startTime,
      elapsedMs: Date.now() - s.startTime,
    };
  }

  private getAllSessions(): GameSession[] {
    const sessions = [...this.data.sessions];
    if (this.activeSession) {
      sessions.push(this.activeSession);
    }
    return sessions;
  }

  private aggregateSessions(
    sessions: GameSession[],
    periodStart: number,
  ): { totalMs: number; gamesPlayed: number; games: GameStats[] } {
    const gameMap = new Map<string, GameStats>();
    const now = Date.now();

    for (const s of sessions) {
      const start = Math.max(s.startTime, periodStart);
      const end = s.endTime ?? now;
      const duration = Math.max(0, end - start);

      const existing = gameMap.get(s.appId);
      if (existing) {
        existing.totalMs += duration;
      } else {
        gameMap.set(s.appId, {
          appId: s.appId,
          gameName: s.gameName,
          totalMs: duration,
        });
      }
    }

    const games = Array.from(gameMap.values()).sort((a, b) => b.totalMs - a.totalMs);
    const totalMs = games.reduce((sum, g) => sum + g.totalMs, 0);

    return {
      totalMs,
      gamesPlayed: games.length,
      games,
    };
  }

  private getWeeklyBreakdown(now: number): { day: string; totalMs: number }[] {
    const days: { day: string; totalMs: number }[] = [];
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    for (let i = 6; i >= 0; i--) {
      const dayStart = startOfDay(now - i * 86_400_000);
      const dayEnd = dayStart + 86_400_000;
      const date = new Date(dayStart);
      const dayLabel = dayNames[date.getDay()];

      let totalMs = 0;
      for (const s of this.getAllSessions()) {
        const sEnd = s.endTime ?? now;
        if (sEnd < dayStart || s.startTime >= dayEnd) continue;
        const start = Math.max(s.startTime, dayStart);
        const end = Math.min(sEnd, dayEnd);
        totalMs += Math.max(0, end - start);
      }

      days.push({ day: dayLabel, totalMs });
    }

    return days;
  }

  /** Load Steam app manifests to map appIds to game names. */
  private async loadManifests(): Promise<void> {
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
  private async loadData(): Promise<void> {
    try {
      const file = Bun.file(this.dataPath);
      if (await file.exists()) {
        this.data = (await file.json()) as PlaytimeData;
        // Clean up: close any sessions that were left open (crash recovery)
        for (const s of this.data.sessions) {
          if (s.endTime === null) {
            s.endTime = s.startTime + 60_000; // Assume 1 minute for orphaned sessions
          }
        }
        console.log(`[playtime] Loaded ${this.data.sessions.length} historical sessions`);
      }
    } catch {
      console.warn("[playtime] Could not load playtime data, starting fresh");
      this.data = { sessions: [] };
    }
  }

  /** Persist playtime data to disk. */
  private async saveData(): Promise<void> {
    try {
      await Bun.write(this.dataPath, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.warn("[playtime] Failed to save playtime data:", err);
    }
  }
}

// --- Date Helpers ---

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfWeek(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  // Week starts on Monday
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return d.getTime();
}

function startOfMonth(ts: number): number {
  const d = new Date(ts);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
