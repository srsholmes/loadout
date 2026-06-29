import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import type { EmitPayload } from "@loadout/types";

/**
 * Apex backend tests.
 *
 * The backend's only real responsibilities are: gate everything on the
 * DMI check, and serialise recover(). We mock `@loadout/devices` (DMI probe)
 * and `./lib/xhci` (the rebind orchestration, tested separately) so
 * these tests assert the wiring — gating, the in-progress lock, and the
 * statusChanged emit — not the hardware logic.
 */

let isApexResult = true;
const recoverImpl = mock(async () => ({
  success: true,
  controller: "0000:65:00.4",
  steps: ["bind"],
  gamepadPresent: true,
}));
const getStatusImpl = mock(async () => ({
  pciDeviceExists: true,
  driverBound: true,
  gamepadPresent: true,
  controller: "0000:65:00.4",
  deadInLog: false,
  summary: "Controller healthy — nothing to do.",
}));

const hidOxpStatusImpl = mock(async () => ({
  blacklisted: false,
  moduleLoaded: true,
  rebootRequired: false,
}));
const setHidOxpImpl = mock(async () => ({
  blacklisted: true,
  moduleLoaded: true,
  rebootRequired: true,
}));
const fingerprintStatusImpl = mock(async () => ({
  supported: true,
  applied: false,
  rebootPending: false,
  kargActive: false,
  distro: "steamos",
}));
const applyFingerprintImpl = mock(async () => ({ success: true, rebootRequired: true, steps: [] }));
const revertFingerprintImpl = mock(async () => ({ success: true, rebootRequired: true, steps: [] }));

const driveFixture = {
  path: "/dev/nvme1n1p1",
  label: "Games",
  uuid: "GAME-1",
  fstype: "ext4",
  size: 1024 ** 4,
  mounted: false,
  mountpoint: null as string | null,
  suggestedMountpoint: "/run/media/deck/Games",
  steamLibraryFound: false,
  inFstab: false,
};
const storageStatusImpl = mock(async () => ({ drives: [{ ...driveFixture }] }));
const detectCandidatesImpl = mock(async () => [
  { path: "/dev/nvme1n1p1", label: "Games", uuid: "GAME-1", fstype: "ext4", size: 1024 ** 4 },
]);
const mountCandidateImpl = mock(async () => ({
  success: true,
  mountpoint: "/run/media/deck/Games",
  steamLibraryFound: true,
}));
const persistFstabImpl = mock(async () => ({ success: true }));
const unpersistFstabImpl = mock(async () => ({ success: true }));

mock.module("@loadout/devices", () => ({
  isApex: async () => isApexResult,
}));
mock.module("./lib/xhci", () => ({
  getStatus: getStatusImpl,
  recover: recoverImpl,
}));
mock.module("./lib/hid-oxp", () => ({
  getHidOxpStatus: hidOxpStatusImpl,
  setHidOxpBlacklist: setHidOxpImpl,
}));
mock.module("./lib/fingerprint", () => ({
  getStatus: fingerprintStatusImpl,
  apply: applyFingerprintImpl,
  revert: revertFingerprintImpl,
}));
mock.module("./lib/storage", () => ({
  getStorageStatus: storageStatusImpl,
  detectCandidates: detectCandidatesImpl,
  mountCandidate: mountCandidateImpl,
  persistFstab: persistFstabImpl,
  unpersistFstab: unpersistFstabImpl,
}));

// In-memory plugin storage so settings persist within a test without touching
// the real ~/.config/loadout file.
let storage: Record<string, unknown> = {};
mock.module("@loadout/plugin-storage", () => ({
  readPluginStorage: async () => ({ ...storage }),
  writePluginStorage: async (_id: string, next: Record<string, unknown>) => {
    storage = { ...next };
  },
}));

// Capture the resume callback and hand back a stop spy so we can assert the
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

import ApexBackend, { resolveTargetUser } from "./backend";

describe("resolveTargetUser", () => {
  const HOME = process.env.HOME;
  const USER = process.env.USER;
  afterEach(() => {
    if (HOME === undefined) delete process.env.HOME;
    else process.env.HOME = HOME;
    if (USER === undefined) delete process.env.USER;
    else process.env.USER = USER;
  });

  it("prefers the --user arg the system unit passes (space form)", () => {
    expect(resolveTargetUser(["loadout", "--user", "deck"])).toBe("deck");
  });

  it("accepts the --user=NAME form", () => {
    expect(resolveTargetUser(["loadout", "--user=alice"])).toBe("alice");
  });

  it("falls back to HOME's basename when there's no --user (root service)", () => {
    process.env.HOME = "/home/deck";
    expect(resolveTargetUser(["loadout"])).toBe("deck");
  });

  it("handles ostree-style /var/home/<user>", () => {
    process.env.HOME = "/var/home/bazzite";
    expect(resolveTargetUser(["loadout"])).toBe("bazzite");
  });

  it("never resolves to root from HOME=/root, using $USER instead", () => {
    process.env.HOME = "/root";
    process.env.USER = "deck";
    expect(resolveTargetUser(["loadout"])).toBe("deck");
  });
});

function makeBackend() {
  const events: EmitPayload[] = [];
  const backend = new ApexBackend();
  backend.emit = (p) => events.push(p);
  return { backend, events };
}

describe("Apex backend", () => {
  beforeEach(() => {
    isApexResult = true;
    recoverImpl.mockClear();
    getStatusImpl.mockClear();
    hidOxpStatusImpl.mockClear();
    setHidOxpImpl.mockClear();
    fingerprintStatusImpl.mockClear();
    applyFingerprintImpl.mockClear();
    revertFingerprintImpl.mockClear();
    storageStatusImpl.mockClear();
    detectCandidatesImpl.mockClear();
    mountCandidateImpl.mockClear();
    persistFstabImpl.mockClear();
    unpersistFstabImpl.mockClear();
    storage = {};
    capturedOnResume = null;
    stopSpy.mockClear();
    startWakeListenerImpl.mockClear();
  });

  it("marks itself unsupported on non-Apex hardware", async () => {
    isApexResult = false;
    const { backend } = makeBackend();
    await backend.onLoad();

    const status = await backend.getStatus();
    expect(status.unsupported).toBe(true);
    expect(status.status).toBeUndefined();
    expect(getStatusImpl).not.toHaveBeenCalled();
  });

  it("returns status on Apex hardware", async () => {
    const { backend } = makeBackend();
    await backend.onLoad();

    const status = await backend.getStatus();
    expect(status.unsupported).toBe(false);
    expect(status.status?.summary).toContain("healthy");
    expect(status.hidOxp).toEqual({
      blacklisted: false,
      moduleLoaded: true,
      rebootRequired: false,
    });
    expect(getStatusImpl).toHaveBeenCalledTimes(1);
    expect(hidOxpStatusImpl).toHaveBeenCalledTimes(1);
  });

  it("toggles the hid-oxp blacklist and emits statusChanged", async () => {
    const { backend, events } = makeBackend();
    await backend.onLoad();

    const res = await backend.setHidOxpBlacklist(true);
    expect(res.success).toBe(true);
    expect(res.hidOxp?.rebootRequired).toBe(true);
    expect(setHidOxpImpl).toHaveBeenCalledTimes(1);
    expect(setHidOxpImpl).toHaveBeenCalledWith(expect.anything(), true);
    expect(events).toEqual([{ event: "statusChanged", data: undefined }]);
  });

  it("refuses to toggle the hid-oxp blacklist on non-Apex hardware", async () => {
    isApexResult = false;
    const { backend } = makeBackend();
    await backend.onLoad();

    const res = await backend.setHidOxpBlacklist(true);
    expect(res.unsupported).toBe(true);
    expect(res.success).toBe(false);
    expect(setHidOxpImpl).not.toHaveBeenCalled();
  });

  it("refuses to recover on non-Apex hardware", async () => {
    isApexResult = false;
    const { backend } = makeBackend();
    await backend.onLoad();

    const res = await backend.recover();
    expect(res.unsupported).toBe(true);
    expect(res.success).toBe(false);
    expect(recoverImpl).not.toHaveBeenCalled();
  });

  it("runs recovery and emits statusChanged on Apex", async () => {
    const { backend, events } = makeBackend();
    await backend.onLoad();

    const res = await backend.recover();
    expect(res.success).toBe(true);
    expect(recoverImpl).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ event: "statusChanged", data: undefined }]);
  });

  it("rejects a concurrent recovery while one is in progress", async () => {
    const { backend } = makeBackend();
    await backend.onLoad();

    // Hold the first recover open so the second observes the lock.
    let release!: () => void;
    recoverImpl.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = () =>
            r({
              success: true,
              controller: "0000:65:00.4",
              steps: ["bind"],
              gamepadPresent: true,
            });
        }),
    );

    const first = backend.recover();
    const second = await backend.recover();
    expect(second.success).toBe(false);
    expect(second.error).toContain("already in progress");

    release();
    await first;
  });

  // ---------- auto-recover-on-wake ----------

  it("enabling auto-recover-on-wake persists the setting and starts the listener", async () => {
    const { backend, events } = makeBackend();
    await backend.onLoad();
    expect(startWakeListenerImpl).not.toHaveBeenCalled();

    const res = await backend.setAutoRecoverOnWake(true);
    expect(res.success).toBe(true);
    expect(storage.autoRecoverOnWake).toBe(true);
    expect(startWakeListenerImpl).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ event: "statusChanged", data: undefined }]);

    const status = await backend.getStatus();
    expect(status.autoRecoverOnWake).toBe(true);
    expect(status.listenerRunning).toBe(true);
  });

  it("disabling auto-recover-on-wake stops the listener and clears the flag", async () => {
    const { backend } = makeBackend();
    await backend.onLoad();
    await backend.setAutoRecoverOnWake(true);

    const res = await backend.setAutoRecoverOnWake(false);
    expect(res.success).toBe(true);
    expect(storage.autoRecoverOnWake).toBe(false);
    expect(stopSpy).toHaveBeenCalledTimes(1);

    const status = await backend.getStatus();
    expect(status.autoRecoverOnWake).toBe(false);
    expect(status.listenerRunning).toBe(false);
  });

  it("restores the wake listener on load when previously enabled", async () => {
    storage = { autoRecoverOnWake: true };
    const { backend } = makeBackend();
    await backend.onLoad();

    expect(startWakeListenerImpl).toHaveBeenCalledTimes(1);
    expect((await backend.getStatus()).listenerRunning).toBe(true);
  });

  it("does not start the listener on load when disabled", async () => {
    storage = { autoRecoverOnWake: false };
    const { backend } = makeBackend();
    await backend.onLoad();

    expect(startWakeListenerImpl).not.toHaveBeenCalled();
    expect((await backend.getStatus()).listenerRunning).toBe(false);
  });

  it("stops the wake listener on unload", async () => {
    storage = { autoRecoverOnWake: true };
    const { backend } = makeBackend();
    await backend.onLoad();
    expect(stopSpy).not.toHaveBeenCalled();

    await backend.onUnload();
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect((await backend.getStatus()).listenerRunning).toBe(false);
  });

  it("runs the guarded recovery when a resume fires", async () => {
    storage = { autoRecoverOnWake: true };
    const { backend } = makeBackend();
    await backend.onLoad();
    expect(capturedOnResume).not.toBeNull();

    // The resume handler waits RESUME_SETTLE_MS before recovering; the timer
    // is the only thing between the signal and recover(), so the call is
    // observable shortly after the settle window.
    capturedOnResume!();
    await new Promise((r) => setTimeout(r, 2_100));
    expect(recoverImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses to enable auto-recover-on-wake on non-Apex hardware", async () => {
    isApexResult = false;
    const { backend } = makeBackend();
    await backend.onLoad();

    const res = await backend.setAutoRecoverOnWake(true);
    expect(res.unsupported).toBe(true);
    expect(res.success).toBe(false);
    expect(startWakeListenerImpl).not.toHaveBeenCalled();
  });

  // ---------- game-storage detect & mount ----------

  it("includes storage in getStatus on Apex hardware", async () => {
    const { backend } = makeBackend();
    await backend.onLoad();

    const status = await backend.getStatus();
    expect(status.storage?.drives[0]?.uuid).toBe("GAME-1");
    expect(storageStatusImpl).toHaveBeenCalledTimes(1);
  });

  it("detectDrives returns the scan and candidates on Apex", async () => {
    const { backend } = makeBackend();
    await backend.onLoad();

    const res = await backend.detectDrives();
    expect(res.unsupported).toBeUndefined();
    expect(res.drives[0]?.uuid).toBe("GAME-1");
    expect(res.candidates?.[0]?.uuid).toBe("GAME-1");
    expect(detectCandidatesImpl).toHaveBeenCalledTimes(1);
  });

  it("detectDrives short-circuits on non-Apex hardware", async () => {
    isApexResult = false;
    const { backend } = makeBackend();
    await backend.onLoad();

    const res = await backend.detectDrives();
    expect(res.unsupported).toBe(true);
    expect(res.drives).toEqual([]);
    expect(detectCandidatesImpl).not.toHaveBeenCalled();
  });

  it("mountDrive mounts through the lib and emits statusChanged", async () => {
    const { backend, events } = makeBackend();
    await backend.onLoad();

    const res = await backend.mountDrive("GAME-1");
    expect(res.success).toBe(true);
    expect(res.mountpoint).toBe("/run/media/deck/Games");
    expect(res.steamLibraryFound).toBe(true);
    expect(mountCandidateImpl).toHaveBeenCalledWith(expect.anything(), { uuid: "GAME-1" });
    expect(events).toEqual([{ event: "statusChanged", data: undefined }]);
  });

  it("refuses to mount on non-Apex hardware", async () => {
    isApexResult = false;
    const { backend } = makeBackend();
    await backend.onLoad();

    const res = await backend.mountDrive("GAME-1");
    expect(res.unsupported).toBe(true);
    expect(res.success).toBe(false);
    expect(mountCandidateImpl).not.toHaveBeenCalled();
  });

  it("setDriveAutoMount(true) persists the resolved mount point", async () => {
    const { backend, events } = makeBackend();
    await backend.onLoad();

    const res = await backend.setDriveAutoMount("GAME-1", true);
    expect(res.success).toBe(true);
    expect(persistFstabImpl).toHaveBeenCalledWith(expect.anything(), {
      uuid: "GAME-1",
      mountpoint: "/run/media/deck/Games",
      fstype: "ext4",
    });
    expect(unpersistFstabImpl).not.toHaveBeenCalled();
    expect(events).toEqual([{ event: "statusChanged", data: undefined }]);
  });

  it("setDriveAutoMount(true) persists the live mount point when already mounted", async () => {
    storageStatusImpl.mockImplementationOnce(async () => ({
      drives: [{ ...driveFixture, mounted: true, mountpoint: "/run/media/deck/Games" }],
    }));
    const { backend } = makeBackend();
    await backend.onLoad();

    await backend.setDriveAutoMount("GAME-1", true);
    expect(persistFstabImpl).toHaveBeenCalledWith(expect.anything(), {
      uuid: "GAME-1",
      mountpoint: "/run/media/deck/Games",
      fstype: "ext4",
    });
  });

  it("setDriveAutoMount(false) removes the fstab entry without needing the drive", async () => {
    const { backend } = makeBackend();
    await backend.onLoad();

    const res = await backend.setDriveAutoMount("GAME-1", false);
    expect(res.success).toBe(true);
    expect(unpersistFstabImpl).toHaveBeenCalledWith(expect.anything(), { uuid: "GAME-1" });
    expect(persistFstabImpl).not.toHaveBeenCalled();
  });

  it("setDriveAutoMount errors when enabling for an unknown drive", async () => {
    storageStatusImpl.mockImplementationOnce(async () => ({ drives: [] }));
    const { backend } = makeBackend();
    await backend.onLoad();

    const res = await backend.setDriveAutoMount("MISSING", true);
    expect(res.success).toBe(false);
    expect(persistFstabImpl).not.toHaveBeenCalled();
  });

  it("refuses to set auto-mount on non-Apex hardware", async () => {
    isApexResult = false;
    const { backend } = makeBackend();
    await backend.onLoad();

    const res = await backend.setDriveAutoMount("GAME-1", true);
    expect(res.unsupported).toBe(true);
    expect(res.success).toBe(false);
    expect(persistFstabImpl).not.toHaveBeenCalled();
    expect(unpersistFstabImpl).not.toHaveBeenCalled();
  });
});
