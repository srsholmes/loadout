/**
 * Plugin-wide settings shape, lifted out of `backend.ts` so the
 * `lib/badge-scripts.ts` script generators can import it without
 * pulling in the backend (which would create a cycle).
 *
 * Kept as `interface` so `JSON.stringify` round-trips it as a plain
 * object; the in-page badge runtimes treat it as a structurally-typed
 * settings bag.
 */
export interface ProtonDBSettings {
  /** Badge size preset — affects icon + label dimensions. */
  size: "regular" | "small" | "minimalist";
  /** Badge corner / edge anchor. `t/b` + `l/m/r` = vertical + horizontal. */
  position: "tl" | "tm" | "tr" | "bl" | "bm" | "br";
  /** For minimalist size, what to reveal on hover. `off` keeps it bare. */
  labelOnHover: "off" | "small" | "regular";
  /** Whether to render the "Submit report" CTA next to the badge. */
  showSubmitButton: boolean;
  /** Master toggle for the Big Picture Mode (library) badge. */
  enableLibraryBadge: boolean;
  /** Master toggle for the store-page badge. */
  enableStoreBadge: boolean;
}

/** Default settings used when no persisted state exists yet. */
export const DEFAULT_SETTINGS: ProtonDBSettings = {
  size: "regular",
  position: "tl",
  labelOnHover: "off",
  showSubmitButton: false,
  enableLibraryBadge: true,
  enableStoreBadge: true,
};
