/**
 * Thin adapter — store-bridge maps `(driver, installed)` onto the
 * canonical shortcut spec in `@loadout/steam-shortcut`. The
 * three-call sequence, compat-tool / user-tag / collection writes,
 * and shortcuts.vdf-fallback appid lookup all live in the shared
 * package now.
 */
import {
  addNonSteamShortcut,
  removeNonSteamShortcut,
  type SteamShortcutResult,
} from "@loadout/steam-shortcut";
import type { InstalledGame } from "./types";
import type { StoreDriver } from "./stores/driver";

export type { SteamShortcutResult };

/**
 * Build the display name we use for the Steam shortcut. Suffixing
 * with the store name disambiguates from Steam-native entries (a
 * user might own the same title on both stores) and groups visually
 * in the library sidebar.
 */
export function shortcutDisplayName(
  driver: StoreDriver,
  installed: InstalledGame,
): string {
  return `${installed.title} (${driver.displayName})`;
}

export async function addToSteam(
  driver: StoreDriver,
  installed: InstalledGame,
): Promise<SteamShortcutResult> {
  const spec = driver.launchSpec(installed);
  if (!spec.exe) {
    throw new Error(
      `Driver ${driver.id} produced an empty launch exe for ${installed.title}`,
    );
  }
  return addNonSteamShortcut({
    displayName: shortcutDisplayName(driver, installed),
    exe: spec.exe,
    args: spec.args,
    cwd: spec.cwd,
    platform: installed.platform,
    userTag: driver.displayName,
    collectionName: driver.displayName,
  });
}

/** Remove a previously-added shortcut. No-op when Steam isn't reachable. */
export async function removeFromSteam(appId: number): Promise<void> {
  return removeNonSteamShortcut(appId);
}
