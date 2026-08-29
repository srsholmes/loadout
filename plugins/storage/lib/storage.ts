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
 * `x-systemd.device-timeout` so a missing drive can never block boot, and
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
  /**
   * That entry, verbatim, or null. Carried on the status so callers don't
   * re-read /etc/fstab — and so the line can be stored exactly as the user
   * wrote it, options and all, rather than regenerated from a template.
   */
  fstabLine: string | null;
  /**
   * The user's stored "mount on boot" choice, filled in by the backend from
   * plugin storage. The UI binds the toggle to THIS, not to `inFstab`: after
   * an A/B update wipes /etc the entry is gone while the intent isn't, and a
   * toggle bound to the derived state would show off and quietly agree that
   * the user never wanted it. Undefined = never chose.
   */
  autoMountWanted?: boolean;
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

/**
 * How long systemd waits for the device node before giving up on the mount.
 *
 * Was 5s, which is thin: on a Steam Deck cold boot the SD controller only
 * publishes `mmcblk0` around two seconds in, and an internal NVMe behind a
 * slower controller can be later still. Combined with `nofail` a miss is
 * SILENT — no failed unit, no journal error, just an unmounted drive and a
 * Steam library full of "missing" games. 10s costs nothing when the device
 * is present (systemd proceeds the moment udev announces it) and only ever
 * delays a boot where the drive genuinely isn't there.
 */
export const DEVICE_TIMEOUT = "10s";

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
  return `UUID=${uuid} ${mountpoint} ${fstype} defaults,nofail,x-systemd.device-timeout=${DEVICE_TIMEOUT} 0 2`;
}

/**
 * Every option string Loadout has ever written for a managed mount, newest
 * first.
 *
 * This is the ONLY thing that identifies an entry as ours. Keying on
 * `UUID=<uuid>` alone does not: the user may have written that line by hand,
 * long before installing Loadout, with options that matter enormously —
 * `subvol=@games` on btrfs, `uid=`/`umask=` on ntfs/exfat. Rewriting one of
 * those to our canonical form silently boots them into the wrong subvolume,
 * or makes the mount root-only so Steam can't write to it.
 *
 * So: an entry whose options are not in this list is the USER'S. We restore
 * it verbatim if it goes missing and otherwise never touch it.
 */
export const MANAGED_OPTIONS = [
  `defaults,nofail,x-systemd.device-timeout=${DEVICE_TIMEOUT}`,
  "defaults,nofail,x-systemd.device-timeout=5s", // pre-0.9 — upgraded on sight
] as const;

/** Split a non-comment fstab line into fields, or null if it isn't one. */
function fstabFields(line: string): string[] | null {
  const t = line.trim();
  if (!t || t.startsWith("#")) return null;
  return t.split(/\s+/);
}

/**
 * Decode systemd's octal escaping (`\040` for a space, `\011` tab, `\134`
 * backslash) in an fstab path field.
 *
 * Loadout's own mount points can't contain a space — SAFE_LABEL excludes one,
 * and we fall back to the UUID — but an adopted third-party entry can:
 * `/mnt/Game\040Drive` is a legal fstab target. Passing that through raw would
 * have us mkdir and mount a literal `/mnt/Game\040Drive`, i.e. a second mount
 * point neither fstab nor Steam is looking at.
 */
export function unescapeFstabField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

/** The verbatim fstab line that mounts this UUID, or null. */
export function fstabLineFor(content: string, uuid: string): string | null {
  const marker = `uuid=${uuid.toLowerCase()}`;
  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    const fields = fstabFields(line);
    if (!fields) continue;
    if ((fields[0] ?? "").toLowerCase() === marker) return line.trim();
  }
  return null;
}

/**
 * The mount point an fstab line targets, unescaped.
 *
 * The heal mounts a drive at the path fstab already pins rather than the one
 * we would pick today: a drive whose label changed since it was pinned would
 * otherwise get mounted at a second, different path while the fstab entry
 * still points at the first — two mount points for one drive, and Steam
 * looking at whichever it recorded.
 */
export function fstabTargetOf(line: string | null): string | null {
  if (!line) return null;
  const target = fstabFields(line)?.[1];
  return target ? unescapeFstabField(target) : null;
}

/** The mount point an existing fstab entry uses for this UUID, or null. */
export function fstabMountpointFor(content: string, uuid: string): string | null {
  return fstabTargetOf(fstabLineFor(content, uuid));
}

/**
 * Did Loadout write this line? See {@link MANAGED_OPTIONS} — the options
 * field is the whole discriminator; mount point and fstype are deliberately
 * not checked, so a drive relabelled or reformatted since we pinned it is
 * still recognised as ours.
 */
export function isManagedFstabLine(line: string | null, uuid: string): boolean {
  if (!line) return false;
  const fields = fstabFields(line);
  if (!fields || fields.length < 6) return false;
  if ((fields[0] ?? "").toLowerCase() !== `uuid=${uuid.toLowerCase()}`) return false;
  if (!(MANAGED_OPTIONS as readonly string[]).includes(fields[3] ?? "")) return false;
  return fields[4] === "0" && fields[5] === "2";
}

/** True if this UUID's fstab entry is byte-for-byte the line we'd write today. */
export function fstabLineIsCurrent(
  content: string,
  opts: { uuid: string; mountpoint: string; fstype: string },
): boolean {
  return fstabLineFor(content, opts.uuid) === fstabEntryLine(opts);
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
export function removeFstabEntry(content: string, uuid: string): string {
  const marker = `uuid=${uuid.toLowerCase()}`;
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return true;
      return (t.split(/\s+/)[0] ?? "").toLowerCase() !== marker; // t non-empty ⇒ [0] present
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
  { uuid, mountpoint: requested }: { uuid: string; mountpoint?: string },
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

  // An explicit target wins: the boot heal passes the path fstab already
  // pins, so a drive relabelled since it was pinned doesn't end up mounted
  // somewhere the fstab entry (and Steam) isn't looking.
  const mountpoint =
    requested ??
    mountPointFor({
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

/**
 * Restore a verbatim fstab line for this UUID (backed up, idempotent).
 *
 * Used to put back an entry that has gone missing, EXACTLY as it was — which
 * for an entry we adopted rather than wrote means the user's own options
 * survive. Regenerating a canonical line here instead would quietly drop a
 * `subvol=`, `uid=` or `compress=` the drive depends on.
 */
export async function persistFstabLine(
  deps: StorageDeps,
  { uuid, line }: { uuid: string; line: string },
): Promise<{ success: boolean; error?: string }> {
  try {
    const current = await deps.readFile(FSTAB_PATH).catch(() => "");
    if (fstabLineFor(current, uuid) === line.trim()) return { success: true };
    const without = removeFstabEntry(current, uuid).replace(/\s*$/, "");
    const next = without.length ? `${without}\n${line.trim()}\n` : `${line.trim()}\n`;
    await deps.writeFile(FSTAB_BACKUP, current);
    await deps.writeFile(FSTAB_PATH, next);
    deps.log?.(`fstab: restored entry for UUID=${uuid}`);
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

/** What {@link reconcileAutoMount} had to do for one drive. */
export interface ReconcileResult {
  /** The fstab entry had gone missing and has been put back. */
  repinned: boolean;
  /** The drive wasn't mounted this boot, and now is. */
  remounted: boolean;
  /** A managed entry was removed because the user had switched the drive off. */
  unpinned: boolean;
  /** Set when we couldn't bring the drive back. */
  error?: string;
}

const NOTHING_TO_DO: ReconcileResult = { repinned: false, remounted: false, unpinned: false };

/**
 * Bring one drive back into line with what the user asked for.
 *
 * Device- and distro-agnostic: nothing here knows about a particular machine,
 * filesystem or mount point. Three failures land here, and the first two look
 * identical to the user ("my games are gone"):
 *
 *   1. The fstab entry is missing. Any OS that regenerates `/etc` on update
 *      does this — SteamOS A/B (where `/etc` is an overlay on the per-slot
 *      `/var`) and rpm-ostree images both. We put the entry back VERBATIM and
 *      mount now, so the current boot is fixed too, not just the next one.
 *   2. The entry is there but the drive didn't mount — `nofail` plus a device
 *      timeout means a slow-to-enumerate drive fails silently, on any distro.
 *      We mount it now.
 *   3. The user switched the drive off but the write failed, so it is still
 *      pinned and still mounting every boot while the toggle reads off.
 *      We remove the entry.
 *
 * What it will NOT do is edit an entry it didn't write. See
 * {@link MANAGED_OPTIONS}: an entry with the user's own options is restored
 * as-is if it vanishes and otherwise left completely alone. Only a line we
 * recognise as ours gets its options refreshed (the 5s→10s timeout bump), and
 * only a line we recognise as ours is ever removed.
 *
 * `wanted` must come from plugin storage, never from the fstab state: the
 * entry is exactly what an update deletes, so afterwards the fstab cannot
 * distinguish "never wanted it" from "wanted it and the OS ate it".
 */
export async function reconcileAutoMount(
  deps: StorageDeps,
  { drive, wanted, storedLine }: { drive: StorageDrive; wanted: boolean; storedLine?: string },
): Promise<ReconcileResult> {
  const name = drive.label || drive.path;
  const fstab = await deps.readFile(FSTAB_PATH).catch(() => "");
  const existing = fstabLineFor(fstab, drive.uuid);
  const ours = isManagedFstabLine(existing, drive.uuid);

  if (!wanted) {
    // Only ever retract our own line. A user who switched the toggle off did
    // not thereby ask us to delete an entry they wrote by hand.
    if (!existing || !ours) return NOTHING_TO_DO;
    deps.log?.(`"${name}" is switched off but still pinned — removing our entry`);
    const res = await unpersistFstab(deps, { uuid: drive.uuid });
    return res.success
      ? { ...NOTHING_TO_DO, unpinned: true }
      : { ...NOTHING_TO_DO, error: res.error ?? "Removing the boot mount failed." };
  }

  let repinned = false;
  if (!existing) {
    // Prefer the exact line last seen for this drive — for an adopted entry
    // that is the user's own, options and all.
    const line =
      storedLine ??
      fstabEntryLine({
        uuid: drive.uuid,
        mountpoint:
          drive.mounted && drive.mountpoint ? drive.mountpoint : drive.suggestedMountpoint,
        fstype: drive.fstype,
      });
    deps.log?.(
      `"${name}" is set to mount on boot but its /etc/fstab entry is gone ` +
        "(a system update usually causes this) — restoring it",
    );
    const res = await persistFstabLine(deps, { uuid: drive.uuid, line });
    if (!res.success) {
      return { ...NOTHING_TO_DO, error: res.error ?? "Restoring the boot mount failed." };
    }
    repinned = true;
  } else if (
    ours &&
    !fstabLineIsCurrent(fstab, {
      uuid: drive.uuid,
      mountpoint: fstabTargetOf(existing) ?? drive.suggestedMountpoint,
      fstype: drive.fstype,
    })
  ) {
    // Ours, but an older shape — the 5s timeout is what lost the boot race.
    // Upkeep, not news: reporting it would fire "your boot mount went missing"
    // at every user still carrying an old entry.
    deps.log?.(`refreshing our stale boot-mount entry for "${name}"`);
    const res = await persistFstab(deps, {
      uuid: drive.uuid,
      mountpoint: fstabTargetOf(existing) ?? drive.suggestedMountpoint,
      fstype: drive.fstype,
    });
    if (!res.success) {
      return { ...NOTHING_TO_DO, error: res.error ?? "Refreshing the boot mount failed." };
    }
  }

  if (drive.mounted) return { ...NOTHING_TO_DO, repinned };

  // Mount where fstab pins it (unescaped), so a drive relabelled since it was
  // pinned doesn't get a second mount point the entry doesn't know about.
  const after = await deps.readFile(FSTAB_PATH).catch(() => "");
  const mountpoint =
    fstabMountpointFor(after, drive.uuid) ??
    (drive.mounted && drive.mountpoint ? drive.mountpoint : drive.suggestedMountpoint);
  const mounted = await mountCandidate(deps, { uuid: drive.uuid, mountpoint });
  if (!mounted.success) {
    return { ...NOTHING_TO_DO, repinned, error: mounted.error ?? "Mounting the drive failed." };
  }
  deps.log?.(`mounted "${name}" at ${mounted.mountpoint} during the boot reconcile`);
  return { ...NOTHING_TO_DO, repinned, remounted: true };
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
        fstabLine: fstabLineFor(fstab, p.uuid),
      };
    }),
  );
  return { drives };
}
