import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import type { EmitPayload } from "@loadout/types";

// Audit: use spyOn instead of mock.module to avoid module-mock leakage
// across backend specs in the single bun test process.
// See network-info/backend.test.ts for the same pattern.
import * as fsPromises from "node:fs/promises";
import * as steamPaths from "@loadout/steam-paths";
import PlaytimeBackend from "./backend";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeBackend() {
  const backend = new PlaytimeBackend();
  const emittedEvents: EmitPayload[] = [];
  backend.emit = (payload: EmitPayload) => {
    emittedEvents.push(payload);
  };
  return { backend, emittedEvents };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PlaytimeBackend", () => {
  let backend: InstanceType<typeof PlaytimeBackend>;
  let emittedEvents: EmitPayload[];

  // Per-test spy handles — created fresh each beforeEach, restored each afterEach.
  let readdirSpy: ReturnType<typeof spyOn>;
  let readFileSpy: ReturnType<typeof spyOn>;
  let mkdirSpy: ReturnType<typeof spyOn>;
  let writeFileSpy: ReturnType<typeof spyOn>;
  let renameSpy: ReturnType<typeof spyOn>;
  let getSteamAppsDirSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    // Spy on fs/promises methods to avoid mock.module leakage.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- readdir overloads require any
    readdirSpy = spyOn(fsPromises, "readdir").mockResolvedValue([] as any);
    readFileSpy = spyOn(fsPromises, "readFile").mockRejectedValue(new Error("ENOENT"));
    mkdirSpy = spyOn(fsPromises, "mkdir").mockResolvedValue(undefined as unknown as string);
    writeFileSpy = spyOn(fsPromises, "writeFile").mockResolvedValue(undefined);
    renameSpy = spyOn(fsPromises, "rename").mockResolvedValue(undefined);

    // Spy on getSteamAppsDir to avoid touching the real filesystem.
    getSteamAppsDirSpy = spyOn(steamPaths, "getSteamAppsDir").mockReturnValue("/fake/steamapps");

    // Default: no persisted data, no manifests.
    // readPluginData calls readFile; ENOENT triggers "use default".

    const r = makeBackend();
    backend = r.backend;
    emittedEvents = r.emittedEvents;

    await backend.onLoad();
  });

  afterEach(async () => {
    await backend.onUnload();

    // Restore all spies so the next beforeEach can re-spy cleanly.
    readdirSpy.mockRestore();
    readFileSpy.mockRestore();
    mkdirSpy.mockRestore();
    writeFileSpy.mockRestore();
    renameSpy.mockRestore();
    getSteamAppsDirSpy.mockRestore();
  });

  // ── Initial State ──────────────────────────────────────────────────────────

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

  // ── getStats ───────────────────────────────────────────────────────────────

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
      const oneHourAgo = now - 3_600_000;

      // Simulate stored JSON being returned by readFile.
      const sessions = [
        {
          appId: "12345",
          gameName: "Test Game",
          startTime: oneHourAgo,
          endTime: now - 1_800_000, // 30 min session
        },
        {
          appId: "12345",
          gameName: "Test Game",
          startTime: now - 1_200_000,
          endTime: now - 600_000, // 10 min session
        },
      ];
      readFileSpy.mockResolvedValue(JSON.stringify({ sessions }));

      await backend.onUnload();
      const r = makeBackend();
      backend = r.backend;
      emittedEvents = r.emittedEvents;
      await backend.onLoad();

      const stats = await backend.getStats();
      expect(stats.today.gamesPlayed).toBe(1); // Same game
      expect(stats.today.totalMs).toBeGreaterThan(0);
      expect(stats.today.games[0].appId).toBe("12345");
    });
  });

  // ── getGameSessions ────────────────────────────────────────────────────────

  describe("getGameSessions", () => {
    it("filters sessions by appId when provided", async () => {
      const now = Date.now();
      const sessions = [
        { appId: "111", gameName: "Game A", startTime: now - 7_200_000, endTime: now - 3_600_000 },
        { appId: "222", gameName: "Game B", startTime: now - 3_600_000, endTime: now - 1_800_000 },
        { appId: "111", gameName: "Game A", startTime: now - 1_800_000, endTime: now },
      ];
      readFileSpy.mockResolvedValue(JSON.stringify({ sessions }));

      await backend.onUnload();
      const r = makeBackend();
      backend = r.backend;
      emittedEvents = r.emittedEvents;
      await backend.onLoad();

      const allSessions = await backend.getGameSessions();
      expect(allSessions).toHaveLength(3);

      const gameASessions = await backend.getGameSessions("111");
      expect(gameASessions).toHaveLength(2);
      expect(gameASessions.every((s) => s.appId === "111")).toBe(true);
    });

    it("returns most recent sessions first (reversed)", async () => {
      const now = Date.now();
      const sessions = [
        { appId: "111", gameName: "Early", startTime: now - 7_200_000, endTime: now - 3_600_000 },
        { appId: "222", gameName: "Late", startTime: now - 1_000, endTime: now },
      ];
      readFileSpy.mockResolvedValue(JSON.stringify({ sessions }));

      await backend.onUnload();
      const r = makeBackend();
      backend = r.backend;
      emittedEvents = r.emittedEvents;
      await backend.onLoad();

      const fetched = await backend.getGameSessions();
      expect(fetched[0].gameName).toBe("Late");
      expect(fetched[1].gameName).toBe("Early");
    });
  });

  // ── Crash Recovery ─────────────────────────────────────────────────────────

  describe("crash recovery", () => {
    it("promotes a pendingActive snapshot into sessions on next load", async () => {
      // Simulate a crash mid-session: the heartbeat wrote pendingActive
      // with endTime = last-heartbeat (~50 min into a session) before
      // the process died. Recovery should turn that into a real session.
      const start = Date.now() - 3_600_000; // 60 min ago
      const heartbeatEnd = Date.now() - 600_000; // 10 min ago (last heartbeat)
      readFileSpy.mockResolvedValue(
        JSON.stringify({
          sessions: [],
          pendingActive: {
            appId: "999",
            gameName: "Crashed Game",
            startTime: start,
            endTime: heartbeatEnd,
          },
        }),
      );

      await backend.onUnload();
      const r = makeBackend();
      backend = r.backend;
      emittedEvents = r.emittedEvents;
      await backend.onLoad();

      const sessions = await backend.getGameSessions();
      expect(sessions).toHaveLength(1);
      // endTime is the last heartbeat — close enough to truth (≤60 s loss).
      expect(sessions[0].endTime).toBe(heartbeatEnd);
      expect(sessions[0].gameName).toBe("Crashed Game");
    });

    it("drops legacy endTime=null sessions instead of clamping them to 1 minute", async () => {
      // The previous schema set endTime=null while a session ran, and
      // _loadData used `startTime + 60_000` as a fake endTime, silently
      // truncating real hours-long sessions to a single minute. Now we
      // drop those instead so the historical log doesn't lie.
      const start = Date.now() - 86_400_000;
      readFileSpy.mockResolvedValue(
        JSON.stringify({
          sessions: [
            { appId: "999", gameName: "Old Schema", startTime: start, endTime: null },
          ],
        }),
      );

      await backend.onUnload();
      const r = makeBackend();
      backend = r.backend;
      emittedEvents = r.emittedEvents;
      await backend.onLoad();

      const sessions = await backend.getGameSessions();
      expect(sessions).toHaveLength(0);
    });

    it("seeds pendingActive on game launch so first 60 s of a crash isn't lost", async () => {
      await backend.handleGameLaunch(999, "Test Game");
      // The save was triggered synchronously inside handleGameLaunch.
      // Find the most recent writeFile call and inspect the persisted data.
      const writes = writeFileSpy.mock.calls;
      expect(writes.length).toBeGreaterThan(0);
      const lastWrite = writes[writes.length - 1];
      const persisted = JSON.parse(lastWrite[1] as string);
      expect(persisted.pendingActive).not.toBeNull();
      expect(persisted.pendingActive.appId).toBe("999");
      expect(persisted.pendingActive.endTime).toBeGreaterThan(0);
    });

    it("clears pendingActive on graceful game exit", async () => {
      await backend.handleGameLaunch(999, "Test Game");
      writeFileSpy.mockClear();
      await backend.handleGameExit(999);
      const writes = writeFileSpy.mock.calls;
      expect(writes.length).toBeGreaterThan(0);
      const lastWrite = writes[writes.length - 1];
      const persisted = JSON.parse(lastWrite[1] as string);
      expect(persisted.pendingActive).toBeNull();
      expect(persisted.sessions).toHaveLength(1);
    });
  });

  // ── Manifest Parsing ───────────────────────────────────────────────────────

  describe("manifest loading", () => {
    it("parses appmanifest files for game names", async () => {
      readdirSpy.mockImplementation(async (path: unknown) => {
        if (String(path).includes("steamapps")) {
          return ["appmanifest_12345.acf", "appmanifest_67890.acf", "somefile.txt"];
        }
        return [];
      });

      // readFile is called for both the data file and manifest files.
      // The data file path contains "loadout/plugins"; manifests contain "steamapps".
      readFileSpy.mockImplementation(async (path: unknown) => {
        const p = String(path);
        if (p.includes("12345") && p.includes("steamapps")) {
          return '"AppState"\n{\n\t"appid"\t\t"12345"\n\t"name"\t\t"Portal 2"\n}';
        }
        if (p.includes("67890") && p.includes("steamapps")) {
          return '"AppState"\n{\n\t"appid"\t\t"67890"\n\t"name"\t\t"Half-Life 2"\n}';
        }
        throw new Error("ENOENT");
      });

      await backend.onUnload();
      const r = makeBackend();
      backend = r.backend;
      emittedEvents = r.emittedEvents;
      await backend.onLoad();

      await backend.handleGameLaunch(67890, "");
      const session = await backend.getCurrentSession();
      expect(session?.gameName).toBe("Half-Life 2");
    });

    it("handles unreadable manifest files gracefully", async () => {
      readdirSpy.mockImplementation(async (path: unknown) => {
        if (String(path).includes("steamapps")) return ["appmanifest_broken.acf"];
        return [];
      });
      // All readFile calls throw
      readFileSpy.mockRejectedValue(new Error("Permission denied"));

      await backend.onUnload();
      const r = makeBackend();
      backend = r.backend;
      emittedEvents = r.emittedEvents;
      await expect(backend.onLoad()).resolves.toBeUndefined();
    });
  });

  // ── Game-detection Broadcasts ──────────────────────────────────────────────

  describe("handleGameLaunch / handleGameExit", () => {
    it("starts a session when a launch broadcast arrives", async () => {
      await backend.handleGameLaunch(730, "Counter-Strike 2");

      const session = await backend.getCurrentSession();
      expect(session).not.toBeNull();
      expect(session?.appId).toBe("730");
      expect(session?.gameName).toBe("Counter-Strike 2");
      expect(session?.elapsedMs).toBeGreaterThanOrEqual(0);

      const updateEvents = emittedEvents.filter((e) => e.event === "sessionUpdate");
      expect(updateEvents.length).toBeGreaterThanOrEqual(1);
      const last = updateEvents[updateEvents.length - 1];
      expect(last.data).not.toBeNull();
      expect((last.data as { appId: string }).appId).toBe("730");
    });

    it("ends the session and persists it on exit broadcast", async () => {
      await backend.handleGameLaunch(730, "CS2");
      writeFileSpy.mockClear();
      await backend.handleGameExit(730);

      const session = await backend.getCurrentSession();
      expect(session).toBeNull();

      // writePluginData → writeFile + rename; at minimum writeFile was called.
      expect(writeFileSpy).toHaveBeenCalled();

      const updateEvents = emittedEvents.filter((e) => e.event === "sessionUpdate");
      expect(updateEvents[updateEvents.length - 1].data).toBeNull();

      const sessions = await backend.getGameSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].appId).toBe("730");
      expect(sessions[0].endTime).not.toBeNull();
    });

    it("ignores duplicate launches for the same appId", async () => {
      await backend.handleGameLaunch(440, "Team Fortress 2");
      const first = await backend.getCurrentSession();
      const firstStart = first?.startTime;

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
      const tf2 = sessions.find((s) => s.appId === "440");
      expect(tf2).toBeDefined();
      expect(tf2?.endTime).not.toBeNull();
    });

    it("ignores exit broadcasts for an inactive appId", async () => {
      await backend.handleGameLaunch(730, "CS2");
      writeFileSpy.mockClear();
      await backend.handleGameExit(440); // never launched

      const session = await backend.getCurrentSession();
      expect(session?.appId).toBe("730");
      expect(writeFileSpy).not.toHaveBeenCalled();
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
      readdirSpy.mockImplementation(async (path: unknown) =>
        String(path).includes("steamapps") ? ["appmanifest_12345.acf"] : [],
      );
      readFileSpy.mockImplementation(async (path: unknown) => {
        if (String(path).includes("steamapps")) {
          return '"AppState"\n{\n\t"appid"\t\t"12345"\n\t"name"\t\t"Portal 2"\n}';
        }
        throw new Error("ENOENT");
      });

      await backend.onUnload();
      const r = makeBackend();
      backend = r.backend;
      emittedEvents = r.emittedEvents;
      await backend.onLoad();

      await backend.handleGameLaunch(12345, "");
      const session = await backend.getCurrentSession();
      expect(session?.gameName).toBe("Portal 2");
    });

    it("falls back to 'Steam App <id>' label when no manifest is loaded", async () => {
      await backend.handleGameLaunch(999999, "");
      const session = await backend.getCurrentSession();
      expect(session?.gameName).toBe("Steam App 999999");
    });
  });

  // ── onUnload ───────────────────────────────────────────────────────────────

  describe("onUnload", () => {
    it("does not throw with no active session", async () => {
      await expect(backend.onUnload()).resolves.toBeUndefined();
    });

    it("persists an active session on unload", async () => {
      await backend.handleGameLaunch(730, "CS2");
      writeFileSpy.mockClear();
      await backend.onUnload();
      expect(writeFileSpy).toHaveBeenCalled();
    });
  });
});
