/**
 * Shared types for the `__core:game-library` core service.
 *
 * Implementation lives in `@loadout/game-library` (server-only) and is
 * hosted by the loader as the `__core:game-library` service. Plugins
 * MUST consume the service via its RPC surface — `useBackend("__core:game-library")`
 * — not import the implementation package. These types are the
 * compile-time contract for both sides of that RPC.
 */

export type GameSource = "steam" | "shortcut";

export interface GameInfo {
  appId: string;
  name: string;
  /** Size on disk in bytes (manifest-reported; 0 for shortcuts). */
  sizeOnDisk: number;
  /** Header artwork URL — local `/api/steam-grid/*` when the user has
   *  applied custom art (file exists in `userdata/<id>/config/grid/`),
   *  Steam CDN otherwise for real games. Shortcuts always use local. */
  headerUrl: string;
  /** Capsule artwork URL — same scheme as `headerUrl`. */
  capsuleUrl: string;
  /** Forced local-endpoint URL for the header — always points at the
   *  loader's `/api/steam-grid/<stem>/<userId>/header` route regardless
   *  of whether a file exists right now. Consumers that just wrote
   *  custom art use this with a cache-busting query string to refresh
   *  the tile without waiting for the public `Cache-Control: max-age`. */
  localHeaderUrl: string;
  /** Forced local-endpoint URL for the capsule. See `localHeaderUrl`. */
  localCapsuleUrl: string;
  /** Where the entry came from. */
  source: GameSource;
  /** Steam categories / collections this game belongs to (collection ids
   *  or legacy tag names). Used by callers to build collection filters. */
  tags: string[];
}

export interface GameCollection {
  id: string;
  count: number;
}

/**
 * Payload broadcast on the `libraryChanged` event when the library
 * rescan produces a different result from the prior cache.
 */
export interface GameLibraryChangedEvent {
  games: GameInfo[];
  collections: GameCollection[];
}
