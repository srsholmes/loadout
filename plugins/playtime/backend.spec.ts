import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import type { EmitPayload } from "@loadout/types";
import PlaytimeBackend from "./backend";

// ── Mock modules ─────────────────────────────────────────────────

const mockReaddir = mock(() => Promise.resolve([] as string[]));
const mockReadFile = mock(() => Promise.resolve(""));
const mockMkdir = mock(() => Promise.resolve(undefined as unknown as string));

mock.module("node:fs/promises", () => ({
  readdir: mockReaddir,
  readFile: mockReadFile,
  mkdir: mockMkdir,
}));

mock.module("@loadout/steam-paths", () => ({
  getSteamAppsDir: () => "/fake/steamapps",
}));

// Mock Bun.file for playtime data persistence
const mockFileExists = mock(() => Promise.resolve(false));
const mockFileJson = mock(() => Promise.resolve({ sessions: [] }));
const originalBunFile = Bun.file;
const originalBunWrite = Bun.write;

const mockBunWrite = mock(() => Promise.resolve(0));

describe("PlaytimeBackend", () => {
  let backend: PlaytimeBackend;
  let emittedEvents: EmitPayload[];

  beforeEach(async () => {
    mockReaddir.mockReset();
    mockReadFile.mockReset();
    mockMkdir.mockReset();
    mockFileExists.mockReset();
    mockFileJson.mockReset();
    mockBunWrite.mockClear();

    // Default: no persisted data, no manifests
    mockFileExists.mockImplementation(() => Promise.resolve(false));
    mockReaddir.mockResolvedValue([]);

    // @ts-expect-error -- mock
    Bun.file = mock(() => ({
      exists: mockFileExists,
      json: mockFileJson,
    }));
    // @ts-expect-error -- mock
    Bun.write = mockBunWrite;

    backend = new PlaytimeBackend();
    emittedEvents = [];
    backend.emit = (payload: EmitPayload) => {
      emittedEvents.push(payload);
    };

    // onLoad sets a 30s emit interval; afterEach clears it via onUnload.
    await backend.onLoad();
  });

  afterEach(async () => {
    await backend.onUnload();
    Bun.file = originalBunFile;
    // @ts-expect-error -- restore
    Bun.write = originalBunWrite;
  });

  // ── Initial State ────────────────────────────────────────────

  describe("initial state", () => {
    it("starts with no active session", async () => {
      const session = await backend.getCurrentSession();
      expect(session).toBeNull();
    });

    it("starts with empty stats", async () => {
      const stats = await backend.getStats();
      expect(stats.allTime.totalMs).toBe(0);
      expect(stats.allTime.gamesPlayed).toBe(0);
      expect(stats.allTime.games).toEqual([]);
    });

    it("starts with empty game sessions list", async () => {
      const sessions = await backend.getGameSessions();
      expect(sessions).toEqual([]);
    });
  });

  // ── Stats Aggregation ────────────────────────────────────────

  describe("getStats", () => {
    it("returns today, week, month, allTime, and weeklyBreakdown", async () => {
      const stats = await backend.getStats();
      expect(stats).toHaveProperty("today");
      expect(stats).toHaveProperty("week");
      expect(stats).toHaveProperty("month");
      expect(stats).toHaveProperty("allTime");
      expect(stats).toHaveProperty("weeklyBreakdown");
    });

    it("weeklyBreakdown has 7 days", async () => {
      const stats = await backend.getStats();
      expect(stats.weeklyBreakdown).toHaveLength(7);
      for (const day of stats.weeklyBreakdown) {
        expect(day).toHaveProperty("day");
        expect(day).toHaveProperty("totalMs");
      }
    });

    it("aggregates persisted session data correctly", async () => {
      const now = Date.now();
      const oneHourAgo = now - 3600_000;

      // Load backend with persisted sessions
      mockFileExists.mockImplementation(() => Promise.resolve(true));
      mockFileJson.mockImplementation(() =>
        Promise.resolve({
          sessions: [
            {
              appId: "12345",
              gameName: "Test Game",
              startTime: oneHourAgo,
              endTime: now - 1800_000, // 30 min session
            },
            {
              appId: "12345",
              gameName: "Test Game",
              startTime: now - 1200_000,
              endTime: now - 600_000, // 10 min session
            },
          ],
        }),
      );

      // Re-create backend with data
      await backend.onUnload();
      backend = new PlaytimeBackend();
      backend.emit = (payload: EmitPayload) => { emittedEvents.push(payload); };
      await backend.onLoad();

      const stats = await backend.getStats();
      expect(stats.today.gamesPlayed).toBe(1); // Same game
      expect(stats.today.totalMs).toBeGreaterThan(0);
      expect(stats.today.games[0].appId).toBe("12345");
    });
  });

  // ── getGameSessions ──────────────────────────────────────────

  describe("getGameSessions", () => {
    it("filters sessions by appId when provided", async () => {
      const now = Date.now();

      mockFileExists.mockImplementation(() => Promise.resolve(true));
      mockFileJson.mockImplementation(() =>
        Promise.resolve({
          sessions: [
            { appId: "111", gameName: "Game A", startTime: now - 7200_000, endTime: now - 3600_000 },
            { appId: "222", gameName: "Game B", startTime: now - 3600_000, endTime: now - 1800_000 },
            { appId: "111", gameName: "Game A", startTime: now - 1800_000, endTime: now },
          ],
        }),
      );

      await backend.onUnload();
      backend = new PlaytimeBackend();
      backend.emit = (payload: EmitPayload) => { emittedEvents.push(payload); };
      await backend.onLoad();

      const allSessions = await backend.getGameSessions();
      expect(allSessions).toHaveLength(3);

      const gameASessions = await backend.getGameSessions("111");
      expect(gameASessions).toHaveLength(2);
      expect(gameASessions.every((s) => s.appId === "111")).toBe(true);
    });

    it("returns most recent sessions first (reversed)", async () => {
      const now = Date.now();

      mockFileExists.mockImplementation(() => Promise.resolve(true));
      mockFileJson.mockImplementation(() =>
        Promise.resolve({
          sessions: [
            { appId: "111", gameName: "Early", startTime: now - 7200_000, endTime: now - 3600_000 },
            { appId: "222", gameName: "Late", startTime: now - 1000, endTime: now },
          ],
        }),
      );

      await backend.onUnload();
      backend = new PlaytimeBackend();
      backend.emit = (payload: EmitPayload) => { emittedEvents.push(payload); };
      await backend.onLoad();

      const sessions = await backend.getGameSessions();
      expect(sessions[0].gameName).toBe("Late");
      expect(sessions[1].gameName).toBe("Early");
    });
  });

  // ── Crash Recovery ───────────────────────────────────────────

  describe("crash recovery", () => {
    it("closes orphaned sessions with 1-minute assumed duration", async () => {
      const now = Date.now();
      const orphanStart = now - 86400_000; // started 24h ago

      mockFileExists.mockImplementation(() => Promise.resolve(true));
      mockFileJson.mockImplementation(() =>
        Promise.resolve({
          sessions: [
            {
              appId: "999",
              gameName: "Crashed Game",
              startTime: orphanStart,
              endTime: null, // orphaned!
            },
          ],
        }),
      );

      await backend.onUnload();
      backend = new PlaytimeBackend();
      backend.emit = (payload: EmitPayload) => { emittedEvents.push(payload); };
      await backend.onLoad();

      const sessions = await backend.getGameSessions();
      expect(sessions).toHaveLength(1);
      // endTime should be startTime + 60_000 (1 minute)
      expect(sessions[0].endTime).toBe(orphanStart + 60_000);
    });
  });

  // ── Manifest Parsing ─────────────────────────────────────────

  describe("manifest loading", () => {
    it("parses appmanifest files for game names", async () => {
      mockReaddir.mockImplementation(async (path: unknown) => {
        const pathStr = String(path);
        if (pathStr.includes("steamapps")) {
          return ["appmanifest_12345.acf", "appmanifest_67890.acf", "somefile.txt"];
        }
        return [];
      });

      mockReadFile.mockImplementation(async (path: unknown) => {
        const pathStr = String(path);
        if (pathStr.includes("12345")) {
          return '"AppState"\n{\n\t"appid"\t\t"12345"\n\t"name"\t\t"Portal 2"\n}';
        }
        if (pathStr.includes("67890")) {
          return '"AppState"\n{\n\t"appid"\t\t"67890"\n\t"name"\t\t"Half-Life 2"\n}';
        }
        return "";
      });

      // Re-create to trigger manifest loading
      await backend.onUnload();
      backend = new PlaytimeBackend();
      backend.emit = (payload: EmitPayload) => { emittedEvents.push(payload); };
      await backend.onLoad();

      // Manifests are loaded; verified indirectly via handleGameLaunch
      // resolving the manifest name when none is provided.
      await backend.handleGameLaunch(67890, "");
      const session = await backend.getCurrentSession();
      expect(session?.gameName).toBe("Half-Life 2");
    });

    it("handles unreadable manifest files gracefully", async () => {
      mockReaddir.mockImplementation(async (path: unknown) => {
        const pathStr = String(path);
        if (pathStr.includes("steamapps")) {
          return ["appmanifest_broken.acf"];
        }
        return [];
      });

      mockReadFile.mockRejectedValue(new Error("Permission denied"));

      await backend.onUnload();
      backend = new PlaytimeBackend();
      backend.emit = (payload: EmitPayload) => { emittedEvents.push(payload); };

      // Should not throw
      await expect(backend.onLoad()).resolves.toBeUndefined();
    });
  });

  // ── Game-detection Broadcasts ────────────────────────────────

  describe("handleGameLaunch / handleGameExit", () => {
    it("starts a session when a launch broadcast arrives", async () => {
      await backend.handleGameLaunch(730, "Counter-Strike 2");

      const session = await backend.getCurrentSession();
      expect(session).not.toBeNull();
      expect(session?.appId).toBe("730");
      expect(session?.gameName).toBe("Counter-Strike 2");
      expect(session?.elapsedMs).toBeGreaterThanOrEqual(0);

      // It should have emitted a sessionUpdate with the new session.
      const updateEvents = emittedEvents.filter((e) => e.event === "sessionUpdate");
      expect(updateEvents.length).toBeGreaterThanOrEqual(1);
      const last = updateEvents[updateEvents.length - 1];
      expect(last.data).not.toBeNull();
      expect((last.data as { appId: string }).appId).toBe("730");
    });

    it("ends the session and persists it on exit broadcast", async () => {
      await backend.handleGameLaunch(730, "CS2");
      mockBunWrite.mockClear();
      await backend.handleGameExit(730);

      const session = await backend.getCurrentSession();
      expect(session).toBeNull();

      // The active session should have been persisted.
      expect(mockBunWrite).toHaveBeenCalled();

      // Final emit should be a null sessionUpdate.
      const updateEvents = emittedEvents.filter((e) => e.event === "sessionUpdate");
      expect(updateEvents[updateEvents.length - 1].data).toBeNull();

      // The session should now appear in history.
      const sessions = await backend.getGameSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].appId).toBe("730");
      expect(sessions[0].endTime).not.toBeNull();
    });

    it("ignores duplicate launches for the same appId", async () => {
      await backend.handleGameLaunch(440, "Team Fortress 2");
      const first = await backend.getCurrentSession();
      const firstStart = first?.startTime;

      // Wait a tick so a re-launched session's startTime would differ.
      await new Promise((resolve) => setTimeout(resolve, 5));

      await backend.handleGameLaunch(440, "Team Fortress 2");
      const second = await backend.getCurrentSession();
      expect(second?.startTime).toBe(firstStart!);
    });

    it("closes the previous session when a different game launches", async () => {
      await backend.handleGameLaunch(440, "Team Fortress 2");
      await backend.handleGameLaunch(730, "Counter-Strike 2");

      const session = await backend.getCurrentSession();
      expect(session?.appId).toBe("730");

      const sessions = await backend.getGameSessions();
      // The first game should have been closed and persisted; the second
      // is still active (also returned by getAllSessions).
      const tf2 = sessions.find((s) => s.appId === "440");
      expect(tf2).toBeDefined();
      expect(tf2?.endTime).not.toBeNull();
    });

    it("ignores exit broadcasts for an inactive appId", async () => {
      await backend.handleGameLaunch(730, "CS2");
      mockBunWrite.mockClear();
      await backend.handleGameExit(440); // never launched

      const session = await backend.getCurrentSession();
      expect(session?.appId).toBe("730");
      // No persist should have happened for the bogus exit.
      expect(mockBunWrite).not.toHaveBeenCalled();
    });

    it("ignores non-finite appIds on launch and exit", async () => {
      await backend.handleGameLaunch(Number.NaN, "Garbage");
      expect(await backend.getCurrentSession()).toBeNull();

      await backend.handleGameLaunch(730, "CS2");
      await backend.handleGameExit(Number.NaN);
      // Still active because the NaN exit was ignored.
      expect(await backend.getCurrentSession()).not.toBeNull();
    });

    it("falls back to the manifest name when the broadcast omits one", async () => {
      mockReaddir.mockImplementation(async (path: unknown) =>
        String(path).includes("steamapps") ? ["appmanifest_12345.acf"] : [],
      );
      mockReadFile.mockImplementation(async () =>
        '"AppState"\n{\n\t"appid"\t\t"12345"\n\t"name"\t\t"Portal 2"\n}',
      );

      await backend.onUnload();
      backend = new PlaytimeBackend();
      backend.emit = (payload: EmitPayload) => { emittedEvents.push(payload); };
      await backend.onLoad();

      await backend.handleGameLaunch(12345, "");
      const session = await backend.getCurrentSession();
      expect(session?.gameName).toBe("Portal 2");
    });

    it("falls back to a 'Steam App <id>' label when no manifest is loaded", async () => {
      await backend.handleGameLaunch(999999, "");
      const session = await backend.getCurrentSession();
      expect(session?.gameName).toBe("Steam App 999999");
    });
  });

  // ── onUnload ─────────────────────────────────────────────────

  describe("onUnload", () => {
    it("does not throw with no active session", async () => {
      await expect(backend.onUnload()).resolves.toBeUndefined();
    });

    it("persists an active session on unload", async () => {
      await backend.handleGameLaunch(730, "CS2");
      mockBunWrite.mockClear();
      await backend.onUnload();
      expect(mockBunWrite).toHaveBeenCalled();
    });
  });
});
