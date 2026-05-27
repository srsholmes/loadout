import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { configDir, gamesDir } from "./platform";
import type {
  PersistedState,
  InstalledGame,
  InstalledModEntry,
  Settings,
} from "./types";

const STATE_FILE = "state.json";

function defaultState(): PersistedState {
  return {
    version: 1,
    installPath: gamesDir(),
    games: {},
    romPaths: {},
    settings: {
      autoAddToSteam: true,
      updateCheckInterval: 86400,
    },
  };
}

export async function loadState(): Promise<PersistedState> {
  const path = join(configDir(), STATE_FILE);
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    const defaults = defaultState();
    return {
      ...defaults,
      ...parsed,
      settings: { ...defaults.settings, ...parsed.settings },
      games: parsed.games ?? {},
      romPaths: parsed.romPaths ?? {},
    };
  } catch {
    return defaultState();
  }
}

/**
 * Persist (or remove) a user-picked ROM path for a game id, so the
 * detail page can re-populate the input on next visit and the
 * pipeline can use it for retries / updates without prompting again.
 *
 * Pass `null` for the path to forget the entry (e.g. the user
 * cleared the input). Empty string is treated the same as null so
 * the caller doesn't have to think about it.
 */
export async function setRomPath(
  state: PersistedState,
  gameId: string,
  path: string | null,
): Promise<PersistedState> {
  const next: PersistedState = {
    ...state,
    romPaths: { ...(state.romPaths ?? {}) },
  };
  if (!path) {
    delete next.romPaths![gameId];
  } else {
    next.romPaths![gameId] = path;
  }
  await saveState(next);
  return next;
}

/**
 * Module-level FIFO queue that serializes `saveState` writes so two
 * concurrent callers can't interleave their atomic-write-and-rename
 * sequences and produce a torn / corrupt `state.json`.
 *
 * IMPORTANT: this only protects the *file write*. The read-modify-
 * write helpers below (`updateInstalledGame`, `removeInstalledGame`,
 * `updateSettings`, `setRomPath`) still operate on the `state`
 * argument they were given, so if two callers start from the same
 * snapshot and update different games concurrently, the second
 * write's snapshot will overwrite the first's game entry — i.e.
 * last-write-wins per call, not per game. Fixing that logical race
 * requires either a single-writer actor over `state` or a deeper
 * merge in each helper; the queue alone is not enough.
 *
 * `.catch(() => {})` on the chain ensures a failed write doesn't
 * poison the queue and block all future writes.
 */
let writeQueue: Promise<void> = Promise.resolve();

export async function saveState(state: PersistedState): Promise<void> {
  const next = writeQueue.then(async () => {
    const dir = configDir();
    await mkdir(dir, { recursive: true });
    const path = join(dir, STATE_FILE);
    const tmpPath = path + ".tmp";
    await writeFile(tmpPath, JSON.stringify(state, null, 2));
    await rename(tmpPath, path);
  });
  writeQueue = next.catch(() => {});
  return next;
}

export async function updateInstalledGame(
  state: PersistedState,
  gameId: string,
  game: InstalledGame,
): Promise<PersistedState> {
  const updated = {
    ...state,
    games: { ...state.games, [gameId]: game },
  };
  await saveState(updated);
  return updated;
}

export async function removeInstalledGame(
  state: PersistedState,
  gameId: string,
): Promise<PersistedState> {
  const { [gameId]: _, ...rest } = state.games;
  const updated = { ...state, games: rest };
  await saveState(updated);
  return updated;
}

export async function updateSettings(
  state: PersistedState,
  settings: Partial<Settings>,
): Promise<PersistedState> {
  const updated = {
    ...state,
    settings: { ...state.settings, ...settings },
  };
  await saveState(updated);
  return updated;
}

/**
 * Stamp an installed-mod entry under `state.games[gameId].installedMods[modId]`.
 *
 * No-op when the base game isn't installed — mods overlay an install,
 * they can't exist on their own. Caller should have already gated on
 * that, but we swallow rather than throw so a UI race (uninstall +
 * mod-install double-click) reduces to "the mod write disappears"
 * instead of an unhandled rejection that flips the install state.
 */
export async function recordInstalledMod(
  state: PersistedState,
  gameId: string,
  modId: string,
  entry: InstalledModEntry,
): Promise<PersistedState> {
  const game = state.games[gameId];
  if (!game) return state;
  const updatedGame: InstalledGame = {
    ...game,
    installedMods: { ...(game.installedMods ?? {}), [modId]: entry },
  };
  const updated = {
    ...state,
    games: { ...state.games, [gameId]: updatedGame },
  };
  await saveState(updated);
  return updated;
}

/**
 * Drop the installed-mod record for `gameId/modId`. Used when the
 * mod's files have been removed (or when the user uninstalls the
 * base game — the base uninstall pipeline blows the whole game entry
 * away, so this helper is for the targeted "remove just this mod"
 * path that v0.1 doesn't expose but the test suite covers).
 */
export async function removeInstalledMod(
  state: PersistedState,
  gameId: string,
  modId: string,
): Promise<PersistedState> {
  const game = state.games[gameId];
  if (!game?.installedMods?.[modId]) return state;
  const { [modId]: _, ...rest } = game.installedMods;
  const updatedGame: InstalledGame = {
    ...game,
    installedMods: rest,
  };
  const updated = {
    ...state,
    games: { ...state.games, [gameId]: updatedGame },
  };
  await saveState(updated);
  return updated;
}

/**
 * Drop `installedMods` entries whose mod id no longer appears in the
 * registry's mod catalog for that game. Runs at plugin onLoad as a
 * one-time sweep so state.json doesn't accumulate orphan records
 * when a catalog entry is renamed / removed across plugin releases.
 *
 * Takes a `catalog` map of `gameId → Set<modId>` built by the
 * caller from `loadBundledRegistry()`. No state write when nothing
 * needs cleaning.
 *
 * **Partial-registry-load safety**: if a game has installedMods on
 * disk but the catalog map has NO entry for that game (or an empty
 * set), the prune SKIPS that game's records — a registry-load
 * failure that dropped the manifest would otherwise look identical
 * to a legit "catalog entry removed upstream" signal and wipe
 * working data. The user gets a console warning so the silent skip
 * is visible.
 */
export async function pruneOrphanInstalledMods(
  state: PersistedState,
  catalog: Map<string, Set<string>>,
): Promise<PersistedState> {
  let mutated = false;
  const nextGames: Record<string, InstalledGame> = { ...state.games };
  for (const [gameId, game] of Object.entries(state.games)) {
    if (!game.installedMods) continue;
    if (Object.keys(game.installedMods).length === 0) continue;
    const allowed = catalog.get(gameId);
    if (!allowed || allowed.size === 0) {
      // Registry doesn't know about ANY mods for this game right now.
      // Either:
      //   - the game's manifest was dropped (rare; usually a recipe
      //     rename), OR
      //   - registry load failed mid-flight (a parse error / missing
      //     setup.ts skipped the game), OR
      //   - the games.json mods catalog was emptied upstream.
      // In every case, blanket-removing the user's installedMods is
      // a destructive overreach. Skip and log instead — the next
      // mod install will overwrite the orphan entry if it really is
      // gone, and a healthy registry load on subsequent boot will
      // converge.
      console.warn(
        `[recomp] pruneOrphanInstalledMods: skipping ${gameId} — registry has no mods for it (would have dropped ${Object.keys(game.installedMods).length} record(s)). Verify the game's manifest loaded correctly.`,
      );
      continue;
    }
    const filtered: Record<string, NonNullable<InstalledGame["installedMods"]>[string]> = {};
    let droppedAny = false;
    for (const [modId, entry] of Object.entries(game.installedMods)) {
      if (allowed.has(modId)) {
        filtered[modId] = entry;
      } else {
        droppedAny = true;
        console.log(
          `[recomp] pruneOrphanInstalledMods: dropping ${gameId}/${modId} (no longer in registry)`,
        );
      }
    }
    if (droppedAny) {
      mutated = true;
      nextGames[gameId] = { ...game, installedMods: filtered };
    }
  }
  if (!mutated) return state;
  const updated = { ...state, games: nextGames };
  await saveState(updated);
  return updated;
}
