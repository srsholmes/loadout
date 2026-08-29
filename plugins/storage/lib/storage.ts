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

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type Run = (
  cmd: string[],
  opts?: { stdin?: string; timeoutMs?: number },
) => Promise<RunResult>;

export interface StorageDeps {
  /** Run a subprocess (wired to `@loadout/exec`'s `runFull` in prod). */
  run: Run;
  /** Read a file as UTF-8. Rejects on a missing file. */
  readFile: (path: string) => Promise<string>;
  /** Write a file (UTF-8), creating it if absent. */
  writeFile: (path: string, content: string) => Promise<void>;
  /** Rename a file. Must be same-filesystem, so the swap is atomic. */
  renameFile: (from: string, to: string) => Promise<void>;
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
 * Label tokens that mark a partition as system-owned. SteamOS (and friends)
 * suffix these with an A/B slot (`rootfs-A`, `var-B`, …), so we match a token
 * that is either the whole label or a `-`/`_`-separated segment of it — NOT a
 * bare substring, which would wrongly skip genuinely-named data drives like
 * `Homelab` (contains "home") or `BootCamp` (contains "boot"). Still biased
 * toward safety: anything that *is* one of these segments is left untouched.
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

/**
 * Where a removable or secondary data drive legitimately lives.
 *
 * Everything else is the operating system's. This is the primary system-
 * partition guard; {@link SYSTEM_LABEL_TOKENS} is a fallback for the
 * unmounted case, and on its own it is nowhere near enough — see
 * {@link isSystemMountpoint}.
 */
export const DATA_MOUNT_ROOTS = ["/run/media/", "/media/", "/mnt/"] as const;

/**
 * Is this partition mounted somewhere that belongs to the OS?
 *
 * Judging "is this a system partition" by LABEL alone is safe on exactly one
 * distro. SteamOS labels its system partitions `rootfs-A`/`var`/`home`/`esp`
 * and refers to them in fstab as `/dev/disk/by-partsets/…` rather than
 * `UUID=`, so neither the label filter nor the fstab matcher can be fooled
 * there. Nowhere else is like that:
 *
 *   - Fedora, Bazzite and Nobara label the btrfs root `fedora`, and leave
 *     `/boot` with NO LABEL AT ALL. Both are `part`, both carry a UUID, both
 *     use a whitelisted filesystem, and `/boot` is exactly 1 GiB — the size
 *     floor is `>=`, so it passes that too.
 *   - Arch, Ubuntu and most manual installs label nothing.
 *
 * So on every non-SteamOS machine `/` and `/boot` were being offered in the
 * UI as game drives with a "Mount on boot" toggle. Turning one off deleted
 * every fstab line carrying that UUID — on btrfs, where one filesystem UUID
 * legitimately has many subvolume entries, that is `/`, `/home` and `/var` in
 * a single click, and an emergency shell on the next boot.
 *
 * An unmounted partition returns false here and is judged by the label and
 * fstab-target rules instead; there is no way to tell an unmounted data drive
 * from an unmounted system partition by inspection alone.
 */
export function isSystemMountpoint(mountpoint: string | null | undefined): boolean {
  if (!mountpoint) return false; // unmounted — other rules decide
  const m = mountpoint.trim();
  if (!m) return false;
  if (m === "[SWAP]") return true;
  return !DATA_MOUNT_ROOTS.some((root) => m.startsWith(root));
}

/** Skip anything smaller than this — real game libraries are never this small. */
export const MIN_SIZE_BYTES = 1024 ** 3; // 1 GiB

/**
 * Mount-point name must be a single clean path segment to be Steam-visible.
 *
 * `.` and `..` are explicitly excluded despite matching the character class:
 * a partition labelled `..` (legal on ext4, exFAT and NTFS) produced the
 * mount point `/run/media/<user>/..`, i.e. `/run/media` itself — mounted over
 * as root, hiding every other mounted drive, and written into /etc/fstab so
 * it recurred every boot. Reachable from any attached USB stick.
 */
const SAFE_LABEL = /^[A-Za-z0-9._-]+$/;
const DOTS_ONLY = /^\.+$/;

/** True if a label is safe to use as a single mount-point path segment. */
export function isSafeLabel(label: string | null | undefined): label is string {
  if (!label) return false;
  return SAFE_LABEL.test(label) && !DOTS_ONLY.test(label);
}

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
  /**
   * That entry (or one of them) is not one Loadout wrote.
   *
   * The UI disables the boot-mount toggle in this state: the drive shows as
   * pinned, but switching it off would mean deleting a line the user wrote
   * with options we can't reason about, and we won't do that.
   */
  externallyPinned: boolean;
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
  const tokens = SYSTEM_LABEL_TOKENS as readonly string[];
  const l = label.toLowerCase();
  // Whole-label match first (covers multi-word tokens like `frzr_root`), then
  // match on the `-`/`_`-separated A/B-slot segments SteamOS uses (`rootfs-A`,
  // `var-b`) — never a bare substring, which would wrongly skip data drives
  // named `Homelab` ("home") or `BootCamp` ("boot").
  if (tokens.includes(l)) return true;
  return l.split(/[-_]/).some((seg) => tokens.includes(seg));
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
  // Where it is mounted beats what it is called: a label filter alone cannot
  // see an unlabelled /boot or a root labelled `fedora`.
  if (isSystemMountpoint(nodeMountpoint(node))) return false;
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
  const name = isSafeLabel(label) ? label : uuid;
  return `/run/media/${user}/${name}`;
}

/**
 * Escape a path for an fstab field, the way systemd expects.
 *
 * fstab is whitespace-delimited, so an unescaped space splits one field into
 * two and shifts every field after it. udisks — which mounts removable drives
 * on KDE and GNOME, and SD cards on SteamOS — mounts at
 * `/run/media/<user>/<label>` with the label VERBATIM, and drives ship
 * labelled `My Passport`, `New Volume`, `Seagate Expansion Drive`. Persisting
 * that live mount point produced a seven-field line:
 *
 *   UUID=… /run/media/deck/My Passport exfat defaults,nofail,… 0 2
 *
 * which systemd reads as target `/run/media/deck/My`, fstype `Passport`,
 * options `exfat` — `nofail` GONE, so the generated unit became a hard
 * requirement of local-fs.target, failed, and dropped the machine to an
 * emergency shell.
 */
export function escapeFstabField(field: string): string {
  return field.replace(/[\\\s]/g, (c) => `\\${c.charCodeAt(0).toString(8).padStart(3, "0")}`);
}

/** Decode systemd's octal escaping (`\040` space, `\011` tab, `\134` backslash). */
export function unescapeFstabField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)));
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
  return `UUID=${uuid} ${escapeFstabField(mountpoint)} ${fstype} defaults,nofail,x-systemd.device-timeout=5s 0 2`;
}

/**
 * Every option string Loadout has written for a managed mount.
 *
 * This is the ONLY thing that identifies an entry as ours. Keying on
 * `UUID=<uuid>` alone does not: the user may have written that line by hand,
 * long before installing Loadout, with options that matter enormously —
 * `subvol=@games` on btrfs, `uid=`/`umask=` on ntfs and exfat, `noauto` on a
 * dual-booter's Windows partition. Deleting or rewriting one of those is not
 * ours to do.
 */
export const MANAGED_OPTIONS = ["defaults,nofail,x-systemd.device-timeout=5s"] as const;

/** Split a non-comment fstab line into fields, or null if it isn't one. */
function fstabFields(line: string): string[] | null {
  const t = line.trim();
  if (!t || t.startsWith("#")) return null;
  return t.split(/\s+/);
}

/**
 * Did Loadout write this line? The options field is the whole discriminator;
 * mount point and fstype are deliberately not checked, so a drive relabelled
 * or reformatted since we pinned it is still recognised as ours.
 */
export function isManagedFstabLine(line: string | null | undefined, uuid: string): boolean {
  if (!line) return false;
  const fields = fstabFields(line);
  if (!fields || fields.length < 6) return false;
  if ((fields[0] ?? "").toLowerCase() !== `uuid=${uuid.toLowerCase()}`) return false;
  if (!(MANAGED_OPTIONS as readonly string[]).includes(fields[3] ?? "")) return false;
  return fields[4] === "0" && fields[5] === "2";
}

/** The mount point an existing fstab entry uses for this UUID, unescaped. */
export function fstabMountpointFor(content: string, uuid: string): string | null {
  const marker = `uuid=${uuid.toLowerCase()}`;
  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    const fields = fstabFields(line);
    if (!fields) continue;
    if ((fields[0] ?? "").toLowerCase() !== marker) continue;
    const target = fields[1];
    if (target) return unescapeFstabField(target);
  }
  return null;
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
      return (t.split(/\s+/)[0] ?? "").toLowerCase() === marker; // t non-empty ⇒ [0] present
    });
}

/**
 * Remove any fstab entry that mounts this UUID (comments preserved). Keyed on
 * the fs_spec field so it only ever drops our own `UUID=…` line, never a
 * device-path or label entry that happens to mention the UUID in a comment.
 */
export function removeFstabEntry(
  content: string,
  uuid: string,
  { onlyManaged = true }: { onlyManaged?: boolean } = {},
): string {
  const marker = `uuid=${uuid.toLowerCase()}`;
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return true;
      if ((t.split(/\s+/)[0] ?? "").toLowerCase() !== marker) return true; // t non-empty ⇒ [0] present
      // One filesystem UUID legitimately has MANY fstab entries — that is how
      // btrfs subvolumes are mounted (`subvol=@games`, `subvol=@snapshots`).
      // Dropping every line for a UUID therefore deletes mounts we never
      // wrote and were never asked to remove; on a root filesystem that is
      // `/`, `/home` and `/var` at once. Keep anything that isn't ours.
      return onlyManaged && !isManagedFstabLine(t, uuid);
    })
    .join("\n");
}

/** True if any entry for this UUID is one the user wrote rather than us. */
export function hasUnmanagedEntry(content: string, uuid: string): boolean {
  const marker = `uuid=${uuid.toLowerCase()}`;
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .some((line) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return false;
      if ((t.split(/\s+/)[0] ?? "").toLowerCase() !== marker) return false;
      return !isManagedFstabLine(t, uuid);
    });
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
  // Replaces a stale line of OURS; a user-written entry for the same UUID is
  // preserved (see removeFstabEntry) rather than silently swapped out.
  const without = removeFstabEntry(content, opts.uuid).replace(/\s*$/, "");
  return without.length ? `${without}\n${line}\n` : `${line}\n`;
}

// --- impure orchestration ----------------------------------------------------

const LSBLK_ARGS = [
  "lsblk",
  "-J",
  "-b",
  "-o",
  "NAME,PATH,FSTYPE,LABEL,UUID,MOUNTPOINT,TYPE,SIZE,RO",
];

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
  deps.log?.(
    `mounted ${candidate.uuid} (${candidate.fstype}) at ${verified}; steamLibrary=${steamLibraryFound}`,
  );
  return { success: true, mountpoint: verified, steamLibraryFound };
}

/** Temp file for the atomic /etc/fstab swap. Same directory, so rename works. */
const FSTAB_TMP = "/etc/fstab.loadout.tmp";

/** True if a thrown error means "no such file" rather than "couldn't read it". */
function isNotFound(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code === "ENOENT";
  return /ENOENT|no such file/i.test(String(e));
}

/**
 * Read /etc/fstab, distinguishing "the file isn't there" from "the read
 * failed" — `null` means the latter.
 *
 * Collapsing both to `""` meant an EIO or a transient failure looked exactly
 * like an empty fstab, and the writers then built a whole new file from that
 * assumption: /etc/fstab replaced by a single line, with root, ESP, swap and
 * /home gone. Callers MUST abort on null rather than write.
 */
async function readFstab(deps: StorageDeps): Promise<string | null> {
  try {
    return await deps.readFile(FSTAB_PATH);
  } catch (e) {
    if (isNotFound(e)) return "";
    deps.log?.(`refusing to touch /etc/fstab — could not read it: ${e}`);
    return null;
  }
}

const UNREADABLE = "Couldn't read /etc/fstab, so it was left untouched.";

/**
 * Replace /etc/fstab, atomically, keeping a backup of what was there.
 *
 * Write-to-temp then rename: an in-place truncate-then-write leaves a
 * zero-length or half-written /etc/fstab if the machine loses power in
 * between, and these are battery-powered handhelds where a hard power-off is
 * routine. A truncated fstab costs /home, /boot and swap on the next boot.
 *
 * The backup is only taken from content we actually read, and never
 * overwritten with nothing — it is the one recovery path, and clobbering it
 * with `""` in exactly the case it is needed is worse than not having it.
 */
async function writeFstab(deps: StorageDeps, current: string, next: string): Promise<void> {
  if (current.trim()) await deps.writeFile(FSTAB_BACKUP, current);
  await deps.writeFile(FSTAB_TMP, next);
  await deps.renameFile(FSTAB_TMP, FSTAB_PATH);
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
    const current = await readFstab(deps);
    if (current === null) return { success: false, error: UNREADABLE };
    const next = addFstabEntry(current, { uuid, mountpoint, fstype });
    if (next === current) {
      deps.log?.(`fstab already persists UUID=${uuid}`);
      return { success: true };
    }
    await writeFstab(deps, current, next);
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
    const current = await readFstab(deps);
    if (current === null) return { success: false, error: UNREADABLE };
    if (!fstabHasUuid(current, uuid)) {
      deps.log?.(`fstab has no entry for UUID=${uuid}`);
      return { success: true };
    }
    // Switching OUR toggle off is not permission to delete a line the user
    // wrote. `removeFstabEntry` keeps unmanaged entries; say so rather than
    // reporting a clean removal that didn't happen.
    const next = removeFstabEntry(current, uuid);
    if (next === current) {
      deps.log?.(`fstab entry for UUID=${uuid} isn't one of ours — leaving it alone`);
      return {
        success: false,
        error:
          "That drive is pinned by an /etc/fstab entry Loadout didn't write, so it was left alone. Edit /etc/fstab by hand to change it.",
      };
    }
    await writeFstab(deps, current, next);
    deps.log?.(`fstab: removed our persistent mount for UUID=${uuid}`);
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
  const fstab = (await readFstab(deps)) ?? "";
  const user = deps.currentUser();
  const parts = parseDataPartitions(r.stdout)
    .filter((p) => p.size >= MIN_SIZE_BYTES)
    // An UNMOUNTED system partition can't be spotted by mount point, and on
    // most distros it has no label either — but if fstab pins it somewhere
    // that isn't a data mount root, it's the OS's. This is what keeps a
    // dual-boot install's /boot, or a root that simply isn't mounted right
    // now, out of the drive list.
    .filter((p) => !isSystemMountpoint(fstabMountpointFor(fstab, p.uuid)));

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
        externallyPinned: hasUnmanagedEntry(fstab, p.uuid),
      };
    }),
  );
  return { drives };
}
