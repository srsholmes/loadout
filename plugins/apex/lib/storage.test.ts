import { describe, it, expect } from "bun:test";
import {
  parseLsblk,
  parseDataPartitions,
  isSystemLabel,
  isWhitelistedFs,
  isDataPartition,
  mountPointFor,
  fstabEntryLine,
  fstabHasUuid,
  addFstabEntry,
  removeFstabEntry,
  detectCandidates,
  mountCandidate,
  persistFstab,
  unpersistFstab,
  getStorageStatus,
  FSTAB_PATH,
  FSTAB_BACKUP,
  type StorageDeps,
} from "./storage";
import type { RunResult } from "./xhci";

/**
 * Storage detect/mount tests. All IO is injected, so these are pure unit tests
 * of the lsblk parse, the system/whitelist filters, the mount-point + fstab
 * string logic, and the mount/persist orchestration — no root, real disks, or
 * a real mount.
 */

const ok = (stdout = ""): RunResult => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr = ""): RunResult => ({ stdout: "", stderr, exitCode: 1 });

const GiB = 1024 ** 3;

// A representative `lsblk -J -b` tree: a system disk (ESP + rootfs) and a data
// SSD with a mountable game library, plus a grab-bag of things that MUST be
// excluded — swap, a mounted data drive, a tiny partition, and a read-only one.
const LSBLK = JSON.stringify({
  blockdevices: [
    {
      name: "nvme0n1",
      path: "/dev/nvme0n1",
      type: "disk",
      size: 512110190592,
      ro: false,
      children: [
        { name: "nvme0n1p1", path: "/dev/nvme0n1p1", fstype: "vfat", label: "ESP", uuid: "ESP-1", mountpoint: "/boot/efi", type: "part", size: 268435456, ro: false },
        { name: "nvme0n1p2", path: "/dev/nvme0n1p2", fstype: "ext4", label: "rootfs-A", uuid: "ROOT-A", mountpoint: "/", type: "part", size: 10 * GiB, ro: false },
        { name: "nvme0n1p3", path: "/dev/nvme0n1p3", fstype: "ext4", label: "var-A", uuid: "VAR-A", mountpoint: null, type: "part", size: 5 * GiB, ro: false },
        { name: "nvme0n1p4", path: "/dev/nvme0n1p4", fstype: "swap", label: "swap", uuid: "SWAP-1", mountpoint: "[SWAP]", type: "part", size: 8 * GiB, ro: false },
      ],
    },
    {
      name: "nvme1n1",
      path: "/dev/nvme1n1",
      type: "disk",
      size: 1024209543168,
      ro: false,
      children: [
        { name: "nvme1n1p1", path: "/dev/nvme1n1p1", fstype: "ext4", label: "Games", uuid: "GAME-1", mountpoint: null, type: "part", size: 1000 * GiB, ro: false },
        { name: "nvme1n1p2", path: "/dev/nvme1n1p2", fstype: "ntfs", label: "Media", uuid: "MEDIA-1", mountpoint: "/run/media/deck/Media", type: "part", size: 500 * GiB, ro: false },
        { name: "nvme1n1p3", path: "/dev/nvme1n1p3", fstype: "ext4", label: "tiny", uuid: "TINY-1", mountpoint: null, type: "part", size: 256 * 1024 * 1024, ro: false },
        { name: "nvme1n1p4", path: "/dev/nvme1n1p4", fstype: "exfat", label: "ReadOnly", uuid: "RO-1", mountpoint: null, type: "part", size: 64 * GiB, ro: true },
      ],
    },
  ],
});

interface FakeOpts {
  lsblk?: string;
  lsblkExit?: number;
  files?: Record<string, string>;
  mounted?: Record<string, string>;
  user?: string;
  mountExit?: number;
}

function makeDeps(o: FakeOpts = {}): {
  deps: StorageDeps;
  files: Record<string, string>;
  mounted: Record<string, string>;
  commands: string[];
} {
  const files: Record<string, string> = { ...(o.files ?? {}) };
  const mounted: Record<string, string> = { ...(o.mounted ?? {}) };
  const commands: string[] = [];

  const deps: StorageDeps = {
    run: async (cmd) => {
      commands.push(cmd.join(" "));
      if (cmd[0] === "lsblk") return { stdout: o.lsblk ?? "{}", stderr: "", exitCode: o.lsblkExit ?? 0 };
      if (cmd[0] === "findmnt") {
        const uuid = (cmd[3] ?? "").replace(/^UUID=/, "");
        const target = mounted[uuid];
        return target ? ok(`${target}\n`) : fail();
      }
      if (cmd[0] === "mount") {
        const uuid = (cmd[1] ?? "").replace(/^UUID=/, "");
        const mp = cmd[2];
        if ((o.mountExit ?? 0) === 0) {
          mounted[uuid] = mp;
          return ok();
        }
        return fail("mount: wrong fs type, bad option, bad superblock");
      }
      return ok();
    },
    readFile: async (p) => {
      if (p in files) return files[p];
      throw new Error("ENOENT");
    },
    writeFile: async (p, c) => {
      files[p] = c;
    },
    pathExists: async (p) => p in files,
    mkdirp: async (p) => {
      files[p] = files[p] ?? "(dir)";
    },
    currentUser: () => o.user ?? "deck",
  };
  return { deps, files, mounted, commands };
}

describe("pure filters", () => {
  it("whitelists only real data filesystems (case-insensitive)", () => {
    for (const fs of ["ext4", "BTRFS", "xfs", "exFAT", "ntfs", "vfat"]) {
      expect(isWhitelistedFs(fs)).toBe(true);
    }
    for (const fs of ["swap", "linux_raid_member", "crypto_LUKS", "squashfs", "", null, undefined]) {
      expect(isWhitelistedFs(fs)).toBe(false);
    }
  });

  it("flags system labels (suffixed forms included), spares data labels", () => {
    for (const l of ["rootfs", "rootfs-A", "frzr_root", "var-B", "home", "esp", "EFI", "boot"]) {
      expect(isSystemLabel(l)).toBe(true);
    }
    for (const l of ["Games", "SteamLibrary", "Media", "", null, undefined]) {
      expect(isSystemLabel(l)).toBe(false);
    }
  });

  it("isDataPartition rejects non-partitions, missing uuid, non-whitelist fs, system labels", () => {
    const base = { type: "part", fstype: "ext4", uuid: "X", label: "Games" };
    expect(isDataPartition(base)).toBe(true);
    expect(isDataPartition({ ...base, type: "disk" })).toBe(false);
    expect(isDataPartition({ ...base, uuid: null })).toBe(false);
    expect(isDataPartition({ ...base, fstype: "swap" })).toBe(false);
    expect(isDataPartition({ ...base, label: "rootfs-B" })).toBe(false);
  });
});

describe("parseLsblk", () => {
  it("returns only unmounted, rw, big-enough, non-system, whitelisted partitions", () => {
    const candidates = parseLsblk(LSBLK);
    expect(candidates.map((c) => c.uuid)).toEqual(["GAME-1"]);
    const c = candidates[0];
    expect(c).toEqual({ path: "/dev/nvme1n1p1", label: "Games", uuid: "GAME-1", fstype: "ext4", size: 1000 * GiB });
  });

  it("excludes mounted, swap, system-labelled, tiny, and read-only partitions", () => {
    const uuids = parseLsblk(LSBLK).map((c) => c.uuid);
    expect(uuids).not.toContain("ROOT-A"); // mounted + system label
    expect(uuids).not.toContain("VAR-A"); // system label (unmounted)
    expect(uuids).not.toContain("SWAP-1"); // non-whitelist fs
    expect(uuids).not.toContain("MEDIA-1"); // mounted
    expect(uuids).not.toContain("TINY-1"); // below size floor
    expect(uuids).not.toContain("RO-1"); // read-only
  });

  it("returns [] on malformed JSON", () => {
    expect(parseLsblk("not json")).toEqual([]);
    expect(parseLsblk("")).toEqual([]);
  });

  it("parseDataPartitions surfaces mounted data drives too (but not system ones)", () => {
    const all = parseDataPartitions(LSBLK).map((p) => p.uuid);
    expect(all).toContain("GAME-1");
    expect(all).toContain("MEDIA-1"); // mounted ntfs data drive
    expect(all).toContain("TINY-1");
    expect(all).toContain("RO-1");
    expect(all).not.toContain("ROOT-A");
    expect(all).not.toContain("VAR-A");
    expect(all).not.toContain("SWAP-1");
    expect(all).not.toContain("ESP-1");
  });
});

describe("mountPointFor", () => {
  it("uses a clean label as the mount-point name", () => {
    expect(mountPointFor({ user: "deck", label: "Games", uuid: "U1" })).toBe("/run/media/deck/Games");
  });

  it("falls back to the UUID for a missing or unsafe label", () => {
    expect(mountPointFor({ user: "deck", label: null, uuid: "U1" })).toBe("/run/media/deck/U1");
    expect(mountPointFor({ user: "ally", label: "My Games/../x", uuid: "U2" })).toBe("/run/media/ally/U2");
    expect(mountPointFor({ user: "deck", label: "has space", uuid: "U3" })).toBe("/run/media/deck/U3");
  });
});

describe("fstab helpers", () => {
  const line = "UUID=GAME-1 /run/media/deck/Games ext4 defaults,nofail,x-systemd.device-timeout=5s 0 2";

  it("builds the canonical entry with nofail + device-timeout", () => {
    expect(fstabEntryLine({ uuid: "GAME-1", mountpoint: "/run/media/deck/Games", fstype: "ext4" })).toBe(line);
  });

  it("addFstabEntry appends to an existing fstab and is idempotent", () => {
    const base = "# /etc/fstab\nUUID=ROOT / ext4 defaults 0 1\n";
    const once = addFstabEntry(base, { uuid: "GAME-1", mountpoint: "/run/media/deck/Games", fstype: "ext4" });
    expect(once).toContain(line);
    expect(once).toContain("UUID=ROOT / ext4 defaults 0 1");
    // Second add is a no-op — no duplicate line.
    const twice = addFstabEntry(once, { uuid: "GAME-1", mountpoint: "/run/media/deck/Games", fstype: "ext4" });
    expect(twice).toBe(once);
    expect(twice.match(/UUID=GAME-1/g)?.length).toBe(1);
  });

  it("addFstabEntry replaces a stale entry for the same UUID (keyed on UUID)", () => {
    const base = addFstabEntry("", { uuid: "GAME-1", mountpoint: "/run/media/deck/Old", fstype: "ext4" });
    const updated = addFstabEntry(base, { uuid: "GAME-1", mountpoint: "/run/media/deck/Games", fstype: "ext4" });
    expect(updated).toContain("/run/media/deck/Games");
    expect(updated).not.toContain("/run/media/deck/Old");
    expect(updated.match(/UUID=GAME-1/g)?.length).toBe(1);
  });

  it("removeFstabEntry drops only the matching UUID line, keeps comments", () => {
    const base = "# keep me\nUUID=ROOT / ext4 defaults 0 1\n" + line + "\n";
    const removed = removeFstabEntry(base, "GAME-1");
    expect(removed).not.toContain(line);
    expect(removed).toContain("# keep me");
    expect(removed).toContain("UUID=ROOT / ext4 defaults 0 1");
    expect(fstabHasUuid(removed, "GAME-1")).toBe(false);
  });

  it("fstabHasUuid is case-insensitive and ignores comments", () => {
    const c = "# UUID=GAME-1 was here\n" + line + "\n";
    expect(fstabHasUuid(c, "game-1")).toBe(true);
    expect(fstabHasUuid("# UUID=GAME-1 only in a comment\n", "GAME-1")).toBe(false);
  });
});

describe("detectCandidates", () => {
  it("runs lsblk with the expected fields and returns the candidate", async () => {
    const { deps, commands } = makeDeps({ lsblk: LSBLK });
    const candidates = await detectCandidates(deps);
    expect(candidates.map((c) => c.uuid)).toEqual(["GAME-1"]);
    expect(commands[0]).toContain("lsblk -J -b -o NAME,PATH,FSTYPE,LABEL,UUID,MOUNTPOINT,TYPE,SIZE,RO");
  });

  it("returns [] when lsblk fails", async () => {
    const { deps } = makeDeps({ lsblk: "", lsblkExit: 1 });
    expect(await detectCandidates(deps)).toEqual([]);
  });
});

describe("mountCandidate", () => {
  it("mounts an unmounted candidate at its Steam-visible path and reports the library", async () => {
    const { deps, files, commands } = makeDeps({
      lsblk: LSBLK,
      files: { "/run/media/deck/Games/SteamLibrary": "(dir)" },
    });
    const res = await mountCandidate(deps, { uuid: "GAME-1" });
    expect(res.success).toBe(true);
    expect(res.mountpoint).toBe("/run/media/deck/Games");
    expect(res.steamLibraryFound).toBe(true);
    expect(commands).toContain("mount UUID=GAME-1 /run/media/deck/Games");
    // The mount point directory was created.
    expect("/run/media/deck/Games" in files).toBe(true);
  });

  it("is a no-op success when the drive is already mounted", async () => {
    const { deps, commands } = makeDeps({
      lsblk: LSBLK,
      mounted: { "GAME-1": "/run/media/deck/Games" },
      files: { "/run/media/deck/Games/steamapps": "(dir)" },
    });
    const res = await mountCandidate(deps, { uuid: "GAME-1" });
    expect(res.success).toBe(true);
    expect(res.mountpoint).toBe("/run/media/deck/Games");
    expect(res.steamLibraryFound).toBe(true);
    expect(commands).not.toContain("mount UUID=GAME-1 /run/media/deck/Games");
  });

  it("fails cleanly when the UUID isn't a known candidate", async () => {
    const { deps } = makeDeps({ lsblk: LSBLK });
    const res = await mountCandidate(deps, { uuid: "NOPE" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("NOPE");
  });

  it("surfaces a mount failure", async () => {
    const { deps } = makeDeps({ lsblk: LSBLK, mountExit: 32 });
    const res = await mountCandidate(deps, { uuid: "GAME-1" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("bad superblock");
  });
});

describe("persistFstab / unpersistFstab", () => {
  it("persists an entry and backs up the original fstab", async () => {
    const original = "# /etc/fstab\nUUID=ROOT / ext4 defaults 0 1\n";
    const { deps, files } = makeDeps({ files: { [FSTAB_PATH]: original } });
    const res = await persistFstab(deps, { uuid: "GAME-1", mountpoint: "/run/media/deck/Games", fstype: "ext4" });
    expect(res.success).toBe(true);
    expect(files[FSTAB_BACKUP]).toBe(original);
    expect(files[FSTAB_PATH]).toContain("UUID=GAME-1 /run/media/deck/Games ext4 defaults,nofail,x-systemd.device-timeout=5s 0 2");
    expect(files[FSTAB_PATH]).toContain("UUID=ROOT / ext4 defaults 0 1");
  });

  it("persist is idempotent — re-running doesn't rewrite or duplicate", async () => {
    const { deps, files } = makeDeps({ files: { [FSTAB_PATH]: "UUID=ROOT / ext4 defaults 0 1\n" } });
    await persistFstab(deps, { uuid: "GAME-1", mountpoint: "/run/media/deck/Games", fstype: "ext4" });
    const after = files[FSTAB_PATH];
    delete files[FSTAB_BACKUP]; // prove a second run doesn't even back up again
    const res = await persistFstab(deps, { uuid: "GAME-1", mountpoint: "/run/media/deck/Games", fstype: "ext4" });
    expect(res.success).toBe(true);
    expect(files[FSTAB_PATH]).toBe(after);
    expect(files[FSTAB_BACKUP]).toBeUndefined();
  });

  it("unpersists an entry, backing up first", async () => {
    const original = "UUID=ROOT / ext4 defaults 0 1\nUUID=GAME-1 /run/media/deck/Games ext4 defaults,nofail,x-systemd.device-timeout=5s 0 2\n";
    const { deps, files } = makeDeps({ files: { [FSTAB_PATH]: original } });
    const res = await unpersistFstab(deps, { uuid: "GAME-1" });
    expect(res.success).toBe(true);
    expect(files[FSTAB_BACKUP]).toBe(original);
    expect(fstabHasUuid(files[FSTAB_PATH], "GAME-1")).toBe(false);
    expect(files[FSTAB_PATH]).toContain("UUID=ROOT");
  });

  it("unpersist is a no-op when the UUID isn't present", async () => {
    const { deps, files } = makeDeps({ files: { [FSTAB_PATH]: "UUID=ROOT / ext4 defaults 0 1\n" } });
    const res = await unpersistFstab(deps, { uuid: "GAME-1" });
    expect(res.success).toBe(true);
    expect(files[FSTAB_BACKUP]).toBeUndefined();
  });
});

describe("getStorageStatus", () => {
  it("reports mounted + unmounted data drives with fstab + steam-library flags", async () => {
    const fstab = "UUID=GAME-1 /run/media/deck/Games ext4 defaults,nofail,x-systemd.device-timeout=5s 0 2\n";
    const { deps } = makeDeps({
      lsblk: LSBLK,
      files: { [FSTAB_PATH]: fstab, "/run/media/deck/Media/steamapps": "(dir)" },
    });
    const { drives } = await getStorageStatus(deps);
    const byUuid = Object.fromEntries(drives.map((d) => [d.uuid, d]));

    expect(byUuid["GAME-1"].mounted).toBe(false);
    expect(byUuid["GAME-1"].inFstab).toBe(true);
    expect(byUuid["GAME-1"].suggestedMountpoint).toBe("/run/media/deck/Games");

    expect(byUuid["MEDIA-1"].mounted).toBe(true);
    expect(byUuid["MEDIA-1"].mountpoint).toBe("/run/media/deck/Media");
    expect(byUuid["MEDIA-1"].steamLibraryFound).toBe(true);
    expect(byUuid["MEDIA-1"].inFstab).toBe(false);

    // System partitions never appear.
    expect(byUuid["ROOT-A"]).toBeUndefined();
    expect(byUuid["VAR-A"]).toBeUndefined();
  });
});
