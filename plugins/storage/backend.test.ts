import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import type { EmitPayload } from "@loadout/types";

/**
 * Storage backend tests.
 *
 * The backend's only job is wiring: hand the real exec/fs deps to the
 * (separately-tested) ./lib/storage orchestration and emit statusChanged
 * after a mutation. We mock ./lib/storage so these assert the wiring —
 * the RPC surface and the emits — not the disk logic. The plugin is never
 * gated, so there's no support check to test.
 */

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
const mountCandidateImpl = mock(async () => ({
  success: true,
  mountpoint: "/run/media/deck/Games",
  steamLibraryFound: true,
}));
const persistFstabImpl = mock(async () => ({ success: true }));
const unpersistFstabImpl = mock(async () => ({ success: true }));

mock.module("./lib/storage", () => ({
  getStorageStatus: storageStatusImpl,
  mountCandidate: mountCandidateImpl,
  persistFstab: persistFstabImpl,
  unpersistFstab: unpersistFstabImpl,
}));

import StorageBackend, { resolveTargetUser } from "./backend";

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
  const backend = new StorageBackend();
  backend.emit = (p) => events.push(p);
  return { backend, events };
}

describe("Storage backend", () => {
  beforeEach(() => {
    storageStatusImpl.mockClear();
    mountCandidateImpl.mockClear();
    persistFstabImpl.mockClear();
    unpersistFstabImpl.mockClear();
  });

  it("getStatus returns the storage status", async () => {
    const { backend } = makeBackend();
    await backend.onLoad();

    const status = await backend.getStatus();
    expect(status.drives[0]?.uuid).toBe("GAME-1");
    expect(storageStatusImpl).toHaveBeenCalledTimes(1);
  });

  it("detectDrives re-scans and returns the storage status", async () => {
    const { backend } = makeBackend();

    const res = await backend.detectDrives();
    expect(res.drives[0]?.uuid).toBe("GAME-1");
    expect(storageStatusImpl).toHaveBeenCalledTimes(1);
  });

  it("mountDrive mounts through the lib and emits statusChanged", async () => {
    const { backend, events } = makeBackend();

    const res = await backend.mountDrive("GAME-1");
    expect(res.success).toBe(true);
    expect(res.mountpoint).toBe("/run/media/deck/Games");
    expect(res.steamLibraryFound).toBe(true);
    expect(mountCandidateImpl).toHaveBeenCalledWith(expect.anything(), { uuid: "GAME-1" });
    expect(events).toEqual([{ event: "statusChanged", data: undefined }]);
  });

  it("mountDrive rejects an empty uuid without calling the lib", async () => {
    const { backend, events } = makeBackend();

    const res = await backend.mountDrive("");
    expect(res.success).toBe(false);
    expect(mountCandidateImpl).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("setDriveAutoMount(true) persists the resolved mount point", async () => {
    const { backend, events } = makeBackend();

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

    await backend.setDriveAutoMount("GAME-1", true);
    expect(persistFstabImpl).toHaveBeenCalledWith(expect.anything(), {
      uuid: "GAME-1",
      mountpoint: "/run/media/deck/Games",
      fstype: "ext4",
    });
  });

  it("setDriveAutoMount(false) removes the fstab entry without needing the drive", async () => {
    const { backend } = makeBackend();

    const res = await backend.setDriveAutoMount("GAME-1", false);
    expect(res.success).toBe(true);
    expect(unpersistFstabImpl).toHaveBeenCalledWith(expect.anything(), { uuid: "GAME-1" });
    expect(persistFstabImpl).not.toHaveBeenCalled();
  });

  it("setDriveAutoMount errors when enabling for an unknown drive", async () => {
    storageStatusImpl.mockImplementationOnce(async () => ({ drives: [] }));
    const { backend } = makeBackend();

    const res = await backend.setDriveAutoMount("MISSING", true);
    expect(res.success).toBe(false);
    expect(persistFstabImpl).not.toHaveBeenCalled();
  });

  it("setDriveAutoMount rejects an empty uuid", async () => {
    const { backend } = makeBackend();

    const res = await backend.setDriveAutoMount("", true);
    expect(res.success).toBe(false);
    expect(persistFstabImpl).not.toHaveBeenCalled();
    expect(unpersistFstabImpl).not.toHaveBeenCalled();
  });
});
