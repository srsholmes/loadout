import { describe, it, expect } from "bun:test";
import { computeSafetyFloor, SAFETY_THRESHOLDS } from "./safety-floor";

// ---------------------------------------------------------------------------
// Pure-function unit tests for the hardware-safety override (issue #97).
//
// Cardinal rules — each is verified at least once below:
//   1. Below WARM_C the override is a strict no-op.
//   2. The override only RAISES; it never lowers a user request.
//   3. null temp → 100 % (failsafe).
//   4. NaN / Infinity inputs → 100 % (failsafe).
//   5. critical=true at CRITICAL_C and on the failsafe path.
//   6. Output percent is always in [0, 100].
// ---------------------------------------------------------------------------

describe("computeSafetyFloor — normal operating range", () => {
  it("is a no-op at 25 C (low load)", () => {
    const r = computeSafetyFloor(15, 25);
    expect(r.percent).toBe(15);
    expect(r.engaged).toBe(false);
    expect(r.critical).toBe(false);
  });

  it("is a no-op at 50 C (typical idle)", () => {
    const r = computeSafetyFloor(20, 50);
    expect(r.percent).toBe(20);
    expect(r.engaged).toBe(false);
    expect(r.critical).toBe(false);
  });

  it("is a no-op at 74 C (just below the warm floor)", () => {
    const r = computeSafetyFloor(25, 74);
    expect(r.percent).toBe(25);
    expect(r.engaged).toBe(false);
  });

  it("is a no-op when user already asked for 100 %", () => {
    const r = computeSafetyFloor(100, 50);
    expect(r.percent).toBe(100);
    expect(r.engaged).toBe(false);
  });
});

// WARM_C was bumped from 75 → 80 after hardware testing. Engagement
// now begins at HOT_C (80) — the WARM tier is degenerate (WARM_C ===
// HOT_C, so the HOT branch always wins). The pre-engagement band that
// used to engage at 75-79 C is now a strict no-op.
describe("computeSafetyFloor — pre-engagement band (75-79 C)", () => {
  it("does NOT engage at 75 C (below new threshold)", () => {
    const r = computeSafetyFloor(10, 75);
    expect(r.engaged).toBe(false);
    expect(r.percent).toBe(10);
  });

  it("does NOT engage at 78 C (below new threshold)", () => {
    const r = computeSafetyFloor(10, 78);
    expect(r.engaged).toBe(false);
    expect(r.percent).toBe(10);
  });

  it("does NOT engage at 79.999 C (just below threshold)", () => {
    const r = computeSafetyFloor(10, 79.999);
    expect(r.engaged).toBe(false);
  });
});

describe("computeSafetyFloor — hot range (>= 80 C)", () => {
  it("raises 10 % to 60 % floor at 80 C", () => {
    const r = computeSafetyFloor(10, 80);
    expect(r.percent).toBe(SAFETY_THRESHOLDS.HOT_FLOOR_PCT);
    expect(r.engaged).toBe(true);
    expect(r.critical).toBe(false);
  });

  it("raises 50 % to 60 % floor at 83 C", () => {
    const r = computeSafetyFloor(50, 83);
    expect(r.percent).toBe(60);
    expect(r.engaged).toBe(true);
  });

  it("leaves user at 75 % when already above the hot floor", () => {
    const r = computeSafetyFloor(75, 83);
    expect(r.percent).toBe(75);
    expect(r.engaged).toBe(false);
  });
});

describe("computeSafetyFloor — force-max range (>= 85 C)", () => {
  it("forces 100 % at 85 C even if user wanted 50 %", () => {
    const r = computeSafetyFloor(50, 85);
    expect(r.percent).toBe(100);
    expect(r.engaged).toBe(true);
    expect(r.critical).toBe(false); // 85 ≤ t < 95 is hot but not critical
  });

  it("forces 100 % at 90 C even if user wanted 80 %", () => {
    const r = computeSafetyFloor(80, 90);
    expect(r.percent).toBe(100);
    expect(r.engaged).toBe(true);
  });

  it("is a no-op (no engaged flag) when user already asked for 100 % at 90 C", () => {
    const r = computeSafetyFloor(100, 90);
    expect(r.percent).toBe(100);
    expect(r.engaged).toBe(false);
  });
});

describe("computeSafetyFloor — critical range (>= 95 C)", () => {
  it("forces 100 % AND flags critical at 95 C", () => {
    const r = computeSafetyFloor(60, 95);
    expect(r.percent).toBe(100);
    expect(r.engaged).toBe(true);
    expect(r.critical).toBe(true);
  });

  it("forces 100 % AND flags critical at 100 C", () => {
    const r = computeSafetyFloor(80, 100);
    expect(r.percent).toBe(100);
    expect(r.critical).toBe(true);
  });

  it("still flags critical when user already asked for 100 %", () => {
    // engaged is false (no upward clamp happened) but critical stays true
    // so callers can still surface the warning to the UI.
    const r = computeSafetyFloor(100, 99);
    expect(r.percent).toBe(100);
    expect(r.critical).toBe(true);
  });
});

describe("computeSafetyFloor — failsafe paths", () => {
  it("forces 100 % when temp is null (sensor unavailable)", () => {
    const r = computeSafetyFloor(20, null);
    expect(r.percent).toBe(100);
    expect(r.engaged).toBe(true);
    expect(r.critical).toBe(true);
    expect(r.reason).toContain("unavailable");
  });

  it("forces 100 % when temp is NaN", () => {
    const r = computeSafetyFloor(20, Number.NaN);
    expect(r.percent).toBe(100);
    expect(r.critical).toBe(true);
  });

  it("forces 100 % when temp is Infinity", () => {
    const r = computeSafetyFloor(20, Number.POSITIVE_INFINITY);
    expect(r.percent).toBe(100);
    expect(r.critical).toBe(true);
  });

  it("forces 100 % when temp is -Infinity (malformed reading)", () => {
    const r = computeSafetyFloor(20, Number.NEGATIVE_INFINITY);
    expect(r.percent).toBe(100);
    expect(r.critical).toBe(true);
  });
});

describe("computeSafetyFloor — input clamping", () => {
  it("clamps negative user percent to 0 (then floor applies)", () => {
    const r = computeSafetyFloor(-50, 30);
    expect(r.percent).toBe(0); // normal range, clamped
  });

  it("clamps over-100 user percent down to 100", () => {
    const r = computeSafetyFloor(250, 30);
    expect(r.percent).toBe(100);
  });

  it("treats NaN user percent as failsafe (100 via clampPct)", () => {
    // NaN in userPercent isn't directly user-reachable, but if it ever
    // got in we want it pinned to 100 (loud) not 0 (silent).
    const r = computeSafetyFloor(Number.NaN, 30);
    expect(r.percent).toBe(100);
  });

  it("rounds fractional user percent", () => {
    const r = computeSafetyFloor(35.7, 30);
    expect(r.percent).toBe(36);
  });
});

describe("computeSafetyFloor — boundary precision", () => {
  it("treats 74.999 as below the warm floor (no override)", () => {
    const r = computeSafetyFloor(10, 74.999);
    expect(r.percent).toBe(10);
    expect(r.engaged).toBe(false);
  });

  it("treats 80.0 as exactly at the engagement threshold (engaged)", () => {
    const r = computeSafetyFloor(10, 80);
    expect(r.engaged).toBe(true);
  });

  it("treats 84.999 as in the hot range (60 % floor, not max)", () => {
    const r = computeSafetyFloor(10, 84.999);
    expect(r.percent).toBe(60);
  });

  it("treats 85.0 as in the force-max range", () => {
    const r = computeSafetyFloor(10, 85);
    expect(r.percent).toBe(100);
  });

  it("treats 94.999 as force-max but not critical", () => {
    const r = computeSafetyFloor(10, 94.999);
    expect(r.percent).toBe(100);
    expect(r.critical).toBe(false);
  });

  it("treats 95.0 as critical", () => {
    const r = computeSafetyFloor(10, 95);
    expect(r.percent).toBe(100);
    expect(r.critical).toBe(true);
  });
});

describe("computeSafetyFloor — invariants", () => {
  it("output percent is always in [0, 100]", () => {
    const samples: Array<[number, number | null]> = [
      [-5, 30],
      [0, 30],
      [50, 30],
      [100, 30],
      [200, 30],
      [50, null],
      [50, 60],
      [50, 75],
      [50, 85],
      [50, 95],
      [50, 120],
    ];
    for (const [u, t] of samples) {
      const r = computeSafetyFloor(u, t);
      expect(r.percent).toBeGreaterThanOrEqual(0);
      expect(r.percent).toBeLessThanOrEqual(100);
    }
  });

  it("override never lowers the user request (only raises)", () => {
    const temps = [25, 50, 70, 75, 80, 85, 95, 100];
    const userPcts = [0, 25, 50, 75, 100];
    for (const t of temps) {
      for (const u of userPcts) {
        const r = computeSafetyFloor(u, t);
        // Result must be >= the clamped user value (since u in [0,100],
        // clamped = u). The pure function may round, so compare against
        // the rounded clamped user value.
        const clampedUser = Math.max(0, Math.min(100, Math.round(u)));
        expect(r.percent).toBeGreaterThanOrEqual(clampedUser);
      }
    }
  });

  it("engaged === true implies result.percent > clampedUser, or critical (null path)", () => {
    // Engagement means we actively did something. For temp-based engages
    // the percent went up. For the failsafe (null) path, engaged is true
    // even when user was 100 % because we *would* have forced max — and
    // critical is also true on that path.
    const r1 = computeSafetyFloor(20, 90);
    expect(r1.engaged).toBe(true);
    expect(r1.percent).toBeGreaterThan(20);

    const r2 = computeSafetyFloor(20, null);
    expect(r2.engaged).toBe(true);
    expect(r2.critical).toBe(true);
  });
});
