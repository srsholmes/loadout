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
  /** Header artwork URL — points at the loader's local
   *  `/api/steam-grid/<stem>/<userId>/header` route. That route's
   *  handler probes the user's `userdata/<id>/config/grid/` first
   *  (custom SGDB art wins), falls back to Steam's downloaded
   *  appcache, and only 302-redirects to the public CDN as a last
   *  resort. With its `Cache-Control: no-cache` + mtime-derived ETag
   *  the browser revalidates on every reload, so freshly-applied
   *  custom art shows up the next time a plugin grid mounts. */
  headerUrl: string;
  /** Capsule artwork URL — same scheme as `headerUrl`. */
  capsuleUrl: string;
  /** Local-endpoint URL for the header — always points at the loader's
   *  `/api/steam-grid/<stem>/<userId>/header` route. Now identical to
   *  `headerUrl` for both Steam apps and shortcuts; the field stays
   *  for backwards-compat and for the rare consumer that wants to
   *  append its own cache-busting query string after a write. */
  localHeaderUrl: string;
  /** Local-endpoint URL for the capsule. See `localHeaderUrl`. */
  localCapsuleUrl: string;
  /** Steam CDN URL for the header — only set for Steam apps (shortcuts
   *  have no CDN counterpart). Plugins that explicitly want the public,
   *  longer-cacheable CDN variant (skipping local custom art) can read
   *  this. Most plugins should prefer `headerUrl` so user customisation
   *  is respected. */
  cdnHeaderUrl?: string;
  /** Steam CDN URL for the capsule. See `cdnHeaderUrl`. */
  cdnCapsuleUrl?: string;
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
