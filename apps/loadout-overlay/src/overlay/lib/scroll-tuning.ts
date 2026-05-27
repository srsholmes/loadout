/**
 * Tuning constants for right-stick analog scroll.
 *
 * Shared between the two implementations:
 *   - useGamepadInput.ts (standalone dev, polls Web Gamepad API)
 *   - overlay-electrobun/.../main.tsx (production path, driven by
 *     evdev → rpc("overlay-scroll"))
 *
 * Keep these in one place so dev and prod scroll at identical rates.
 */

/** Stick magnitude below this is treated as released (drives momentum decay). */
export const RIGHT_STICK_DEADZONE = 0.15;

/** Pixels per frame at full deflection (|value| = 1). */
export const RIGHT_STICK_SPEED = 12;

/** Per-frame velocity multiplier after the stick re-centers. */
export const SCROLL_FRICTION = 0.92;

/** Velocity magnitude below this snaps to zero (so momentum doesn't dribble). */
export const SCROLL_MIN_VELOCITY = 0.5;
