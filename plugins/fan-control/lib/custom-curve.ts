/**
 * User-editable custom fan curve — limits + sanitisation. Pure logic, no
 * I/O.
 *
 * The built-in presets in `./fan-curves` ship as fixed `FanCurvePoint[]`
 * tables. A custom curve is the same shape, but its points come from the
 * UI graph editor and round-trip through plugin storage, so the values
 * are untrusted: they can arrive out of order, with duplicate or
 * out-of-range temperatures, non-numeric junk, or too few/many points.
 *
 * `sanitiseCurve` is the single chokepoint that turns any such input into
 * a curve `interpolateCurve` can safely consume — strictly-ascending
 * temperatures (no divide-by-zero in the interpolation), clamped ranges,
 * and a guaranteed minimum point count. It NEVER throws: malformed input
 * collapses to the default curve rather than leaving fan control wedged.
 */

import type { FanCurvePoint } from "./fan-curves";
import { clampPercent } from "./fan-curves";

/** Editable temperature range for custom-curve points (°C). */
export const CURVE_TEMP_MIN = 20;
export const CURVE_TEMP_MAX = 100;

/** A custom curve must have at least this many points (interpolation needs ≥2). */
export const CURVE_MIN_POINTS = 2;
/** ...and at most this many — keeps the editor and the graph legible. */
export const CURVE_MAX_POINTS = 8;

/**
 * Starting curve offered to a user who has never edited one. A gentle
 * ramp that mirrors the "balanced" preset's intent: near-silent when
 * cool, full tilt before the safety floor would take over.
 */
export const DEFAULT_CUSTOM_CURVE: readonly FanCurvePoint[] = [
  { tempC: 40, percent: 20 },
  { tempC: 55, percent: 45 },
  { tempC: 70, percent: 70 },
  { tempC: 85, percent: 100 },
];

/** Clamp a temperature into the editable range and round to a whole °C. */
export function clampTemp(tempC: number): number {
  return Math.max(CURVE_TEMP_MIN, Math.min(CURVE_TEMP_MAX, Math.round(tempC)));
}

function freshDefault(): FanCurvePoint[] {
  return DEFAULT_CUSTOM_CURVE.map((p) => ({ ...p }));
}

/**
 * Coerce arbitrary input into a valid, strictly-ascending fan curve.
 *
 * Pipeline:
 *   1. Keep only entries with finite numeric tempC + percent.
 *   2. Clamp temp into [CURVE_TEMP_MIN, CURVE_TEMP_MAX] and percent into
 *      [0, 100], rounding both to whole numbers.
 *   3. Sort ascending by temp, then drop any point whose temp is ≤ the
 *      one before it — interpolateCurve divides by (hi.tempC - lo.tempC),
 *      so equal adjacent temps would be a divide-by-zero.
 *   4. Trim to CURVE_MAX_POINTS.
 *   5. If fewer than CURVE_MIN_POINTS survive, fall back to the default
 *      curve wholesale (a 1-point "curve" is meaningless).
 *
 * Total: never throws, always returns a curve safe for interpolateCurve.
 */
export function sanitiseCurve(input: unknown): FanCurvePoint[] {
  if (!Array.isArray(input)) return freshDefault();

  const cleaned: FanCurvePoint[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const { tempC, percent } = raw as { tempC?: unknown; percent?: unknown };
    if (typeof tempC !== "number" || !Number.isFinite(tempC)) continue;
    if (typeof percent !== "number" || !Number.isFinite(percent)) continue;
    cleaned.push({ tempC: clampTemp(tempC), percent: clampPercent(percent) });
  }

  cleaned.sort((a, b) => a.tempC - b.tempC);

  const ascending: FanCurvePoint[] = [];
  for (const point of cleaned) {
    const prev = ascending[ascending.length - 1];
    if (prev && point.tempC <= prev.tempC) continue;
    ascending.push(point);
    if (ascending.length >= CURVE_MAX_POINTS) break;
  }

  if (ascending.length < CURVE_MIN_POINTS) return freshDefault();
  return ascending;
}
