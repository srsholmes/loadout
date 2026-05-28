import type {
  EmitPayload,
  GameCollection,
  GameInfo,
  GameLibraryChangedEvent,
  PluginBackend,
} from "@loadout/types";
import {
  getCollectionsFromGames,
  scanLibrary,
} from "@loadout/game-library";

/**
 * `__core:game-library` core service. Replaces the deprecated
 * `game-browser` plugin (the panel had no UX value; the backend was
 * load-bearing for hltb / launch-options / sgdb / lsfg-vk /
 * protondb-badges). Lives in the loader so we have a single cache
 * shared across every consumer.
 *
 * Pattern mirrors `__core:game-detection`: the service owns the
 * cache, emits a `libraryChanged` event when the rescan result
 * differs from the prior cache (signature-compared so identical
 * rescans don't spam every subscriber), and exposes its RPC surface
 * through the normal `PluginBackend` resolver. The actual scan logic
 * is in `@loadout/game-library` and stays mockable as a separate
 * package.
 */
export class GameLibraryService implements PluginBackend {
  private cache: GameInfo[] | null = null;
  // Audit precedent A-026 in `__core:game-detection`: cache the
  // signature of the last broadcast so a no-op rescan (same games,
  // same order) doesn't trigger a re-render on every subscriber.
  // Seeded with the empty-state signature so the very first no-op
  // call also short-circuits.
  private lastBroadcastSig: string = "0|";
  emit?: (payload: EmitPayload) => void;

  /** Return the cached library, scanning on first access. */
  async getGames(): Promise<GameInfo[]> {
    if (this.cache === null) {
      this.cache = await scanLibrary();
    }
    return this.cache.map((g) => ({ ...g, tags: [...g.tags] }));
  }

  /** Derive collections from the cached library. */
  async getCollections(): Promise<GameCollection[]> {
    const games = this.cache ?? (await this.getGames());
    return getCollectionsFromGames(games);
  }

  /**
   * Force a re-scan. Broadcasts `libraryChanged` if the result differs
   * from the prior cache. Returns the fresh list either way.
   */
  async rescan(): Promise<GameInfo[]> {
    const fresh = await scanLibrary();
    this.cache = fresh;
    this.broadcastChange();
    return fresh.map((g) => ({ ...g, tags: [...g.tags] }));
  }

  private broadcastChange(): void {
    const games = this.cache ?? [];
    const sig = this.signature(games);
    if (sig === this.lastBroadcastSig) return;
    this.lastBroadcastSig = sig;
    const payload: GameLibraryChangedEvent = {
      games: games.map((g) => ({ ...g, tags: [...g.tags] })),
      collections: getCollectionsFromGames(games),
    };
    this.emit?.({ event: "libraryChanged", data: payload });
  }

  private signature(games: GameInfo[]): string {
    // Compact projection: count + sorted appId list. Two libraries with
    // identical membership are treated as identical; an appId or
    // shortcut added/removed flips the sig. Names/tags shifts don't
    // bump the signature today — consumers re-poll on `libraryChanged`
    // for fresh metadata when they care.
    const ids = games.map((g) => g.appId).sort();
    return `${games.length}|${ids.join(",")}`;
  }
}

export const GAME_LIBRARY_SERVICE_ID = "__core:game-library";
