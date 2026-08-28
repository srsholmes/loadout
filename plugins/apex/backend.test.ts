import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { EmitPayload } from "@loadout/types";
// Captured before the mock.module below replaces the module, so the heal
// decision under test is the real one rather than a stub that agrees with us.
import { shouldHeal as realShouldHeal } from "./lib/fingerprint";

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
let isOneXPlayerResult = true;
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
const removeHidOxpImpl = mock(async () => ({
  blacklisted: false,
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

mock.module("@loadout/devices", () => ({
  isApex: async () => isApexResult,
  isOneXPlayer: async () => isOneXPlayerResult,
}));
mock.module("./lib/xhci", () => ({
  getStatus: getStatusImpl,
  recover: recoverImpl,
}));
// Rumble control reads real sysfs unless given an fs, and these tests run on
// a machine that HAS OneXPlayer rumble hardware — so left unmocked it detects
// it, emits rumbleChanged during onLoad, and every exact-event assertion
// below fails depending on what's plugged in. Its own logic is covered in
// lib/rumble-control.test.ts.
const rumbleGetInfoSpy = mock(async () => ({
  available: false,
  devicePath: null,
  min: 0,
  max: 5,
  intensity: null,
  source: null,
}));
const rumbleRescanSpy = mock(async () => ({
  available: false,
  devicePath: null,
  min: 0,
  max: 5,
  intensity: null,
  source: null,
}));
mock.module("./lib/rumble-control", () => ({
  RumbleControl: class {
    async start() {}
    stop() {}
    async getInfo() {
      return rumbleGetInfoSpy();
    }
    async setIntensity() {
      return { success: false, error: "no hardware" };
    }
    async rescan() {
      return rumbleRescanSpy();
    }
  },
}));
mock.module("./lib/hid-oxp", () => ({
  getHidOxpStatus: hidOxpStatusImpl,
  removeHidOxpBlacklist: removeHidOxpImpl,
}));
mock.module("./lib/fingerprint", () => ({
  getStatus: fingerprintStatusImpl,
  apply: applyFingerprintImpl,
  revert: revertFingerprintImpl,
  shouldHeal: realShouldHeal,
}));

// In-memory plugin storage so settings persist within a test without touching
// the real ~/.config/loadout file.
let storage: Record<string, unknown> = {};
mock.module("@loadout/plugin-storage", () => ({
  readPluginStorage: async () => ({ ...storage }),
  writePluginStorage: async (_id: string, next: Record<string, unknown>) => {
    storage = { ...next };
  },
  mutatePluginStorage: async (
    _id: string,
    fn: (existing: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    storage = fn({ ...storage });
  },
}));

// systemctl reboot goes through @loadout/exec.
const runFullImpl = mock(async (_cmd: string[]) => ({ exitCode: 0, stdout: "", stderr: "" }));
mock.module("@loadout/exec", () => ({
  runFull: runFullImpl,
  runStreaming: mock(async () => ({ exitCode: 0 })),
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

import ApexBackend from "./backend";

function makeBackend() {
  const events: EmitPayload[] = [];
  const backend = new ApexBackend();
  backend.emit = (p) => events.push(p);
  return { backend, events };
}

describe("Apex backend", () => {
  beforeEach(() => {
    isApexResult = true;
    isOneXPlayerResult = true;
    recoverImpl.mockClear();
    getStatusImpl.mockClear();
    hidOxpStatusImpl.mockClear();
    removeHidOxpImpl.mockClear();
    fingerprintStatusImpl.mockClear();
    applyFingerprintImpl.mockClear();
    revertFingerprintImpl.mockClear();
    storage = {};
    capturedOnResume = null;
    stopSpy.mockClear();
    startWakeListenerImpl.mockClear();
  });

  it("runs on a OneXPlayer that isn't an Apex", async () => {
    // The X2 Mini Pro case. Gating the whole plugin on one model hid working
    // features from siblings on the same silicon: the fingerprint probe and
    // the xHCI recovery both detect their own hardware.
    isApexResult = false;
    isOneXPlayerResult = true;
    const { backend } = makeBackend();
    await backend.onLoad();

    const status = await backend.getStatus();
    expect(status.unsupported).toBe(false);
    expect(getStatusImpl).toHaveBeenCalled();
  });

  it("won't auto-stage the fingerprint karg on a board it hasn't measured", async () => {
    // The GPIO pin in KARG is board wiring. On a sibling we apply the
    // derived PME path but leave the bootloader alone.
    isApexResult = false;
    isOneXPlayerResult = true;
    const { backend } = makeBackend();
    await backend.onLoad();

    await backend.setFingerprintBlock(true);

    expect(applyFingerprintImpl).toHaveBeenCalledWith(expect.anything(), { autoKarg: false });
  });

  it("still auto-stages the karg on the Apex", async () => {
    isApexResult = true;
    isOneXPlayerResult = true;
    const { backend } = makeBackend();
    await backend.onLoad();

    await backend.setFingerprintBlock(true);

    expect(applyFingerprintImpl).toHaveBeenCalledWith(expect.anything(), { autoKarg: true });
  });

  it("marks itself unsupported on non-OneXPlayer hardware", async () => {
    isApexResult = false;
    isOneXPlayerResult = false;
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

  it("removes the hid-oxp blacklist and emits statusChanged", async () => {
    const { backend, events } = makeBackend();
    await backend.onLoad();

    const res = await backend.removeHidOxpBlacklist();
    expect(res.success).toBe(true);
    expect(res.hidOxp?.rebootRequired).toBe(true);
    expect(removeHidOxpImpl).toHaveBeenCalledTimes(1);
    // No second argument — removal is the only operation; there is
    // deliberately no way to apply the blacklist.
    expect(removeHidOxpImpl).toHaveBeenCalledWith(expect.anything());
    expect(events).toEqual([{ event: "statusChanged", data: undefined }]);
  });

  it("refuses to remove the hid-oxp blacklist on non-OneXPlayer hardware", async () => {
    isApexResult = false;
    isOneXPlayerResult = false;
    const { backend } = makeBackend();
    await backend.onLoad();

    const res = await backend.removeHidOxpBlacklist();
    expect(res.unsupported).toBe(true);
    expect(res.success).toBe(false);
    expect(removeHidOxpImpl).not.toHaveBeenCalled();
  });

  it("refuses to recover on non-OneXPlayer hardware", async () => {
    isApexResult = false;
    isOneXPlayerResult = false;
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

  it("refuses to enable auto-recover-on-wake on non-OneXPlayer hardware", async () => {
    isApexResult = false;
    isOneXPlayerResult = false;
    const { backend } = makeBackend();
    await backend.onLoad();

    const res = await backend.setAutoRecoverOnWake(true);
    expect(res.unsupported).toBe(true);
    expect(res.success).toBe(false);
    expect(startWakeListenerImpl).not.toHaveBeenCalled();
  });
});

describe("rumble RPCs on non-OneXPlayer hardware", () => {
  beforeEach(() => {
    rumbleRescanSpy.mockClear();
    rumbleGetInfoSpy.mockClear();
  });

  it("never touches the HID bus on a device this plugin is inert on", async () => {
    // Without the guard, rescanRumble would readdir the real
    // /sys/bus/hid/devices on a Steam Deck.
    isOneXPlayerResult = false;
    const { backend } = makeBackend();
    await backend.onLoad();

    const info = await backend.rescanRumble();
    expect(info.available).toBe(false);
    expect(rumbleRescanSpy).not.toHaveBeenCalled();

    expect((await backend.getRumbleInfo()).available).toBe(false);
    expect(rumbleGetInfoSpy).not.toHaveBeenCalled();
    expect((await backend.setRumbleIntensity(3)).success).toBe(false);
  });
});

describe("fingerprint self-heal", () => {
  beforeEach(() => {
    isApexResult = true;
    isOneXPlayerResult = true;
    storage = {};
    fingerprintStatusImpl.mockClear();
    applyFingerprintImpl.mockClear();
    revertFingerprintImpl.mockClear();
    runFullImpl.mockClear();
    // mockClear keeps implementations, so restore the defaults or a hanging
    // stub from one test silently times out the next.
    applyFingerprintImpl.mockImplementation(async () => ({
      success: true,
      rebootRequired: true,
      steps: [],
    }));
    runFullImpl.mockImplementation(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    // Default: drifted — enabled by the user, no longer in effect.
    fingerprintStatusImpl.mockImplementation(async () => ({
      supported: true,
      applied: false,
      kargUnpersisted: false,
      rebootPending: false,
      kargActive: false,
      distro: "steamos",
    }));
  });

  it("records the user's choice somewhere an OS update can't reach", async () => {
    // /etc is wiped by A/B updates, so the intent has to live in plugin
    // storage or the plugin can't tell "never wanted" from "update ate it".
    const { backend } = makeBackend();
    await backend.setFingerprintBlock(true);
    expect(storage.fingerprintBlock).toBe(true);
    await backend.setFingerprintBlock(false);
    expect(storage.fingerprintBlock).toBe(false);
  });

  it("re-applies the block at startup when it went missing", async () => {
    storage = { fingerprintBlock: true };
    const { backend } = makeBackend();
    await backend.onLoad();
    const notice = await backend.getFingerprintHealNotice();
    expect(applyFingerprintImpl).toHaveBeenCalledTimes(1);
    expect(notice?.restored).toBe(true);
  });

  it("adopts a block that was already on before this feature shipped", async () => {
    // Otherwise the users this exists for — who enabled it months ago — have
    // no stored flag and are never healed.
    storage = {};
    fingerprintStatusImpl.mockImplementation(async () => ({
      supported: true,
      applied: true,
      kargUnpersisted: false,
      rebootPending: false,
      kargActive: true,
      distro: "steamos",
    }));
    const { backend } = makeBackend();
    await backend.onLoad();
    await backend.getFingerprintHealNotice();
    expect(storage.fingerprintBlock).toBe(true);
    // Already in effect, so nothing to re-apply right now.
    expect(applyFingerprintImpl).not.toHaveBeenCalled();
  });

  it("does not adopt a block the user had switched off", async () => {
    storage = { fingerprintBlock: false };
    const { backend } = makeBackend();
    await backend.onLoad();
    await backend.getFingerprintHealNotice();
    expect(storage.fingerprintBlock).toBe(false);
    expect(applyFingerprintImpl).not.toHaveBeenCalled();
  });

  it("leaves a device alone whose owner never enabled it", async () => {
    storage = {};
    const { backend } = makeBackend();
    await backend.onLoad();
    await backend.getFingerprintHealNotice();
    expect(applyFingerprintImpl).not.toHaveBeenCalled();
  });

  it("does not block backend boot on the heal", async () => {
    // loadPlugins() awaits each onLoad in turn with no timeout and the HTTP
    // server doesn't start until that loop ends, so awaiting update-grub here
    // would stall the whole backend.
    storage = { fingerprintBlock: true };
    let release: (() => void) | null = null;
    let applyFinished = false;
    applyFingerprintImpl.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => {
            applyFinished = true;
            resolve({ success: true, rebootRequired: false, steps: [] });
          };
        }),
    );
    const { backend } = makeBackend();
    await backend.onLoad();

    // onLoad has already returned. Let the heal run on far enough to call
    // apply, and confirm apply is still pending — i.e. boot never waited.
    await new Promise((r) => setTimeout(r, 40));
    expect(applyFingerprintImpl).toHaveBeenCalledTimes(1);
    expect(applyFinished).toBe(false);

    release!();
    const notice = await backend.getFingerprintHealNotice();
    expect(notice?.restored).toBe(true);
  });

  it("keeps the notice readable until it has actually been shown", async () => {
    // Reading used to consume it, so the startup toast destroyed the notice
    // before the plugin page could ever render the same message — and a
    // webview reload lost it for good.
    storage = { fingerprintBlock: true };
    const { backend } = makeBackend();
    await backend.onLoad();
    expect((await backend.getFingerprintHealNotice())?.restored).toBe(true);
    expect((await backend.getFingerprintHealNotice())?.restored).toBe(true);

    await backend.ackFingerprintHealNotice();
    expect(await backend.getFingerprintHealNotice()).toBeNull();
  });

  it("does not overwrite an off recorded WHILE the status read was running", async () => {
    // The actual race: nothing stored when the heal starts, so the snapshot
    // says "undefined". Reading status shells out to lsusb and a sh loop, and
    // the user flips the block off in that window. Deciding from the snapshot
    // writes true over their explicit off — and the next boot re-applies a
    // block its owner turned off.
    storage = {};
    fingerprintStatusImpl.mockImplementation(async () => {
      storage = { ...storage, fingerprintBlock: false };
      return {
        supported: true,
        applied: true,
        kargUnpersisted: false,
        rebootPending: false,
        kargActive: true,
        distro: "steamos",
      };
    });
    const { backend } = makeBackend();
    await backend.onLoad();
    await backend.getFingerprintHealNotice();
    expect(storage.fingerprintBlock).toBe(false);
    expect(applyFingerprintImpl).not.toHaveBeenCalled();
  });

  it("does not overwrite an explicit off with the backfill", async () => {
    // The window that matters: status says applied (read seconds ago, before
    // the user flipped it off), storage now says false. Deciding from the
    // snapshot would re-enable a block its owner just turned off.
    storage = { fingerprintBlock: false };
    fingerprintStatusImpl.mockImplementation(async () => ({
      supported: true,
      applied: true,
      kargUnpersisted: false,
      rebootPending: false,
      kargActive: true,
      distro: "steamos",
    }));
    const { backend } = makeBackend();
    await backend.onLoad();
    await backend.getFingerprintHealNotice();
    expect(storage.fingerprintBlock).toBe(false);
    expect(applyFingerprintImpl).not.toHaveBeenCalled();
  });

  it("serialises a heal against a concurrent toggle", async () => {
    // apply/revert run steamos-readonly + update-grub; interleaving two of
    // them can leave the bootloader inconsistent.
    storage = { fingerprintBlock: true };
    let inFlight = 0;
    let overlapped = false;
    const track = async () => {
      inFlight++;
      if (inFlight > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 25));
      inFlight--;
      return { success: true, rebootRequired: false, steps: [] };
    };
    applyFingerprintImpl.mockImplementation(track);
    revertFingerprintImpl.mockImplementation(track);

    const { backend } = makeBackend();
    await backend.onLoad(); // heal starts, fire-and-forget
    await backend.setFingerprintBlock(false); // user toggles mid-heal
    await backend.getFingerprintHealNotice();
    expect(overlapped).toBe(false);
  });

  it("reports a failed re-apply instead of claiming success", async () => {
    storage = { fingerprintBlock: true };
    applyFingerprintImpl.mockImplementation(async () => ({
      success: false,
      rebootRequired: false,
      steps: [],
      error: "EACCES",
    }));
    const { backend } = makeBackend();
    await backend.onLoad();
    const notice = await backend.getFingerprintHealNotice();
    expect(notice?.restored).toBe(false);
    expect(notice?.error).toContain("EACCES");
  });

  it("survives a heal that throws, rather than losing the rest of onLoad", async () => {
    storage = { fingerprintBlock: true };
    fingerprintStatusImpl.mockImplementation(async () => {
      throw new Error("sysfs gone");
    });
    const { backend } = makeBackend();
    await backend.onLoad();
    expect(await backend.getFingerprintHealNotice()).toBeNull();
  });
});

describe("rebootDevice", () => {
  beforeEach(() => {
    isApexResult = true;
    isOneXPlayerResult = true;
    runFullImpl.mockClear();
    runFullImpl.mockImplementation(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  });

  it("reboots via systemctl", async () => {
    const { backend } = makeBackend();
    const res = await backend.rebootDevice();
    expect(res.success).toBe(true);
    expect(runFullImpl).toHaveBeenCalled();
    expect(runFullImpl.mock.calls[0]![0]).toEqual(["systemctl", "reboot"]);
  });

  it("refuses on hardware the rest of the plugin is inert on", async () => {
    // A root-privileged power-cycle should not be reachable where every
    // sibling RPC short-circuits.
    isOneXPlayerResult = false;
    const { backend } = makeBackend();
    await backend.onLoad();
    const res = await backend.rebootDevice();
    expect(res.success).toBe(false);
    expect(runFullImpl).not.toHaveBeenCalled();
  });

  it("surfaces a refusal instead of pretending it worked", async () => {
    runFullImpl.mockImplementation(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "Interactive authentication required",
    }));
    const { backend } = makeBackend();
    const res = await backend.rebootDevice();
    expect(res.success).toBe(false);
    expect(res.error).toContain("Interactive authentication");
  });
});
