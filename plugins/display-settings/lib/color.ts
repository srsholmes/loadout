/**
 * Pure color-math helpers for the display-settings plugin.
 *
 * floatToLong / longToFloat: pack/unpack a 32-bit IEEE 754 float as a
 * uint32 for writing/reading the GAMESCOPE_COLOR_SDR_GAMUT_WIDENESS X11
 * atom.
 *
 * percentToRaw / rawToPercent: scale between the 0-100 UI percentage
 * and the kernel's raw sysfs brightness range.
 */

/** Pack a float32 into a uint32 (little-endian bit-cast). */
export function floatToLong(x: number): number {
  const buf = new ArrayBuffer(4);
  new Float32Array(buf)[0] = x;
  return new Uint32Array(buf)[0];
}

/** Unpack a uint32 back to a float32 (little-endian bit-cast). */
export function longToFloat(x: number): number {
  const buf = new ArrayBuffer(4);
  new Uint32Array(buf)[0] = x;
  return new Float32Array(buf)[0];
}

/**
 * Scale a 0-100 brightness percentage to the raw sysfs integer value,
 * clamping to [0, maxBrightness].
 */
export function percentToRaw(percent: number, maxBrightness: number): number {
  return Math.round(Math.max(0, Math.min(1, percent / 100)) * maxBrightness);
}

/**
 * Scale a raw sysfs brightness value to a 0-100 percentage.
 */
export function rawToPercent(raw: number, maxBrightness: number): number {
  if (maxBrightness === 0) return 0;
  return Math.round((raw / maxBrightness) * 100);
}
