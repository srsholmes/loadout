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
  fstabLine: null as string | null,
};
const storageStatusImpl = mock(async () => ({ drives: [{ ...driveFixture }] }));
const mountCandidateImpl = mock(async () => ({
  success: true,
  mountpoint: "/run/media/deck/Games",
  steamLibraryFound: true,
}));
const persistFstabImpl = mock(async (_deps: unknown, _o: unknown) => ({
  success: true,
  error: undefined as string | undefined,
}));
const unpersistFstabImpl = mock(async () => ({ success: true }));
const reconcileImpl = mock(
  async (
    _deps: unknown,
    _o: { drive: { uuid: string }; wanted: boolean; storedLine?: string },
  ) => ({
    repinned: false,
    remounted: false,
    unpinned: false,
    error: undefined as string | undefined,
  }),
);

import * as actualStorage from "./lib/storage";
mock.module("./lib/storage", () => ({
  ...actualStorage,
  getStorageStatus: storageStatusImpl,
  mountCandidate: mountCandidateImpl,
  persistFstab: persistFstabImpl,
  unpersistFstab: unpersistFstabImpl,
  reconcileAutoMount: reconcileImpl,
}));

// Plugin storage is the whole point of the reconcile — it's the record that
// outlives an A/B update — so it's an in-memory fake, never the real $HOME.
let stored: Record<string, unknown> = {};
/** Simulates a full or read-only $HOME for the intent-recording path. */
let mutateThrows = false;
mock.module("@loadout/plugin-storage", () => ({
  readPluginStorage: async () => ({ ...stored }),
  writePluginStorage: async (_id: string, next: Record<string, unknown>) => {
    stored = { ...next };
  },
  mutatePluginStorage: async (
    _id: string,
    fn: (existing: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    if (mutateThrows) throw new Error("ENOSPC: no space left on device");
    stored = fn({ ...stored });
  },
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

/**
 * Wait for the DETACHED re-scan passes.
 *
 * `getHealNotice` deliberately resolves after the first pass — making it wait
 * out the whole window meant a dropped WebSocket lost the toast — so anything
 * asserting on a later pass has to wait for it here.
 */
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function makeBackend(opts: { rescanDelays?: readonly number[] } = {}) {
  const events: EmitPayload[] = [];
  // Default to no re-scan window so tests don't wait real seconds; the
  // re-scan itself is exercised explicitly below.
  const backend = new StorageBackend({ rescanDelays: opts.rescanDelays ?? [] });
  backend.emit = (p) => events.push(p);
  return { backend, events };
}

describe("Storage backend", () => {
  beforeEach(() => {
    stored = {};
    storageStatusImpl.mockClear();
    mountCandidateImpl.mockClear();
    persistFstabImpl.mockClear();
    unpersistFstabImpl.mockClear();
    reconcileImpl.mockClear();
    // mockClear keeps implementations, so restore the defaults or a stub set
    // by one test silently changes the next.
    storageStatusImpl.mockImplementation(async () => ({ drives: [{ ...driveFixture }] }));
    persistFstabImpl.mockImplementation(async () => ({ success: true, error: undefined }));
    reconcileImpl.mockImplementation(async () => ({
      repinned: false,
      remounted: false,
      unpinned: false,
      error: undefined,
    }));
  });

  it("getStatus returns the storage status", async () => {
    const { backend } = makeBackend();

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

describe("boot reconcile", () => {
  const managedLine =
    "UUID=GAME-1 /run/media/deck/Games ext4 defaults,nofail,x-systemd.device-timeout=10s 0 2";
  const mountedPinned = {
    ...driveFixture,
    mounted: true,
    mountpoint: "/run/media/deck/Games",
    inFstab: true,
    fstabLine: managedLine,
  };

  beforeEach(() => {
    stored = {};
    storageStatusImpl.mockClear();
    reconcileImpl.mockClear();
    persistFstabImpl.mockClear();
    unpersistFstabImpl.mockClear();
    storageStatusImpl.mockImplementation(async () => ({ drives: [{ ...driveFixture }] }));
    // mockClear keeps implementations. Without this line every test after the
    // "read-only" one below ran with persistFstab FAILING — including the one
    // that reads as testing the success path.
    persistFstabImpl.mockImplementation(async () => ({ success: true, error: undefined }));
    reconcileImpl.mockImplementation(async () => ({
      repinned: false,
      remounted: false,
      unpinned: false,
      error: undefined,
    }));
  });

  it("records the user's choice somewhere an OS update can't reach", async () => {
    // /etc is regenerated by an A/B or rpm-ostree update, so intent stored in
    // fstab cannot survive one.
    const { backend } = makeBackend();
    await backend.setDriveAutoMount("GAME-1", true);
    expect(stored.autoMount).toEqual({
      "game-1": { enabled: true, line: managedLine, adopted: false },
    });
    await backend.setDriveAutoMount("GAME-1", false);
    expect((stored.autoMount as Record<string, { enabled: boolean }>)["game-1"]?.enabled).toBe(
      false,
    );
  });

  it("keeps the line it wrote when the drive is switched off and on again", async () => {
    // The line is the only record of an adopted entry's own options; dropping
    // it on "off" would mean re-deriving a canonical one on the next "on".
    const { backend } = makeBackend();
    await backend.setDriveAutoMount("GAME-1", true);
    await backend.setDriveAutoMount("GAME-1", false);
    expect((stored.autoMount as Record<string, { line?: string }>)["game-1"]?.line).toBe(
      managedLine,
    );
  });

  it("keeps the recorded choice even when the fstab write fails", async () => {
    // Otherwise a transient read-only /etc loses the intent as well as the
    // entry, and the next boot has nothing to heal from.
    persistFstabImpl.mockImplementation(async () => ({ success: false, error: "read-only" }));
    const { backend } = makeBackend();
    const res = await backend.setDriveAutoMount("GAME-1", true);
    expect(res.success).toBe(false);
    expect((stored.autoMount as Record<string, { enabled: boolean }>)["game-1"]?.enabled).toBe(
      true,
    );
  });

  it("does not record a line for a write that failed", async () => {
    // Storing a line we never managed to write would have the reconcile
    // "restore" an entry that was never there.
    persistFstabImpl.mockImplementation(async () => ({ success: false, error: "read-only" }));
    const { backend } = makeBackend();
    await backend.setDriveAutoMount("GAME-1", true);
    expect((stored.autoMount as Record<string, { line?: string }>)["game-1"]?.line).toBeUndefined();
  });

  it("stores the uuid lowercased so case can't split one drive in two", async () => {
    const { backend } = makeBackend();
    await backend.setDriveAutoMount("GAME-1", true);
    await backend.setDriveAutoMount("game-1", false);
    expect(Object.keys(stored.autoMount as object)).toEqual(["game-1"]);
  });

  it("restores a wanted drive at startup", async () => {
    stored = { autoMount: { "game-1": { enabled: true, line: managedLine } } };
    reconcileImpl.mockImplementation(async () => ({
      repinned: true,
      remounted: true,
      unpinned: false,
      error: undefined,
    }));
    const { backend, events } = makeBackend();
    await backend.onLoad();

    const notice = await backend.getHealNotice();
    expect(reconcileImpl).toHaveBeenCalledTimes(1);
    expect(reconcileImpl.mock.calls[0]![1]).toMatchObject({
      wanted: true,
      storedLine: managedLine,
    });
    expect(notice).toEqual({
      repinned: ["Games"],
      remounted: ["Games"],
      unpinned: [],
      failed: [],
    });
    expect(events).toEqual([{ event: "statusChanged", data: undefined }]);
  });

  it("adopts a pin that was already in place, storing the line verbatim", async () => {
    // Adoption does not imply authorship: most pinned entries were written by
    // the machine's owner, and the line is the only record of their options.
    const custom = "UUID=GAME-1 /mnt/games btrfs defaults,noatime,compress=zstd,subvol=@games 0 0";
    storageStatusImpl.mockImplementation(async () => ({
      drives: [{ ...mountedPinned, fstabLine: custom }],
    }));
    const { backend } = makeBackend();
    await backend.onLoad();
    await backend.getHealNotice();

    expect(stored.autoMount).toEqual({
      "game-1": { enabled: true, line: custom, adopted: true },
    });
  });

  it("backfills the fstab line for someone who enabled this before it shipped", async () => {
    // They have intent stored but no line, so an update would have us
    // "restore" a canonical entry over their own hand-written one.
    const custom = "UUID=GAME-1 /mnt/games btrfs defaults,noatime,subvol=@games 0 0";
    stored = { autoMount: { "game-1": true } };
    storageStatusImpl.mockImplementation(async () => ({
      drives: [{ ...mountedPinned, fstabLine: custom }],
    }));
    const { backend } = makeBackend();
    await backend.onLoad();
    await backend.getHealNotice();

    expect(stored.autoMount).toEqual({
      "game-1": { enabled: true, line: custom, adopted: true },
    });
  });

  it("never resurrects an explicit off while backfilling", async () => {
    stored = { autoMount: { "game-1": false } };
    storageStatusImpl.mockImplementation(async () => ({ drives: [{ ...mountedPinned }] }));
    const { backend } = makeBackend();
    await backend.onLoad();
    await backend.getHealNotice();

    expect((stored.autoMount as Record<string, { enabled: boolean }>)["game-1"]?.enabled).toBe(
      false,
    );
  });

  it("does not adopt a drive the user switched off", async () => {
    stored = { autoMount: { "game-1": { enabled: false } } };
    storageStatusImpl.mockImplementation(async () => ({ drives: [{ ...mountedPinned }] }));
    const { backend } = makeBackend();
    await backend.onLoad();
    await backend.getHealNotice();

    expect((stored.autoMount as Record<string, { enabled: boolean }>)["game-1"]?.enabled).toBe(
      false,
    );
    expect(reconcileImpl.mock.calls[0]![1]).toMatchObject({ wanted: false });
  });

  it("reconciles a switched-off drive so a failed unpin self-corrects", async () => {
    // Turning the toggle off with a failing write left stored=false against a
    // pinned fstab: toggle reads off, drive mounts every boot, forever.
    stored = { autoMount: { "game-1": { enabled: false } } };
    storageStatusImpl.mockImplementation(async () => ({ drives: [{ ...mountedPinned }] }));
    reconcileImpl.mockImplementation(async () => ({
      repinned: false,
      remounted: false,
      unpinned: true,
      error: undefined,
    }));
    const { backend } = makeBackend();
    await backend.onLoad();

    expect((await backend.getHealNotice())?.unpinned).toEqual(["Games"]);
  });

  it("leaves a drive alone whose owner never asked for a boot mount", async () => {
    // driveFixture is unpinned and has no stored intent.
    const { backend } = makeBackend();
    await backend.onLoad();

    expect(await backend.getHealNotice()).toBeNull();
    expect(reconcileImpl).not.toHaveBeenCalled();
  });

  it("says nothing when the wanted drive was already fine", async () => {
    // Every boot after a healthy one lands here. A notice would toast "we
    // fixed something" at a user whose drives never broke.
    stored = { autoMount: { "game-1": { enabled: true } } };
    const { backend, events } = makeBackend();
    await backend.onLoad();

    expect(await backend.getHealNotice()).toBeNull();
    expect(reconcileImpl).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
  });

  it("reports a failed restore instead of claiming success", async () => {
    stored = { autoMount: { "game-1": { enabled: true } } };
    reconcileImpl.mockImplementation(async () => ({
      repinned: false,
      remounted: false,
      unpinned: false,
      error: "mount: wrong fs type",
    }));
    const { backend } = makeBackend();
    await backend.onLoad();

    const notice = await backend.getHealNotice();
    expect(notice?.failed).toEqual([{ name: "Games", error: "mount: wrong fs type" }]);
  });

  it("reads the pre-0.9 boolean shape rather than losing everyone's intent", async () => {
    stored = { autoMount: { "game-1": true } };
    const { backend } = makeBackend();
    await backend.onLoad();
    await backend.getHealNotice();

    expect(reconcileImpl.mock.calls[0]![1]).toMatchObject({ wanted: true });
    expect((await backend.getStatus()).drives[0]?.autoMountWanted).toBe(true);
  });

  it("one drive failing hard doesn't discard another's notice or skip the rest", async () => {
    // mountCandidate runs a subprocess; a spawn failure rejects, and an
    // unguarded rejection aborted the loop and threw away everything.
    storageStatusImpl.mockImplementation(async () => ({
      drives: [
        { ...driveFixture, uuid: "GAME-1", label: "Games" },
        { ...driveFixture, uuid: "GAME-2", label: "Boom" },
        { ...driveFixture, uuid: "GAME-3", label: "SD" },
      ],
    }));
    stored = {
      autoMount: {
        "game-1": { enabled: true },
        "game-2": { enabled: true },
        "game-3": { enabled: true },
      },
    };
    reconcileImpl.mockImplementation(async (_d, o) => {
      if (o.drive.uuid === "GAME-2") throw new Error("spawn EAGAIN");
      return { repinned: true, remounted: false, unpinned: false, error: undefined };
    });
    const { backend } = makeBackend();
    await backend.onLoad();

    const notice = await backend.getHealNotice();
    expect(notice?.repinned).toEqual(["Games", "SD"]);
    expect(notice?.failed[0]?.name).toBe("Boom");
  });

  it("re-scans for a wanted drive that hasn't enumerated yet", async () => {
    // The slow-to-enumerate drive is the whole point of the reconcile, and a
    // single-shot lsblk is exactly what can't see it.
    stored = { autoMount: { "sd-card": { enabled: true } } };
    let scans = 0;
    storageStatusImpl.mockImplementation(async () => {
      scans++;
      return scans < 3
        ? { drives: [] }
        : { drives: [{ ...driveFixture, uuid: "SD-CARD", label: "SD" }] };
    });
    reconcileImpl.mockImplementation(async () => ({
      repinned: true,
      remounted: true,
      unpinned: false,
      error: undefined,
    }));
    const { backend } = makeBackend({ rescanDelays: [1, 1, 1, 1] });
    await backend.onLoad();
    await settle();

    const notice = await backend.getHealNotice();
    expect(notice?.remounted).toEqual(["SD"]);
  });

  it("gives up re-scanning for a drive that simply isn't attached", async () => {
    // An SD card left at home must not cost the full window on every boot,
    // nor produce an error notice.
    stored = { autoMount: { "sd-card": { enabled: true } } };
    storageStatusImpl.mockImplementation(async () => ({ drives: [] }));
    const { backend } = makeBackend({ rescanDelays: [1, 1] });
    await backend.onLoad();
    await settle();

    expect(await backend.getHealNotice()).toBeNull();
    expect(storageStatusImpl).toHaveBeenCalledTimes(3); // initial + 2 re-scans
    expect(reconcileImpl).not.toHaveBeenCalled();
  });

  it("doesn't re-scan when every wanted drive is already present", async () => {
    stored = { autoMount: { "game-1": { enabled: true } } };
    const { backend } = makeBackend({ rescanDelays: [1, 1, 1] });
    await backend.onLoad();
    await settle();

    expect(storageStatusImpl).toHaveBeenCalledTimes(1);
  });

  it("stops a pending re-scan on unload", async () => {
    stored = { autoMount: { "sd-card": { enabled: true } } };
    storageStatusImpl.mockImplementation(async () => ({ drives: [] }));
    const { backend } = makeBackend({ rescanDelays: [20, 20, 20, 20] });
    await backend.onLoad();
    await backend.onUnload();
    const scansAtUnload = storageStatusImpl.mock.calls.length;
    await settle(120);

    expect(storageStatusImpl.mock.calls.length).toBeLessThanOrEqual(scansAtUnload + 1);
  });

  it("getHealNotice awaits an in-flight reconcile rather than racing it", async () => {
    // The backend starts before the overlay connects and emit has no replay,
    // so a notice read that returned null while the heal was still running
    // would lose the message entirely.
    stored = { autoMount: { "game-1": { enabled: true } } };
    let release: (() => void) | null = null;
    reconcileImpl.mockImplementation(async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return { repinned: true, remounted: false, unpinned: false, error: undefined };
    });
    const { backend } = makeBackend();
    await backend.onLoad(); // returns without waiting for the reconcile

    const pending = backend.getHealNotice();
    await new Promise((r) => setTimeout(r, 5));
    release!();
    expect((await pending)?.repinned).toEqual(["Games"]);
  });

  it("lets the toast and the page each consume the notice once", async () => {
    // A single shared flag meant the toast — which fires on the first overlay
    // open, before any navigation — acked it and the page always read null.
    stored = { autoMount: { "game-1": { enabled: true } } };
    reconcileImpl.mockImplementation(async () => ({
      repinned: true,
      remounted: false,
      unpinned: false,
      error: undefined,
    }));
    const { backend } = makeBackend();
    await backend.onLoad();

    expect(await backend.getHealNotice("toast")).not.toBeNull();
    await backend.ackHealNotice("toast");
    expect(await backend.getHealNotice("toast")).toBeNull(); // toast is done
    expect(await backend.getHealNotice("page")).not.toBeNull(); // page still gets it
    await backend.ackHealNotice("page");
    expect(await backend.getHealNotice("page")).toBeNull();
  });

  it("keeps whatever it managed before an unexpected failure", async () => {
    stored = { autoMount: { "game-1": { enabled: true } } };
    reconcileImpl.mockImplementation(async () => {
      throw new Error("lsblk exploded");
    });
    const { backend } = makeBackend();
    await backend.onLoad();

    expect((await backend.getHealNotice())?.failed[0]?.error).toContain("lsblk exploded");
  });

  it("getStatus reports stored intent, not the wiped /etc state", async () => {
    // The toggle binds to this. After an update eats the entry, a toggle fed
    // from inFstab would show off and quietly agree the user never wanted it.
    stored = { autoMount: { "game-1": { enabled: true } } };
    const { backend } = makeBackend();

    const status = await backend.getStatus();
    expect(status.drives[0]?.inFstab).toBe(false);
    expect(status.drives[0]?.autoMountWanted).toBe(true);
  });

  it("getStatus falls back to the fstab state when nothing is stored", async () => {
    storageStatusImpl.mockImplementation(async () => ({ drives: [{ ...mountedPinned }] }));
    const { backend } = makeBackend();

    expect((await backend.getStatus()).drives[0]?.autoMountWanted).toBe(true);
  });
});

describe("things the reconcile must not get wrong twice", () => {
  const managedLine =
    "UUID=GAME-1 /run/media/deck/Games ext4 defaults,nofail,x-systemd.device-timeout=10s 0 2";
  const custom = "UUID=GAME-1 /mnt/games btrfs defaults,noatime,subvol=@games 0 0";

  beforeEach(() => {
    stored = {};
    storageStatusImpl.mockClear();
    reconcileImpl.mockClear();
    persistFstabImpl.mockClear();
    unpersistFstabImpl.mockClear();
    storageStatusImpl.mockImplementation(async () => ({ drives: [{ ...driveFixture }] }));
    persistFstabImpl.mockImplementation(async () => ({ success: true, error: undefined }));
    reconcileImpl.mockImplementation(async () => ({
      repinned: false,
      remounted: false,
      unpinned: false,
      error: undefined,
    }));
  });

  it("serialises the whole toggle, so a concurrent off isn't undone", async () => {
    // A wrote intent outside the lock, parked on lsblk, then re-wrote it
    // after B's "off" had landed: fstab ended with no entry but intent `true`,
    // so the toggle sprang back on and the next boot re-pinned the drive.
    let releaseA: (() => void) | null = null;
    storageStatusImpl.mockImplementation(async () => {
      if (!releaseA) await new Promise<void>((r) => (releaseA = r));
      return { drives: [{ ...driveFixture }] };
    });
    const { backend } = makeBackend();

    const a = backend.setDriveAutoMount("GAME-1", true);
    await new Promise((r) => setTimeout(r, 5));
    const b = backend.setDriveAutoMount("GAME-1", false);
    await new Promise((r) => setTimeout(r, 5));
    releaseA?.();
    await Promise.all([a, b]);

    // B ran entirely after A, so the last word is "off" — and it stays off.
    expect((stored.autoMount as Record<string, { enabled: boolean }>)["game-1"]?.enabled).toBe(
      false,
    );
    expect(unpersistFstabImpl).toHaveBeenCalled();
  });

  it("retries a drive whose reconcile failed transiently", async () => {
    // "device busy" while udev settles is exactly what the window is for;
    // marking the drive handled before the attempt meant it never retried.
    stored = { autoMount: { "game-1": { enabled: true } } };
    let calls = 0;
    reconcileImpl.mockImplementation(async () => {
      calls++;
      return calls < 3
        ? { repinned: false, remounted: false, unpinned: false, error: "device busy" }
        : { repinned: true, remounted: true, unpinned: false, error: undefined };
    });
    const { backend } = makeBackend({ rescanDelays: [1, 1, 1, 1] });
    await backend.onLoad();
    await settle();

    const notice = await backend.getHealNotice();
    expect(calls).toBe(3);
    expect(notice?.remounted).toEqual(["Games"]);
    expect(notice?.failed).toEqual([]); // the earlier failure is retracted
  });

  it("keeps re-scanning when the only wanted drive is the failing one", async () => {
    // `handled` made `missing` false, so the loop exited at attempt 0.
    stored = { autoMount: { "game-1": { enabled: true } } };
    reconcileImpl.mockImplementation(async () => ({
      repinned: false,
      remounted: false,
      unpinned: false,
      error: "device busy",
    }));
    const { backend } = makeBackend({ rescanDelays: [1, 1] });
    await backend.onLoad();
    await settle();

    expect(reconcileImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("adopts a drive that only appears on a later scan", async () => {
    // Adoption gated on attempt 0 meant a slow-enumerating pinned drive was
    // never adopted, never mounted, and unhealable after the next update.
    let scans = 0;
    storageStatusImpl.mockImplementation(async () => {
      scans++;
      return scans < 2
        ? { drives: [] }
        : {
            drives: [{ ...driveFixture, mounted: true, inFstab: true, fstabLine: custom }],
          };
    });
    const { backend } = makeBackend({ rescanDelays: [1, 1, 1] });
    await backend.onLoad();
    await settle();

    expect(stored.autoMount).toEqual({
      "game-1": { enabled: true, line: custom, adopted: true },
    });
  });

  it("heals the drives even when recording intent fails", async () => {
    // Adoption is an optimisation; a full or read-only $HOME must not cancel
    // every fstab operation that would have succeeded.
    stored = { autoMount: { "game-1": { enabled: true } } };
    storageStatusImpl.mockImplementation(async () => ({
      drives: [{ ...driveFixture, inFstab: true, fstabLine: managedLine }],
    }));
    mutateThrows = true;
    reconcileImpl.mockImplementation(async () => ({
      repinned: true,
      remounted: false,
      unpinned: false,
      error: undefined,
    }));
    const { backend } = makeBackend();
    await backend.onLoad();

    expect((await backend.getHealNotice())?.repinned).toEqual(["Games"]);
    mutateThrows = false;
  });

  it("never lets our canonical line evict an adopted one", async () => {
    // The toggle always supplies a line, so `line ?? priorLine` meant one
    // off/on round-trip replaced subvol=@games with our ext4 default and
    // destroyed the last record of the user's options.
    storageStatusImpl.mockImplementation(async () => ({
      drives: [{ ...driveFixture, mounted: true, inFstab: true, fstabLine: custom }],
    }));
    storageStatusImpl.mockImplementation(async () => ({
      drives: [
        {
          ...driveFixture,
          mounted: true,
          inFstab: true,
          fstabLine: custom,
          externallyPinned: true,
        },
      ],
    }));
    const { backend } = makeBackend();
    await backend.onLoad();
    await backend.getHealNotice();

    // Refused on both edges — the RPC must not be a softer path than the UI.
    expect((await backend.setDriveAutoMount("GAME-1", false)).success).toBe(false);
    expect((await backend.setDriveAutoMount("GAME-1", true)).success).toBe(false);
    expect(unpersistFstabImpl).not.toHaveBeenCalled();
    expect(persistFstabImpl).not.toHaveBeenCalled();
    expect((stored.autoMount as Record<string, { line?: string }>)["game-1"]?.line).toBe(custom);
  });

  it("re-reads an adopted line so a later hand-edit isn't reverted", async () => {
    // Freezing it on first sight meant the next /etc regeneration restored
    // the stale copy, silently undoing the user's edit.
    stored = { autoMount: { "game-1": { enabled: true, line: custom, adopted: true } } };
    const edited = `${custom},compress=zstd`;
    storageStatusImpl.mockImplementation(async () => ({
      drives: [{ ...driveFixture, mounted: true, inFstab: true, fstabLine: edited }],
    }));
    const { backend } = makeBackend();
    await backend.onLoad();
    await backend.getHealNotice();

    expect((stored.autoMount as Record<string, { line?: string }>)["game-1"]?.line).toBe(edited);
  });
});
