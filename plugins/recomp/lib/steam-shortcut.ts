/**
 * Recomp-side adapter for `@loadout/steam-shortcut`. The Steam
 * three-call sequence + compat-tool + user-tag + collection writes
 * are owned by the shared package. Recomp keeps its launch-template
 * resolution (rom-path substitution, registry/platform-aware
 * launchCommand pick) here because that's recomp-specific.
 */
import {
  addNonSteamShortcut,
  removeNonSteamShortcut,
  type SteamShortcutResult,
} from "@loadout/steam-shortcut";
import { currentPlatform, getPlatformValue } from "./platform";
import { resolveTemplate } from "./pipeline";
import type { GameEntry, InstalledGame } from "./types";

export type { SteamShortcutResult };

/**
 * Display name appearing in the Steam library. Suffixing with
 * "(Recomp)" disambiguates from Steam-native entries and lets the
 * user see at a glance which shortcuts came from this plugin.
 */
function displayNameFor(entry: GameEntry): string {
  return `${entry.name} (Recomp)`;
}

/**
 * Resolve a recomp game's launch command for the current install
 * and produce the shared `addNonSteamShortcut` spec.
 */
function buildSpec(entry: GameEntry, installed: InstalledGame) {
  // Prefer the platform the install actually came from (set by the
  // pipeline) so Windows-via-Proton installs keep their .exe launch
  // command on a Linux host. Falls back to the current platform for
  // state files written before `installedPlatform` existed.
  const installPlatform = installed.installedPlatform ?? currentPlatform();

  // For build_from_source installs the launch command is set by the
  // recipe / installer-host's auto-wrapper at install time and
  // persisted on `installed.launchCommand` — the registry doesn't
  // know it since the build path varies per game. Prefer the
  // persisted value so post-restart re-adds work without depending
  // on a fresh install.
  const launchCmd =
    installed.launchCommand ??
    entry.launchCommand[installPlatform] ??
    getPlatformValue(entry.launchCommand);
  if (!launchCmd) {
    throw new Error(`No launch command for ${entry.name} on this platform`);
  }

  const resolved = resolveTemplate(
    launchCmd,
    installed.installDir,
    installed.romPath,
  );
  const parts = resolved.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    throw new Error("Empty launch command");
  }
  const [exe, ...argTokens] = parts;
  return {
    exe: exe!,
    args: argTokens.join(" "),
    platform: installPlatform,
  };
}

/**
 * Register a recomp game as a non-Steam shortcut. Tag stays
 * `"Recomp"` for back-compat with existing user libraries; the
 * `"Recomp Hub"` collection is new and places the shortcut in
 * Steam's Collections tab proper.
 */
export async function addToSteam(
  entry: GameEntry,
  installed: InstalledGame,
): Promise<SteamShortcutResult> {
  const spec = buildSpec(entry, installed);
  return addNonSteamShortcut({
    displayName: displayNameFor(entry),
    exe: spec.exe,
    args: spec.args,
    platform: spec.platform,
    userTag: "Recomp",
    collectionName: "Recomp Hub",
  });
}

/** Remove a previously-added shortcut. No-op if Steam isn't reachable. */
export async function removeFromSteam(appId: number): Promise<void> {
  return removeNonSteamShortcut(appId);
}
