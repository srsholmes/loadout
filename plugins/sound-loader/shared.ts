/**
 * Pure types + constants shared between the sound-loader backend (Bun)
 * and frontend (browser) bundles.
 *
 * Anything in this module must not import `node:*`, FFI, fs, or DOM APIs —
 * it has to load cleanly in both runtimes.
 */
import type { CommunityPackEntry } from "./lib/types";

/** Sound event keys supported by the sound engine. Must match in backend + frontend. */
export const SOUND_EVENTS = [
  "nav",
  "select",
  "back",
  "toggleOn",
  "toggleOff",
  "sliderUp",
  "error",
  "sideMenuIn",
  "sideMenuOut",
  "tabTransition",
] as const;

export type SoundEvent = (typeof SOUND_EVENTS)[number];

/**
 * Community pack entry, annotated with local install status. Returned by
 * `listCommunityPacks` and consumed by the Community tab. Single source
 * of truth — backend and app both import this.
 */
export interface CommunityPackInfo extends CommunityPackEntry {
  installed: boolean;
}

/**
 * Hostnames the plugin is permitted to contact via fetch / load images
 * from. Mirrors `package.json#plugin.permissions.network`, kept here so
 * runtime URL validation has a programmatic source of truth (the host
 * sandbox cannot today enforce this for raw `fetch`, so we self-enforce).
 *
 * `localhost` / `127.0.0.1` are CDP-only and never used for HTTP fetches
 * — they're not on this list intentionally, so registry-controlled URLs
 * can't be redirected to local services.
 */
export const ALLOWED_REGISTRY_HOSTS = new Set([
  "api.deckthemes.com",
  "cdn.deckthemes.com",
]);

/**
 * Returns true if `url` resolves to an allow-listed registry host.
 * Used to defend against a compromised deckthemes registry handing the
 * plugin arbitrary download/preview URLs.
 */
export function isAllowedRegistryUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    return ALLOWED_REGISTRY_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}
