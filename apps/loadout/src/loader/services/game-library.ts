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
import {
  SteamClientUnreachableError,
  withSteamClient,
} from "@loadout/steam-cdp";

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
  /**
   * Separate cache for the owned-augmented library (installed +
   * shortcuts + owned-but-not-installed). Kept distinct from `cache`
   * so the classic installed-only `getGames()` every other consumer
   * relies on is never contaminated with not-installed games.
   */
  private fullCache: GameInfo[] | null = null;
  /** Whether `fullCache` was built with owned games available (Steam
   *  reachable). Lets us avoid serving a stale installed-only list when
   *  Steam has since come up, and vice-versa. */
  private fullCacheOwnedAvailable = false;
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
   * Return the user's *entire owned* library — installed games and
   * non-Steam shortcuts (same as `getGames`) PLUS owned-but-not-
   * installed Steam titles. The extra titles are read from Steam's
   * in-memory `appStore.allApps` over CDP (`@loadout/steam-cdp`'s
   * `getAllApps()`), the only source for games that have no
   * `appmanifest_*.acf` on disk.
   *
   * `ownedAvailable` reflects whether that CDP read succeeded: when
   * Steam isn't running / its library UI hasn't booted the read throws
   * `SteamClientUnreachableError`, and we transparently fall back to the
   * installed-only scan so the picker still works — callers use the flag
   * to nudge the user to start Steam for the full library. Any other
   * error is rethrown (a genuine failure the caller should surface).
   *
   * Cached in `fullCache` (distinct from `getGames`'s installed-only
   * `cache`); `rescan()` clears both.
   */
  async getFullLibrary(): Promise<{
    games: GameInfo[];
    ownedAvailable: boolean;
  }> {
    let owned: Array<{ appId: string; name: string }> | null = null;
    try {
      owned = await withSteamClient((sc) => sc.apps.getAllApps());
    } catch (err) {
      if (!(err instanceof SteamClientUnreachableError)) throw err;
      owned = null; // Steam closed — fall back to installed-only.
    }

    // Only reuse the cache when it reflects the same owned-availability
    // as this call, so a first Steam-closed call doesn't pin an
    // installed-only list for a later Steam-open one (and vice-versa).
    if (this.fullCache !== null && this.fullCacheOwnedAvailable === (owned !== null)) {
      return {
        games: this.fullCache.map((g) => ({ ...g, tags: [...g.tags] })),
        ownedAvailable: owned !== null,
      };
    }

    const games = await scanLibrary({ ownedApps: owned ?? undefined });
    this.fullCache = games;
    this.fullCacheOwnedAvailable = owned !== null;
    return {
      games: games.map((g) => ({ ...g, tags: [...g.tags] })),
      ownedAvailable: owned !== null,
    };
  }

  /**
   * Force a re-scan. Broadcasts `libraryChanged` if the result differs
   * from the prior cache. Returns the fresh list either way.
   */
  async rescan(): Promise<GameInfo[]> {
    const fresh = await scanLibrary();
    this.cache = fresh;
    // Owned-augmented library is derived from a live CDP read; drop its
    // cache so the next `getFullLibrary` rebuilds against fresh state.
    this.fullCache = null;
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
