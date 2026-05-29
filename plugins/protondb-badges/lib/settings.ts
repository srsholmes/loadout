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

const SIZE_VALUES: ReadonlySet<ProtonDBSettings["size"]> = new Set([
  "regular",
  "small",
  "minimalist",
]);

const POSITION_VALUES: ReadonlySet<ProtonDBSettings["position"]> = new Set([
  "tl",
  "tm",
  "tr",
  "bl",
  "bm",
  "br",
]);

const LABEL_ON_HOVER_VALUES: ReadonlySet<ProtonDBSettings["labelOnHover"]> = new Set(
  ["off", "small", "regular"],
);

function pickEnum<T extends string>(
  set: ReadonlySet<T>,
  candidate: unknown,
  fallback: T,
): T {
  return typeof candidate === "string" && (set as ReadonlySet<string>).has(candidate)
    ? (candidate as T)
    : fallback;
}

function pickBool(candidate: unknown, fallback: boolean): boolean {
  return typeof candidate === "boolean" ? candidate : fallback;
}

/**
 * Pick only well-formed values out of a possibly-malformed partial
 * settings bag. Anything missing or out-of-domain is replaced with
 * the current setting (so the caller's `coerceSettings(current, …)`
 * usage already merges over the existing state — no second spread
 * needed at the call site).
 *
 * Replaces a previous spread-merge that happily persisted invalid
 * enum values like `position: "garbage"` straight to disk; the
 * library then crashed the in-page badge runtime on the next
 * inject. The RPC surface is reachable from any plugin caller, so
 * structural defence is cheap insurance.
 */
export function coerceSettings(
  current: ProtonDBSettings,
  partial: unknown,
): ProtonDBSettings {
  const src = (typeof partial === "object" && partial !== null
    ? partial
    : {}) as Record<string, unknown>;
  return {
    size: pickEnum(SIZE_VALUES, src.size, current.size),
    position: pickEnum(POSITION_VALUES, src.position, current.position),
    labelOnHover: pickEnum(
      LABEL_ON_HOVER_VALUES,
      src.labelOnHover,
      current.labelOnHover,
    ),
    showSubmitButton: pickBool(src.showSubmitButton, current.showSubmitButton),
    enableLibraryBadge: pickBool(
      src.enableLibraryBadge,
      current.enableLibraryBadge,
    ),
    enableStoreBadge: pickBool(src.enableStoreBadge, current.enableStoreBadge),
  };
}
