/**
 * Thin adapter that maps a recomp `GameEntry` onto the canonical
 * SGDB-art pipeline in `@loadout/sgdb-art`. Recomp has a
 * `steamGridDbId` baked into many of its registry entries — pass
 * it through as a hint so the shared package can skip the title
 * autocomplete.
 *
 * Don't add logic in here — anything beyond mapping belongs in the
 * shared package so recomp + store-bridge can't drift apart on
 * artwork behaviour.
 */
import {
  applyAllArtwork,
  getCatalogCoverUrl,
  getCatalogHeroUrl,
} from "@loadout/sgdb-art";
import type { GameEntry } from "./types";

/**
 * Apply SGDB artwork to a freshly-added Steam shortcut. Returns a
 * `{ written }` count for the caller's progress message.
 *
 * Historically this threw when no SGDB API key was configured —
 * preserved here so existing callers (`pipeline.ts`, `backend.ts`)
 * keep their try/catch error rendering. The shared package signals
 * the same condition via `missingApiKey: true`.
 */
export async function applyArtwork(
  entry: GameEntry,
  appIdUint32: number,
): Promise<{ written: number }> {
  const result = await applyAllArtwork({
    appId: appIdUint32,
    source: "shortcut",
    title: entry.name,
    sgdbId:
      typeof entry.steamGridDbId === "number" && entry.steamGridDbId > 0
        ? entry.steamGridDbId
        : undefined,
  });
  if (result.missingApiKey) {
    throw new Error(
      "No SteamGridDB API key. Configure the SteamGridDB plugin to enable artwork for recomp installs.",
    );
  }
  return { written: result.written };
}

/**
 * Resolve a portrait-capsule URL for a recomp catalog entry — used
 * by the catalog tile to show real cover art for uninstalled games.
 * Null when no API key, no SGDB match, or any network failure.
 */
export async function getCatalogArtUrl(entry: GameEntry): Promise<string | null> {
  return getCatalogCoverUrl({
    title: entry.name,
    cacheKey: entry.id,
    sgdbId:
      typeof entry.steamGridDbId === "number" && entry.steamGridDbId > 0
        ? entry.steamGridDbId
        : undefined,
  });
}

/**
 * Resolve a landscape hero URL for a recomp catalog entry — used by
 * the detail page's hero banner. Null when no API key, no SGDB
 * match, or any network failure (the caller falls back to a flat
 * gradient or the capsule art).
 */
export async function getDetailHeroUrl(entry: GameEntry): Promise<string | null> {
  return getCatalogHeroUrl({
    title: entry.name,
    cacheKey: entry.id,
    sgdbId:
      typeof entry.steamGridDbId === "number" && entry.steamGridDbId > 0
        ? entry.steamGridDbId
        : undefined,
  });
}
