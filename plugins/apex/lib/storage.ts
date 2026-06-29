/**
 * Game-storage drive detect & mount — bring a second internal SSD holding a
 * Steam library back online when SteamOS/Steam stops auto-mounting it after an
 * update, so Steam can see the games again.
 *
 * The whole module is detection-driven: nothing about the drive is hardcoded.
 * `lsblk` enumerates the block devices; we pick the partitions that are real,
 * unmounted *data* filesystems and leave everything else strictly alone. The
 * mount point is `/run/media/<user>/<name>` — the same place Steam's own
 * auto-mount uses — with `<user>` and `<name>` derived at runtime.
 *
 * SAFETY — this module only ever *mounts an existing filesystem read-write*.
 * It never formats, fsck's, partitions, or writes into the data filesystem.
 * The candidate filter is deny-by-default:
 *
 *   - type must be "part" (a partition, not a disk/loop/rom)
 *   - must be unmounted right now (mountpoint null)
 *   - must be read-write (RO false)
 *   - must carry a UUID
 *   - fstype must be in WHITELIST_FS (a real, mountable data fs)
 *   - label must NOT look like a system partition (rootfs, frzr_root, var,
 *     home, esp, efi, boot — SteamOS suffixes these, so we substring-match)
 *   - must be at least MIN_SIZE_BYTES (skip tiny helper partitions)
 *
 * The fstab persistence is idempotent (keyed on UUID), uses `nofail` +
 * `x-systemd.device-timeout=5s` so a missing drive can never block boot, and
 * backs /etc/fstab up to /etc/fstab.loadout.bak before writing — mirroring the
 * `.loadout.bak` pattern in ./fingerprint.ts.
 *
 * All IO is injected (`StorageDeps`) so the orchestration is unit-testable
 * without root, real disks, or a real mount.
 */

import type { Run } from "./xhci";

export interface StorageDeps {
  /** Run a subprocess (wired to `@loadout/exec`'s `runFull` in prod). */
  run: Run;
  /** Read a file as UTF-8. Rejects on a missing file. */
  readFile: (path: string) => Promise<string>;
  /** Write a file (UTF-8), creating it if absent. */
  writeFile: (path: string, content: string) => Promise<void>;
  pathExists: (path: string) => Promise<boolean>;
  /** Create a directory and any missing parents (mkdir -p). */
  mkdirp: (path: string) => Promise<void>;
  /** The current username — drives the /run/media/<user> mount root. */
  currentUser: () => string;
  log?: (message: string) => void;
}

export const FSTAB_PATH = "/etc/fstab";
export const FSTAB_BACKUP = "/etc/fstab.loadout.bak";

/** Real, mountable data filesystems. Everything else is skipped. */
export const WHITELIST_FS = ["ext4", "btrfs", "xfs", "exfat", "ntfs", "vfat"] as const;

/**
 * Label/mountpoint tokens that mark a partition as system-owned. SteamOS (and
 * friends) suffix these (rootfs-A, var-B, …), so we substring-match
 * case-insensitively. Better to skip a genuinely-named data drive than to ever
 * touch a system partition.
 */
export const SYSTEM_LABEL_TOKENS = [
  "rootfs",
  "frzr_root",
  "var",
  "home",
  "esp",
  "efi",
  "boot",
] as const;

/** Skip anything smaller than this — real game libraries are never this small. */
export const MIN_SIZE_BYTES = 1024 ** 3; // 1 GiB

/** Mount-point name must be a single clean path segment to be Steam-visible. */
const SAFE_LABEL = /^[A-Za-z0-9._-]+$/;

// --- types -------------------------------------------------------------------

/** An unmounted, mountable data partition the UI can offer to mount. */
export interface Candidate {
  path: string;
  label: string | null;
  uuid: string;
  fstype: string;
  /** Size in bytes. */
  size: number;
}

/** A data partition in any state, used to build the full status view. */
export interface RawPartition extends Candidate {
  mountpoint: string | null;
  ro: boolean;
}

/** One block-device node as emitted by `lsblk -J` (recursive via children). */
export interface LsblkNode {
  name?: string;
  path?: string;
  fstype?: string | null;
  label?: string | null;
  uuid?: string | null;
  mountpoint?: string | null;
  /** Newer lsblk emits an array instead of a scalar mountpoint. */
  mountpoints?: (string | null)[] | null;
  type?: string;
  size?: number | string | null;
  ro?: boolean | string | null;
  children?: LsblkNode[];
}

export interface MountResult {
  success: boolean;
  mountpoint: string;
  /** A SteamLibrary/steamapps folder was found on the mounted drive. */
  steamLibraryFound: boolean;
  error?: string;
}

export interface StorageDrive {
  path: string;
  label: string | null;
  uuid: string;
  fstype: string;
  size: number;
  mounted: boolean;
  mountpoint: string | null;
  /** Where we'd mount it if asked (Steam-visible path). */
  suggestedMountpoint: string;
  steamLibraryFound: boolean;
  /** A persistent /etc/fstab entry for this UUID exists. */
  inFstab: boolean;
}

export interface StorageStatus {
  drives: StorageDrive[];
}

// --- pure helpers ------------------------------------------------------------

/** True if `fstype` is a real, mountable data filesystem we allow. */
export function isWhitelistedFs(fstype: string | null | undefined): boolean {
  if (!fstype) return false;
  return (WHITELIST_FS as readonly string[]).includes(fstype.toLowerCase());
}

/** True if a label looks like a system partition we must never touch. */
export function isSystemLabel(label: string | null | undefined): boolean {
  if (!label) return false;
  const l = label.toLowerCase();
  return SYSTEM_LABEL_TOKENS.some((t) => l.includes(t));
}

function toBytes(size: number | string | null | undefined): number {
  if (typeof size === "number") return Number.isFinite(size) ? size : 0;
  if (typeof size === "string") {
    const n = Number(size);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function nodeMountpoint(node: LsblkNode): string | null {
  if (node.mountpoint) return node.mountpoint;
  if (Array.isArray(node.mountpoints)) {
    const m = node.mountpoints.find((x) => x != null);
    return m ?? null;
  }
  return null;
}

function nodeRo(node: LsblkNode): boolean {
  return node.ro === true || node.ro === "1" || node.ro === "true";
}

/**
 * Is this node a *data partition* we're allowed to consider — regardless of
 * whether it's currently mounted? Enforces the type/uuid/fstype/system-label
 * rules. Mount-state and size are applied separately by the callers so the
 * full-status view can still surface a mounted or smaller managed drive.
 */
export function isDataPartition(node: LsblkNode): boolean {
  if (node.type !== "part") return false;
  if (!node.uuid) return false;
  if (!isWhitelistedFs(node.fstype)) return false;
  if (isSystemLabel(node.label)) return false;
  return true;
}

/** Flatten `lsblk -J` output to the data partitions, in any mount state. */
export function parseDataPartitions(json: string): RawPartition[] {
  let parsed: { blockdevices?: LsblkNode[] };
  try {
    parsed = JSON.parse(json) as { blockdevices?: LsblkNode[] };
  } catch {
    return [];
  }
  const out: RawPartition[] = [];
  const walk = (nodes: LsblkNode[] | undefined): void => {
    for (const node of nodes ?? []) {
      if (isDataPartition(node)) {
        out.push({
          path: node.path ?? `/dev/${node.name ?? ""}`,
          label: node.label ?? null,
          uuid: node.uuid as string,
          fstype: (node.fstype as string).toLowerCase(),
          size: toBytes(node.size),
          mountpoint: nodeMountpoint(node),
          ro: nodeRo(node),
        });
      }
      walk(node.children);
    }
  };
  walk(parsed.blockdevices);
  return out;
}

/**
 * Parse `lsblk -J` output to the mountable *candidates*: unmounted,
 * read-write, big-enough data partitions. PURE — the testable core of
 * detectCandidates.
 */
export function parseLsblk(json: string): Candidate[] {
  return parseDataPartitions(json)
    .filter((p) => p.mountpoint === null && !p.ro && p.size >= MIN_SIZE_BYTES)
    .map(({ path, label, uuid, fstype, size }) => ({ path, label, uuid, fstype, size }));
}

/**
 * Steam-visible mount point for a drive. Uses the label when it's a single
 * clean path segment, else falls back to the UUID — so a weird/empty label
 * can never produce a path-traversing or multi-segment mount point.
 */
export function mountPointFor({
  user,
  label,
  uuid,
}: {
  user: string;
  label: string | null;
  uuid: string;
}): string {
  const name = label && SAFE_LABEL.test(label) ? label : uuid;
  return `/run/media/${user}/${name}`;
}

/** The canonical fstab line for a managed mount. */
export function fstabEntryLine({
  uuid,
  mountpoint,
  fstype,
}: {
  uuid: string;
  mountpoint: string;
  fstype: string;
}): string {
  return `UUID=${uuid} ${mountpoint} ${fstype} defaults,nofail,x-systemd.device-timeout=5s 0 2`;
}

/** True if a non-comment fstab line already mounts this UUID. */
export function fstabHasUuid(content: string, uuid: string): boolean {
  const marker = `uuid=${uuid.toLowerCase()}`;
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .some((line) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return false;
      return t.split(/\s+/)[0].toLowerCase() === marker;
    });
}

/**
 * Remove any fstab entry that mounts this UUID (comments preserved). Keyed on
 * the fs_spec field so it only ever drops our own `UUID=…` line, never a
 * device-path or label entry that happens to mention the UUID in a comment.
 */
export function removeFstabEntry(content: string, uuid: string): string {
  const marker = `uuid=${uuid.toLowerCase()}`;
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return true;
      return t.split(/\s+/)[0].toLowerCase() !== marker;
    })
    .join("\n");
}

/**
 * Add (or update) the managed entry for a UUID. Idempotent: if the exact line
 * is already present the content is returned unchanged; a stale entry for the
 * same UUID (e.g. a different mount point) is replaced.
 */
export function addFstabEntry(
  content: string,
  opts: { uuid: string; mountpoint: string; fstype: string },
): string {
  const line = fstabEntryLine(opts);
  const normalized = content.replace(/\r\n/g, "\n");
  if (normalized.split("\n").some((l) => l.trim() === line)) return content;
  const without = removeFstabEntry(content, opts.uuid).replace(/\s*$/, "");
  return without.length ? `${without}\n${line}\n` : `${line}\n`;
}

// --- impure orchestration ----------------------------------------------------

const LSBLK_ARGS = ["lsblk", "-J", "-b", "-o", "NAME,PATH,FSTYPE,LABEL,UUID,MOUNTPOINT,TYPE,SIZE,RO"];

/** Enumerate unmounted, mountable data partitions. */
export async function detectCandidates(deps: StorageDeps): Promise<Candidate[]> {
  const r = await deps.run(LSBLK_ARGS, { timeoutMs: 10_000 });
  if (r.exitCode !== 0) {
    deps.log?.(`lsblk failed (${r.exitCode}): ${r.stderr.trim()}`);
    return [];
  }
  return parseLsblk(r.stdout);
}

/** Where (if anywhere) the filesystem with this UUID is currently mounted. */
async function mountedTarget(deps: StorageDeps, uuid: string): Promise<string | null> {
  const r = await deps.run(["findmnt", "-rn", "-S", `UUID=${uuid}`, "-o", "TARGET"], {
    timeoutMs: 5_000,
  });
  if (r.exitCode !== 0) return null;
  const target = r.stdout.split("\n")[0]?.trim();
  return target ? target : null;
}

/** True if the mounted tree looks like a Steam library. */
async function steamLibraryAt(deps: StorageDeps, mountpoint: string): Promise<boolean> {
  return (
    (await deps.pathExists(`${mountpoint}/SteamLibrary`)) ||
    (await deps.pathExists(`${mountpoint}/steamapps`))
  );
}

/**
 * Mount the data partition with the given UUID at its Steam-visible mount
 * point. A no-op (success) if it's already mounted. Only ever mounts an
 * existing filesystem — never formats or repairs it.
 */
export async function mountCandidate(
  deps: StorageDeps,
  { uuid }: { uuid: string },
): Promise<MountResult> {
  // Already mounted — report where, and whether Steam content is there.
  const existing = await mountedTarget(deps, uuid);
  if (existing) {
    const steamLibraryFound = await steamLibraryAt(deps, existing);
    deps.log?.(`drive ${uuid} already mounted at ${existing}`);
    return { success: true, mountpoint: existing, steamLibraryFound };
  }

  const candidate = (await detectCandidates(deps)).find(
    (c) => c.uuid.toLowerCase() === uuid.toLowerCase(),
  );
  if (!candidate) {
    return {
      success: false,
      mountpoint: "",
      steamLibraryFound: false,
      error: `No unmounted, mountable drive with UUID ${uuid} was found.`,
    };
  }

  const mountpoint = mountPointFor({
    user: deps.currentUser(),
    label: candidate.label,
    uuid: candidate.uuid,
  });
  try {
    await deps.mkdirp(mountpoint);
  } catch (e) {
    return {
      success: false,
      mountpoint,
      steamLibraryFound: false,
      error: `Could not create mount point ${mountpoint}: ${e}`,
    };
  }

  const m = await deps.run(["mount", `UUID=${candidate.uuid}`, mountpoint], { timeoutMs: 30_000 });
  if (m.exitCode !== 0) {
    return {
      success: false,
      mountpoint,
      steamLibraryFound: false,
      error: m.stderr.trim() || `mount exited ${m.exitCode}`,
    };
  }

  // Verify it actually mounted (mount can exit 0 yet not stick on some setups).
  const verified = await mountedTarget(deps, candidate.uuid);
  if (!verified) {
    return {
      success: false,
      mountpoint,
      steamLibraryFound: false,
      error: "mount reported success but the drive isn't showing as mounted.",
    };
  }

  const steamLibraryFound = await steamLibraryAt(deps, verified);
  deps.log?.(`mounted ${candidate.uuid} (${candidate.fstype}) at ${verified}; steamLibrary=${steamLibraryFound}`);
  return { success: true, mountpoint: verified, steamLibraryFound };
}

/**
 * Persist a mount in /etc/fstab so a future update can't silently un-mount it.
 * Idempotent (keyed on UUID), backs up /etc/fstab first. The entry uses
 * `nofail` + a short device timeout, so a missing drive never blocks boot.
 */
export async function persistFstab(
  deps: StorageDeps,
  { uuid, mountpoint, fstype }: { uuid: string; mountpoint: string; fstype: string },
): Promise<{ success: boolean; error?: string }> {
  try {
    const current = await deps.readFile(FSTAB_PATH).catch(() => "");
    const next = addFstabEntry(current, { uuid, mountpoint, fstype });
    if (next === current) {
      deps.log?.(`fstab already persists UUID=${uuid}`);
      return { success: true };
    }
    await deps.writeFile(FSTAB_BACKUP, current);
    await deps.writeFile(FSTAB_PATH, next);
    deps.log?.(`fstab: persisted UUID=${uuid} -> ${mountpoint}`);
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

/** Remove the persistent /etc/fstab entry for this UUID (idempotent, backed up). */
export async function unpersistFstab(
  deps: StorageDeps,
  { uuid }: { uuid: string },
): Promise<{ success: boolean; error?: string }> {
  try {
    const current = await deps.readFile(FSTAB_PATH).catch(() => "");
    if (!fstabHasUuid(current, uuid)) {
      deps.log?.(`fstab has no entry for UUID=${uuid}`);
      return { success: true };
    }
    const next = removeFstabEntry(current, uuid);
    await deps.writeFile(FSTAB_BACKUP, current);
    await deps.writeFile(FSTAB_PATH, next);
    deps.log?.(`fstab: removed persistent mount for UUID=${uuid}`);
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

/** Full storage view for the UI: every managed data drive + its mount/fstab state. */
export async function getStorageStatus(deps: StorageDeps): Promise<StorageStatus> {
  const r = await deps.run(LSBLK_ARGS, { timeoutMs: 10_000 });
  if (r.exitCode !== 0) {
    deps.log?.(`lsblk failed (${r.exitCode}): ${r.stderr.trim()}`);
    return { drives: [] };
  }
  const parts = parseDataPartitions(r.stdout).filter((p) => p.size >= MIN_SIZE_BYTES);
  const fstab = await deps.readFile(FSTAB_PATH).catch(() => "");
  const user = deps.currentUser();

  const drives = await Promise.all(
    parts.map(async (p): Promise<StorageDrive> => {
      const mounted = p.mountpoint !== null;
      return {
        path: p.path,
        label: p.label,
        uuid: p.uuid,
        fstype: p.fstype,
        size: p.size,
        mounted,
        mountpoint: p.mountpoint,
        suggestedMountpoint: mountPointFor({ user, label: p.label, uuid: p.uuid }),
        steamLibraryFound: p.mountpoint ? await steamLibraryAt(deps, p.mountpoint) : false,
        inFstab: fstabHasUuid(fstab, p.uuid),
      };
    }),
  );
  return { drives };
}
