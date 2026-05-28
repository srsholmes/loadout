/**
 * Fan-curve presets + interpolation + PWM↔percent conversion — pure
 * logic, no I/O.
 *
 * Split out of backend.ts so the curve maths and the duty-cycle
 * conversions are independently readable and unit-testable. The backend
 * reads sysfs and feeds temperatures / PWM register values through these
 * helpers; nothing here touches the filesystem or a subprocess.
 */

export interface FanCurvePoint {
  tempC: number;
  percent: number;
}

export type PresetName = "silent" | "balanced" | "performance" | "custom";

/** Built-in fan-curve presets, keyed by name. `custom` is user-supplied
 *  and lives on the backend, so it's excluded here. */
export const FAN_CURVES: Record<Exclude<PresetName, "custom">, FanCurvePoint[]> = {
  silent: [
    { tempC: 40, percent: 0 },
    { tempC: 50, percent: 20 },
    { tempC: 60, percent: 40 },
    { tempC: 70, percent: 60 },
    { tempC: 80, percent: 80 },
    { tempC: 90, percent: 100 },
  ],
  balanced: [
    { tempC: 30, percent: 15 },
    { tempC: 45, percent: 30 },
    { tempC: 55, percent: 50 },
    { tempC: 65, percent: 70 },
    { tempC: 75, percent: 85 },
    { tempC: 85, percent: 100 },
  ],
  performance: [
    { tempC: 30, percent: 30 },
    { tempC: 40, percent: 50 },
    { tempC: 50, percent: 60 },
    { tempC: 60, percent: 75 },
    { tempC: 70, percent: 90 },
    { tempC: 80, percent: 100 },
  ],
};

/**
 * Interpolate the target fan percent for a given temperature along a
 * curve. Points are assumed sorted ascending by `tempC`. Below the first
 * point the first percent is held; above the last point the last percent
 * is held; in between it's a linear interpolation rounded to a whole
 * percent. Pure.
 */
export function interpolateCurve(curve: FanCurvePoint[], tempC: number): number {
  if (tempC <= curve[0].tempC) return curve[0].percent;
  if (tempC >= curve[curve.length - 1].tempC) return curve[curve.length - 1].percent;

  for (let i = 0; i < curve.length - 1; i++) {
    const lo = curve[i];
    const hi = curve[i + 1];
    if (tempC >= lo.tempC && tempC <= hi.tempC) {
      const ratio = (tempC - lo.tempC) / (hi.tempC - lo.tempC);
      return Math.round(lo.percent + ratio * (hi.percent - lo.percent));
    }
  }

  return curve[curve.length - 1].percent;
}

/** Clamp a percent into [0, 100] and round to a whole number. Pure. */
export function clampPercent(percent: number): number {
  return Math.max(0, Math.min(100, Math.round(percent)));
}

/** Convert a fan percent (0–100) to a PWM register value (0–255). The
 *  input is clamped first so out-of-range callers can't escape [0, 255].
 *  Pure. */
export function percentToPwm(percent: number): number {
  return Math.round((clampPercent(percent) / 100) * 255);
}

/** Convert a PWM register value (0–255) to a fan percent (0–100),
 *  rounded to a whole percent. Pure. */
export function pwmToPercent(pwm: number): number {
  return Math.round((pwm / 255) * 100);
}

/**
 * Validate a user-supplied custom fan curve before it can drive
 * hardware. Returns an error string, or `null` when the curve is usable.
 * Pure.
 *
 * Requirements: at least 2 points, and every point's `tempC` / `percent`
 * must be a finite number (so a bad RPC payload can't sneak a NaN into
 * interpolateCurve, which would otherwise propagate to the PWM write).
 */
export function validateCurve(curve: FanCurvePoint[] | undefined): string | null {
  if (!curve || curve.length < 2) {
    return "Custom preset requires at least 2 curve points";
  }
  for (const point of curve) {
    if (
      !point ||
      !Number.isFinite(point.tempC) ||
      !Number.isFinite(point.percent)
    ) {
      return "Custom curve points must have finite tempC and percent values";
    }
  }
  return null;
}
