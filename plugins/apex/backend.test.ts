import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { EmitPayload } from "@loadout/types";

/**
 * Apex backend tests.
 *
 * The backend's only real responsibilities are: gate everything on the
 * DMI check, and serialise recover(). We mock `./lib/dmi` (DMI probe)
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

mock.module("./lib/dmi", () => ({
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
    recoverImpl.mockClear();
    getStatusImpl.mockClear();
    hidOxpStatusImpl.mockClear();
    setHidOxpImpl.mockClear();
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
});
