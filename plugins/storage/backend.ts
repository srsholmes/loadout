import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import { userInfo, homedir } from "node:os";
import type { PluginBackend, EmitPayload, PluginLogger } from "@loadout/types";
import { runFull } from "@loadout/exec";
import {
  getStorageStatus,
  mountCandidate,
  persistFstab,
  unpersistFstab,
  type StorageDeps,
  type StorageStatus,
  type MountResult,
} from "./lib/storage";

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
    if (argv[i] === "--user" && argv[i + 1]) return argv[i + 1];
    if (argv[i].startsWith("--user=")) return argv[i].slice("--user=".length);
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

  // Filesystem + OS access for the game-storage detect/mount block. The
  // backend runs as root, so it writes /etc/fstab via node fs directly and
  // runs lsblk/mount/findmnt via @loadout/exec. Swapped for fakes in tests.
  private get storageDeps(): StorageDeps {
    return {
      run: (cmd, opts) => runFull(cmd, opts),
      readFile: (path) => readFile(path, "utf-8"),
      writeFile: (path, content) => writeFile(path, content),
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
  }

  async onUnload(): Promise<void> {
    this.log?.info("[storage] Plugin unloaded.");
  }

  // ---------- RPC ----------

  /** Full storage view for the UI: every managed data drive + its state. */
  async getStatus(): Promise<StorageStatus> {
    return getStorageStatus(this.storageDeps);
  }

  /**
   * Re-scan for unmounted/mounted data drives (the "Detect drives" button).
   * `getStorageStatus` already enumerates every managed drive (including the
   * unmounted ones the UI offers to mount), so a separate candidate scan would
   * just be a second redundant `lsblk`.
   */
  async detectDrives(): Promise<StorageStatus> {
    return getStorageStatus(this.storageDeps);
  }

  /**
   * Mount the data drive with the given UUID at its Steam-visible mount point.
   * Only ever mounts an existing filesystem — never formats or repairs it.
   */
  async mountDrive(uuid: string): Promise<MountResult> {
    if (!uuid) {
      return { success: false, mountpoint: "", steamLibraryFound: false, error: "No drive selected." };
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
      let result: { success: boolean; error?: string };
      if (!enabled) {
        result = await unpersistFstab(this.storageDeps, { uuid });
      } else {
        const { drives } = await getStorageStatus(this.storageDeps);
        const drive = drives.find((d) => d.uuid.toLowerCase() === uuid.toLowerCase());
        if (!drive) return { success: false, error: `Drive ${uuid} not found.` };
        // Persist the live mount point if it's mounted, else the path we'd
        // mount it at — systemd's fstab generator creates the directory.
        const mountpoint = drive.mounted && drive.mountpoint ? drive.mountpoint : drive.suggestedMountpoint;
        result = await persistFstab(this.storageDeps, { uuid, mountpoint, fstype: drive.fstype });
      }
      this.emit?.({ event: "statusChanged", data: undefined });
      return result;
    } catch (e) {
      this.log?.warn(`[storage] setDriveAutoMount failed: ${e}`);
      return { success: false, error: String(e) };
    }
  }
}
