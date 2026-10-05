/**
 * Base-game overlays.
 *
 * Most catalog entries ARE the game: a recompilation or port that ships
 * its own binary and ingests the user's ROM. A few projects are instead
 * launchers / runtimes that run ON TOP of a retail PC game the user owns
 * on Steam — ReSkate (skate.) is the first. Upstream's install step is
 * "extract the launcher beside the game's own .exe", and the launcher
 * then finds the game's data via relative paths.
 *
 * We can't write into the user's Steam library (the backend runs as
 * root and the install dir must stay confined), and copying a 14 GB
 * game into the recomp install dir is a non-starter. So the install
 * stays in `<gamesDir>/<id>/` and we SYMLINK every top-level entry of
 * the base game's folder beside the extracted launcher. Wine resolves
 * Unix symlinks transparently, so from inside Proton the launcher sees
 * `Skate.exe` and the data folders right next to itself — exactly the
 * layout upstream documents. The launcher's own writes (`logs/`,
 * `Mods/`, its settings JSON) land in the install dir, not the Steam
 * library, and uninstall is still a plain `rm -rf` of the install dir:
 * `fs.rm` unlinks symlinks without following them, so the Steam copy
 * is never touched.
 *
 * Resolution order for the base game's folder:
 *   1. a folder the user picked in the UI (persisted as the entry's
 *      `romPath` — same slot the ROM picker uses), verified to hold
 *      `requiredFile`;
 *   2. the Steam library: `appmanifest_<appId>.acf` in any library
 *      folder → `common/<installdir>`, again verified to hold
 *      `requiredFile` (a manifest exists while the download is still
 *      in progress, so the file check is what proves the game is
 *      actually there).
 */
import { readdir, readFile, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { getLibraryPaths } from "@loadout/steam-paths";
import type { BaseGameInfo } from "./types";

/**
 * Where Steam installed `appId`, or null when no library has a manifest
 * for it (or the manifest's `installdir` doesn't exist on disk yet).
 * `libraries` overrides the libraryfolders.vdf scan — for tests.
 */
export async function findSteamAppInstallDir(
  appId: number,
  libraries?: string[],
): Promise<string | null> {
  const libs = libraries ?? (await getLibraryPaths().catch(() => [] as string[]));
  for (const lib of libs) {
    let content: string;
    try {
      content = await readFile(join(lib, `appmanifest_${appId}.acf`), "utf-8");
    } catch {
      continue;
    }
    const installdir = content.match(/"installdir"\s+"([^"]+)"/)?.[1];
    if (!installdir) continue;
    const dir = join(lib, "common", installdir);
    if (existsSync(dir)) return dir;
  }
  return null;
}

export type BaseGameResolution =
  | { ok: true; dir: string; source: "picked" | "steam" }
  | { ok: false; reason: string };

/**
 * Decide which folder holds the base game. Never throws — a `reason`
 * is user-facing copy for the detail page, so it says what to do next
 * (finish the Steam download / pick the folder) rather than what
 * failed internally.
 */
export async function resolveBaseGameDir(
  info: BaseGameInfo,
  pickedDir: string | undefined,
  libraries?: string[],
): Promise<BaseGameResolution> {
  if (pickedDir && pickedDir.trim() !== "") {
    const dir = resolve(pickedDir.trim());
    if (existsSync(join(dir, info.requiredFile))) {
      return { ok: true, dir, source: "picked" };
    }
    return {
      ok: false,
      reason:
        `The folder you picked (${dir}) doesn't contain ${info.requiredFile}. ` +
        `Pick the ${info.name} install folder — in Steam: ${info.name} → Manage → ` +
        `Browse local files — or clear the path to detect it automatically.`,
    };
  }

  const steamDir = await findSteamAppInstallDir(info.steamAppId, libraries);
  if (steamDir && existsSync(join(steamDir, info.requiredFile))) {
    return { ok: true, dir: steamDir, source: "steam" };
  }
  if (steamDir) {
    return {
      ok: false,
      reason:
        `Steam has ${info.name} registered at ${steamDir}, but ${info.requiredFile} ` +
        `isn't there yet — it's probably still downloading. Let Steam finish, ` +
        `then install again.`,
    };
  }
  return {
    ok: false,
    reason:
      `${info.name} isn't installed through Steam on this device. Install it in ` +
      `Steam first (it must be your own copy), or pick the folder that contains ` +
      `${info.requiredFile}.`,
  };
}

/**
 * Symlink every top-level entry of `baseDir` into `stageDir`, skipping
 * names the extracted release already provides (the launcher's own
 * files win). Absolute link targets, so the links survive the
 * pipeline's `.partial` → final `rename`.
 *
 * Refuses nested layouts (one dir inside the other) — linking a folder
 * into its own subtree would make a cycle that every recursive walk
 * afterwards (chown, uninstall, backups) would have to special-case.
 */
export async function linkBaseGameInto(
  stageDir: string,
  baseDir: string,
): Promise<{ linked: string[]; skipped: string[] }> {
  const stage = resolve(stageDir);
  const base = resolve(baseDir);
  if (
    stage === base ||
    stage.startsWith(base + sep) ||
    base.startsWith(stage + sep)
  ) {
    throw new Error(
      `Refusing to link base game: ${base} and the install dir ${stage} overlap.`,
    );
  }

  const linked: string[] = [];
  const skipped: string[] = [];
  for (const name of await readdir(base)) {
    const dest = join(stage, name);
    if (existsSync(dest)) {
      skipped.push(name);
      continue;
    }
    await symlink(join(base, name), dest);
    linked.push(name);
  }
  return { linked, skipped };
}
