import type { PluginBackend, EmitPayload } from "@loadout/types";
import { getSteamAppsDir } from "@loadout/steam-paths";
import { run, runFull } from "@loadout/exec";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { formatSize } from "./lib/size";
import { isValidAppId } from "./lib/appid";
import { parseDfOutput, type DiskPartition } from "./lib/parse-df";
import { buildAppManifestMap, type ManifestFile } from "./lib/manifests";

interface GameEntry {
  appId: string;
  name: string;
  sizeBytes: number;
  sizeFormatted: string;
}

interface OrphanedEntry extends GameEntry {
  type: "shadercache" | "compatdata";
}

/**
 * Read every appmanifest_*.acf in `steamAppsDir` and aggregate into an
 * appId → name map. I/O happens here; the pure filter + parse + collect
 * lives in `lib/manifests.ts` so its silent-skip branches are
 * directly testable.
 */
async function parseAppManifests(steamAppsDir: string): Promise<Map<string, string>> {
  let entries: string[];
  try {
    entries = await readdir(steamAppsDir);
  } catch {
    return new Map();
  }
  const files: ManifestFile[] = [];
  for (const name of entries) {
    if (!name.startsWith("appmanifest_") || !name.endsWith(".acf")) continue;
    try {
      const content = await Bun.file(join(steamAppsDir, name)).text();
      files.push({ name, content });
    } catch {
      // Skip unreadable manifests.
    }
  }
  return buildAppManifestMap(files);
}

/**
 * Get directory size in bytes using `du -sb`.
 */
async function getDirSize(path: string): Promise<number> {
  try {
    const { stdout } = await run(["du", "-sb", path]);
    const match = stdout.match(/^(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  } catch {
    return 0;
  }
}

export default class StorageCleanerBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;

  async onLoad(): Promise<void> {
    console.log("[storage-cleaner] Plugin loaded");
  }

  async onUnload(): Promise<void> {
    console.log("[storage-cleaner] Plugin unloaded");
  }

  /**
   * Run `df -h` and parse output for root and home partitions.
   */
  async getDiskUsage(): Promise<DiskPartition[]> {
    const { stdout } = await run(["df", "-h", "/", homedir()]);
    return parseDfOutput(stdout);
  }

  /**
   * Calculate shader cache size per game.
   */
  async getShaderCacheSize(): Promise<{ total: number; totalFormatted: string; games: GameEntry[] }> {
    const steamAppsDir = getSteamAppsDir();
    const shaderCacheDir = join(steamAppsDir, "shadercache");
    const appNames = await parseAppManifests(steamAppsDir);

    let total = 0;
    const games: GameEntry[] = [];

    try {
      const entries = await readdir(shaderCacheDir);
      for (const entry of entries) {
        const fullPath = join(shaderCacheDir, entry);
        const sizeBytes = await getDirSize(fullPath);
        if (sizeBytes === 0) continue;

        total += sizeBytes;
        games.push({
          appId: entry,
          name: appNames.get(entry) ?? `Unknown App (${entry})`,
          sizeBytes,
          sizeFormatted: formatSize(sizeBytes),
        });
      }
    } catch {
      // shadercache dir may not exist
    }

    games.sort((a, b) => b.sizeBytes - a.sizeBytes);
    return { total, totalFormatted: formatSize(total), games };
  }

  /**
   * Calculate compatdata (Proton prefix) size per game.
   */
  async getCompatDataSize(): Promise<{ total: number; totalFormatted: string; games: GameEntry[] }> {
    const steamAppsDir = getSteamAppsDir();
    const compatDataDir = join(steamAppsDir, "compatdata");
    const appNames = await parseAppManifests(steamAppsDir);

    let total = 0;
    const games: GameEntry[] = [];

    try {
      const entries = await readdir(compatDataDir);
      for (const entry of entries) {
        const fullPath = join(compatDataDir, entry);
        const sizeBytes = await getDirSize(fullPath);
        if (sizeBytes === 0) continue;

        total += sizeBytes;
        games.push({
          appId: entry,
          name: appNames.get(entry) ?? `Unknown App (${entry})`,
          sizeBytes,
          sizeFormatted: formatSize(sizeBytes),
        });
      }
    } catch {
      // compatdata dir may not exist
    }

    games.sort((a, b) => b.sizeBytes - a.sizeBytes);
    return { total, totalFormatted: formatSize(total), games };
  }

  /**
   * Find orphaned shader cache and compat data for games that are no longer installed.
   */
  async getOrphanedData(): Promise<{ total: number; totalFormatted: string; entries: OrphanedEntry[] }> {
    const steamAppsDir = getSteamAppsDir();
    const appNames = await parseAppManifests(steamAppsDir);
    const installedAppIds = new Set(appNames.keys());

    let total = 0;
    const orphaned: OrphanedEntry[] = [];

    // Check shadercache
    const shaderCacheDir = join(steamAppsDir, "shadercache");
    try {
      const entries = await readdir(shaderCacheDir);
      for (const entry of entries) {
        if (installedAppIds.has(entry)) continue;
        const fullPath = join(shaderCacheDir, entry);
        const sizeBytes = await getDirSize(fullPath);
        if (sizeBytes === 0) continue;
        total += sizeBytes;
        orphaned.push({
          appId: entry,
          name: `Unknown App (${entry})`,
          sizeBytes,
          sizeFormatted: formatSize(sizeBytes),
          type: "shadercache",
        });
      }
    } catch {
      // dir may not exist
    }

    // Check compatdata
    const compatDataDir = join(steamAppsDir, "compatdata");
    try {
      const entries = await readdir(compatDataDir);
      for (const entry of entries) {
        if (installedAppIds.has(entry)) continue;
        const fullPath = join(compatDataDir, entry);
        const sizeBytes = await getDirSize(fullPath);
        if (sizeBytes === 0) continue;
        total += sizeBytes;
        orphaned.push({
          appId: entry,
          name: `Unknown App (${entry})`,
          sizeBytes,
          sizeFormatted: formatSize(sizeBytes),
          type: "compatdata",
        });
      }
    } catch {
      // dir may not exist
    }

    orphaned.sort((a, b) => b.sizeBytes - a.sizeBytes);
    return { total, totalFormatted: formatSize(total), entries: orphaned };
  }

  /**
   * Delete shader cache for specific app IDs.
   */
  async cleanShaderCache(appIds: string[]): Promise<{ deleted: string[]; errors: string[] }> {
    const shaderCacheDir = join(getSteamAppsDir(), "shadercache");
    const deleted: string[] = [];
    const errors: string[] = [];

    for (const appId of appIds) {
      if (!isValidAppId(appId)) {
        errors.push(`${appId}: invalid app ID (must be numeric)`);
        continue;
      }
      const target = join(shaderCacheDir, appId);
      try {
        const { stderr, exitCode } = await runFull(["rm", "-rf", target]);
        if (exitCode === 0) deleted.push(appId);
        else errors.push(`${appId}: ${stderr.trim()}`);
      } catch (err) {
        errors.push(`${appId}: ${String(err)}`);
      }
    }

    this.emit?.({ event: "cacheCleared", data: { type: "shadercache", deleted, errors } });
    return { deleted, errors };
  }

  /**
   * Delete compatdata (Proton prefix) for specific app IDs.
   */
  async cleanCompatData(appIds: string[]): Promise<{ deleted: string[]; errors: string[] }> {
    const compatDataDir = join(getSteamAppsDir(), "compatdata");
    const deleted: string[] = [];
    const errors: string[] = [];

    for (const appId of appIds) {
      if (!isValidAppId(appId)) {
        errors.push(`${appId}: invalid app ID (must be numeric)`);
        continue;
      }
      const target = join(compatDataDir, appId);
      try {
        const { stderr, exitCode } = await runFull(["rm", "-rf", target]);
        if (exitCode === 0) deleted.push(appId);
        else errors.push(`${appId}: ${stderr.trim()}`);
      } catch (err) {
        errors.push(`${appId}: ${String(err)}`);
      }
    }

    this.emit?.({ event: "cacheCleared", data: { type: "compatdata", deleted, errors } });
    return { deleted, errors };
  }
}
