import { describe, it, expect, mock, beforeEach, spyOn } from "bun:test";
import type { EmitPayload } from "@loadout/types";
import type { BunFile, Subprocess } from "bun";

// ---------------------------------------------------------------------------
// Shared test-only helper types. The casts below intentionally narrow `any`
// usage to a single named surface per mock so each callsite reuses the same
// loose type instead of open-coding `as any`.
// ---------------------------------------------------------------------------

/** Minimal slice of BunFile we touch in these tests. */
type BunFileLike = Pick<BunFile, "exists" | "json">;

/** Minimal slice of a Bun.spawn return value. */
type SpawnedLike = Pick<Subprocess, "exited" | "kill"> & { pid?: number; exitCode?: number | null };

/** Minimal shape of a Response we hand back from a mocked fetch. */
type FetchResponseLike = Pick<Response, "ok" | "status"> & { json?: () => Promise<unknown> };

/** Convenience cast: lets a Partial-shaped mock satisfy the strict return type. */
const asBunFile = (m: BunFileLike): BunFile => m as unknown as BunFile;
const asSpawned = (m: SpawnedLike): Subprocess => m as unknown as Subprocess;
const asFetchResponse = (m: FetchResponseLike): Response => m as unknown as Response;
/** Bun.write has a half-dozen overloads; mockReturnValue picks the first. */
const asBunWriteResult = (n: number): ReturnType<typeof Bun.write> =>
  Promise.resolve(n) as unknown as ReturnType<typeof Bun.write>;

// Mock @loadout/exec
const mockCommandExists = mock(() => Promise.resolve(false));
const mockRun = mock(() => Promise.resolve({ stdout: "", exitCode: 0 }));

mock.module("@loadout/exec", () => ({
  commandExists: mockCommandExists,
  run: mockRun,
}));

// Mock node:fs/promises
const mockMkdir = mock(() => Promise.resolve());
const mockRm = mock(() => Promise.resolve());
const mockChmod = mock(() => Promise.resolve());
const mockRename = mock(() => Promise.resolve());
const mockOpen = mock(() =>
  Promise.resolve({
    write: mock(() => Promise.resolve()),
    close: mock(() => Promise.resolve()),
  }),
);

const fsMocks = {
  mkdir: mockMkdir,
  rm: mockRm,
  chmod: mockChmod,
  rename: mockRename,
  open: mockOpen,
};

mock.module("fs/promises", () => fsMocks);
mock.module("node:fs/promises", () => fsMocks);

import HandyDictationBackend from "./backend";

/**
 * Test-only handle on the backend's private fields. Keeps the cast to a
 * single named alias so each `internals(backend).handyProc = …` callsite
 * shares one loose surface instead of opening its own.
 */
type HandyProcLike = {
  exitCode?: number | null;
  pid?: number;
  exited?: Promise<unknown>;
  // Loose `kill` to permit the spec's signature-capturing fake.
  kill?: (sig: string) => unknown;
};
type BackendInternals = {
  handyProc: HandyProcLike | null;
  appImagePath: string | null;
  installedVersion: string | null;
  installing: boolean;
};
const internals = (b: HandyDictationBackend): BackendInternals =>
  b as unknown as BackendInternals;

describe("HandyDictationBackend (Handy wrapper)", () => {
  let backend: HandyDictationBackend;
  let emittedEvents: EmitPayload[];

  beforeEach(() => {
    backend = new HandyDictationBackend();
    emittedEvents = [];
    backend.emit = (payload: EmitPayload) => {
      emittedEvents.push(payload);
    };
    mockCommandExists.mockClear();
    mockRun.mockClear();
    mockMkdir.mockClear();
    mockRm.mockClear();
    // Reset implementations too — otherwise a previous test's mockImplementation
    // (e.g. commandExists => true) leaks into the next.
    mockCommandExists.mockImplementation(() => Promise.resolve(false));
    mockRun.mockImplementation(() =>
      Promise.resolve({ stdout: "", exitCode: 0 }),
    );
  });

  describe("getStatus()", () => {
    it("reports not installed when AppImage is missing and nothing on PATH", async () => {
      const mockBunFile = spyOn(Bun, "file").mockReturnValue(
        asBunFile({
          exists: () => Promise.resolve(false),
          json: () => Promise.resolve({}),
        }),
      );
      mockCommandExists.mockImplementation(() => Promise.resolve(false));

      const status = await backend.getStatus();
      expect(status.installed).toBe(false);
      expect(status.appImagePath).toBeNull();
      expect(status.running).toBe(false);
      expect(status.setupComplete).toBe(false);
      expect(status.missingSystemDeps.length).toBeGreaterThan(0);

      mockBunFile.mockRestore();
    });

    it("reports installed and setupComplete when AppImage, typing tool, and Handy settings all exist", async () => {
      // Handy settings file → fully configured.
      const mockBunFile = spyOn(Bun, "file").mockReturnValue(
        asBunFile({
          exists: () => Promise.resolve(true),
          json: () =>
            Promise.resolve({
              settings: {
                selected_microphone: "HD-Audio Generic",
                selected_model: "parakeet-tdt-0.6b-v3",
              },
            }),
        }),
      );
      mockCommandExists.mockImplementation((name: string) =>
        Promise.resolve(name === "wtype"),
      );

      const status = await backend.getStatus();
      expect(status.installed).toBe(true);
      expect(status.appImagePath).not.toBeNull();
      expect(status.missingSystemDeps).toEqual([]);
      expect(status.setupComplete).toBe(true);

      mockBunFile.mockRestore();
    });

    it("flags missing typing tool as a system dep", async () => {
      const mockBunFile = spyOn(Bun, "file").mockReturnValue(
        asBunFile({
          exists: () => Promise.resolve(true),
          json: () => Promise.resolve({}),
        }),
      );
      mockCommandExists.mockImplementation(() => Promise.resolve(false));

      const status = await backend.getStatus();
      expect(status.installed).toBe(true);
      expect(status.setupComplete).toBe(false);
      expect(status.missingSystemDeps.join(",")).toContain("wtype");

      mockBunFile.mockRestore();
    });

    it("clears stale Handy proc on getStatus", async () => {
      const mockBunFile = spyOn(Bun, "file").mockReturnValue(
        asBunFile({
          exists: () => Promise.resolve(false),
          json: () => Promise.resolve({}),
        }),
      );

      internals(backend).handyProc = { exitCode: 0, pid: 1234 };

      const status = await backend.getStatus();
      expect(status.running).toBe(false);
      expect(internals(backend).handyProc).toBeNull();

      mockBunFile.mockRestore();
    });
  });

  describe("updateConfig()", () => {
    it("persists config and emits configChanged", async () => {
      const mockBunWrite = spyOn(Bun, "write").mockReturnValue(
        asBunWriteResult(0),
      );

      const result = await backend.updateConfig({ startHidden: false });
      expect(result.success).toBe(true);

      const config = await backend.getConfig();
      expect(config.startHidden).toBe(false);

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].event).toBe("configChanged");

      mockBunWrite.mockRestore();
    });

    it("accepts partial updates for autostartOnLoad", async () => {
      const mockBunWrite = spyOn(Bun, "write").mockReturnValue(
        asBunWriteResult(0),
      );

      await backend.updateConfig({ autostartOnLoad: true });
      const config = await backend.getConfig();
      expect(config.autostartOnLoad).toBe(true);
      // startHidden should keep its previous/default value
      expect(typeof config.startHidden).toBe("boolean");

      mockBunWrite.mockRestore();
    });

  });

  describe("getStatus() / Handy settings snapshot", () => {
    it("reports configured=false when Handy settings file is missing", async () => {
      const mockBunFile = spyOn(Bun, "file").mockReturnValue(
        asBunFile({
          exists: () => Promise.resolve(false),
          json: () => Promise.resolve({}),
        }),
      );
      mockCommandExists.mockImplementation(() => Promise.resolve(true));

      const status = await backend.getStatus();
      expect(status.settings.configured).toBe(false);
      expect(status.settings.microphone).toBeNull();
      expect(status.settings.model).toBeNull();
      expect(status.setupComplete).toBe(false);

      mockBunFile.mockRestore();
    });

    it("surfaces microphone + model from Handy's settings_store.json", async () => {
      const mockBunFile = spyOn(Bun, "file").mockImplementation(
        ((path: string) => {
          const isHandySettings = path.includes("settings_store.json");
          return asBunFile({
            exists: () => Promise.resolve(true),
            json: () =>
              Promise.resolve(
                isHandySettings
                  ? {
                      settings: {
                        selected_microphone: "HD-Audio Generic",
                        selected_model: "parakeet-tdt-0.6b-v3",
                      },
                    }
                  : {},
              ),
          });
        }) as typeof Bun.file,
      );
      mockCommandExists.mockImplementation(() => Promise.resolve(true));

      const status = await backend.getStatus();
      expect(status.settings.microphone).toBe("HD-Audio Generic");
      expect(status.settings.model).toBe("parakeet-tdt-0.6b-v3");
      expect(status.settings.configured).toBe(true);
      expect(status.setupComplete).toBe(true);

      mockBunFile.mockRestore();
    });

    it("configured=false when only one of mic/model is set", async () => {
      const mockBunFile = spyOn(Bun, "file").mockReturnValue(
        asBunFile({
          exists: () => Promise.resolve(true),
          json: () =>
            Promise.resolve({
              settings: {
                selected_microphone: "",
                selected_model: "parakeet-tdt-0.6b-v3",
              },
            }),
        }),
      );
      mockCommandExists.mockImplementation(() => Promise.resolve(true));

      const status = await backend.getStatus();
      expect(status.settings.configured).toBe(false);

      mockBunFile.mockRestore();
    });

    it("reports running=true when pgrep finds Handy even if we didn't spawn it", async () => {
      const mockBunFile = spyOn(Bun, "file").mockReturnValue(
        asBunFile({
          exists: () => Promise.resolve(false),
          json: () => Promise.resolve({}),
        }),
      );
      // pgrep available + returns success (exit 0 = match found).
      mockCommandExists.mockImplementation(() => Promise.resolve(true));
      mockRun.mockImplementation((cmd: string[]) => {
        if (cmd[0] === "pgrep" && cmd.includes("handy")) {
          return Promise.resolve({ stdout: "1234", exitCode: 0 });
        }
        return Promise.resolve({ stdout: "", exitCode: 0 });
      });

      // We did NOT spawn Handy — handyProc stays null.
      const status = await backend.getStatus();
      expect(status.running).toBe(true);

      mockBunFile.mockRestore();
    });

    it("running=false when pgrep finds no Handy and we didn't spawn it", async () => {
      const mockBunFile = spyOn(Bun, "file").mockReturnValue(
        asBunFile({
          exists: () => Promise.resolve(false),
          json: () => Promise.resolve({}),
        }),
      );
      mockCommandExists.mockImplementation(() => Promise.resolve(true));
      mockRun.mockImplementation((cmd: string[]) => {
        if (cmd[0] === "pgrep") {
          // exit 1 = no match
          return Promise.resolve({ stdout: "", exitCode: 1 });
        }
        return Promise.resolve({ stdout: "", exitCode: 0 });
      });

      const status = await backend.getStatus();
      expect(status.running).toBe(false);

      mockBunFile.mockRestore();
    });
  });

  describe("launchHandyGui()", () => {
    it("stops external Handy via pkill before spawning a visible instance", async () => {
      internals(backend).appImagePath = "/path/to/Handy.AppImage";
      internals(backend).handyProc = null;

      const pgrepCalls: number[] = [];
      let externalAlive = true;
      mockCommandExists.mockImplementation(() => Promise.resolve(true));
      mockRun.mockImplementation((cmd: string[]) => {
        if (cmd[0] === "pgrep") {
          pgrepCalls.push(Date.now());
          return Promise.resolve({
            stdout: externalAlive ? "1234" : "",
            exitCode: externalAlive ? 0 : 1,
          });
        }
        if (cmd[0] === "pkill") {
          externalAlive = false; // pkill succeeded; next pgrep says gone
          return Promise.resolve({ stdout: "", exitCode: 0 });
        }
        return Promise.resolve({ stdout: "", exitCode: 0 });
      });

      const mockSpawn = spyOn(Bun, "spawn").mockReturnValue(
        asSpawned({
          exited: Promise.resolve(0),
          kill: () => {},
        }),
      );

      const result = await backend.launchHandyGui();
      expect(result.success).toBe(true);

      // Key assertion: pkill must have been called to free the single-
      // instance lock, otherwise the spawn below is swallowed by Handy.
      expect(
        mockRun.mock.calls.some(
          (c) => c[0]?.[0] === "pkill" && c[0]?.includes("handy"),
        ),
      ).toBe(true);

      // And then we spawn Handy ourselves (without --start-hidden)
      expect(mockSpawn).toHaveBeenCalled();
      const spawnArgs = mockSpawn.mock.calls[0][0] as string[];
      expect(spawnArgs).toEqual(["/path/to/Handy.AppImage"]);

      mockSpawn.mockRestore();
    });

    it("errors when Handy is not installed", async () => {
      internals(backend).appImagePath = null;
      const result = await backend.launchHandyGui();
      expect(result.success).toBe(false);
      expect(result.error).toContain("not installed");
    });
  });

  describe("startHandy() with external Handy", () => {
    it("returns success without spawning when Handy is already running externally", async () => {
      internals(backend).appImagePath = "/path/to/Handy.AppImage";
      internals(backend).handyProc = null;
      mockCommandExists.mockImplementation(() => Promise.resolve(true));
      mockRun.mockImplementation((cmd: string[]) => {
        if (cmd[0] === "pgrep") {
          return Promise.resolve({ stdout: "1234", exitCode: 0 });
        }
        return Promise.resolve({ stdout: "", exitCode: 0 });
      });

      const mockSpawn = spyOn(Bun, "spawn");

      const result = await backend.startHandy();
      expect(result.success).toBe(true);
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(
        emittedEvents.some(
          (e) =>
            e.event === "statusChanged" &&
            (e.data as { running?: boolean }).running === true,
        ),
      ).toBe(true);

      mockSpawn.mockRestore();
    });
  });

  describe("startHandy()", () => {
    it("returns error when AppImage is not installed", async () => {
      internals(backend).appImagePath = null;

      const result = await backend.startHandy();
      expect(result.success).toBe(false);
      expect(result.error).toContain("not installed");
    });

    it("returns error when Handy is already running", async () => {
      internals(backend).appImagePath = "/path/to/Handy.AppImage";
      internals(backend).handyProc = { pid: 42, exitCode: null };

      const result = await backend.startHandy();
      expect(result.success).toBe(false);
      expect(result.error).toBe("Handy already running");
    });
  });

  describe("toggleDictation()", () => {
    it("returns error when Handy is not installed", async () => {
      internals(backend).appImagePath = null;

      const result = await backend.toggleDictation();
      expect(result.success).toBe(false);
      expect(result.error).toContain("not installed");
    });

    it("calls Handy with --toggle-transcription when already running", async () => {
      internals(backend).appImagePath = "/path/to/Handy.AppImage";
      internals(backend).handyProc = { pid: 42, exitCode: null };

      mockRun.mockImplementation(() =>
        Promise.resolve({ stdout: "", exitCode: 0 }),
      );

      const result = await backend.toggleDictation();
      expect(result.success).toBe(true);
      expect(mockRun).toHaveBeenCalledWith([
        "/path/to/Handy.AppImage",
        "--toggle-transcription",
      ]);
      expect(emittedEvents.some((e) => e.event === "dictationToggled")).toBe(
        true,
      );
    });

    it("surfaces non-zero exit codes as errors", async () => {
      internals(backend).appImagePath = "/path/to/Handy.AppImage";
      internals(backend).handyProc = { pid: 42, exitCode: null };

      mockRun.mockImplementation(() =>
        Promise.resolve({ stdout: "", exitCode: 1 }),
      );

      const result = await backend.toggleDictation();
      expect(result.success).toBe(false);
      expect(result.error).toContain("exited 1");
    });
  });

  describe("installHandy()", () => {
    it("rejects concurrent installs", async () => {
      internals(backend).installing = true;

      const result = await backend.installHandy();
      expect(result.success).toBe(false);
      expect(result.error).toContain("already in progress");

      internals(backend).installing = false;
    });

    it("returns an error when no matching AppImage asset exists", async () => {
      const mockBunWrite = spyOn(Bun, "write").mockReturnValue(
        asBunWriteResult(0),
      );
      const mockFetch = spyOn(globalThis, "fetch").mockImplementation(() =>
        Promise.resolve(
          asFetchResponse({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                tag_name: "v0.0.0",
                assets: [
                  {
                    name: "Handy_0.0.0_x64.msi",
                    browser_download_url: "https://example/msi",
                  },
                ],
              }),
          }),
        ),
      );

      const result = await backend.installHandy();
      expect(result.success).toBe(false);
      expect(result.error).toContain("No AppImage");

      mockFetch.mockRestore();
      mockBunWrite.mockRestore();
    });

    it("reports HTTP errors from the GitHub API", async () => {
      const mockFetch = spyOn(globalThis, "fetch").mockImplementation(() =>
        Promise.resolve(asFetchResponse({ ok: false, status: 503 })),
      );

      const result = await backend.installHandy();
      expect(result.success).toBe(false);
      expect(result.error).toContain("HTTP 503");

      mockFetch.mockRestore();
    });
  });

  describe("uninstallHandy()", () => {
    it("removes the AppImage, clears state, and emits statusChanged", async () => {
      internals(backend).appImagePath = "/path/to/Handy.AppImage";
      internals(backend).installedVersion = "v0.8.2";

      const mockBunFile = spyOn(Bun, "file").mockReturnValue(
        asBunFile({
          exists: () => Promise.resolve(false),
          json: () => Promise.resolve({}),
        }),
      );
      const mockBunWrite = spyOn(Bun, "write").mockReturnValue(
        asBunWriteResult(0),
      );

      const result = await backend.uninstallHandy();
      expect(result.success).toBe(true);
      expect(mockRm).toHaveBeenCalled();
      expect(internals(backend).appImagePath).toBeNull();
      expect(internals(backend).installedVersion).toBeNull();
      expect(emittedEvents.some((e) => e.event === "statusChanged")).toBe(true);

      mockBunFile.mockRestore();
      mockBunWrite.mockRestore();
    });
  });

  describe("onUnload()", () => {
    it("cleans up the Handy process", async () => {
      const killCalls: string[] = [];
      const exitedPromise = Promise.resolve();

      internals(backend).handyProc = {
        kill: (sig: string) => killCalls.push(`handy:${sig}`),
        exited: exitedPromise,
      };

      await backend.onUnload();

      expect(killCalls).toContain("handy:SIGTERM");
      expect(internals(backend).handyProc).toBeNull();
    });
  });

  /**
   * Audit F-019: SIGTERM-only shutdown can wedge the loader if Handy
   * doesn't respond (mid-transcription + locked model is a common
   * trigger). The fix waits up to 5s and then escalates to SIGKILL.
   *
   * The two tests below cover the real-clock-timer paths (the existing
   * suite); the F-022 block further down covers the same logic with
   * stubbed setTimeout so we can also exercise the SIGKILL-throw and
   * no-proc edge cases without the 5s wait.
   */
  describe("stopHandy() SIGKILL escalation (F-019)", () => {
    it("escalates to SIGKILL when SIGTERM is ignored", async () => {
      const killCalls: string[] = [];
      // `exited` only resolves after SIGKILL is sent — mimics a wedged
      // child that ignores SIGTERM.
      let resolveExited: () => void = () => {};
      const exited = new Promise<void>((res) => {
        resolveExited = res;
      });

      (backend as any).handyProc = {
        kill: (sig: string) => {
          killCalls.push(sig);
          if (sig === "SIGKILL") resolveExited();
        },
        exited,
      };

      const t0 = Date.now();
      await backend.onUnload();
      const elapsed = Date.now() - t0;

      // Both signals went out, in order.
      expect(killCalls[0]).toBe("SIGTERM");
      expect(killCalls).toContain("SIGKILL");
      // Escalation happens after the 5s timeout window — loose ceiling
      // for CI jitter, but the point is "we waited rather than killed
      // immediately".
      expect(elapsed).toBeGreaterThanOrEqual(4900);
      expect((backend as any).handyProc).toBeNull();
    }, 10_000);

    it("does NOT send SIGKILL when SIGTERM cleanly exits Handy", async () => {
      const killCalls: string[] = [];
      // exited resolves immediately — well-behaved child.
      (backend as any).handyProc = {
        kill: (sig: string) => killCalls.push(sig),
        exited: Promise.resolve(),
      };

      await backend.onUnload();

      expect(killCalls).toEqual(["SIGTERM"]);
      expect((backend as any).handyProc).toBeNull();
    });
  });

  // ── F-022: SIGTERM-hang fallback edge cases ──────────────────────
  //
  // F-019 added a 5s timer-then-SIGKILL escalation inside _stopHandy.
  // The block above covers the wall-clock paths. The block below uses
  // a stubbed setTimeout to (a) keep the suite fast and (b) exercise
  // two edge cases the real-clock suite can't: the SIGKILL kill()
  // throwing because the process exited between the timeout firing
  // and the kill call, and the no-proc / no-op entry path.

  describe("F-022: _stopHandy SIGTERM → SIGKILL edge cases", () => {
    beforeEach(() => {
      // No external Handy — keep the test focused on the proc.kill path.
      mockCommandExists.mockImplementation(() => Promise.resolve(true));
      mockRun.mockImplementation((cmd: string[]) => {
        if (cmd[0] === "pgrep") {
          return Promise.resolve({ stdout: "", exitCode: 1 });
        }
        return Promise.resolve({ stdout: "", exitCode: 0 });
      });
    });

    it("happy path (stubbed timer): exits cleanly after SIGTERM, timer is cancelled", async () => {
      // proc.exited already resolved → race wins before setTimeout fires →
      // clearTimeout cancels the timer → SIGKILL is never sent.
      const killCalls: string[] = [];
      const realSetTimeout = globalThis.setTimeout;
      const realClearTimeout = globalThis.clearTimeout;
      let timerScheduled = false;
      let timerCancelled = false;

      // Stub setTimeout/clearTimeout so we can assert on the lifecycle.
      // The stub schedules with a huge real timeout — clearTimeout fires
      // long before the callback would, so SIGKILL never gets the chance.
      (globalThis as any).setTimeout = (cb: () => void, _ms: number) => {
        timerScheduled = true;
        const handle = realSetTimeout(cb, 60_000);
        return handle;
      };
      (globalThis as any).clearTimeout = (handle: any) => {
        timerCancelled = true;
        return realClearTimeout(handle);
      };

      (backend as any).handyProc = {
        kill: (sig: string) => killCalls.push(sig),
        exited: Promise.resolve(0),
      };

      try {
        const result = await backend.stopHandy();
        expect(result.success).toBe(true);
        expect(killCalls).toEqual(["SIGTERM"]);
        expect(timerScheduled).toBe(true);
        expect(timerCancelled).toBe(true);
        expect((backend as any).handyProc).toBeNull();
      } finally {
        (globalThis as any).setTimeout = realSetTimeout;
        (globalThis as any).clearTimeout = realClearTimeout;
      }
    });

    it("hang path (stubbed timer): SIGKILL throw is swallowed (process gone between timeout and kill)", async () => {
      // Edge case: by the time we fire SIGKILL, the process is already
      // gone and proc.kill throws ESRCH. _stopHandy must catch + continue.
      const realSetTimeout = globalThis.setTimeout;
      const realClearTimeout = globalThis.clearTimeout;
      let exitedResolve!: (v: number) => void;
      const exitedPromise = new Promise<number>((res) => {
        exitedResolve = res;
      });

      (globalThis as any).setTimeout = (cb: () => void, _ms: number) => {
        queueMicrotask(cb);
        return 0 as any;
      };
      (globalThis as any).clearTimeout = (_h: any) => {};

      (backend as any).handyProc = {
        kill: (sig: string) => {
          if (sig === "SIGKILL") {
            // Simulate the process having just exited — resolve exited
            // BEFORE we throw so the awaited proc.exited completes.
            exitedResolve(0);
            throw new Error("ESRCH: no such process");
          }
        },
        exited: exitedPromise,
      };

      try {
        const result = await backend.stopHandy();
        // The thrown ESRCH is caught inside _stopHandy and logged; the
        // overall stopHandy result must still be a success.
        expect(result.success).toBe(true);
        expect((backend as any).handyProc).toBeNull();
      } finally {
        (globalThis as any).setTimeout = realSetTimeout;
        (globalThis as any).clearTimeout = realClearTimeout;
      }
    });

    it("already-exited path: stopHandy with no handyProc is a no-op", async () => {
      // No spawned proc, no external Handy — should still resolve cleanly
      // and emit one statusChanged so the UI can resync.
      (backend as any).handyProc = null;

      const result = await backend.stopHandy();
      expect(result.success).toBe(true);
      // No kill was attempted because there was no proc to kill.
      expect((backend as any).handyProc).toBeNull();
      // The "nothing to stop" branch emits statusChanged({running:false}).
      const sawStatusChanged = emittedEvents.some(
        (e) =>
          e.event === "statusChanged" && (e.data as any).running === false,
      );
      expect(sawStatusChanged).toBe(true);
    });
  });
});
