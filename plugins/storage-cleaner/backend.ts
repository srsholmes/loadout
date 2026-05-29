import type { PluginBackend, EmitPayload } from "@loadout/types";
import { getSteamAppsDir, getLibraryPaths } from "@loadout/steam-paths";
import { run } from "@loadout/exec";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { formatSize } from "./lib/size";
import { isValidAppId } from "./lib/appid";
import { parseDfOutput, type DiskPartition } from "./lib/parse-df";
import { buildAppManifestMap, type ManifestFile } from "./lib/manifests";
import { parseDuOutput } from "./lib/parse-du";

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
    entries = await fsp.readdir(steamAppsDir);
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
 * Aggregate appId → name across every Steam library on disk (default
 * steamapps + every extra library declared in libraryfolders.vdf), so
 * `getOrphanedData` doesn't falsely flag a game installed on a
 * secondary drive as orphaned just because the manifest lives there.
 */
async function parseAppManifestsAllLibraries(): Promise<Map<string, string>> {
  const libraries = await getLibraryPaths().catch(() => [getSteamAppsDir()]);
  const all = new Map<string, string>();
  for (const lib of libraries) {
    const partial = await parseAppManifests(lib);
    for (const [appId, name] of partial) all.set(appId, name);
  }
  return all;
}

/**
 * Batched `du -sb path1 path2 ...` — one fork per call, regardless of
 * how many directories. Replaces the per-entry pattern that forked
 * once per shadercache/compatdata subdir (which on a Deck with many
 * orphaned entries was the hottest cost in this plugin).
 */
async function getDirSizes(paths: string[]): Promise<Map<string, number>> {
  if (paths.length === 0) return new Map();
  try {
    const { stdout } = await run(["du", "-sb", ...paths]);
    return parseDuOutput(stdout);
  } catch {
    return new Map();
  }
}

/**
 * Filter a list of paths down to those that currently exist as
 * directories. Used to keep `df` from emitting "no such file"
 * warnings when an extra Steam library no longer exists, and to
 * skip missing shadercache/compatdata roots.
 */
async function filterExisting(paths: string[]): Promise<string[]> {
  const checks = await Promise.all(
    paths.map(async (p) => {
      try {
        const s = await fsp.stat(p);
        return s.isDirectory() ? p : null;
      } catch {
        return null;
      }
    }),
  );
  return checks.filter((p): p is string => p !== null);
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
   * `df -h` for `/`, `$HOME`, and every Steam library mountpoint —
   * deduped by filesystem. Reporting every library matters on
   * multi-drive setups (e.g. an SD-card SteamLibrary) where the
   * stacked-usage bar would otherwise show a "used" total that
   * exceeds the displayed disk capacity.
   */
  async getDiskUsage(): Promise<DiskPartition[]> {
    const libraries = await getLibraryPaths().catch(() => [] as string[]);
    const paths = await filterExisting(["/", homedir(), ...libraries]);
    const { stdout } = await run(["df", "-h", ...paths]);
    return parseDfOutput(stdout);
  }

  /**
   * Calculate shader cache size per game.
   */
  async getShaderCacheSize(): Promise<{ total: number; totalFormatted: string; games: GameEntry[] }> {
    const steamAppsDir = getSteamAppsDir();
    const shaderCacheDir = join(steamAppsDir, "shadercache");
    const appNames = await parseAppManifestsAllLibraries();

    const games: GameEntry[] = [];
    let total = 0;

    let entries: string[];
    try {
      entries = await fsp.readdir(shaderCacheDir);
    } catch {
      return { total: 0, totalFormatted: formatSize(0), games };
    }

    const paths = entries.map((e) => join(shaderCacheDir, e));
    const sizes = await getDirSizes(paths);
    for (const entry of entries) {
      const sizeBytes = sizes.get(join(shaderCacheDir, entry)) ?? 0;
      if (sizeBytes === 0) continue;
      total += sizeBytes;
      games.push({
        appId: entry,
        name: appNames.get(entry) ?? `Unknown App (${entry})`,
        sizeBytes,
        sizeFormatted: formatSize(sizeBytes),
      });
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
    const appNames = await parseAppManifestsAllLibraries();

    const games: GameEntry[] = [];
    let total = 0;

    let entries: string[];
    try {
      entries = await fsp.readdir(compatDataDir);
    } catch {
      return { total: 0, totalFormatted: formatSize(0), games };
    }

    const paths = entries.map((e) => join(compatDataDir, e));
    const sizes = await getDirSizes(paths);
    for (const entry of entries) {
      const sizeBytes = sizes.get(join(compatDataDir, entry)) ?? 0;
      if (sizeBytes === 0) continue;
      total += sizeBytes;
      games.push({
        appId: entry,
        name: appNames.get(entry) ?? `Unknown App (${entry})`,
        sizeBytes,
        sizeFormatted: formatSize(sizeBytes),
      });
    }

    games.sort((a, b) => b.sizeBytes - a.sizeBytes);
    return { total, totalFormatted: formatSize(total), games };
  }

  /**
   * Find orphaned shader cache and compat data — entries whose appId
   * doesn't match any installed game across any Steam library.
   */
  async getOrphanedData(): Promise<{ total: number; totalFormatted: string; entries: OrphanedEntry[] }> {
    const steamAppsDir = getSteamAppsDir();
    const installedAppIds = new Set((await parseAppManifestsAllLibraries()).keys());

    const shaderCacheDir = join(steamAppsDir, "shadercache");
    const compatDataDir = join(steamAppsDir, "compatdata");

    const [shaderEntries, compatEntries] = await Promise.all([
      fsp.readdir(shaderCacheDir).catch(() => [] as string[]),
      fsp.readdir(compatDataDir).catch(() => [] as string[]),
    ]);

    const candidates: Array<{ type: "shadercache" | "compatdata"; appId: string; path: string }> = [];
    for (const entry of shaderEntries) {
      if (installedAppIds.has(entry)) continue;
      candidates.push({ type: "shadercache", appId: entry, path: join(shaderCacheDir, entry) });
    }
    for (const entry of compatEntries) {
      if (installedAppIds.has(entry)) continue;
      candidates.push({ type: "compatdata", appId: entry, path: join(compatDataDir, entry) });
    }

    const sizes = await getDirSizes(candidates.map((c) => c.path));
    let total = 0;
    const orphaned: OrphanedEntry[] = [];
    for (const c of candidates) {
      const sizeBytes = sizes.get(c.path) ?? 0;
      if (sizeBytes === 0) continue;
      total += sizeBytes;
      orphaned.push({
        appId: c.appId,
        name: `Unknown App (${c.appId})`,
        sizeBytes,
        sizeFormatted: formatSize(sizeBytes),
        type: c.type,
      });
    }

    orphaned.sort((a, b) => b.sizeBytes - a.sizeBytes);
    return { total, totalFormatted: formatSize(total), entries: orphaned };
  }

  /**
   * Delete shader cache for specific app IDs. Uses `fs.rm` directly
   * instead of forking `rm -rf` — the appId validation guarantees the
   * leaf segment is a safe digit-only token, and `fs.rm` removes the
   * subprocess boundary as a vector for argv escaping mistakes.
   */
  async cleanShaderCache(appIds: string[]): Promise<{ deleted: string[]; errors: string[] }> {
    return this._cleanCache(appIds, "shadercache");
  }

  /**
   * Delete compatdata (Proton prefix) for specific app IDs.
   */
  async cleanCompatData(appIds: string[]): Promise<{ deleted: string[]; errors: string[] }> {
    return this._cleanCache(appIds, "compatdata");
  }

  private async _cleanCache(
    appIds: string[],
    type: "shadercache" | "compatdata",
  ): Promise<{ deleted: string[]; errors: string[] }> {
    const dir = join(getSteamAppsDir(), type);
    const deleted: string[] = [];
    const errors: string[] = [];

    for (const appId of appIds) {
      if (!isValidAppId(appId)) {
        errors.push(`${appId}: invalid app ID (must be numeric)`);
        continue;
      }
      try {
        await fsp.rm(join(dir, appId), { recursive: true, force: true });
        deleted.push(appId);
      } catch (err) {
        errors.push(`${appId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.emit?.({ event: "cacheCleared", data: { type, deleted, errors } });
    return { deleted, errors };
  }
}
