import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { EmitPayload } from "@loadout/types";

/**
 * WiFi backend tests.
 *
 * The backend's job is wiring: call enable/disable, persist the setting,
 * start/stop the wake listener, and emit statusChanged. We mock the
 * ./lib/powersave orchestration (tested separately), plugin storage, and
 * @loadout/wake so these assert the wiring without root, fs, or dbus.
 */

const enableImpl = mock(async () => ({ success: true, iface: "wlan0", steps: ["nm-config-written", "runtime-off"] }));
const disableImpl = mock(async () => ({ success: true, iface: "wlan0", steps: ["nm-config-removed", "runtime-on"] }));
const getStatusImpl = mock(async () => ({
  iface: "wlan0",
  nmConfigured: false,
  iwdPresent: false,
  iwdConfigured: false,
  runtime: "on" as "on" | "off" | null,
  configured: false,
}));
const reassertImpl = mock(async () => {});

mock.module("./lib/powersave", () => ({
  enable: enableImpl,
  disable: disableImpl,
  getStatus: getStatusImpl,
  reassertRuntime: reassertImpl,
}));

// In-memory plugin storage so settings persist within a test. The mutate
// path is a spy so tests can assert write counts (skip-unchanged branch).
let storage: Record<string, unknown> = {};
const mutateSpy = mock(
  async (
    _id: string,
    mutate: (current: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    storage = { ...mutate({ ...storage }) };
  },
);
mock.module("@loadout/plugin-storage", () => ({
  readPluginStorage: async () => ({ ...storage }),
  writePluginStorage: async (_id: string, next: Record<string, unknown>) => {
    storage = { ...next };
  },
  mutatePluginStorage: mutateSpy,
}));

// Mock the recovery orchestration (tested separately in lib/recovery.test.ts)
// so backend tests assert the wiring: single-flight, persistence, events.
const recoverImpl = mock(
  async (_opts: unknown): Promise<Record<string, unknown>> => ({
    ok: true,
    stage: "done",
    tier: "modprobe",
    driver: "iwlwifi",
    iface: "wlan1",
    detail: "Driver reloaded — radio back as wlan1.",
    durationMs: 5,
  }),
);
const getWifiDeviceImpl = mock(async () => ({ device: "wlan0", state: "connected" }));
const detectDriverInfoImpl = mock(async () => ({
  driver: "iwlwifi",
  pciAddress: "0000:62:00.0",
  iface: "wlan0",
  updatedAt: 1,
}));
const evaluateWatchdogImpl = mock((opts: { state: unknown }) => ({
  next: opts.state,
  fire: false,
  reason: "healthy",
}));
const recordRecoveryOutcomeImpl = mock((opts: { state: unknown }) => opts.state);
mock.module("./lib/recovery", () => ({
  recover: recoverImpl,
  getWifiDevice: getWifiDeviceImpl,
  detectDriverInfo: detectDriverInfoImpl,
  readRfkill: async () => ({ soft: false, hard: false, blocked: false }),
  nmRadioEnabled: async () => true,
  initialWatchdogState: () => ({
    consecutiveBad: 0,
    consecutiveFailures: 0,
    lastAttemptAt: null,
    suspended: false,
  }),
  evaluateWatchdog: evaluateWatchdogImpl,
  recordRecoveryOutcome: recordRecoveryOutcomeImpl,
  DEFAULT_WATCHDOG: { debounceCount: 2, cooldownMs: 60_000, maxFailures: 3 },
}));

// Capture the resume callback + hand back a stop spy so we can assert the
// listener is started/stopped without a real dbus-monitor.
let capturedOnResume: (() => void) | null = null;
const stopSpy = mock(() => {});
const startWakeListenerImpl = mock((_deps: unknown, onResume: () => void) => {
  capturedOnResume = onResume;
  return { stop: stopSpy };
});
mock.module("@loadout/wake", () => ({
  startWakeListener: startWakeListenerImpl,
}));

// runStreaming is referenced by the (mocked) wake spawn path; stub it so the
// import resolves without spawning anything.
mock.module("@loadout/exec", () => ({
  runFull: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  runStreaming: async () => ({ exitCode: 0 }),
}));

import WifiBackend from "./backend";

function makeBackend() {
  const events: EmitPayload[] = [];
  const backend = new WifiBackend();
  backend.emit = (p) => events.push(p);
  return { backend, events };
}

// Typed access to private members the wiring tests exercise directly:
// watchdogTick is only reachable through a real 12s interval otherwise.
interface BackendInternals {
  watchdogTick(): Promise<void>;
  refreshLastKnownDriver(): Promise<void>;
  recoveryTimer?: ReturnType<typeof setInterval>;
}
const internals = (backend: WifiBackend) => backend as unknown as BackendInternals;

describe("WiFi backend", () => {
  beforeEach(() => {
    enableImpl.mockClear();
    disableImpl.mockClear();
    getStatusImpl.mockClear();
    reassertImpl.mockClear();
    storage = {};
    capturedOnResume = null;
    stopSpy.mockClear();
    startWakeListenerImpl.mockClear();
    recoverImpl.mockClear();
    getWifiDeviceImpl.mockClear();
    detectDriverInfoImpl.mockClear();
    mutateSpy.mockClear();
    evaluateWatchdogImpl.mockClear();
    recordRecoveryOutcomeImpl.mockClear();
  });

  it("returns status merged with the persisted setting", async () => {
    const { backend } = makeBackend();
    await backend.onLoad();

    const status = await backend.getStatus();
    expect(status.iface).toBe("wlan0");
    expect(status.powerSaveDisabled).toBe(false);
    expect(status.listenerRunning).toBe(false);
    expect(getStatusImpl).toHaveBeenCalledTimes(1);
  });

  it("enables power-save-off: applies, persists, starts the wake listener, emits", async () => {
    const { backend, events } = makeBackend();
    await backend.onLoad();

    const res = await backend.setPowerSaveDisabled(true);
    expect(res.success).toBe(true);
    expect(enableImpl).toHaveBeenCalledTimes(1);
    expect(storage.powerSaveDisabled).toBe(true);
    expect(startWakeListenerImpl).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ event: "statusChanged", data: undefined }]);

    const status = await backend.getStatus();
    expect(status.listenerRunning).toBe(true);
  });

  it("disables power-save-off: reverts, persists, stops the wake listener", async () => {
    const { backend } = makeBackend();
    await backend.onLoad();
    await backend.setPowerSaveDisabled(true);

    const res = await backend.setPowerSaveDisabled(false);
    expect(res.success).toBe(true);
    expect(disableImpl).toHaveBeenCalledTimes(1);
    expect(storage.powerSaveDisabled).toBe(false);
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it("surfaces an enable failure without persisting or starting the listener", async () => {
    enableImpl.mockImplementationOnce(async () => ({
      success: false,
      iface: null,
      steps: [],
      error: "boom",
    }));
    const { backend, events } = makeBackend();
    await backend.onLoad();

    const res = await backend.setPowerSaveDisabled(true);
    expect(res.success).toBe(false);
    expect(res.error).toBe("boom");
    expect(storage.powerSaveDisabled).toBeUndefined();
    expect(startWakeListenerImpl).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("surfaces a disable failure and leaves the listener running", async () => {
    storage = { powerSaveDisabled: true };
    disableImpl.mockImplementationOnce(async () => ({
      success: false,
      iface: "wlan0",
      steps: [],
      error: "EROFS",
    }));
    const { backend } = makeBackend();
    await backend.onLoad(); // listener started from persisted setting

    const res = await backend.setPowerSaveDisabled(false);
    expect(res.success).toBe(false);
    expect(res.error).toBe("EROFS");
    // The persisted flag and the live listener are untouched on failure.
    expect(storage.powerSaveDisabled).toBe(true);
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it("swallows a reassert error on resume", async () => {
    reassertImpl.mockImplementationOnce(async () => {
      throw new Error("iw gone");
    });
    const { backend } = makeBackend();
    await backend.onLoad();
    await backend.setPowerSaveDisabled(true);

    expect(capturedOnResume).toBeTruthy();
    // Must not throw out of the resume callback.
    expect(() => capturedOnResume!()).not.toThrow();
    await Promise.resolve();
  });

  it("restores the wake listener on load when the setting was persisted", async () => {
    storage = { powerSaveDisabled: true };
    const { backend } = makeBackend();
    await backend.onLoad();
    expect(startWakeListenerImpl).toHaveBeenCalledTimes(1);

    const status = await backend.getStatus();
    expect(status.listenerRunning).toBe(true);
  });

  it("re-asserts runtime power-save on resume", async () => {
    const { backend } = makeBackend();
    await backend.onLoad();
    await backend.setPowerSaveDisabled(true);

    expect(capturedOnResume).toBeTruthy();
    capturedOnResume!();
    await Promise.resolve();
    expect(reassertImpl).toHaveBeenCalledTimes(1);
  });

  it("stops the listener on unload", async () => {
    storage = { powerSaveDisabled: true };
    const { backend } = makeBackend();
    await backend.onLoad();
    await backend.onUnload();
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it("captures the wifi driver into storage on load", async () => {
    const { backend } = makeBackend();
    await backend.onLoad();
    // refreshLastKnownDriver is fire-and-forget — let it settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(storage.lastKnownDriver).toEqual({
      driver: "iwlwifi",
      pciAddress: "0000:62:00.0",
      iface: "wlan0",
      updatedAt: 1,
    });
    await backend.onUnload();
  });

  it("recoverRadio runs a recovery, records it, and emits events", async () => {
    const { backend, events } = makeBackend();
    await backend.onLoad();

    const res = await backend.recoverRadio();
    expect(res.ok).toBe(true);
    expect(res.iface).toBe("wlan1");
    expect(recoverImpl).toHaveBeenCalledTimes(1);

    const phases = events
      .filter((e) => e.event === "recoveryState")
      .map((e) => (e.data as { phase: string }).phase);
    expect(phases).toEqual(["recovering", "recovered"]);
    expect(events.some((e) => e.event === "statusChanged")).toBe(true);

    const status = await backend.getStatus();
    expect(status.lastRecovery?.ok).toBe(true);
    expect(status.lastRecovery?.source).toBe("manual");
    expect(status.recovering).toBe(false);
    await backend.onUnload();
  });

  it("concurrent recoverRadio calls share a single run", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    recoverImpl.mockImplementationOnce(async () => {
      await gate;
      return {
        ok: true,
        stage: "done",
        tier: "modprobe",
        driver: "iwlwifi",
        iface: "wlan1",
        detail: "ok",
        durationMs: 5,
      };
    });
    const { backend } = makeBackend();
    await backend.onLoad();

    const first = backend.recoverRadio();
    const second = backend.recoverRadio();
    const status = await backend.getStatus();
    expect(status.recovering).toBe(true);

    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(recoverImpl).toHaveBeenCalledTimes(1);
    await backend.onUnload();
  });

  it("a failed recovery surfaces in lastRecovery and emits 'failed'", async () => {
    recoverImpl.mockImplementationOnce(async () => ({
      ok: false,
      stage: "pci-rescan",
      tier: "pci-rescan",
      driver: "iwlwifi",
      iface: null,
      detail: "Recovery exhausted",
      durationMs: 60_000,
    }));
    const { backend, events } = makeBackend();
    await backend.onLoad();

    const res = await backend.recoverRadio();
    expect(res.ok).toBe(false);
    const phases = events
      .filter((e) => e.event === "recoveryState")
      .map((e) => (e.data as { phase: string }).phase);
    expect(phases).toEqual(["recovering", "failed"]);

    const status = await backend.getStatus();
    expect(status.lastRecovery?.ok).toBe(false);
    expect(status.lastRecovery?.stage).toBe("pci-rescan");
    await backend.onUnload();
  });

  it("setAutoRecover persists the toggle and reflects it in status", async () => {
    const { backend, events } = makeBackend();
    await backend.onLoad();

    const on = await backend.setAutoRecover(true);
    expect(on.success).toBe(true);
    expect(storage.autoRecover).toBe(true);
    expect(events).toContainEqual({ event: "statusChanged", data: undefined });
    expect((await backend.getStatus()).autoRecover).toBe(true);

    const off = await backend.setAutoRecover(false);
    expect(off.success).toBe(true);
    expect(storage.autoRecover).toBe(false);
    expect((await backend.getStatus()).autoRecover).toBe(false);
    await backend.onUnload();
  });

  it("a firing watchdog tick runs a recovery with source 'watchdog'", async () => {
    evaluateWatchdogImpl.mockImplementationOnce((opts) => ({
      next: opts.state,
      fire: true,
      reason: "device-unavailable",
    }));
    const { backend } = makeBackend();
    await backend.onLoad();

    await internals(backend).watchdogTick();
    expect(recoverImpl).toHaveBeenCalledTimes(1);
    const status = await backend.getStatus();
    expect(status.lastRecovery?.source).toBe("watchdog");
    await backend.onUnload();
  });

  it("a tick during an in-flight manual recovery early-returns (no second run)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    recoverImpl.mockImplementationOnce(async () => {
      await gate;
      return {
        ok: true,
        stage: "done",
        tier: "modprobe",
        driver: "iwlwifi",
        iface: "wlan1",
        detail: "ok",
        durationMs: 5,
      };
    });
    const { backend } = makeBackend();
    await backend.onLoad();

    const manual = backend.recoverRadio();
    await internals(backend).watchdogTick();
    // Early return happens before sampling, so the reducer never ran.
    expect(evaluateWatchdogImpl).not.toHaveBeenCalled();

    release();
    await manual;
    expect(recoverImpl).toHaveBeenCalledTimes(1);
    await backend.onUnload();
  });

  it("a watchdog-fired precheck failure still counts toward suspension", async () => {
    // Unlike a manual button press, a watchdog-fired refusal (dead radio,
    // unresolvable driver) must feed the failure counter — otherwise the
    // watchdog would fire→refuse every cooldown forever.
    evaluateWatchdogImpl.mockImplementationOnce((opts) => ({
      next: opts.state,
      fire: true,
      reason: "device-missing",
    }));
    recoverImpl.mockImplementationOnce(async () => ({
      ok: false,
      stage: "precheck",
      tier: null,
      driver: null,
      iface: null,
      detail: "No WiFi driver known — open this plugin once while WiFi works, then retry.",
      durationMs: 1,
    }));
    const { backend } = makeBackend();
    await backend.onLoad();

    await internals(backend).watchdogTick();
    expect(recoverImpl).toHaveBeenCalledTimes(1);
    expect(recordRecoveryOutcomeImpl).toHaveBeenCalledTimes(1);
    await backend.onUnload();
  });

  it("precheck refusals don't feed the watchdog's failure counter; real failures do", async () => {
    recoverImpl.mockImplementationOnce(async () => ({
      ok: false,
      stage: "precheck",
      tier: null,
      driver: null,
      iface: null,
      detail: "WiFi is switched off (rfkill) — recovery skipped.",
      durationMs: 1,
    }));
    const { backend } = makeBackend();
    await backend.onLoad();

    await backend.recoverRadio();
    expect(recordRecoveryOutcomeImpl).not.toHaveBeenCalled();

    recoverImpl.mockImplementationOnce(async () => ({
      ok: false,
      stage: "unload",
      tier: "modprobe",
      driver: "iwlwifi",
      iface: null,
      detail: "Couldn't unload the driver: in use",
      durationMs: 100,
    }));
    await backend.recoverRadio();
    expect(recordRecoveryOutcomeImpl).toHaveBeenCalledTimes(1);
    await backend.onUnload();
  });

  it("refreshLastKnownDriver skips the storage write when nothing changed", async () => {
    const { backend } = makeBackend();
    await backend.onLoad();
    await new Promise((resolve) => setTimeout(resolve, 0)); // onLoad capture settles
    const writesAfterCapture = mutateSpy.mock.calls.length;
    expect(storage.lastKnownDriver).toBeTruthy();

    await internals(backend).refreshLastKnownDriver();
    expect(mutateSpy.mock.calls.length).toBe(writesAfterCapture);
    await backend.onUnload();
  });

  it("onLoad starts the watchdog when autoRecover was persisted", async () => {
    storage = { autoRecover: true };
    const { backend } = makeBackend();
    await backend.onLoad();
    expect(internals(backend).recoveryTimer).toBeTruthy();

    await backend.onUnload();
    expect(internals(backend).recoveryTimer).toBeUndefined();
  });

  it("getStatus keeps the legacy keys intact alongside the recovery keys", async () => {
    const { backend } = makeBackend();
    await backend.onLoad();

    const status = await backend.getStatus();
    // Legacy power-save surface (existing UI contract).
    expect(status.iface).toBe("wlan0");
    expect(status.powerSaveDisabled).toBe(false);
    expect(status.listenerRunning).toBe(false);
    // New recovery surface.
    expect(status.autoRecover).toBe(false);
    expect(status.recovering).toBe(false);
    expect(status.lastRecovery).toBeNull();
    expect(status.watchdogSuspended).toBe(false);
    await backend.onUnload();
  });
});
