import { join } from "node:path";
import { homedir } from "node:os";
import type { PlatformAssets, PlatformCommand } from "./types";

// Loadout is a Linux-only app, so the *host* is always Linux. `windows`
// remains as a *game-target*: recomp installs Windows game binaries that
// run via Proton on the Linux host (see getEffectivePlatformValue).
export type PlatformName = "linux" | "windows";

/** The host platform Loadout runs on — always Linux. */
export function currentPlatform(): PlatformName {
  return "linux";
}

export function dataDir(): string {
  return join(homedir(), ".local", "share", "recomp-hub");
}

export function gamesDir(): string {
  return join(dataDir(), "games");
}

export function tempDir(): string {
  return join(dataDir(), "tmp");
}

/**
 * Per-mod scratch dir. Setup scripts that need persistent scratch
 * across runs (e.g. caching a large download between attempts) get
 * their own subdir here. Lives under `$XDG_CACHE_HOME` so the user
 * can `rm -rf` it without breaking installed mods.
 */
export function modCacheDir(gameId: string, modId: string): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".cache");
  return join(base, "steam-loader", "recomp", "mods", gameId, modId);
}

export function configDir(): string {
  // Honour `$XDG_CONFIG_HOME` like `modCacheDir` honours XDG_CACHE_HOME.
  // On the device this is unset, so it resolves to the same
  // `~/.config/...` path as before — but it lets tests redirect state
  // writes into a temp sandbox (otherwise `os.homedir()` ignores the
  // `process.env.HOME` they set, and `updateSettings` leaks into the
  // real on-disk state and pollutes later tests).
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "steam-loader", "recomp");
}

export function getPlatformValue<T extends PlatformAssets | PlatformCommand>(
  assets: T,
): string | undefined {
  // Host is always Linux; prefer the native Linux value. The
  // Linux→Windows-via-Proton fallback lives in getEffectivePlatformValue.
  return assets.linux ?? undefined;
}

export interface ResolvedPlatformValue {
  value: string;
  /** Which platform this value actually came from. `"windows"` on a
   *  linux host means the caller should wrap the launch in Proton —
   *  the Steam shortcut needs `SpecifyCompatTool` set after
   *  registration so Steam runs the .exe through the compat layer. */
  platform: PlatformName;
}

/**
 * Like `getPlatformValue` but with a Linux→Windows fallback: if the
 * current host is Linux and no Linux value exists, returns the
 * Windows value with `platform: "windows"` so the caller knows to
 * route through Proton. Other hosts behave like `getPlatformValue`.
 *
 * Used for the install pipeline + shortcut registration so games
 * that ship Windows binaries (Sonic Unleashed Recomp, Space Cadet
 * Pinball, etc.) become "available" on Linux instead of dead-ended
 * at "unavailable".
 */
export function getEffectivePlatformValue<T extends PlatformAssets | PlatformCommand>(
  assets: T,
): ResolvedPlatformValue | undefined {
  const native = getPlatformValue(assets);
  // Use `!= null` not `!== undefined`: many `games.json` entries
  // declare a platform as literal `null` (e.g. drmario64-recomp:
  // `releaseAssets: { windows: "…", linux: null }`) meaning "not
  // shipped for this platform". Without this check, the null would
  // propagate through as the resolved value, downstream
  // `globMatches(null, …)` crashes with `null is not an object
  // (evaluating 'pattern.toLowerCase')`, AND the Windows-via-Proton
  // fallback below is shadowed because we'd never reach it.
  if (native != null) {
    return { value: native, platform: currentPlatform() };
  }
  if (currentPlatform() === "linux" && assets.windows) {
    return { value: assets.windows, platform: "windows" };
  }
  return undefined;
}
