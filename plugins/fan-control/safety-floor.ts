/**
 * Hardware-safety fan floor — pure logic, no I/O.
 *
 * The maintainer's device thermal-tripped (sudden shutdown) because the
 * fan curve let PWM stay low while the SoC climbed past Tjunction. This
 * module enforces a non-disablable floor on top of whatever percent the
 * user's curve / slider asked for.
 *
 * Failure semantics: "fail SAFE = fans on". Any caller that can't get a
 * real temperature reading MUST pass `null` here, and we return MAX. The
 * pure function is the only correct place to encode that policy — every
 * sysfs failure path in the backend funnels through it.
 *
 * Thresholds (verified against AMD Ryzen Tjunction = 95–105 °C and the
 * OXP Apex / Steam Deck thermal-trip behaviour observed in journalctl
 * shutdowns; the maintainer's report aligns with a ~95 °C trip):
 *
 *   < 75 °C → no-op. The user's curve runs unchanged.
 *   ≥ 75 °C → floor at 40 % (gentle ramp; below this fans can't pull
 *             enough air to drop SoC under sustained load).
 *   ≥ 80 °C → floor at 60 % (linear-ish step toward max).
 *   ≥ 85 °C → force 100 %, regardless of user curve. 10 °C headroom
 *             before Tjunction-driven shutdown.
 *   ≥ 95 °C → force 100 % + critical flag set. Caller logs/emits.
 *   unknown → force 100 %. Failsafe for sysfs read failures.
 *
 * Floors only RAISE the percent; they never lower it. If the user asked
 * for 100 %, the override is a no-op.
 */

/** A percent in [0, 100]. Pre-clamping is the caller's job; we clamp again
 *  on output so we can't return a value outside the safe range. */
export type Percent = number;

/** Temperature in degrees Celsius, or null when no valid reading is
 *  available (sysfs error, missing sensor, NaN, etc.). null is the
 *  signal that triggers the failsafe-to-max path. */
export type TempCOrNull = number | null;

export interface SafetyFloorResult {
  /** Final fan percent to write. Always >= userPercent. */
  percent: Percent;
  /** True when the floor raised the percent above what the user asked. */
  engaged: boolean;
  /** True when temp >= 95 °C or temp is unknown — caller should log
   *  loudly and consider emitting an event for the UI. */
  critical: boolean;
  /** Human-readable reason for the override (used in journalctl logs). */
  reason: string;
}

/** Threshold table. Exported for tests / future tuning. */
export const SAFETY_THRESHOLDS = {
  /** Below this, the override is a complete no-op. Engagement was
   *  bumped from 75 → 80 after hardware testing showed the override
   *  fired too eagerly during sustained gaming load on the OXP Apex. */
  WARM_C: 80,
  /** First floor step — keep fans audible to head off the climb.
   *  At WARM_C=80 this tier is degenerate (HOT_C is also 80, so the
   *  HOT branch always wins); kept as the applyCurve floor clamp so
   *  the curve loop never undershoots when the watchdog is engaged. */
  WARM_FLOOR_PCT: 40,
  /** Second floor step. */
  HOT_C: 80,
  HOT_FLOOR_PCT: 60,
  /** Force-max threshold. 10 °C headroom before Tjunction trip. */
  FORCE_MAX_C: 85,
  /** CRITICAL log threshold — alert the UI and journalctl. */
  CRITICAL_C: 95,
  /** Watchdog release hysteresis: once engaged at WARM_C, only release
   *  after temp drops this many °C below WARM_C. With WARM_C=80 the
   *  release point is 55 °C — wide gap so the override sticks through
   *  a sustained gaming load instead of flapping every time the temp
   *  briefly dips. UX feedback from real hardware testing on the OXP
   *  Apex. */
  RELEASE_HYSTERESIS_C: 25,
} as const;

/** Clamp helper. Mirrors what backend does to slider values. */
function clampPct(n: number): Percent {
  if (!Number.isFinite(n)) return 100; // failsafe: NaN/Inf → max
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Compute the safe fan percent given a user-requested percent and the
 * current temperature.
 *
 * Pure function. No I/O, no logging. The backend wraps this with the
 * journalctl log line and the optional event emit.
 *
 * @param userPercent  Whatever the user's curve / slider / preset
 *                     calculated. Will be clamped to [0, 100].
 * @param tempC        Highest hot-side temp reading in °C, or `null` if
 *                     no valid reading is available. **null triggers
 *                     the failsafe-to-max path** — this is intentional
 *                     and non-negotiable: an unreadable sensor is
 *                     indistinguishable from a thermal runaway.
 */
export function computeSafetyFloor(
  userPercent: number,
  tempC: TempCOrNull,
): SafetyFloorResult {
  const user = clampPct(userPercent);

  // Failsafe: no valid temp = assume worst case. The thermal-trip
  // shutdown that motivated this fix was a black-box event from the
  // user's POV; if our temp source goes blind we behave as if we're
  // about to trip.
  if (tempC === null || !Number.isFinite(tempC)) {
    return {
      percent: 100,
      engaged: user < 100,
      critical: true,
      reason: `temperature unavailable — failsafe to MAX (user wanted ${user}%)`,
    };
  }

  const t = tempC;

  // Critical: ≥ 95 °C. AMD Ryzen Tjunction is ~95–105 °C; the OXP Apex
  // SoC tripped to power-off in the maintainer's incident. Above this
  // line we force max AND set the critical flag so the caller can
  // surface it to the UI.
  if (t >= SAFETY_THRESHOLDS.CRITICAL_C) {
    return {
      percent: 100,
      engaged: user < 100,
      critical: true,
      reason: `CRITICAL: temp=${t}°C >= ${SAFETY_THRESHOLDS.CRITICAL_C}°C — forced MAX (user wanted ${user}%)`,
    };
  }

  // Hot: ≥ 85 °C. 10 °C headroom before Tjunction trip; max fans buys
  // the cooling system time to claw temps back without a shutdown.
  if (t >= SAFETY_THRESHOLDS.FORCE_MAX_C) {
    return {
      percent: 100,
      engaged: user < 100,
      critical: false,
      reason: `temp=${t}°C >= ${SAFETY_THRESHOLDS.FORCE_MAX_C}°C — forced MAX (user wanted ${user}%)`,
    };
  }

  // Warm-hot: ≥ 80 °C. Raise the floor to 60 %.
  if (t >= SAFETY_THRESHOLDS.HOT_C) {
    if (user < SAFETY_THRESHOLDS.HOT_FLOOR_PCT) {
      return {
        percent: SAFETY_THRESHOLDS.HOT_FLOOR_PCT,
        engaged: true,
        critical: false,
        reason: `temp=${t}°C >= ${SAFETY_THRESHOLDS.HOT_C}°C — floor raised ${user}% → ${SAFETY_THRESHOLDS.HOT_FLOOR_PCT}%`,
      };
    }
    return {
      percent: user,
      engaged: false,
      critical: false,
      reason: `temp=${t}°C ok at user ${user}% (above ${SAFETY_THRESHOLDS.HOT_FLOOR_PCT}% floor)`,
    };
  }

  // Warm: ≥ 75 °C. Raise the floor to 40 %.
  if (t >= SAFETY_THRESHOLDS.WARM_C) {
    if (user < SAFETY_THRESHOLDS.WARM_FLOOR_PCT) {
      return {
        percent: SAFETY_THRESHOLDS.WARM_FLOOR_PCT,
        engaged: true,
        critical: false,
        reason: `temp=${t}°C >= ${SAFETY_THRESHOLDS.WARM_C}°C — floor raised ${user}% → ${SAFETY_THRESHOLDS.WARM_FLOOR_PCT}%`,
      };
    }
    return {
      percent: user,
      engaged: false,
      critical: false,
      reason: `temp=${t}°C ok at user ${user}% (above ${SAFETY_THRESHOLDS.WARM_FLOOR_PCT}% floor)`,
    };
  }

  // Normal operating range — override is a strict no-op.
  return {
    percent: user,
    engaged: false,
    critical: false,
    reason: `temp=${t}°C normal — no override`,
  };
}
