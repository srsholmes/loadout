import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import type { EmitPayload } from "@loadout/types";
import MusicPlayerBackend from "./backend";

// ── Mock fs/promises ─────────────────────────────────────────────

const mockReaddir = mock(() => Promise.resolve([] as string[]));
const mockMkdir = mock(() => Promise.resolve(undefined as unknown as string));
const mockUnlink = mock(() => Promise.resolve());
const mockReadFile = mock(() => Promise.resolve("{}"));
const mockWriteFile = mock(() => Promise.resolve());

mock.module("fs/promises", () => ({
  readdir: mockReaddir,
  mkdir: mockMkdir,
  unlink: mockUnlink,
  readFile: mockReadFile,
  writeFile: mockWriteFile,
}));

// Mock Bun.spawn so we never launch a real mpv process
const mockSpawnKill = mock(() => {});
const mockSpawn = mock(() => ({
  kill: mockSpawnKill,
  exitCode: 0,
  exited: Promise.resolve(0),
  pid: 9999,
  stdout: null,
  stderr: null,
}));

const mockConnect = mock(() => Promise.reject(new Error("no socket")));

const originalSpawn = Bun.spawn;
const originalConnect = Bun.connect;

describe("MusicPlayerBackend", () => {
  let backend: MusicPlayerBackend;
  let emittedEvents: EmitPayload[];

  beforeEach(async () => {
    mockReaddir.mockReset();
    mockMkdir.mockReset();
    mockUnlink.mockReset();
    mockReadFile.mockReset();
    mockWriteFile.mockReset();
    mockSpawn.mockClear();
    mockSpawnKill.mockClear();
    mockConnect.mockClear();

    // Default: no preferences file (throws), empty music dir
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    mockReaddir.mockResolvedValue([]);

    // @ts-expect-error -- mock
    Bun.spawn = mockSpawn;
    // @ts-expect-error -- mock
    Bun.connect = mockConnect;

    backend = new MusicPlayerBackend();
    emittedEvents = [];
    backend.emit = (payload: EmitPayload) => {
      emittedEvents.push(payload);
    };

    // Call onLoad to initialize
    await backend.onLoad();
  });

  afterEach(async () => {
    await backend.onUnload();
    Bun.spawn = originalSpawn;
    // @ts-expect-error -- restore
    Bun.connect = originalConnect;
  });

  // ── Initial State ────────────────────────────────────────────

  describe("initial state", () => {
    it("starts with no track playing", async () => {
      const status = await backend.getStatus();
      expect(status.currentTrack).toBeNull();
      expect(status.playing).toBe(false);
      expect(status.paused).toBe(false);
      expect(status.trackIndex).toBe(-1);
    });

    it("defaults to 80% volume", async () => {
      const status = await backend.getStatus();
      expect(status.volume).toBe(80);
    });
  });

  // ── Track Scanning ───────────────────────────────────────────

  describe("getTracks", () => {
    it("returns only audio files sorted alphabetically", async () => {
      mockReaddir.mockResolvedValueOnce([
        "c-song.mp3",
        "a-song.flac",
        "readme.txt",
        "b-song.ogg",
        "cover.png",
        "track.wav",
      ]);

      const tracks = await backend.getTracks();
      expect(tracks).toEqual(["a-song.flac", "b-song.ogg", "c-song.mp3", "track.wav"]);
    });

    it("returns empty array when music dir is missing", async () => {
      mockReaddir.mockRejectedValueOnce(new Error("ENOENT"));
      const tracks = await backend.getTracks();
      expect(tracks).toEqual([]);
    });

    it("filters by supported extensions (.mp3, .ogg, .wav, .flac)", async () => {
      mockReaddir.mockResolvedValueOnce([
        "song.mp3",
        "song.ogg",
        "song.wav",
        "song.flac",
        "song.aac",
        "song.m4a",
        "song.wma",
      ]);

      const tracks = await backend.getTracks();
      expect(tracks).toHaveLength(4);
    });
  });

  // ── Playback ─────────────────────────────────────────────────

  describe("play", () => {
    it("throws when track is not in the track list", async () => {
      mockReaddir.mockResolvedValueOnce(["song.mp3"]);
      await backend.getTracks();

      expect(backend.play("nonexistent.mp3")).rejects.toThrow("Track not found");
    });

    it("spawns mpv and updates state on play", async () => {
      mockReaddir.mockResolvedValueOnce(["alpha.mp3", "beta.ogg"]);
      await backend.getTracks();

      await backend.play("alpha.mp3");

      expect(mockSpawn).toHaveBeenCalledTimes(1);

      const status = await backend.getStatus();
      expect(status.playing).toBe(true);
      expect(status.paused).toBe(false);
      expect(status.currentTrack).toBe("alpha.mp3");
      expect(status.trackIndex).toBe(0);
    });

    it("emits playbackUpdate on play", async () => {
      mockReaddir.mockResolvedValueOnce(["song.mp3"]);
      await backend.getTracks();
      emittedEvents = [];

      await backend.play("song.mp3");

      const playEvents = emittedEvents.filter((e) => e.event === "playbackUpdate");
      expect(playEvents.length).toBeGreaterThan(0);
      expect((playEvents[0].data as { playing: boolean }).playing).toBe(true);
    });

    it("kills previous mpv process when playing a new track", async () => {
      mockReaddir.mockResolvedValueOnce(["a.mp3", "b.mp3"]);
      await backend.getTracks();

      await backend.play("a.mp3");
      await backend.play("b.mp3");

      // kill is called once for the first play (cleanup) and once switching tracks
      expect(mockSpawnKill).toHaveBeenCalled();
    });

    // F-020 (audit 2026-05): a previous mpv crash (segfault/SIGKILL/OOM)
    // leaves the IPC socket file on disk. The next spawn would bail with
    // "Address already in use". The fix unlinks the socket file right
    // before spawning so the new mpv can bind cleanly even when the prior
    // killMpv never ran.
    it("unlinks the stale socket file before spawning a new mpv", async () => {
      mockReaddir.mockResolvedValueOnce(["alpha.mp3"]);
      await backend.getTracks();
      mockUnlink.mockClear();
      mockSpawn.mockClear();

      // Track the order: unlink must precede spawn so mpv finds the
      // address free when it tries to bind --input-ipc-server.
      const callOrder: string[] = [];
      mockUnlink.mockImplementation(() => {
        callOrder.push("unlink");
        return Promise.resolve();
      });
      const trackingSpawn = mock((_argv: string[], _opts: any) => {
        callOrder.push("spawn");
        return {
          kill: mockSpawnKill,
          exitCode: 0,
          exited: Promise.resolve(0),
          pid: 9999,
          stdout: null,
          stderr: null,
        };
      });
      // @ts-expect-error -- mock
      Bun.spawn = trackingSpawn;

      await backend.play("alpha.mp3");

      expect(mockUnlink).toHaveBeenCalled();
      expect(trackingSpawn).toHaveBeenCalled();
      const unlinkIdx = callOrder.indexOf("unlink");
      const spawnIdx = callOrder.indexOf("spawn");
      expect(unlinkIdx).toBeGreaterThanOrEqual(0);
      expect(spawnIdx).toBeGreaterThanOrEqual(0);
      expect(unlinkIdx).toBeLessThan(spawnIdx);
    });

    it("ignores ENOENT from the pre-spawn unlink (steady state)", async () => {
      mockReaddir.mockResolvedValueOnce(["alpha.mp3"]);
      await backend.getTracks();
      // Simulate the steady-state case: no stale socket on disk.
      mockUnlink.mockImplementation(() =>
        Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
      );

      // Must not throw — spawn still proceeds.
      await expect(backend.play("alpha.mp3")).resolves.toBeUndefined();
      const status = await backend.getStatus();
      expect(status.playing).toBe(true);
    });

    // F-003 (audit 2026-05): stale-callback race when the user rapidly
    // skips tracks. Track A's mpv onExit can fire AFTER track B has
    // already spawned — without the proc-identity check in play(), the
    // old callback would clobber track B's state to {playing: false,
    // currentTrack: null}.
    it("ignores onExit from a stale mpv proc when a newer track is playing", async () => {
      mockReaddir.mockResolvedValueOnce(["a.mp3", "b.mp3"]);
      await backend.getTracks();

      // Capture each spawn's onExit so we can fire them out-of-order.
      const onExitByCall: Array<() => void> = [];
      const spawnedProcs: Array<{ kill: () => void }> = [];
      const captureSpawn = mock((_argv: string[], opts: { onExit?: () => void }) => {
        const proc = { kill: mockSpawnKill, exitCode: 0, exited: Promise.resolve(0), pid: 1000 + spawnedProcs.length, stdout: null, stderr: null };
        spawnedProcs.push(proc);
        if (opts.onExit) onExitByCall.push(opts.onExit);
        return proc;
      });
      // @ts-expect-error -- mock
      Bun.spawn = captureSpawn;

      await backend.play("a.mp3"); // proc 0
      await backend.play("b.mp3"); // proc 1, replaces this.mpvProcess

      // State should reflect track B.
      let status = await backend.getStatus();
      expect(status.currentTrack).toBe("b.mp3");
      expect(status.playing).toBe(true);

      // Fire track A's stale onExit — must NOT clobber track B's state.
      onExitByCall[0]();

      status = await backend.getStatus();
      expect(status.currentTrack).toBe("b.mp3");
      expect(status.playing).toBe(true);
      expect(status.trackIndex).toBe(1);

      // Sanity: firing track B's own onExit DOES clear state (proves the
      // guard isn't unconditionally ignoring callbacks).
      onExitByCall[1]();
      status = await backend.getStatus();
      expect(status.currentTrack).toBeNull();
      expect(status.playing).toBe(false);
      expect(status.trackIndex).toBe(-1);
    });
  });

  // ── Pause / Resume ───────────────────────────────────────────

  describe("pause and resume", () => {
    it("does nothing when not playing", async () => {
      await backend.pause();
      const status = await backend.getStatus();
      expect(status.paused).toBe(false);
    });

    it("pauses and resumes playback", async () => {
      mockReaddir.mockResolvedValueOnce(["song.mp3"]);
      await backend.getTracks();
      await backend.play("song.mp3");

      await backend.pause();
      let status = await backend.getStatus();
      expect(status.paused).toBe(true);
      expect(status.playing).toBe(true);

      await backend.resume();
      status = await backend.getStatus();
      expect(status.paused).toBe(false);
      expect(status.playing).toBe(true);
    });

    it("resume does nothing when not paused", async () => {
      mockReaddir.mockResolvedValueOnce(["song.mp3"]);
      await backend.getTracks();
      await backend.play("song.mp3");
      emittedEvents = [];

      await backend.resume(); // already playing, not paused
      expect(emittedEvents).toHaveLength(0);
    });
  });

  // ── Stop ─────────────────────────────────────────────────────

  describe("stop", () => {
    it("resets playback state", async () => {
      mockReaddir.mockResolvedValueOnce(["song.mp3"]);
      await backend.getTracks();
      await backend.play("song.mp3");

      await backend.stop();
      const status = await backend.getStatus();
      expect(status.playing).toBe(false);
      expect(status.currentTrack).toBeNull();
      expect(status.trackIndex).toBe(-1);
    });
  });

  // ── Volume ───────────────────────────────────────────────────

  describe("setVolume", () => {
    it("clamps volume between 0 and 100", async () => {
      await backend.setVolume(150);
      expect((await backend.getStatus()).volume).toBe(100);

      await backend.setVolume(-50);
      expect((await backend.getStatus()).volume).toBe(0);
    });

    it("rounds volume to integer", async () => {
      await backend.setVolume(73.7);
      expect((await backend.getStatus()).volume).toBe(74);
    });

    it("emits playbackUpdate on volume change", async () => {
      emittedEvents = [];
      await backend.setVolume(50);
      const event = emittedEvents.find((e) => e.event === "playbackUpdate");
      expect(event).toBeDefined();
      expect((event!.data as { volume: number }).volume).toBe(50);
    });
  });

  // ── Next / Previous ──────────────────────────────────────────

  describe("next and previous", () => {
    it("next does nothing with no tracks", async () => {
      await backend.next();
      const status = await backend.getStatus();
      expect(status.playing).toBe(false);
    });

    it("wraps around to first track on next", async () => {
      mockReaddir.mockResolvedValueOnce(["a.mp3", "b.mp3"]);
      await backend.getTracks();

      await backend.play("b.mp3"); // index 1
      await backend.next(); // should wrap to index 0

      const status = await backend.getStatus();
      expect(status.currentTrack).toBe("a.mp3");
    });

    it("wraps around to last track on previous from first", async () => {
      mockReaddir.mockResolvedValueOnce(["a.mp3", "b.mp3", "c.mp3"]);
      await backend.getTracks();

      await backend.play("a.mp3"); // index 0
      await backend.previous(); // should wrap to index 2

      const status = await backend.getStatus();
      expect(status.currentTrack).toBe("c.mp3");
    });
  });

  // ── Music Directory ──────────────────────────────────────────

  describe("getMusicDir / setMusicDir", () => {
    it("returns the default music directory path", async () => {
      const dir = await backend.getMusicDir();
      expect(dir).toContain("loadout/music");
    });

    it("updates the directory and rescans tracks", async () => {
      // After setMusicDir, scanTracks is called
      mockReaddir.mockResolvedValueOnce(["new-song.mp3"]);

      await backend.setMusicDir("/tmp/test-music");
      const dir = await backend.getMusicDir();
      expect(dir).toBe("/tmp/test-music");
    });

    it("stops playback when changing directory", async () => {
      mockReaddir.mockResolvedValueOnce(["song.mp3"]);
      await backend.getTracks();
      await backend.play("song.mp3");

      mockReaddir.mockResolvedValueOnce([]);
      await backend.setMusicDir("/tmp/other");

      const status = await backend.getStatus();
      expect(status.playing).toBe(false);
    });
  });

  // ── listDirectories ──────────────────────────────────────────

  describe("listDirectories", () => {
    it("returns sorted subdirectories excluding hidden ones", async () => {
      mockReaddir.mockResolvedValueOnce([
        { name: "Music", isDirectory: () => true },
        { name: ".hidden", isDirectory: () => true },
        { name: "file.txt", isDirectory: () => false },
        { name: "Audio", isDirectory: () => true },
      ] as any);

      const result = await backend.listDirectories("/home/user");
      expect(result.dirs).toEqual(["Audio", "Music"]);
      expect(result.path).toBe("/home/user");
      expect(result.parent).toBe("/home");
    });

    it("returns empty dirs on error", async () => {
      mockReaddir.mockRejectedValueOnce(new Error("ENOENT"));
      const result = await backend.listDirectories("/nonexistent");
      expect(result.dirs).toEqual([]);
    });

    it("returns null parent for root directory", async () => {
      mockReaddir.mockResolvedValueOnce([]);
      const result = await backend.listDirectories("/");
      expect(result.parent).toBeNull();
    });
  });
});
