/**
 * Pure color-math helpers for the display-settings plugin.
 *
 * floatToLong / longToFloat: pack/unpack a 32-bit IEEE 754 float as a
 * uint32 for writing/reading the GAMESCOPE_COLOR_SDR_GAMUT_WIDENESS X11
 * atom.
 *
 * kelvinToGamma: Tanner Helland algorithm — converts a color temperature
 * in Kelvin to an sRGB gamma-multiplier triple clamped to [0, 1].
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
 * Convert a color temperature in Kelvin to RGB gamma multipliers.
 *
 * Each channel is in [0, 1] (1.0 = full white for that channel).
 * Based on Tanner Helland's algorithm — fast approximation, good enough
 * for display calibration.
 */
export function kelvinToGamma(kelvin: number): {
  r: number;
  g: number;
  b: number;
} {
  const temp = kelvin / 100;
  let r: number, g: number, b: number;

  if (temp <= 66) {
    r = 255;
  } else {
    r = 329.698727446 * Math.pow(temp - 60, -0.1332047592);
    r = Math.max(0, Math.min(255, r));
  }

  if (temp <= 66) {
    g = 99.4708025861 * Math.log(temp) - 161.1195681661;
  } else {
    g = 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
  }
  g = Math.max(0, Math.min(255, g));

  if (temp >= 66) {
    b = 255;
  } else if (temp <= 19) {
    b = 0;
  } else {
    b = 138.5177312231 * Math.log(temp - 10) - 305.0447927307;
    b = Math.max(0, Math.min(255, b));
  }

  return {
    r: +(r / 255).toFixed(3),
    g: +(g / 255).toFixed(3),
    b: +(b / 255).toFixed(3),
  };
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
