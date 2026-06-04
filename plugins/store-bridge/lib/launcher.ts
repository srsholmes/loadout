import { withSteamClient } from "@loadout/steam-cdp";
import type { InstalledGame } from "./types";

/**
 * Launch an installed game via Steam.
 *
 * Every install routes through Steam (`steam://rungameid/<gameid64>`)
 * after we've added the shortcut — same reasoning as the recomp
 * launcher: Steam owns playtime, the overlay attaches, and Gaming
 * Mode's home tile + this plugin share one launch code path.
 *
 * The Steam URL is dispatched via CDP rather than `xdg-open` because
 * the loader runs as a systemd user service with a minimal PATH; the
 * desktop's xdg-open shim isn't reliably reachable, and Steam's own
 * runtime shim doesn't dispatch to the live client when invoked
 * outside a normal desktop session.
 */
export async function launchGame(installed: InstalledGame): Promise<void> {
  if (!installed.addedToSteam || !installed.steamGameId64) {
    throw new Error(
      `${installed.title} is not yet registered with Steam. Open the detail page and choose 'Add to Steam'.`,
    );
  }
  const uri = `steam://rungameid/${installed.steamGameId64}`;
  await withSteamClient((sc) => sc.url.executeSteamURL(uri));
}
