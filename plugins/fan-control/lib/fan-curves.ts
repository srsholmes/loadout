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

export type PresetName = "silent" | "balanced" | "performance";

/** Built-in fan-curve presets, keyed by name. */
export const FAN_CURVES: Record<PresetName, FanCurvePoint[]> = {
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
  const first = curve[0];
  const last = curve[curve.length - 1];
  if (!first || !last) return 0;
  if (tempC <= first.tempC) return first.percent;
  if (tempC >= last.tempC) return last.percent;

  for (let i = 0; i < curve.length - 1; i++) {
    const lo = curve[i]!; // i < curve.length - 1, so i and i+1 are in bounds
    const hi = curve[i + 1]!;
    if (tempC >= lo.tempC && tempC <= hi.tempC) {
      const ratio = (tempC - lo.tempC) / (hi.tempC - lo.tempC);
      return Math.round(lo.percent + ratio * (hi.percent - lo.percent));
    }
  }

  return last.percent;
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

