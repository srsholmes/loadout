/**
 * Shared types for the `__core:game-metadata` core service — the enriched
 * per-app corpus that `plugins/library-tabs` (and, later, any plugin that
 * wants genres / Deck compatibility / ownership) evaluates rules against.
 *
 * Relationship to `./game-library`: `GameInfo` is the cheap, hot path —
 * ~9 plugins call `getGames()` on mount just to render a name and a
 * capsule. `GameMetadata` is the expensive, cold path. They are
 * deliberately separate types served by separate services so that adding
 * a field here never widens the payload every other plugin pays for.
 *
 * Implementation lives in `@loadout/game-metadata` (server-only) and is
 * hosted by the loader. Plugins MUST consume it over RPC via
 * `useBackend("__core:game-metadata")`. These types are the compile-time
 * contract for both sides.
 *
 * ## Sentinel discipline
 *
 * Every numeric field uses **-1 for "unknown"** — never `0`, never
 * `undefined`, never omitted. This is load-bearing rather than stylistic:
 * a rule like "released before 2015" must be able to decide whether a
 * game with no known release date should match, and it cannot do that if
 * "unknown" and "1970" are both `0`. Making unknown a distinct, checkable
 * value is what lets range predicates return `indeterminate` instead of
 * silently excluding games — the failure mode that produces mysteriously
 * empty tabs.
 *
 * `lastPlayed` and `playtimeMinutes` carry a *third* state: `0` means
 * "provably never played" (Steam told us, and that is a useful thing to
 * filter on), while `-1` means "we don't know". Do not collapse them.
 */

import type { GameSource } from "./game-library";

/**
 * Steam's app type, normalised. Derived from `appinfo.vdf`'s
 * `common.type` or `appStore`'s numeric `app_type`, whichever provider
 * answered — the string form exists so rules and UI never traffic in
 * Steam's magic numbers (`1073741824` for a shortcut, `8` for a demo).
 */
export type AppKind =
  | "game"
  | "demo"
  | "dlc"
  | "tool"
  | "application"
  | "music"
  | "video"
  | "series"
  | "mod"
  | "config"
  | "beta"
  | "shortcut"
  | "unknown";

/** Steam Deck compatibility rating. Ordered worst → best for sorting. */
export type DeckCompat = "unknown" | "unsupported" | "playable" | "verified";

/** SteamOS compatibility rating — distinct from, and newer than, Deck. */
export type SteamOsCompat = "unknown" | "unsupported" | "compatible";

/**
 * The three sources that can contribute to a record, in ascending cost:
 * - `manifest` — `appmanifest_*.acf` + `shortcuts.vdf` on disk. Fast
 *   (~100 ms), always available, but only knows *installed* apps.
 * - `appstore` — Steam's live `window.appStore` over CDP. The only source
 *   of owned-but-not-installed apps; needs Steam's library to have booted.
 * - `appinfo` — `appcache/appinfo.vdf`. Slow to index but works with
 *   Steam closed, and is the only source of genres / publishers /
 *   Metacritic / the full feature set.
 */
export type MetadataProviderId = "manifest" | "appstore" | "appinfo";

/**
 * Steam store "features" (categories), as named booleans rather than the
 * 33 opaque numeric category ids Steam actually uses.
 */
export interface GameFeatures {
  singlePlayer: boolean;
  multiPlayer: boolean;
  coop: boolean;
  cloudSaves: boolean;
  achievements: boolean;
  tradingCards: boolean;
  workshop: boolean;
  fullControllerSupport: boolean;
  partialControllerSupport: boolean;
  remotePlayTogether: boolean;
  vr: boolean;
  hdr: boolean;
}

/** Every key of {@link GameFeatures} — useful for building rule pickers. */
export const GAME_FEATURE_KEYS = [
  "singlePlayer",
  "multiPlayer",
  "coop",
  "cloudSaves",
  "achievements",
  "tradingCards",
  "workshop",
  "fullControllerSupport",
  "partialControllerSupport",
  "remotePlayTogether",
  "vr",
  "hdr",
] as const satisfies readonly (keyof GameFeatures)[];

/** All-false feature set — the default when no provider has spoken. */
export function emptyFeatures(): GameFeatures {
  return {
    singlePlayer: false,
    multiPlayer: false,
    coop: false,
    cloudSaves: false,
    achievements: false,
    tradingCards: false,
    workshop: false,
    fullControllerSupport: false,
    partialControllerSupport: false,
    remotePlayTogether: false,
    vr: false,
    hdr: false,
  };
}

export interface GameMetadata {
  appId: string;
  name: string;
  /** `common.sortas` when Steam provides one, else `name`. Never empty. */
  sortAs: string;
  kind: AppKind;
  source: GameSource;
  installed: boolean;
  /**
   * `false` only ever means "not *provably* owned" — it is never proof of
   * non-ownership. Check `providers.appstore.status` before treating it
   * as authoritative; with no ownership snapshot every app reads `false`.
   */
  owned: boolean;
  /** Bytes. `-1` unknown. Shortcuts report `0` (Steam doesn't track them). */
  sizeOnDisk: number;
  /** Absolute install directory, or `null`. Drives SD-card / drive rules. */
  installPath: string | null;
  /** Epoch **seconds**. `-1` unknown. */
  releaseDate: number;
  /** Epoch **seconds** the app entered the library. `-1` unknown. */
  purchasedAt: number;
  /** Epoch **seconds** of last launch. `0` = provably never. `-1` unknown. */
  lastPlayed: number;
  /** Minutes across all clients. `0` = provably never. `-1` unknown. */
  playtimeMinutes: number;
  deckCompat: DeckCompat;
  steamOsCompat: SteamOsCompat;
  /** Steam user review percentage, 0–100. `-1` unknown. */
  reviewPercentage: number;
  /** Metacritic score, 0–100. `-1` unknown. */
  metacritic: number;
  /** Announced but unreleased. */
  comingSoon: boolean;
  /** Shared into this account from a Steam Family member. */
  familyShared: boolean;
  /**
   * Installed on some *other* client, so it can be streamed here.
   * TabMaster calls this "streamable".
   */
  streamable: boolean;
  developers: string[];
  publishers: string[];
  franchises: string[];
  genres: string[];
  /** Human-readable community/store tag names, not numeric tag ids. */
  storeTags: string[];
  /** Steam collection ids and user tags this app belongs to. */
  collections: string[];
  features: GameFeatures;
  /** Artwork URLs — carried over from `GameInfo` so consumers of this
   *  service don't have to join against `__core:game-library`. */
  headerUrl: string;
  capsuleUrl: string;
  /** Which providers actually contributed a field to this record. */
  contributors: MetadataProviderId[];
}

export interface ProviderState {
  status: "ok" | "stale" | "unavailable" | "loading";
  /** Epoch ms of the data being served. `0` when never captured. */
  capturedAt: number;
  /**
   * Rendered **verbatim** to the user whenever `status !== "ok"`. Write it
   * as a sentence a player can act on ("Steam isn't running — showing
   * ownership from 3 days ago"), not as an error code.
   */
  reason?: string;
  /**
   * Fields for which this provider is the *sole* source. Drives which
   * rules the filter builder disables and annotates when the provider is
   * unavailable — so a missing data source shows as "couldn't check"
   * rather than silently matching nothing.
   */
  ownsFields: readonly (keyof GameMetadata)[];
}

export interface GameMetadataSnapshot {
  games: GameMetadata[];
  providers: Record<MetadataProviderId, ProviderState>;
  /** Epoch ms this snapshot was assembled. */
  generatedAt: number;
}
