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

// In-memory plugin storage so settings persist within a test.
let storage: Record<string, unknown> = {};
mock.module("@loadout/plugin-storage", () => ({
  readPluginStorage: async () => ({ ...storage }),
  writePluginStorage: async (_id: string, next: Record<string, unknown>) => {
    storage = { ...next };
  },
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
});
