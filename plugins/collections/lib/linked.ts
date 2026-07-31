/**
 * The collections you already have in Steam. [iso]
 *
 * A **linked** collection is one this plugin did not create — EmuDeck / Steam
 * ROM Manager's `srm-*` sets, anything made by hand in Steam. They are read
 * live and never persisted: Steam owns them, and keeping a copy here would
 * only create two records to disagree with each other.
 *
 * They exist in the grid so the plugin tells the truth about your library. A
 * collections manager that showed only its own collections would be lying by
 * omission, and would happily create a second "Emulation" beside the one
 * EmuDeck made.
 *
 * Rules never apply to these. Pointing rules at a set somebody else curated
 * would replace their work on the first sync.
 *
 * Pure: takes what Steam reported and the ledger, returns a view. The CDP call
 * belongs to `backend.ts`.
 */

import type { SteamCollectionInfo } from "@loadout/steam-cdp";
import type { MirrorLedger } from "./types";

export interface LinkedCollection {
  /** Steam's own id — `srm-…`, `uc-…`. This is the only handle it has. */
  id: string;
  name: string;
  appIds: string[];
  /**
   * Steam recomputes this one's contents from a filter, so its membership is
   * not ours to set. The UI shows it read-only rather than offering an edit
   * that Steam would silently undo.
   */
  isDynamic: boolean;
  /**
   * Steam-derived and not the user's to change — `uncategorized`, `favorite`,
   * `local-install`, the `type-*` sets. These are library *filters* rather
   * than collections, so they are excluded from the grid entirely.
   */
  isEditable: boolean;
}

/**
 * Split what Steam reported into the collections worth showing.
 *
 * Two exclusions, for different reasons:
 *
 * - **Anything in the ledger** is one of ours, and is already on the grid as a
 *   managed collection. Listing it twice would be worse than confusing: the
 *   two cards would disagree the moment its rules matched something new.
 * - **Anything Steam derives** (`isEditable === false`) is a library filter —
 *   All Games, Installed, Uncategorized, Favorites. Steam already surfaces
 *   these in its own UI and recomputes them constantly; showing them here
 *   would put a second "Installed" beside Steam's and imply we could edit it.
 *
 * Dynamic collections *are* kept. They are the user's own, they show up in
 * Steam's sidebar, and hiding them would misrepresent the library — but they
 * are flagged so the UI can offer them read-only.
 */
export function linkedCollections(args: {
  steamCollections: readonly SteamCollectionInfo[];
  ledger: MirrorLedger;
}): LinkedCollection[] {
  const { steamCollections, ledger } = args;
  const ours = new Set(ledger.entries.map((e) => e.steamCollectionId));

  return steamCollections
    .filter((c) => !ours.has(c.id))
    .filter((c) => c.isEditable)
    .map((c) => ({
      id: c.id,
      name: c.name,
      appIds: [...c.appIds],
      isDynamic: c.isDynamic,
      isEditable: c.isEditable,
    }));
}

/**
 * Order for the grid: most-populated first, then by name.
 *
 * Steam's own ordering is not stable enough to rely on, and an alphabetical
 * list buries the collections you actually use behind a one-game experiment.
 * Ties break on name so the order does not shuffle between reads.
 */
export function sortLinked(collections: readonly LinkedCollection[]): LinkedCollection[] {
  return [...collections].sort(
    (a, b) => b.appIds.length - a.appIds.length || a.name.localeCompare(b.name),
  );
}
