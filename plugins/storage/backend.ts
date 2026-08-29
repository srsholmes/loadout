import { access, readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { userInfo, homedir } from "node:os";
import type { PluginBackend, EmitPayload, PluginLogger } from "@loadout/types";
import { runFull } from "@loadout/exec";
import { readPluginStorage, mutatePluginStorage } from "@loadout/plugin-storage";
import {
  getStorageStatus,
  mountCandidate,
  persistFstab,
  unpersistFstab,
  reconcileAutoMount,
  fstabEntryLine,
  type StorageDeps,
  type StorageDrive,
  type StorageStatus,
  type MountResult,
} from "./lib/storage";

const PLUGIN_ID = "storage";

/**
 * How long to keep re-scanning for a drive the user wants that hasn't shown
 * up yet, and how often.
 *
 * The reconcile's whole reason for existing is drives that enumerate slowly,
 * and a drive that isn't in `lsblk` when the backend starts is invisible to a
 * single-shot scan — the one case that most needs healing is the one we'd
 * miss. The backend is `WantedBy=multi-user.target` and `nofail` mounts carry
 * no ordering barrier, so starting before a slow SD or USB enclosure settles
 * is ordinary, not exotic. Cheap: a handful of `lsblk` calls, and only while
 * something is actually still missing.
 */
const RESCAN_DELAYS_MS = [3_000, 8_000, 15_000, 30_000] as const;

/** One drive's boot-mount record. */
export interface AutoMountEntry {
  /** Whether the user wants this drive mounted on boot. */
  enabled: boolean;
  /**
   * The exact /etc/fstab line last seen for this drive, restored verbatim if
   * it goes missing.
   *
   * For an entry we adopted rather than wrote, this is the USER'S line —
   * `subvol=`, `uid=`, `compress=` and all. Regenerating a canonical line
   * instead would silently boot a btrfs user into the wrong subvolume, or
   * make an ntfs mount root-only so Steam can't write to it.
   */
  line?: string;
}

/**
 * What this plugin remembers between boots, under `$HOME`.
 *
 * Deliberately NOT inferred from /etc/fstab. Any OS that regenerates `/etc`
 * on update takes the entry with it — SteamOS A/B, where `/etc` is an overlay
 * whose upper layer lives on the per-slot `/var`, and rpm-ostree images both.
 * That entry is exactly the evidence the old code used to decide a drive was
 * wanted, so after an update it could not tell "the user never asked for
 * this" from "the user asked and the update ate it". `$HOME` survives, so
 * this is the only record that can outlive one.
 */
export interface StorageSettings {
  /**
   * Lowercased UUID -> the user's boot-mount record. Absent = never chose.
   *
   * `boolean` is the pre-0.9 shape, still read so an upgrade doesn't lose
   * everyone's stored intent the moment it lands.
   */
  autoMount?: Record<string, AutoMountEntry | boolean>;
}

/** Normalise the stored map, coercing the pre-0.9 boolean shape. */
export function readAutoMount(settings: {
  autoMount?: Record<string, AutoMountEntry | boolean>;
}): Record<string, AutoMountEntry> {
  const out: Record<string, AutoMountEntry> = {};
  for (const [uuid, value] of Object.entries(settings.autoMount ?? {})) {
    out[uuid] = typeof value === "boolean" ? { enabled: value } : value;
  }
  return out;
}

/** What the startup reconcile did, surfaced once per surface so the UI can say so. */
export interface StorageHealNotice {
  /** Drives whose fstab entry had gone missing and has been put back. */
  repinned: string[];
  /** Drives that were pinned but hadn't mounted this boot, and are now. */
  remounted: string[];
  /** Drives switched off whose leftover entry we removed. */
  unpinned: string[];
  /** Drives we couldn't bring back, with the reason. */
  failed: { name: string; error: string }[];
}

/** Where a notice can be shown. Each surface consumes it independently. */
export type NoticeSurface = "toast" | "page";

/** True if the notice has nothing worth telling the user about. */
function noticeIsEmpty(notice: StorageHealNotice): boolean {
  return (
    !notice.repinned.length &&
    !notice.remounted.length &&
    !notice.unpinned.length &&
    !notice.failed.length
  );
}

/**
 * Resolve the real desktop user that owns the Steam session, for the
 * `/run/media/<user>/…` mount root. The backend runs as a ROOT system service,
 * so `os.userInfo()` reports `root` — mounting under `/run/media/root` where
 * Steam can't see it. The unit instead passes `--user <name>` and sets
 * `HOME=/home/<name>` (see loadout.service), so we trust those: the `--user`
 * arg first, then HOME's basename (covers `/home/<u>` and ostree's
 * `/var/home/<u>`), falling back to `$USER` and finally the process owner.
 */
export function resolveTargetUser(argv: readonly string[] = process.argv): string {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]; // i < length, in bounds
    if (arg === undefined) continue; // unreachable: i < argv.length.
    const nextArg = argv[i + 1];
    if (arg === "--user" && nextArg) return nextArg;
    if (arg.startsWith("--user=")) return arg.slice("--user=".length);
  }
  const home = process.env.HOME || homedir();
  const base = home.replace(/\/+$/, "").split("/").pop();
  if (base && base !== "root") return base;
  if (process.env.USER && process.env.USER !== "root") return process.env.USER;
  return userInfo().username;
}

/**
 * Storage — detect & mount a game-storage drive.
 *
 * Brings a second internal SSD holding a Steam library back online when the
 * system stops auto-mounting it after an update, and can pin it in /etc/fstab
 * so a future update can't silently drop it again. Device-agnostic — never
 * gated, so it works on any handheld/desktop. All the real logic lives in
 * ./lib/storage.ts (fully DI'd + unit-tested); this class just wires the real
 * exec/fs dependencies and exposes the RPC surface.
 */
export default class StorageBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;
  log?: PluginLogger;

  /** Re-scan schedule; overridable so tests don't wait real seconds. */
  private readonly rescanDelays: readonly number[];

  constructor({ rescanDelays }: { rescanDelays?: readonly number[] } = {}) {
    this.rescanDelays = rescanDelays ?? RESCAN_DELAYS_MS;
  }

  // Filesystem + OS access for the game-storage detect/mount block. The
  // backend runs as root, so it writes /etc/fstab via node fs directly and
  // runs lsblk/mount/findmnt via @loadout/exec. Swapped for fakes in tests.
  private get storageDeps(): StorageDeps {
    return {
      run: (cmd, opts) => runFull(cmd, opts),
      readFile: (path) => readFile(path, "utf-8"),
      writeFile: (path, content) => writeFile(path, content),
      renameFile: (from, to) => rename(from, to),
      pathExists: async (path) => {
        try {
          await access(path);
          return true;
        } catch {
          return false;
        }
      },
      mkdirp: async (path) => {
        await mkdir(path, { recursive: true });
      },
      currentUser: () => resolveTargetUser(),
      log: (m) => this.log?.info(`[storage] ${m}`),
    };
  }

  async onLoad(): Promise<void> {
    this.log?.info("[storage] Plugin loaded.");
    // Fire-and-forget — see healAutoMounts for why this must not be awaited.
    // The promise is kept only so the UI can await it on demand.
    this.healing = this.healAutoMounts();
  }

  async onUnload(): Promise<void> {
    // Stops a pending re-scan; without it the loop keeps waking for its full
    // window after the plugin is gone.
    this.stopped = true;
    this.log?.info("[storage] Plugin unloaded.");
  }

  // ---------- Boot reconcile ----------

  /** In-flight reconcile, so getHealNotice can await it rather than race it. */
  private healing: Promise<void> | null = null;

  /**
   * One-shot per surface: each of the toast and the page reads it once, so the
   * toast fires once per backend start rather than on every overlay reload,
   * and acking one never hides it from the other.
   */
  private healNotice: StorageHealNotice | null = null;
  private noticeAcked: Record<NoticeSurface, boolean> = { toast: false, page: false };

  /**
   * Serialises everything that edits /etc/fstab.
   *
   * persistFstab and unpersistFstab are read-modify-write on one file, and
   * the startup reconcile can still be mid-sequence (it shells out to lsblk
   * and mount, so seconds pass) when the user flips a toggle. Interleaved,
   * one side's write lands on a snapshot taken before the other's — a lost
   * update that silently drops an entry we just added.
   */
  private fstabLock: Promise<unknown> = Promise.resolve();

  private serialiseFstab<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.fstabLock.then(fn, fn);
    // Keep the chain alive regardless of outcome.
    this.fstabLock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Set on unload so a pending re-scan stops instead of running on. */
  private stopped = false;

  /**
   * Put every drive back in line with what the user asked for.
   *
   * Never awaited by onLoad: `loadPlugins()` walks plugins sequentially with
   * no timeout and the HTTP server does not start until that loop finishes,
   * so blocking here on lsblk + mount — let alone the re-scan window — would
   * delay the whole backend boot.
   */
  private async healAutoMounts(): Promise<void> {
    const notice: StorageHealNotice = { repinned: [], remounted: [], unpinned: [], failed: [] };
    const handled = new Set<string>();
    try {
      for (let attempt = 0; ; attempt++) {
        const { drives } = await getStorageStatus(this.storageDeps);
        if (attempt === 0) await this.adoptExistingPins(drives);

        for (const drive of drives) {
          const uuid = drive.uuid.toLowerCase();
          if (handled.has(uuid)) continue;
          handled.add(uuid);
          await this.serialiseFstab(() => this.healOneDrive(drive, notice));
        }

        // Keep looking only while a drive the user actually wants is still
        // absent — a drive left at home must not cost us the full window.
        const stored = readAutoMount(await readPluginStorage<StorageSettings>(PLUGIN_ID));
        const missing = Object.entries(stored).some(
          ([uuid, entry]) => entry.enabled && !handled.has(uuid),
        );
        const delay = this.rescanDelays[attempt];
        if (!missing || delay === undefined || this.stopped) break;
        await new Promise((r) => setTimeout(r, delay));
        if (this.stopped) break;
      }
    } catch (e) {
      // Never let this escape: onLoad ignores throws, but an unhandled
      // rejection here would be invisible. Whatever the reconcile managed
      // before the failure is still worth reporting, so fall through.
      this.log?.warn(`[storage] boot reconcile failed: ${e}`);
    }

    if (noticeIsEmpty(notice)) return;
    this.healNotice = notice;
    this.emit?.({ event: "statusChanged", data: undefined });
  }

  /**
   * Record a pinned drive that has no stored choice, and backfill the line
   * for one whose record predates us storing it.
   *
   * Without adoption the users the feature exists for — who turned the toggle
   * on months ago — have no stored intent, so the first update to wipe their
   * fstab is the one we can't heal. A pin that is in effect right now is proof
   * enough that they wanted it.
   *
   * The line is stored VERBATIM, because adoption is not authorship: most
   * pinned entries on a given machine were written by its owner, and the line
   * is the only record of the options they chose. Backfilling matters for the
   * same reason — anyone who enabled a drive before this shipped has intent
   * stored but no line, so an update would have us "restore" a canonical entry
   * over their own. Recording it now is the only chance to, while the evidence
   * is still on disk.
   */
  private async adoptExistingPins(drives: StorageDrive[]): Promise<void> {
    const pinned = drives.filter((d) => d.inFstab);
    if (pinned.length === 0) return;
    let adopted = 0;
    let backfilled = 0;
    await mutatePluginStorage<StorageSettings>(PLUGIN_ID, (existing) => {
      const autoMount = { ...(existing.autoMount ?? {}) };
      // Decided INSIDE the lock, not from a snapshot: reading status shells
      // out to lsblk, so seconds can pass, and a user switching a drive off
      // in that window would otherwise have their explicit "off" overwritten
      // with true — then see it silently re-pinned on the next boot. Exactly
      // what this design exists to prevent.
      for (const drive of pinned) {
        const key = drive.uuid.toLowerCase();
        const prior = autoMount[key];
        if (prior === undefined) {
          autoMount[key] = { enabled: true, line: drive.fstabLine ?? undefined };
          adopted++;
          continue;
        }
        // Never resurrect an explicit "off" — only fill in a missing line.
        const record = typeof prior === "boolean" ? { enabled: prior } : prior;
        if (record.enabled && !record.line && drive.fstabLine) {
          autoMount[key] = { ...record, line: drive.fstabLine };
          backfilled++;
        } else if (typeof prior === "boolean") {
          autoMount[key] = record;
        }
      }
      return { ...existing, autoMount };
    });
    if (adopted) this.log?.info(`[storage] adopted ${adopted} existing boot mount(s) as wanted`);
    if (backfilled) this.log?.info(`[storage] recorded ${backfilled} existing fstab line(s)`);
  }

  /**
   * Reconcile one drive, appending what happened to `notice`.
   *
   * Runs inside the fstab lock and re-reads intent there rather than trusting
   * a snapshot: a reconcile pass takes seconds (lsblk, then mount), and a
   * user toggling a drive off in that window would otherwise have the heal
   * re-pin it afterwards — leaving stored intent `false` against a pinned
   * fstab, a state that never self-corrects.
   */
  private async healOneDrive(drive: StorageDrive, notice: StorageHealNotice): Promise<void> {
    const name = drive.label || drive.path;
    try {
      const stored = readAutoMount(await readPluginStorage<StorageSettings>(PLUGIN_ID));
      const entry = stored[drive.uuid.toLowerCase()];
      if (entry === undefined) return; // never chose — leave it alone

      const res = await reconcileAutoMount(this.storageDeps, {
        drive,
        wanted: entry.enabled,
        storedLine: entry.line,
      });
      if (res.repinned) notice.repinned.push(name);
      if (res.remounted) notice.remounted.push(name);
      if (res.unpinned) notice.unpinned.push(name);
      if (res.error) notice.failed.push({ name, error: res.error });
    } catch (e) {
      // One drive must not take the others down with it: mountCandidate runs
      // a subprocess, and a spawn failure rejecting here would abort the loop
      // and discard every notice already accumulated.
      this.log?.warn(`[storage] reconciling "${name}" failed: ${e}`);
      notice.failed.push({ name, error: String(e) });
    }
  }

  /**
   * The reconcile outcome for one surface, or null. Awaits an in-flight
   * reconcile first — `emit` has no replay, and the backend starts before the
   * overlay connects, so a heal that already finished would otherwise never
   * be seen.
   *
   * Each surface consumes the notice INDEPENDENTLY. A single shared flag meant
   * the startup toast — which fires on the first overlay open, before the user
   * can possibly have navigated anywhere — acked it, and the plugin page then
   * always read null. The page banner, and the promise that someone who opens
   * the plugin later still finds out what happened, were unreachable.
   */
  async getHealNotice(surface: NoticeSurface = "page"): Promise<StorageHealNotice | null> {
    await this.healing;
    if (!this.healNotice || this.noticeAcked[surface]) return null;
    return this.healNotice;
  }

  /** Called once the notice has actually been shown on that surface. */
  async ackHealNotice(surface: NoticeSurface = "page"): Promise<void> {
    this.noticeAcked[surface] = true;
  }

  // ---------- RPC ----------

  /** Merge one drive's boot-mount record into plugin storage. */
  private async storeIntent(uuid: string, entry: AutoMountEntry): Promise<void> {
    await mutatePluginStorage<StorageSettings>(PLUGIN_ID, (existing) => {
      const autoMount = { ...(existing.autoMount ?? {}) };
      const prior = autoMount[uuid.toLowerCase()];
      const priorLine = typeof prior === "object" ? prior.line : undefined;
      // Keep the last known line when the caller doesn't supply one, so
      // switching a drive off and on again doesn't discard an adopted entry's
      // custom options.
      autoMount[uuid.toLowerCase()] = { ...entry, line: entry.line ?? priorLine };
      return { ...existing, autoMount };
    });
  }

  /**
   * Full storage view for the UI: every managed data drive + its state, with
   * the user's stored boot-mount choice overlaid so the toggle reflects
   * intent rather than a derived /etc state an update can erase.
   */
  async getStatus(): Promise<StorageStatus> {
    const [status, settings] = await Promise.all([
      getStorageStatus(this.storageDeps),
      readPluginStorage<StorageSettings>(PLUGIN_ID),
    ]);
    const stored = readAutoMount(settings);
    return {
      drives: status.drives.map((d) => ({
        ...d,
        autoMountWanted: stored[d.uuid.toLowerCase()]?.enabled ?? d.inFstab,
      })),
    };
  }

  /**
   * Re-scan for unmounted/mounted data drives (the "Detect drives" button).
   * `getStorageStatus` already enumerates every managed drive (including the
   * unmounted ones the UI offers to mount), so a separate candidate scan would
   * just be a second redundant `lsblk`.
   */
  async detectDrives(): Promise<StorageStatus> {
    return this.getStatus();
  }

  /**
   * Mount the data drive with the given UUID at its Steam-visible mount point.
   * Only ever mounts an existing filesystem — never formats or repairs it.
   */
  async mountDrive(uuid: string): Promise<MountResult> {
    if (!uuid) {
      return {
        success: false,
        mountpoint: "",
        steamLibraryFound: false,
        error: "No drive selected.",
      };
    }
    const result = await mountCandidate(this.storageDeps, { uuid });
    this.emit?.({ event: "statusChanged", data: undefined });
    return result;
  }

  /**
   * Persist (or remove) an /etc/fstab entry so the drive auto-mounts on boot
   * and a future update can't silently un-mount it. Backed up + idempotent.
   */
  async setDriveAutoMount(
    uuid: string,
    enabled: boolean,
  ): Promise<{ success: boolean; error?: string }> {
    if (!uuid) return { success: false, error: "No drive selected." };
    try {
      // Record the choice BEFORE touching /etc/fstab, and keep it even if the
      // write fails: the intent is the user's, not a side effect of a
      // successful write, and storing it means the next boot's reconcile
      // retries instead of silently agreeing the drive was never wanted.
      await this.storeIntent(uuid, { enabled });

      const result = await this.serialiseFstab(async () => {
        if (!enabled) return unpersistFstab(this.storageDeps, { uuid });
        const { drives } = await getStorageStatus(this.storageDeps);
        const drive = drives.find((d) => d.uuid.toLowerCase() === uuid.toLowerCase());
        if (!drive) return { success: false, error: `Drive ${uuid} not found.` };
        // Persist the live mount point if it's mounted, else the path we'd
        // mount it at — systemd's fstab generator creates the directory.
        const mountpoint =
          drive.mounted && drive.mountpoint ? drive.mountpoint : drive.suggestedMountpoint;
        const res = await persistFstab(this.storageDeps, {
          uuid,
          mountpoint,
          fstype: drive.fstype,
        });
        // Remember the line we wrote, so a later reconcile restores exactly
        // that rather than re-deriving one from a label that may have changed.
        if (res.success) {
          await this.storeIntent(uuid, {
            enabled: true,
            line: fstabEntryLine({ uuid, mountpoint, fstype: drive.fstype }),
          });
        }
        return res;
      });
      this.emit?.({ event: "statusChanged", data: undefined });
      return result;
    } catch (e) {
      this.log?.warn(`[storage] setDriveAutoMount failed: ${e}`);
      return { success: false, error: String(e) };
    }
  }
}
