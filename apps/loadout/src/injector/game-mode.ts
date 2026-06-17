/**
 * Gaming Mode detection for the CEF injector.
 *
 * Plugin CEF injection (ProtonDB / HLTB badges, route/menu patches, panels)
 * should only happen in Steam Gaming Mode, not in the desktop client — see
 * issue #111. We gate the injector on whether the SteamOS gamescope
 * compositor is running, scanning /proc/<pid>/comm.
 *
 * We deliberately do NOT key off $GAMESCOPE_DISPLAY: the loader runs as a
 * session-level service that inherits GAMESCOPE_DISPLAY=":0" even in desktop
 * mode, so it would falsely report Gaming Mode. A running gamescope process
 * is the reliable signal. (Same rationale and prefix-match as the overlay's
 * isGameModeActive in apps/loadout-overlay/src/bun/native/process-control.ts.)
 */

import { readdirSync, readFileSync } from "node:fs";

/**
 * True when a gamescope compositor process is running (Gaming Mode).
 *
 * Prefix-match, not exact: the SteamOS compositor's kernel comm is
 * "gamescope-wl" (the Wayland gamescope), not a bare "gamescope". Other
 * gamescope-spawned helpers ("gamescopereaper") share the prefix and are
 * Gaming-Mode-only too. The desktop's xdg-desktop-portal-gamescope is
 * truncated to "xdg-desktop-por" (15-char TASK_COMM_LEN), so it does NOT
 * start with "gamescope" — no false positive in desktop mode.
 */
export function isGamescopeRunning(): boolean {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return false;
  }
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    try {
      if (readFileSync(`/proc/${pid}/comm`, "utf8").trim().startsWith("gamescope")) {
        return true;
      }
    } catch {
      // Process gone between readdir and readFile — normal, skip.
    }
  }
  return false;
}
