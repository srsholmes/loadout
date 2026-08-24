/**
 * Pure helpers for the OneXPlayer rumble-intensity attribute.
 *
 * The kernel's `hid-oxp` driver exposes two sysfs files on the gamepad's HID
 * device:
 *
 *   rumble_intensity        RW  a single u8, rejected above the range max
 *   rumble_intensity_range  RO  the literal string "0-5"
 *
 * It is **not** force feedback — there is no `FF_RUMBLE` and no `EVIOCSFF`,
 * so nothing appears under /sys/class/input/*&#47;device/ff*. It is one global
 * attenuator on the MCU: Steam Input decides what rumbles and how strongly
 * per effect, and this scales all of it. That makes it the only control that
 * reaches games ignoring Steam Input's own settings.
 *
 * The range is read rather than hardcoded: it is an RO attribute precisely so
 * userspace doesn't bake in 0–5, and a future device could widen it.
 */

/** The inclusive bounds the driver will accept. */
export interface IntensityRange {
  min: number;
  max: number;
}

/** Used when `rumble_intensity_range` is missing or unparseable. Matches
 *  every device the driver supports today. */
export const FALLBACK_RANGE: IntensityRange = { min: 0, max: 5 };

/**
 * Parse `rumble_intensity_range`. The driver emits exactly `"0-5\n"`, but
 * this is deliberately tolerant of whitespace and of a wider range appearing
 * later — and returns null rather than guessing when the shape is wrong, so
 * the caller can fall back explicitly.
 */
export function parseIntensityRange(raw: string | null): IntensityRange | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return null;
  const min = Number(m[1]);
  const max = Number(m[2]);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  // A range that doesn't ascend tells us nothing usable.
  if (max <= min) return null;
  return { min, max };
}

/** Round and clamp a requested level into the device's range. */
export function clampIntensity(value: number, range: IntensityRange): number {
  if (!Number.isFinite(value)) return range.min;
  return Math.max(range.min, Math.min(range.max, Math.round(value)));
}

/**
 * Whether a persisted value can be applied as-is.
 *
 * Storage is user-editable JSON, so this is the gate between the file and a
 * sysfs write — the driver rejects out-of-range values with EINVAL, but there
 * is no reason to hand it one.
 */
export function isValidIntensity(
  value: unknown,
  range: IntensityRange,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= range.min &&
    value <= range.max
  );
}

/**
 * Human label for a level. 0 is off rather than "very weak" — the driver
 * accepts it and the motors are silent, so no separate enable toggle is
 * needed (two controls over one register is how state-desync bugs start).
 */
export function intensityLabel(value: number, range: IntensityRange): string {
  if (value <= range.min) return "Off";
  if (value >= range.max) return "Full";
  return `Level ${value}`;
}
