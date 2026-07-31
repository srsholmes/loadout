import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";

export { isGamescopeRunning } from "./gaming-mode";

/**
 * Get the base Steam installation directory.
 * Checks standard path first, then Flatpak path.
 */
export function getSteamDir(): string {
  return join(homedir(), ".local", "share", "Steam");
}

/**
 * Get the Steam userdata directory (contains per-user configs, screenshots, etc.)
 */
export function getUserdataDir(): string {
  return join(getSteamDir(), "userdata");
}

/**
 * Get the default steamapps directory.
 */
export function getSteamAppsDir(): string {
  return join(getSteamDir(), "steamapps");
}

/**
 * Steam's library-art appcache. Each installed app has its own dir
 * under here with the standard set Steam itself downloads from the
 * CDN: `library_hero.jpg`, `library_600x900.jpg` (capsule, portrait),
 * `header.jpg`, `logo.png`. Used by the loader's steam-grid route as
 * a fallback when the user hasn't applied SGDB / custom artwork to a
 * given app — Steam already has the canonical files locally, so the
 * overlay can render art for every installed game offline without
 * round-tripping the CDN.
 */
export function getAppCacheLibraryDir(): string {
  return join(getSteamDir(), "appcache", "librarycache");
}

/**
 * Steam's shipped client UI bundle — the webpack output that renders Big
 * Picture / Gaming Mode.
 *
 * Read-only, and only ever *text-searched*: `@loadout/steam-cdp`'s service
 * caller greps these chunks for a literal like `"Player.GetAchievementsProgress#1"`
 * to discover which webpack module id currently exports that service, because
 * the ids change on every Steam build and hardcoding one is a guaranteed
 * breakage. Never write here.
 */
export function getSteamUiDir(): string {
  return join(getSteamDir(), "steamui");
}

/**
 * List the `chunk~*.js` files of Steam's UI bundle, newest first.
 *
 * Newest-first because a service literal is overwhelmingly likely to live in
 * a recently-built chunk, so callers that stop at the first hit do less I/O.
 *
 * The filenames are content-hashed by webpack, which makes the *set* of names
 * a free cache key for "has Steam's UI changed?" — see
 * `chunkCacheKey` in `@loadout/steam-cdp`. Returns `[]` when Steam isn't
 * installed rather than throwing; a caller with no chunks to search reports
 * that as an unresolved service, which is the more useful error.
 */
export async function listSteamUiChunks(): Promise<string[]> {
  const dir = getSteamUiDir();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const chunks = names.filter((n) => n.startsWith("chunk~") && n.endsWith(".js"));

  // stat every candidate up front so the sort comparator stays pure — an
  // async comparator would silently not sort.
  const withMtime = await Promise.all(
    chunks.map(async (name) => {
      const path = join(dir, name);
      try {
        return { path, mtimeMs: (await stat(path)).mtimeMs };
      } catch {
        // Vanished between readdir and stat (Steam updating underneath us).
        return null;
      }
    }),
  );

  return withMtime
    .filter((entry): entry is { path: string; mtimeMs: number } => entry !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((entry) => entry.path);
}

/**
 * Get all Steam library folder paths by parsing libraryfolders.vdf.
 * Returns the default steamapps path plus any additional library folders.
 */
export async function getLibraryPaths(): Promise<string[]> {
  const defaultPath = getSteamAppsDir();
  const paths: string[] = [defaultPath];

  try {
    const vdfPath = join(defaultPath, "libraryfolders.vdf");
    const content = await readFile(vdfPath, "utf-8");

    // Extract "path" values from libraryfolders.vdf
    const pathRegex = /"path"\s+"([^"]+)"/gi;
    let match: RegExpExecArray | null;
    while ((match = pathRegex.exec(content)) !== null) {
      // Group 1 is a required capture, so it is always present; `?? ""`
      // only satisfies the type checker.
      const libPath = join(match[1] ?? "", "steamapps");
      if (!paths.includes(libPath)) {
        paths.push(libPath);
      }
    }
  } catch {
    // libraryfolders.vdf doesn't exist or isn't readable — return default only
  }

  return paths;
}

export { steamArtworkUrls, type SteamArtworkUrls } from "./artwork.js";

/**
 * Enumerate Steam user IDs from the userdata directory.
 * Returns numeric directory names (Steam user IDs).
 */
export async function getUserIds(): Promise<string[]> {
  try {
    const entries = await readdir(getUserdataDir(), { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** A Steam-installed game, parsed from `appmanifest_*.acf`. */
export interface InstalledGame {
  /** Steam app id, the canonical id Steam uses for art and store URLs. */
  appId: string;
  /** Display name from the manifest. */
  name: string;
}

/**
 * Walk every Steam library path on disk and return the
 * `{appId, name}` pairs for every installed game. Filters out the
 * Steam runtime / Proton tooling apps so callers don't have to.
 *
 * Sorted alphabetically by name. Returns an empty array if Steam
 * isn't installed or no manifests exist.
 */
export async function listInstalledGames(): Promise<InstalledGame[]> {
  const libraries = await getLibraryPaths().catch(() => [] as string[]);
  const seen = new Map<string, string>();
  for (const lib of libraries) {
    let entries: string[];
    try {
      entries = await readdir(lib);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith("appmanifest_") || !entry.endsWith(".acf")) {
        continue;
      }
      try {
        const content = await readFile(join(lib, entry), "utf-8");
        const appIdMatch = content.match(/"appid"\s+"(\d+)"/);
        const nameMatch = content.match(/"name"\s+"([^"]+)"/);
        if (!appIdMatch || !nameMatch) continue;
        // Both matches are truthy and group 1 is a required capture in each,
        // so they are always present; `?? ""` only satisfies the type checker.
        const appId = appIdMatch[1] ?? "";
        const name = nameMatch[1] ?? "";
        // Skip Steam itself + Steam-runtime / Proton tooling apps.
        // They're "installed" technically but they don't carry user
        // game art, HLTB times, or any other library-level metadata
        // a plugin would care about.
        if (
          appId === "0" ||
          appId === "7" ||
          appId === "228980" ||
          /^steamlinuxruntime/i.test(name) ||
          /^proton/i.test(name)
        ) {
          continue;
        }
        // Library paths can overlap (rare but possible). Last write
        // wins — names are typically identical.
        seen.set(appId, name);
      } catch {
        /* skip unreadable manifest */
      }
    }
  }
  return Array.from(seen.entries())
    .map(([appId, name]) => ({ appId, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
