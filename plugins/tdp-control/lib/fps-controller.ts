/**
 * Pure closed-loop controller that nudges TDP (watts) to hold a target FPS.
 *
 * No I/O, no timers, no clock — every input arrives via `configure()` /
 * `update()` and every decision is returned. This keeps the control math
 * fully deterministic and unit-testable; the backend owns the interval, the
 * FPS reader, and the (serialized) hardware write.
 *
 * Design notes
 * ------------
 * The watts→fps transfer function is unknown, nonlinear, and game-specific,
 * so we deliberately avoid a tuned PID. Instead: a bounded proportional step
 * with an **asymmetric deadband** (wider on the reduce side, so we bias toward
 * holding frames and only give power back when there's clear, sustained
 * headroom), plus a one-tick **settle skip** after every change (so we never
 * react to an FPS sample measured *before* the last watt change took effect),
 * plus **direction hysteresis** on the reduce side (requires the over-target
 * condition to persist before stepping down). Together these stop the loop
 * from oscillating on noisy frame rates.
 */

export type ControllerReason =
  | "warming-up" // no FPS sample yet
  | "settling" // just changed watts, skipping a tick to let it take effect
  | "holding" // within the deadband — target met
  | "climbing" // below target, adding power
  | "reducing" // above target with headroom, giving power back
  | "floor" // above target but already at the minimum watt bound
  | "unreachable"; // below target but pinned at the maximum watt bound

export interface ControllerConfig {
  targetFps: number;
  /** Lower watt bound the loop may not go below. */
  minWatts: number;
  /** Upper watt bound the loop may not exceed (already power-state clamped). */
  maxWatts: number;
}

export interface ControllerTuning {
  /** Below-target FPS slack (fps) before we add power. */
  deadbandBelowFps: number;
  /** Above-target FPS slack (fps) before we consider reducing power. */
  deadbandAboveFps: number;
  /** Proportional gain on the up (add power) side. */
  upGain: number;
  /** Proportional gain on the down (reduce power) side. */
  downGain: number;
  /** Bounds on a single up-step, in watts. */
  upStepMin: number;
  upStepMax: number;
  /** Bounds on a single down-step, in watts. */
  downStepMin: number;
  downStepMax: number;
  /** Consecutive over-target ticks required before stepping down. */
  aboveStreakNeeded: number;
  /** Consecutive at-ceiling-but-below-target ticks before reporting unreachable. */
  saturationTicks: number;
}

export interface ControllerDecision {
  /** The watts the backend should apply this tick. */
  targetWatts: number;
  /** True when targetWatts differs from the currentWatts we were given. */
  changed: boolean;
  /** True when the loop believes it has reached a stable resting point. */
  settled: boolean;
  reason: ControllerReason;
}

/**
 * Default tuning. Deadbands are also scaled by the target at configure()
 * time (a 3%/7% band), whichever is larger — so 30fps and 120fps targets
 * both get a sensible slack.
 */
export const DEFAULT_TUNING: ControllerTuning = {
  deadbandBelowFps: 2,
  deadbandAboveFps: 4,
  upGain: 0.2,
  downGain: 0.1,
  upStepMin: 1,
  upStepMax: 3,
  downStepMin: 1,
  downStepMax: 2,
  aboveStreakNeeded: 2,
  saturationTicks: 3,
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function createFpsController(tuning: Partial<ControllerTuning> = {}) {
  const cfg: ControllerTuning = { ...DEFAULT_TUNING, ...tuning };

  let targetFps = 60;
  let minWatts = 5;
  let maxWatts = 35;
  let deadbandBelow = cfg.deadbandBelowFps;
  let deadbandAbove = cfg.deadbandAboveFps;

  // Mutable per-run state.
  let aboveStreak = 0;
  let settleSkip = 0;
  let saturationStreak = 0;

  function reset(): void {
    aboveStreak = 0;
    settleSkip = 0;
    saturationStreak = 0;
  }

  function configure(config: ControllerConfig): void {
    targetFps = config.targetFps;
    // Keep min <= max even if callers pass a collapsed/inverted band.
    minWatts = Math.min(config.minWatts, config.maxWatts);
    maxWatts = Math.max(config.minWatts, config.maxWatts);
    // Scale the deadband with the target, but never below the floor slack.
    deadbandBelow = Math.max(cfg.deadbandBelowFps, Math.round(targetFps * 0.03));
    deadbandAbove = Math.max(cfg.deadbandAboveFps, Math.round(targetFps * 0.07));
  }

  /**
   * Advance the loop one tick.
   *
   * @param currentFps  Smoothed FPS, or null when no sample is available yet.
   * @param currentWatts  The watts currently applied (post-clamp).
   */
  function update(
    currentFps: number | null,
    currentWatts: number,
  ): ControllerDecision {
    const hold = (
      reason: ControllerReason,
      settled: boolean,
    ): ControllerDecision => ({
      targetWatts: currentWatts,
      changed: false,
      settled,
      reason,
    });

    // No data yet — do nothing, don't advance streaks.
    if (currentFps === null || !Number.isFinite(currentFps)) {
      return hold("warming-up", false);
    }

    // One-tick cooldown after any change so we measure the *new* watts, not
    // the frame rate produced by the previous setting.
    if (settleSkip > 0) {
      settleSkip -= 1;
      return hold("settling", false);
    }

    const err = targetFps - currentFps; // >0 ⇒ below target ⇒ want more power

    // --- Below target: add power (respond promptly, no streak gate) ---------
    if (err > deadbandBelow) {
      aboveStreak = 0;
      if (currentWatts >= maxWatts) {
        // Pinned at the ceiling and still short — GPU/thermal bound.
        saturationStreak += 1;
        return hold(
          saturationStreak >= cfg.saturationTicks ? "unreachable" : "climbing",
          saturationStreak >= cfg.saturationTicks,
        );
      }
      saturationStreak = 0;
      const step = clamp(
        Math.ceil(err * cfg.upGain),
        cfg.upStepMin,
        cfg.upStepMax,
      );
      const next = Math.min(maxWatts, currentWatts + step);
      const changed = next !== currentWatts;
      if (changed) settleSkip = 1;
      return {
        targetWatts: next,
        changed,
        settled: false,
        reason: "climbing",
      };
    }

    // --- Above target: reduce power, but only after sustained headroom ------
    if (err < -deadbandAbove) {
      saturationStreak = 0;
      aboveStreak += 1;
      if (aboveStreak < cfg.aboveStreakNeeded) {
        // Not yet convinced the headroom is real — hold and watch.
        return hold("holding", false);
      }
      if (currentWatts <= minWatts) {
        return hold("floor", true);
      }
      const overBy = -err;
      const step = clamp(
        Math.ceil(overBy * cfg.downGain),
        cfg.downStepMin,
        cfg.downStepMax,
      );
      const next = Math.max(minWatts, currentWatts - step);
      const changed = next !== currentWatts;
      if (changed) settleSkip = 1;
      return {
        targetWatts: next,
        changed,
        settled: false,
        reason: "reducing",
      };
    }

    // --- Within the deadband: target met, rest here -------------------------
    aboveStreak = 0;
    saturationStreak = 0;
    return hold("holding", true);
  }

  return { configure, update, reset };
}

export type FpsController = ReturnType<typeof createFpsController>;
