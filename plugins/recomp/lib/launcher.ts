import { withSteamClient } from "@loadout/steam-cdp";
import type { GameEntry, InstalledGame } from "./types";

/**
 * Launch an installed recomp game via Steam.
 *
 * Recomp games are always launched through Steam (`steam://rungameid/
 * <gameid64>`) once they've been added as a non-Steam shortcut. This
 * means:
 *
 *   - Steam tracks playtime.
 *   - The Steam overlay attaches (community chat, screenshots, BPM
 *     overlay UI, …).
 *   - Launching from Gaming Mode home and launching from this plugin
 *     are the same code path — no surprises around "launches differently
 *     from different places".
 *
 * Dispatched via Steam's CDP (`SteamClient.URL.ExecuteSteamURL`) rather
 * than `xdg-open`. The loader runs as a systemd user service with a
 * stripped PATH; `xdg-open` either isn't found or resolves to Steam's
 * own runtime shim, which doesn't reliably dispatch to the live Steam
 * client when invoked outside a normal desktop session. CDP hands the
 * URL straight to the running client's URL handler — same path
 * quick-links uses for its cold-launch flow.
 */
export async function launchGame(
  _entry: GameEntry,
  installed: InstalledGame,
): Promise<void> {
  if (!installed.addedToSteam || !installed.steamGameId64) {
    throw new Error(
      "Game is not yet registered with Steam. Open the detail page and choose 'Add to Steam'.",
    );
  }

  const uri = `steam://rungameid/${installed.steamGameId64}`;
  console.log(`[recomp] launchGame: dispatching ${uri}`);
  await withSteamClient((sc) => sc.url.executeSteamURL(uri));
}
