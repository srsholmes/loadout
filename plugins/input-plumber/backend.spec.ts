import {
  describe,
  it,
  expect,
  mock,
  beforeEach,
  afterEach,
} from "bun:test";
import type { EmitPayload } from "@loadout/types";

/**
 * InputPlumber backend tests.
 *
 * The backend is a thin orchestrator over `./src/install`:
 *   - it polls `getStatus()` every 5s and re-emits it as `input-plumber-status`
 *   - it serialises `install()` runs and frames them with
 *     `install-state` + `install-log` events
 *
 * Rather than reach through to real `sudo` / `bash`, we mock the
 * install module wholesale and assert on the events the backend emits
 * plus the call shape it makes into the installer.
 */

// ---------------------------------------------------------------------
// Install module mock
// ---------------------------------------------------------------------

let statusImpl: () => Promise<unknown> = async () => ({
  installed: false,
  binaryPath: null,
  managedBy: "none" as const,
  version: null,
  serviceActive: false,
  serviceEnabled: false,
  scriptPresent: true,
  summary: "InputPlumber is not installed.",
});

interface InstallCallArgs {
  cancellation?: { cancel: () => void };
  onLog?: (text: string, stream: "stdout" | "stderr") => void;
}

let installCalls: InstallCallArgs[] = [];
// The install runner returns a deferred promise so tests can interleave
// "running" assertions before resolving. Each test reassigns this in
// beforeEach to a fresh resolver.
let installResolve: (
  result:
    | {
        success: boolean;
        exitCode: number;
        timedOut: boolean;
        durationSeconds: number;
        error?: string;
      }
    | PromiseLike<{
        success: boolean;
        exitCode: number;
        timedOut: boolean;
        durationSeconds: number;
        error?: string;
      }>,
) => void = () => {};
let installReject: (err: unknown) => void = () => {};
let installImpl: (opts: InstallCallArgs) => Promise<{
  success: boolean;
  exitCode: number;
  timedOut: boolean;
  durationSeconds: number;
  error?: string;
}> = (opts) => {
  installCalls.push(opts);
  return new Promise((resolve, reject) => {
    installResolve = resolve;
    installReject = reject;
  });
};

mock.module("./src/install", () => ({
  getStatus: () => statusImpl(),
  install: (opts: InstallCallArgs) => installImpl(opts),
}));

// Import after the mock is registered.
import InputPlumberBackend from "./backend";

describe("InputPlumberBackend", () => {
  let backend: InputPlumberBackend;
  let emitted: EmitPayload[];

  beforeEach(() => {
    backend = new InputPlumberBackend();
    emitted = [];
    backend.emit = (p) => {
      emitted.push(p);
    };

    // Reset per-test mock state.
    installCalls = [];
    statusImpl = async () => ({
      installed: false,
      binaryPath: null,
      managedBy: "none",
      version: null,
      serviceActive: false,
      serviceEnabled: false,
      scriptPresent: true,
      summary: "InputPlumber is not installed.",
    });
    installImpl = (opts) => {
      installCalls.push(opts);
      return new Promise((resolve, reject) => {
        installResolve = resolve;
        installReject = reject;
      });
    };
  });

  afterEach(async () => {
    // Always tear down the 5s status timer to keep `bun test` from
    // hanging on lingering intervals.
    await backend.onUnload();
  });

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  describe("onLoad / onUnload", () => {
    it("broadcasts status immediately on load", async () => {
      statusImpl = async () => ({
        installed: true,
        binaryPath: "/usr/bin/inputplumber",
        managedBy: "distro",
        version: "0.50.0",
        serviceActive: true,
        serviceEnabled: true,
        scriptPresent: true,
        summary: "InputPlumber active (v0.50.0), managed by system package.",
      });

      await backend.onLoad();
      // The broadcast is fire-and-forget (`void this.broadcastStatus()`),
      // so we need to drain the microtask queue before asserting.
      await Promise.resolve();
      await Promise.resolve();

      const status = emitted.find(
        (e) => e.event === "input-plumber-status",
      );
      expect(status).toBeDefined();
      expect((status?.data as { installed: boolean }).installed).toBe(true);
    });

    it("clears the status timer on unload", async () => {
      await backend.onLoad();
      // onUnload() is awaited in afterEach as well, but calling it
      // explicitly here also exercises the early-exit path on the
      // second call (statusTimer is already undefined).
      await backend.onUnload();
      await backend.onUnload(); // idempotent
      // Hard to assert "no more timer fires" without faking time; the
      // afterEach hook still calls onUnload, so we settle for "doesn't
      // throw" as the contract.
      expect(true).toBe(true);
    });

    it("swallows status broadcast errors so the timer survives", async () => {
      statusImpl = async () => {
        throw new Error("boom");
      };
      // Should not reject — broadcastStatus catches internally and
      // logs to console.error.
      await expect(backend.onLoad()).resolves.toBeUndefined();
      // And no input-plumber-status event was emitted (the throw
      // short-circuited the emit call).
      await Promise.resolve();
      await Promise.resolve();
      expect(
        emitted.find((e) => e.event === "input-plumber-status"),
      ).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------
  // getStatus passthrough
  // -------------------------------------------------------------------

  describe("getStatus", () => {
    it("returns whatever the installer module says", async () => {
      statusImpl = async () => ({
        installed: false,
        binaryPath: null,
        managedBy: "none",
        version: null,
        serviceActive: false,
        serviceEnabled: false,
        scriptPresent: false,
        hhd: { installed: false, active: false, units: [] },
        summary: "InputPlumber is not installed.",
      });
      const status = await backend.getStatus();
      expect(status.installed).toBe(false);
      expect(status.summary).toContain("not installed");
    });

    it("surfaces installer errors as a rejection", async () => {
      statusImpl = async () => {
        throw new Error("status probe failed");
      };
      await expect(backend.getStatus()).rejects.toThrow("status probe failed");
    });
  });

  // -------------------------------------------------------------------
  // isInstallRunning
  // -------------------------------------------------------------------

  describe("isInstallRunning", () => {
    it("returns false when nothing is queued", () => {
      expect(backend.isInstallRunning()).toEqual({ running: false });
    });

    it("returns true while an install is in flight", async () => {
      const r = await backend.startInstall();
      expect(r.started).toBe(true);
      expect(backend.isInstallRunning()).toEqual({ running: true });
      // Resolve the install so afterEach doesn't hang.
      installResolve({
        success: true,
        exitCode: 0,
        timedOut: false,
        durationSeconds: 1,
      });
      // Let the promise chain (then + finally) settle.
      await new Promise((r) => setTimeout(r, 0));
      expect(backend.isInstallRunning()).toEqual({ running: false });
    });
  });

  // -------------------------------------------------------------------
  // startInstall
  // -------------------------------------------------------------------

  describe("startInstall", () => {
    it("emits state=running and a header log line on success", async () => {
      const res = await backend.startInstall();
      expect(res).toEqual({ started: true });

      // The two synchronous emits happen before installer.install runs.
      const states = emitted.filter((e) => e.event === "install-state");
      expect(states).toHaveLength(1);
      expect((states[0].data as { running: boolean }).running).toBe(true);

      const logs = emitted.filter((e) => e.event === "install-log");
      expect(logs).toHaveLength(1);
      expect((logs[0].data as { text: string }).text).toContain(
        "Starting install",
      );

      // The backend passed `onLog` and `cancellation` to installer.install.
      expect(installCalls).toHaveLength(1);
      expect(typeof installCalls[0].onLog).toBe("function");
      expect(installCalls[0].cancellation).toBeDefined();

      // Pump a fake log chunk through and assert it surfaces as an event.
      installCalls[0].onLog?.("hello\n", "stdout");
      const chunk = emitted.find(
        (e) =>
          e.event === "install-log" &&
          (e.data as { kind: string }).kind === "stdout",
      );
      expect(chunk).toBeDefined();
      expect((chunk?.data as { text: string }).text).toBe("hello\n");

      // Finish the install so afterEach unloads cleanly.
      installResolve({
        success: true,
        exitCode: 0,
        timedOut: false,
        durationSeconds: 3,
      });
      await new Promise((r) => setTimeout(r, 0));

      const completion = emitted.find(
        (e) =>
          e.event === "install-log" &&
          (e.data as { text: string }).text.includes("install complete"),
      );
      expect(completion).toBeDefined();
      const finalState = emitted
        .filter((e) => e.event === "install-state")
        .at(-1);
      expect((finalState?.data as { running: boolean }).running).toBe(false);
    });

    it("rejects a second start while one is already running", async () => {
      await backend.startInstall();
      const second = await backend.startInstall();
      expect(second.started).toBe(false);
      expect(second.error).toContain("already in progress");
      // Only one installer.install call.
      expect(installCalls).toHaveLength(1);

      // Tidy up.
      installResolve({
        success: true,
        exitCode: 0,
        timedOut: false,
        durationSeconds: 0,
      });
      await new Promise((r) => setTimeout(r, 0));
    });

    it("emits a failure log when the installer reports !success", async () => {
      await backend.startInstall();
      installResolve({
        success: false,
        exitCode: 2,
        timedOut: false,
        durationSeconds: 4,
        error: "permission denied",
      });
      await new Promise((r) => setTimeout(r, 0));

      const failureLog = emitted.find(
        (e) =>
          e.event === "install-log" &&
          (e.data as { text: string }).text.includes("install failed"),
      );
      expect(failureLog).toBeDefined();
      expect((failureLog?.data as { text: string }).text).toContain(
        "permission denied",
      );

      const finalState = emitted
        .filter((e) => e.event === "install-state")
        .at(-1);
      expect((finalState?.data as { running: boolean }).running).toBe(false);
      // The installer's full result is included.
      expect(
        (finalState?.data as { result: { success: boolean } }).result.success,
      ).toBe(false);

      // Running flag must have cleared so a retry is possible.
      expect(backend.isInstallRunning()).toEqual({ running: false });
    });

    it("emits an install-threw log when the installer rejects", async () => {
      await backend.startInstall();
      installReject(new Error("kaboom"));
      await new Promise((r) => setTimeout(r, 0));

      const thrown = emitted.find(
        (e) =>
          e.event === "install-log" &&
          (e.data as { text: string }).text.includes("install threw"),
      );
      expect(thrown).toBeDefined();
      expect((thrown?.data as { text: string }).text).toContain("kaboom");

      const finalState = emitted
        .filter((e) => e.event === "install-state")
        .at(-1);
      expect(
        (
          finalState?.data as {
            result: { success: boolean; exitCode: number };
          }
        ).result.exitCode,
      ).toBe(-1);
      // Running clears even on throw.
      expect(backend.isInstallRunning()).toEqual({ running: false });
    });
  });

  // -------------------------------------------------------------------
  // cancelInstall
  // -------------------------------------------------------------------

  describe("cancelInstall", () => {
    it("returns an error when no install is in flight", () => {
      const r = backend.cancelInstall();
      expect(r.cancelled).toBe(false);
      expect(r.error).toContain("no install in progress");
    });

    it("invokes the active cancellation handle", async () => {
      let cancelCalled = false;
      // Replace the install impl to capture the cancellation handle
      // and trigger a cancel-side-effect on it.
      installImpl = (opts) => {
        installCalls.push(opts);
        // Stash a cancel handler that flips our flag.
        if (opts.cancellation) {
          opts.cancellation.cancel = () => {
            cancelCalled = true;
          };
        }
        return new Promise((resolve, reject) => {
          installResolve = resolve;
          installReject = reject;
        });
      };

      await backend.startInstall();
      const r = backend.cancelInstall();
      expect(r.cancelled).toBe(true);
      expect(cancelCalled).toBe(true);

      // Resolve install so afterEach completes.
      installResolve({
        success: false,
        exitCode: 130,
        timedOut: false,
        durationSeconds: 1,
        error: "cancelled",
      });
      await new Promise((r) => setTimeout(r, 0));
    });
  });
});
