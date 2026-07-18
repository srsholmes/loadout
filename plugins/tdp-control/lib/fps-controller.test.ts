import { describe, test, expect } from "bun:test";
import { createFpsController } from "./fps-controller";

function make(targetFps = 60, minWatts = 5, maxWatts = 30) {
  const c = createFpsController();
  c.configure({ targetFps, minWatts, maxWatts });
  return c;
}

describe("FPS controller", () => {
  test("returns warming-up and no change while FPS is null", () => {
    const c = make();
    const d = c.update(null, 15);
    expect(d.reason).toBe("warming-up");
    expect(d.changed).toBe(false);
    expect(d.targetWatts).toBe(15);
  });

  test("below target adds a bounded amount of power", () => {
    const c = make(60, 5, 30);
    const d = c.update(45, 15); // 15 fps short
    expect(d.reason).toBe("climbing");
    expect(d.changed).toBe(true);
    // ceil(15 * 0.2) = 3, capped at upStepMax 3
    expect(d.targetWatts).toBe(18);
  });

  test("up-step is clamped to the max step size", () => {
    const c = make(120, 5, 30);
    const d = c.update(30, 15); // 90 fps short -> huge error
    expect(d.targetWatts).toBe(18); // still only +3
  });

  test("within the deadband it settles and holds", () => {
    const c = make(60, 5, 30);
    const d = c.update(61, 20); // 1 over, inside deadbandAbove
    expect(d.reason).toBe("holding");
    expect(d.settled).toBe(true);
    expect(d.changed).toBe(false);
    expect(d.targetWatts).toBe(20);
  });

  test("a change is followed by a one-tick settle skip", () => {
    const c = make(60, 5, 30);
    const first = c.update(45, 15);
    expect(first.changed).toBe(true);
    const skipped = c.update(80, first.targetWatts); // would normally reduce
    expect(skipped.reason).toBe("settling");
    expect(skipped.changed).toBe(false);
    expect(skipped.targetWatts).toBe(first.targetWatts);
  });

  test("reduces only after sustained over-target ticks (hysteresis)", () => {
    const c = make(60, 5, 30);
    // First over-target tick: hold, don't reduce yet.
    const t1 = c.update(80, 20);
    expect(t1.reason).toBe("holding");
    expect(t1.changed).toBe(false);
    // Second consecutive over-target tick: now reduce.
    const t2 = c.update(80, 20);
    expect(t2.reason).toBe("reducing");
    expect(t2.changed).toBe(true);
    expect(t2.targetWatts).toBeLessThan(20);
  });

  test("clamps at the max watt bound and reports unreachable when stuck", () => {
    const c = make(60, 5, 20);
    let watts = 20; // already at ceiling
    let sawUnreachable = false;
    for (let i = 0; i < 8; i++) {
      const d = c.update(45, watts); // always short
      watts = d.targetWatts;
      expect(watts).toBeLessThanOrEqual(20);
      if (d.reason === "unreachable") sawUnreachable = true;
    }
    expect(watts).toBe(20);
    expect(sawUnreachable).toBe(true);
  });

  test("clamps at the min watt bound and reports floor", () => {
    const c = make(60, 5, 30);
    // Drive it well over target repeatedly; it should walk down to the floor.
    let watts = 8;
    let sawFloor = false;
    for (let i = 0; i < 20; i++) {
      const d = c.update(140, watts);
      watts = d.targetWatts;
      expect(watts).toBeGreaterThanOrEqual(5);
      if (d.reason === "floor") sawFloor = true;
    }
    expect(watts).toBe(5);
    expect(sawFloor).toBe(true);
  });

  test("alternating high/low readings do not oscillate the watts", () => {
    const c = make(60, 5, 30);
    let watts = 15;
    const history: number[] = [watts];
    const samples = [45, 80, 45, 80, 45, 80, 45, 80];
    for (const fps of samples) {
      const d = c.update(fps, watts);
      watts = d.targetWatts;
      history.push(watts);
    }
    // Because every change is followed by a settle-skip, the tick that sees a
    // high reading right after an up-step is ignored — so watts never steps
    // down in response to the alternation. The series is monotonic non-decreasing.
    for (let i = 1; i < history.length; i++) {
      expect(history[i]).toBeGreaterThanOrEqual(history[i - 1]);
    }
  });

  test("converges on a synthetic monotone watts→fps curve", () => {
    const c = make(60, 5, 40);
    // Simple linear model: fps = watts * 3 (so 20W ⇒ 60fps is the solution).
    let watts = 8;
    let settledWatts = -1;
    for (let i = 0; i < 60; i++) {
      const fps = watts * 3;
      const d = c.update(fps, watts);
      watts = d.targetWatts;
      if (d.settled && d.reason === "holding") {
        settledWatts = watts;
        break;
      }
    }
    expect(settledWatts).toBeGreaterThan(0);
    // Solution is 20W; allow a small band for the deadband/step granularity.
    expect(settledWatts).toBeGreaterThanOrEqual(18);
    expect(settledWatts).toBeLessThanOrEqual(23);
  });

  test("reset clears streak state", () => {
    const c = make(60, 5, 30);
    c.update(80, 20); // aboveStreak = 1
    c.reset();
    // After reset the first over-target tick should hold again, not reduce.
    const d = c.update(80, 20);
    expect(d.reason).toBe("holding");
    expect(d.changed).toBe(false);
  });
});
