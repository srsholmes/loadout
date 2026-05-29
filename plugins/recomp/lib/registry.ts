import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GameEntry, Manifest, ModEntry, Registry } from "./types";
import bundled from "../games.json" with { type: "json" };

/**
 * Load the merged game registry from two sources:
 *
 *   1. `plugins/recomp/games.json` — the legacy bundled list,
 *      mostly `prebuilt` and `rom_extract` entries that are pure
 *      data with no install code. ~460 entries; kept inline so we
 *      don't generate hundreds of tiny manifest files.
 *
 *   2. `plugins/recomp/games/<id>/manifest.json` — per-game
 *      directories for `build_from_source` entries that ship their
 *      own `setup.ts` recipe. Each manifest is converted into a
 *      `GameEntry` with `installType: "build_from_source"`.
 *
 * If an id appears in BOTH sources, the directory wins — the
 * recipe-driven entry overrides the JSON one. This lets us migrate
 * games incrementally without breaking the catalog.
 *
 * The function is sync because it's called once at backend startup
 * and the file count is small. Non-sync I/O during plugin init
 * complicates the loader's RPC bootstrap.
 */
export function loadBundledRegistry(): GameEntry[] {
  const fromJson = (bundled as Registry).games;
  const fromDir = scanGamesDirectory();

  const overridden = new Set(fromDir.map((g) => g.id));
  const merged = [
    ...fromJson.filter((g) => !overridden.has(g.id)),
    ...fromDir,
  ];
  // Validate mods on every merged entry — the games.json path doesn't
  // go through validateManifest, so a fat-fingered mod entry would
  // otherwise reach the UI and 500 on install. Invalid entries are
  // dropped with a console warning; the rest of the game survives.
  return merged.map((entry) => filterValidMods(entry));
}

/** Apply `validateModEntry` to every mod on `entry`, dropping
 *  invalid ones with a console warning. Idempotent. */
function filterValidMods(entry: GameEntry): GameEntry {
  if (!entry.mods || entry.mods.length === 0) return entry;
  const valid: ModEntry[] = [];
  for (const mod of entry.mods) {
    const err = validateModEntry(entry.id, mod);
    if (err) {
      console.warn(`[recomp] ${entry.id}: dropping mod entry — ${err}`);
      continue;
    }
    valid.push(mod);
  }
  return { ...entry, mods: valid };
}

/**
 * Resolve the absolute path to a per-game `setup.ts`, or null if
 * none exists for that id. Used by the install pipeline to spawn
 * the recipe.
 */
export function setupScriptPathFor(id: string): string | null {
  const dir = gamesDirPath();
  if (!dir) return null;
  const candidate = join(dir, id, "setup.ts");
  return existsSync(candidate) ? candidate : null;
}

/**
 * Resolve the absolute path to a per-mod setup module under
 * `plugins/recomp/games/<gameId>/mods/<modId>/<file>`. Returns null
 * when the path doesn't exist. The mod install pipeline calls this
 * before dynamic-importing the script — if it returns null we abort
 * with an actionable error rather than letting `import()` swallow
 * the missing file.
 */
export function setupModulePathFor(
  gameId: string,
  modId: string,
  filename: string,
): string | null {
  const dir = gamesDirPath();
  if (!dir) return null;
  const candidate = join(dir, gameId, "mods", modId, filename);
  return existsSync(candidate) ? candidate : null;
}

/**
 * Validate a single mod entry against the rules the install pipeline
 * relies on. Returns an error string when invalid; null on success.
 * Exported so the registry loader AND `backend.installMod` can both
 * gate on the same rules — the backend re-checks at install time so
 * a manifest that mutated after load can't slip through.
 */
export function validateModEntry(
  gameId: string,
  mod: ModEntry,
): string | null {
  if (typeof mod.id !== "string" || mod.id.length === 0) {
    return "Mod entry missing id";
  }
  if (typeof mod.name !== "string" || mod.name.length === 0) {
    return `Mod "${mod.id}" missing name`;
  }
  if (!mod.source || typeof mod.source !== "object") {
    return `Mod "${mod.id}" missing source`;
  }
  if (mod.source.kind === "manual-import" && !mod.externalUrl) {
    return `Mod "${mod.id}" is manual-import but has no externalUrl — the "Open page" button has nowhere to go`;
  }
  if (!mod.setupModule && !mod.installSubdir) {
    return `Mod "${mod.id}" declares neither setupModule nor installSubdir — install would be a no-op`;
  }
  if (mod.setupModule && !setupModulePathFor(gameId, mod.id, mod.setupModule)) {
    return `Mod "${mod.id}" declares setupModule "${mod.setupModule}" but the file doesn't exist at games/${gameId}/mods/${mod.id}/${mod.setupModule}`;
  }
  return null;
}

// ── Internals ────────────────────────────────────────────────────────

/** Resolve `<plugin-root>/games` regardless of where this module is
 *  imported from. Works in dev (running `bun` from the monorepo
 *  root) and in install (`~/.local/share/steam-loader/plugins/recomp`).
 *
 *  Both layouts converge on the same `../games` parent-walk:
 *    - Source: `plugins/recomp/lib/registry.ts` → `plugins/recomp/games`
 *    - Bundled (loader emits `<plugin>/.cache/backend.bundle.js`):
 *      `plugins/recomp/.cache/` → `plugins/recomp/games`
 *  Both `here` values are exactly one level below the plugin root, so
 *  a single candidate handles both modes.
 */
function gamesDirPath(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidate = join(here, "..", "games");
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate;
    }
  } catch {
    // `import.meta.url` may not be defined in some bundlers / runtimes;
    // the registry just degrades to bundled-games.json-only.
  }
  return null;
}

function scanGamesDirectory(): GameEntry[] {
  const dir = gamesDirPath();
  if (!dir) return [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const result: GameEntry[] = [];
  for (const name of entries) {
    const subdir = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(subdir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    const manifestPath = join(subdir, "manifest.json");
    if (!existsSync(manifestPath)) continue;

    let manifest: Manifest;
    try {
      const raw = readFileSync(manifestPath, "utf8");
      const parsed = JSON.parse(raw);
      if (!validateManifest(parsed)) {
        console.warn(
          `[recomp] Skipping ${manifestPath}: invalid manifest (id/name/repo/platform required, id must match dir)`,
        );
        continue;
      }
      manifest = parsed;
    } catch (err) {
      console.warn(`[recomp] Skipping ${manifestPath}: ${err}`);
      continue;
    }

    if (manifest.id !== name) {
      console.warn(
        `[recomp] Skipping ${manifestPath}: manifest.id "${manifest.id}" doesn't match directory name "${name}"`,
      );
      continue;
    }

    if (!existsSync(join(subdir, "setup.ts"))) {
      console.warn(
        `[recomp] Skipping ${manifestPath}: no setup.ts found alongside manifest`,
      );
      continue;
    }

    result.push(manifestToGameEntry(manifest));
  }
  return result;
}

function validateManifest(m: unknown): m is Manifest {
  if (typeof m !== "object" || m === null) return false;
  const obj = m as Record<string, unknown>;
  if (
    !(
      typeof obj.id === "string" &&
      obj.id.length > 0 &&
      typeof obj.name === "string" &&
      obj.name.length > 0 &&
      typeof obj.repo === "string" &&
      obj.repo.length > 0 &&
      typeof obj.platform === "string" &&
      obj.platform.length > 0
    )
  ) {
    return false;
  }
  // Mods are optional. When present, validate each entry; reject the
  // whole manifest if any entry fails. The error winds up in the
  // console warning that's already printed for skipped manifests.
  if (obj.mods !== undefined) {
    if (!Array.isArray(obj.mods)) return false;
    for (const mod of obj.mods as ModEntry[]) {
      const err = validateModEntry(obj.id as string, mod);
      if (err) {
        console.warn(`[recomp] manifest ${obj.id}: ${err}`);
        return false;
      }
    }
  }
  return true;
}

function manifestToGameEntry(m: Manifest): GameEntry {
  return {
    id: m.id,
    name: m.name,
    project: m.project,
    platform: m.platform,
    repo: m.repo,
    description: m.description ?? "",
    installType: "build_from_source",
    // Empty — the recipe owns the build, no GitHub asset matching.
    releaseAssets: {},
    // Populated post-install when the recipe calls
    // sdk.declareLaunchCommand() or sdk.declareOutput(). Left
    // empty here so the catalog UI knows the binary path isn't
    // known until first build.
    launchCommand: {},
    requiresRom: m.requiresRom,
    romInfo: m.romInfo,
    tags: m.tags ?? [],
    website: m.website,
    steamGridDbId: m.steamGridDbId,
    preservePaths: m.preservePaths,
    userDataDir: m.userDataDir,
    mods: m.mods,
  };
}
