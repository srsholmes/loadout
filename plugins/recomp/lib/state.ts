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
    // Coerce the keyed maps to plain objects: a hand-edited state.json
    // with `"games": []` or `"games": "x"` would otherwise flow a
    // non-object through `{ ...current.games }` spreads and corrupt the
    // file on the next write. `?? {}` only guards null/undefined.
    const obj = <T>(v: unknown, fallback: T): T =>
      v != null && typeof v === "object" && !Array.isArray(v)
        ? (v as T)
        : fallback;
    return {
      ...defaults,
      ...parsed,
      settings: { ...defaults.settings, ...obj(parsed.settings, {}) },
      games: obj(parsed.games, {}),
      romPaths: obj(parsed.romPaths, {}),
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
  return mutateState((current) => {
    const next: PersistedState = {
      ...current,
      romPaths: { ...(current.romPaths ?? {}) },
    };
    if (!path) {
      delete next.romPaths![gameId];
    } else {
      next.romPaths![gameId] = path;
    }
    return next;
  });
}

/**
 * Module-level FIFO queue that serializes state mutations end-to-end.
 *
 * Two separate hazards motivate this:
 *
 *   1. Torn writes: two callers interleaving their atomic-write-and-
 *      rename sequences could produce a corrupt `state.json`.
 *   2. Lost updates (read-modify-write race): two callers that start
 *      from the SAME in-memory snapshot and update DIFFERENT games
 *      concurrently. With the old design each helper merged into the
 *      caller's stale `state` arg and wrote it, so the second write's
 *      snapshot lacked the first caller's change → that game entry was
 *      silently lost (last-write-wins per call rather than per game).
 *
 * Fix: route every mutation through `mutateState`, which queues the
 * WHOLE read-modify-write cycle. Inside the queued critical section it
 * re-reads the latest persisted state from disk and applies the
 * caller's `mutator` to THAT, so concurrent updates to different keys
 * merge instead of clobbering. Only one RMW runs at a time, so the
 * snapshot a mutator sees always reflects every prior committed write.
 *
 * Write failures are NOT swallowed for the caller: `mutateState`
 * returns the real promise (which rejects on failure). The queue link
 * (`writeQueue`) is the only thing that gets `.catch(() => {})`, purely
 * so one failed write can't poison the chain and wedge all future
 * writes — it never hides the error from the caller who initiated it.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

async function writeStateFile(state: PersistedState): Promise<void> {
  const dir = configDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, STATE_FILE);
  const tmpPath = path + ".tmp";
  await writeFile(tmpPath, JSON.stringify(state, null, 2));
  await rename(tmpPath, path);
}

/**
 * Atomic read-modify-write. Serialized behind `writeQueue` so the
 * `current` snapshot the `mutator` receives is always the latest
 * committed on-disk state, never a stale in-memory one held by a
 * concurrent caller. Returns the persisted state. Rejects (does not
 * swallow) if the read, mutate, or write throws.
 */
async function mutateState(
  mutator: (current: PersistedState) => PersistedState | Promise<PersistedState>,
): Promise<PersistedState> {
  const run = writeQueue.catch(() => undefined).then(async () => {
    const current = await loadState();
    const next = await mutator(current);
    await writeStateFile(next);
    return next;
  });
  writeQueue = run.catch(() => {});
  return run;
}

/**
 * Persist a full state object. Kept for callers that have already
 * computed the complete next state. Serialized behind the same queue
 * as `mutateState` to avoid torn / interleaved writes. Note this
 * still does a blind whole-object write — prefer the targeted helpers
 * (`updateInstalledGame` etc.) for concurrent-safe per-key updates.
 */
export async function saveState(state: PersistedState): Promise<void> {
  const run = writeQueue.catch(() => undefined).then(() => writeStateFile(state));
  writeQueue = run.catch(() => {});
  return run;
}

export async function updateInstalledGame(
  state: PersistedState,
  gameId: string,
  game: InstalledGame,
): Promise<PersistedState> {
  return mutateState((current) => ({
    ...current,
    games: { ...current.games, [gameId]: game },
  }));
}

/**
 * Remove a game's install record. Also drops the game's saved
 * `romPaths` entry so a later reinstall doesn't silently reuse a
 * stale ROM path the user never re-confirmed. The game's
 * `installedMods` live inside the `games[gameId]` entry, so deleting
 * that entry already clears them — no separate step needed.
 */
export async function removeInstalledGame(
  state: PersistedState,
  gameId: string,
): Promise<PersistedState> {
  return mutateState((current) => {
    const { [gameId]: _, ...rest } = current.games;
    const next: PersistedState = { ...current, games: rest };
    if (current.romPaths && gameId in current.romPaths) {
      const { [gameId]: _rom, ...restRoms } = current.romPaths;
      next.romPaths = restRoms;
    }
    return next;
  });
}

export async function updateSettings(
  state: PersistedState,
  settings: Partial<Settings>,
): Promise<PersistedState> {
  return mutateState((current) => ({
    ...current,
    settings: { ...current.settings, ...settings },
  }));
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
  return mutateState((current) => {
    const game = current.games[gameId];
    if (!game) return current;
    const updatedGame: InstalledGame = {
      ...game,
      installedMods: { ...(game.installedMods ?? {}), [modId]: entry },
    };
    return {
      ...current,
      games: { ...current.games, [gameId]: updatedGame },
    };
  });
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
  return mutateState((current) => {
    const game = current.games[gameId];
    if (!game?.installedMods?.[modId]) return current;
    const { [modId]: _, ...rest } = game.installedMods;
    const updatedGame: InstalledGame = {
      ...game,
      installedMods: rest,
    };
    return {
      ...current,
      games: { ...current.games, [gameId]: updatedGame },
    };
  });
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
  // Decide what to drop from the caller's snapshot (for the warn/log),
  // then apply those drops atomically onto the FRESH on-disk state via
  // `mutateState` — a blind `saveState` of the snapshot would clobber any
  // concurrent RPC write (e.g. a setRomPath serviced while this onLoad
  // sweep runs). Keyed per (gameId, modId) so we only remove the exact
  // orphans, leaving everything else (incl. concurrent edits) intact.
  const drops: Array<[string, string]> = [];
  for (const [gameId, game] of Object.entries(state.games)) {
    if (!game.installedMods) continue;
    if (Object.keys(game.installedMods).length === 0) continue;
    const allowed = catalog.get(gameId);
    if (!allowed || allowed.size === 0) {
      // Registry doesn't know about ANY mods for this game right now
      // (manifest dropped, registry load failed mid-flight, or catalog
      // emptied upstream). Blanket-removing the user's installedMods is
      // a destructive overreach — skip and log instead; the next mod
      // install / a healthy boot converges.
      console.warn(
        `[recomp] pruneOrphanInstalledMods: skipping ${gameId} — registry has no mods for it (would have dropped ${Object.keys(game.installedMods).length} record(s)). Verify the game's manifest loaded correctly.`,
      );
      continue;
    }
    for (const modId of Object.keys(game.installedMods)) {
      if (!allowed.has(modId)) {
        drops.push([gameId, modId]);
        console.log(
          `[recomp] pruneOrphanInstalledMods: dropping ${gameId}/${modId} (no longer in registry)`,
        );
      }
    }
  }
  if (drops.length === 0) return state;
  return mutateState((current) => {
    const nextGames: Record<string, InstalledGame> = { ...current.games };
    for (const [gameId, modId] of drops) {
      const game = nextGames[gameId];
      if (!game?.installedMods || !(modId in game.installedMods)) continue;
      const { [modId]: _removed, ...rest } = game.installedMods;
      nextGames[gameId] = { ...game, installedMods: rest };
    }
    return { ...current, games: nextGames };
  });
}
