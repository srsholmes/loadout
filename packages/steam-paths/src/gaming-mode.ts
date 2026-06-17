/**
 * SteamOS Gaming Mode detection.
 *
 * "Gaming Mode" is the gamescope session (Steam fullscreen GamepadUI), as
 * opposed to the KDE/Plasma desktop. Detect it by scanning /proc for a
 * running gamescope compositor process.
 *
 * We deliberately do NOT key off $GAMESCOPE_DISPLAY: session-level services
 * (the loader, the overlay) inherit GAMESCOPE_DISPLAY=":0" even in desktop
 * mode, so it falsely reports Gaming Mode. A running gamescope process is the
 * reliable signal.
 *
 * Shared between the overlay (gates the Steam SIGSTOP freeze) and the loader's
 * CEF injector (gates plugin injection — issue #111).
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
