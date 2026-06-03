/**
 * Thin adapter that maps a store-bridge `LibraryEntry` to the
 * canonical SGDB-art pipeline in `@loadout/sgdb-art`. Epic
 * (and future GOG / Amazon) keyImage URLs land in `fallbackUrls`
 * so SGDB stays preferred while the store's own art covers
 * obscure titles SGDB doesn't have.
 *
 * Don't add logic in here — anything beyond mapping belongs in the
 * shared package so recomp + store-bridge can't drift apart.
 */
import {
  applyAllArtwork,
  type ApplyAllArtworkResult,
} from "@loadout/sgdb-art";
import type { LibraryEntry } from "./types";

export async function applyArtwork(
  entry: LibraryEntry,
  appIdUint32: number,
): Promise<ApplyAllArtworkResult> {
  return applyAllArtwork({
    appId: appIdUint32,
    source: "shortcut",
    title: entry.title,
    fallbackUrls: {
      grid_p: entry.coverUrl,
      hero: entry.heroUrl,
      logo: entry.logoUrl,
    },
  });
}
