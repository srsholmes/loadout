import { describe, expect, it, beforeEach } from "bun:test";
import {
  NavController,
  REPEAT_DELAY_MS,
  REPEAT_RATE_MS,
  AXIS_DEADZONE,
  type AnalogAxis,
  type NavAction,
  type InputEvent,
} from "./nav-controller";

/** Fake clock — every test controls time explicitly. */
function makeClock(start = 0): {
  now: () => number;
  set: (t: number) => void;
  advance: (dt: number) => void;
} {
  let t = start;
  return {
    now: () => t,
    set: (x) => {
      t = x;
    },
    advance: (dt) => {
      t += dt;
    },
  };
}

function fxController() {
  const clock = makeClock();
  const emitted: NavAction[] = [];
  const emittedAxis: Array<[AnalogAxis, number]> = [];
  const nav = new NavController({
    emit: (a) => emitted.push(a),
    emitAxis: (axis, value) => emittedAxis.push([axis, value]),
    now: clock.now,
  });
  return { clock, emitted, emittedAxis, nav };
}

describe("NavController — button dispatch", () => {
  let f: ReturnType<typeof fxController>;
  beforeEach(() => {
    f = fxController();
  });

  it("A emits on press, not release", () => {
    f.nav.processEvents("ctrl1", [
      { kind: "button", button: "A", pressed: true },
    ]);
    expect(f.emitted).toEqual(["a"]);
    f.nav.processEvents("ctrl1", [
      { kind: "button", button: "A", pressed: false },
    ]);
    expect(f.emitted).toEqual(["a"]); // no extra emit on release
  });

  it("B emits on release, NOT on press (nav_controller.rs rule)", () => {
    f.nav.processEvents("ctrl1", [
      { kind: "button", button: "B", pressed: true },
    ]);
    expect(f.emitted).toEqual([]);
    f.nav.processEvents("ctrl1", [
      { kind: "button", button: "B", pressed: false },
    ]);
    expect(f.emitted).toEqual(["b"]);
  });

  it("X emits 'x' on press and 'x_up' on release (both edges)", () => {
    f.nav.processEvents("ctrl1", [
      { kind: "button", button: "X", pressed: true },
    ]);
    expect(f.emitted).toEqual(["x"]);
    f.nav.processEvents("ctrl1", [
      { kind: "button", button: "X", pressed: false },
    ]);
    expect(f.emitted).toEqual(["x", "x_up"]);
  });

  it("Y/LB/RB emit press-only like A", () => {
    f.nav.processEvents("ctrl1", [
      { kind: "button", button: "Y", pressed: true },
      { kind: "button", button: "LB", pressed: true },
      { kind: "button", button: "RB", pressed: true },
    ]);
    expect(f.emitted).toEqual(["y", "lb", "rb"]);
    f.nav.processEvents("ctrl1", [
      { kind: "button", button: "Y", pressed: false },
      { kind: "button", button: "LB", pressed: false },
      { kind: "button", button: "RB", pressed: false },
    ]);
    // No extra emits on release.
    expect(f.emitted).toEqual(["y", "lb", "rb"]);
  });

  it("Mode button alone emits nothing (it's a modifier)", () => {
    f.nav.processEvents("ctrl1", [
      { kind: "button", button: "Mode", pressed: true },
      { kind: "button", button: "Mode", pressed: false },
    ]);
    expect(f.emitted).toEqual([]);
  });

  it("Select button alone emits nothing", () => {
    f.nav.processEvents("ctrl1", [
      { kind: "button", button: "Select", pressed: true },
      { kind: "button", button: "Select", pressed: false },
    ]);
    expect(f.emitted).toEqual([]);
  });
});

describe("NavController — modifier suppression", () => {
  it("A while Mode is held does not emit (combo detector owns it)", () => {
    const f = fxController();
    f.nav.processEvents("ctrl1", [
      { kind: "button", button: "Mode", pressed: true },
      { kind: "button", button: "A", pressed: true },
    ]);
    expect(f.emitted).toEqual([]);
  });

  it("Releasing Mode in a later batch restores normal dispatch", () => {
    const f = fxController();
    // Batch 1 — A is suppressed because Mode is still held at the end
    // of processing.
    f.nav.processEvents("ctrl1", [
      { kind: "button", button: "Mode", pressed: true },
      { kind: "button", button: "A", pressed: true },
      { kind: "button", button: "A", pressed: false },
    ]);
    expect(f.emitted).toEqual([]);

    // Batch 2 — Mode released, still nothing to emit.
    f.nav.processEvents("ctrl1", [
      { kind: "button", button: "Mode", pressed: false },
    ]);
    expect(f.emitted).toEqual([]);

    // Batch 3 — A now fires normally.
    f.nav.processEvents("ctrl1", [
      { kind: "button", button: "A", pressed: true },
    ]);
    expect(f.emitted).toEqual(["a"]);
  });

  it("Select suppresses emission the same way Mode does", () => {
    const f = fxController();
    f.nav.processEvents("ctrl1", [
      { kind: "button", button: "Select", pressed: true },
      { kind: "button", button: "Y", pressed: true },
    ]);
    expect(f.emitted).toEqual([]);
  });
});

describe("NavController — axis → dpad", () => {
  it("values past +AXIS_DEADZONE fire the positive direction on X axis (right)", () => {
    const f = fxController();
    f.nav.processEvents("ctrl1", [
      { kind: "axis", axis: "LeftStickX", value: AXIS_DEADZONE + 0.01 },
    ]);
    expect(f.emitted).toEqual(["right"]);
  });

  it("values past -AXIS_DEADZONE fire the negative direction on Y axis (up)", () => {
    const f = fxController();
    f.nav.processEvents("ctrl1", [
      { kind: "axis", axis: "LeftStickY", value: -(AXIS_DEADZONE + 0.01) },
    ]);
    expect(f.emitted).toEqual(["up"]);
  });

  it("values inside the deadzone don't emit", () => {
    const f = fxController();
    f.nav.processEvents("ctrl1", [
      { kind: "axis", axis: "HatX", value: 0.3 },
    ]);
    expect(f.emitted).toEqual([]);
  });

  it("HatX and LeftStickX share the right/left action slots", () => {
    // A held direction from the HAT should not re-fire when the stick
    // ALSO tilts in the same direction — same action key in held map.
    const f = fxController();
    f.nav.processEvents("ctrl1", [
      { kind: "axis", axis: "HatX", value: 1.0 },
    ]);
    expect(f.emitted).toEqual(["right"]);
    f.nav.processEvents("ctrl1", [
      { kind: "axis", axis: "LeftStickX", value: 1.0 },
    ]);
    // No second "right" emission because the held state is already set.
    expect(f.emitted).toEqual(["right"]);
  });

  it("crossing through zero releases the held direction", () => {
    const f = fxController();
    f.nav.processEvents("ctrl1", [
      { kind: "axis", axis: "LeftStickX", value: 1.0 },
    ]);
    f.nav.processEvents("ctrl1", [
      { kind: "axis", axis: "LeftStickX", value: 0 },
    ]);
    // Only one "right" emit (press edge); no emit on release for right.
    expect(f.emitted).toEqual(["right"]);

    // A subsequent press should fire again.
    f.nav.processEvents("ctrl1", [
      { kind: "axis", axis: "LeftStickX", value: 1.0 },
    ]);
    expect(f.emitted).toEqual(["right", "right"]);
  });
});

describe("NavController — key repeat", () => {
  it("first repeat fires exactly REPEAT_DELAY_MS after press, subsequent at REPEAT_RATE_MS", () => {
    const f = fxController();
    f.nav.processEvents("ctrl1", [
      { kind: "button", button: "A", pressed: true },
    ]);
    expect(f.emitted).toEqual(["a"]);

    // Just before the first repeat — no extra.
    f.clock.advance(REPEAT_DELAY_MS - 1);
    f.nav.processEvents("ctrl1", []);
    expect(f.emitted).toEqual(["a"]);

    // Cross the threshold.
    f.clock.advance(1);
    f.nav.processEvents("ctrl1", []);
    expect(f.emitted).toEqual(["a", "a"]);

    // Steady-state rate.
    f.clock.advance(REPEAT_RATE_MS);
    f.nav.processEvents("ctrl1", []);
    expect(f.emitted).toEqual(["a", "a", "a"]);
  });

  it("releasing the button stops repeats", () => {
    const f = fxController();
    f.nav.processEvents("ctrl1", [
      { kind: "button", button: "A", pressed: true },
    ]);
    f.nav.processEvents("ctrl1", [
      { kind: "button", button: "A", pressed: false },
    ]);
    f.clock.advance(5 * REPEAT_RATE_MS);
    f.nav.processEvents("ctrl1", []);
    expect(f.emitted).toEqual(["a"]);
  });

  it("key repeat fires for held directions (axis-driven)", () => {
    const f = fxController();
    f.nav.processEvents("ctrl1", [
      { kind: "axis", axis: "HatY", value: 1.0 },
    ]);
    expect(f.emitted).toEqual(["down"]);
    f.clock.advance(REPEAT_DELAY_MS);
    f.nav.processEvents("ctrl1", []);
    expect(f.emitted).toEqual(["down", "down"]);
  });

  it("B's held repeat is suppressed (B is release-only)", () => {
    const f = fxController();
    f.nav.processEvents("ctrl1", [
      { kind: "button", button: "B", pressed: true },
    ]);
    f.clock.advance(REPEAT_DELAY_MS + 5 * REPEAT_RATE_MS);
    f.nav.processEvents("ctrl1", []);
    expect(f.emitted).toEqual([]); // no rapid-fire Escape while B is held
  });
});

describe("NavController — reset + multi-controller", () => {
  it("reset() clears all held state + per-controller entries", () => {
    const f = fxController();
    f.nav.processEvents("ctrl1", [
      { kind: "button", button: "A", pressed: true },
    ]);
    f.nav.reset();
    // A repeat tick after reset: nothing, because the held map was wiped.
    f.clock.advance(REPEAT_DELAY_MS + REPEAT_RATE_MS);
    f.nav.processEvents("ctrl1", []);
    expect(f.emitted).toEqual(["a"]);
  });

  it("reset() emits x_up for a still-held X so long-press isn't stranded", () => {
    const f = fxController();
    f.nav.processEvents("ctrl1", [
      { kind: "button", button: "X", pressed: true },
    ]);
    expect(f.emitted).toEqual(["x"]); // press seen, release pending
    // Overlay tears down mid-hold (open/close → reset). The release half
    // must still fire or a frontend long-press handler hangs forever.
    f.nav.reset();
    expect(f.emitted).toEqual(["x", "x_up"]);
  });

  it("reset() does NOT emit a phantom 'b' for a still-held B", () => {
    const f = fxController();
    f.nav.processEvents("ctrl1", [
      { kind: "button", button: "B", pressed: true },
    ]);
    f.nav.reset();
    // Emitting "b" here would inject a spurious Escape into the webview.
    expect(f.emitted).toEqual([]);
  });

  it("separate controllerIds maintain independent held state", () => {
    const f = fxController();
    // Ctrl1 holds A, ctrl2 is in modifier suppression.
    f.nav.processEvents("ctrl1", [
      { kind: "button", button: "A", pressed: true },
    ]);
    f.nav.processEvents("ctrl2", [
      { kind: "button", button: "Mode", pressed: true },
      { kind: "button", button: "A", pressed: true },
    ]);
    expect(f.emitted).toEqual(["a"]); // ctrl2's A is suppressed
  });
});

describe("NavController — right-stick analog axes", () => {
  it("RightStickY forwards to emitAxis verbatim, never as a NavAction", () => {
    const f = fxController();
    f.nav.processEvents("ctrl1", [
      { kind: "axis", axis: "RightStickY", value: 0.8 },
    ]);
    expect(f.emitted).toEqual([]); // no up/down emitted
    expect(f.emittedAxis).toEqual([["RightStickY", 0.8]]);
  });

  it("RightStickX forwards to emitAxis without firing left/right", () => {
    const f = fxController();
    f.nav.processEvents("ctrl1", [
      { kind: "axis", axis: "RightStickX", value: -0.6 },
    ]);
    expect(f.emitted).toEqual([]);
    expect(f.emittedAxis).toEqual([["RightStickX", -0.6]]);
  });

  it("does not put right-stick into the held map (no key repeat)", () => {
    const f = fxController();
    f.nav.processEvents("ctrl1", [
      { kind: "axis", axis: "RightStickY", value: 1.0 },
    ]);
    f.clock.advance(REPEAT_DELAY_MS + 5 * REPEAT_RATE_MS);
    f.nav.processEvents("ctrl1", []);
    expect(f.emitted).toEqual([]);
    // Only the initial emit — no repeats.
    expect(f.emittedAxis).toEqual([["RightStickY", 1.0]]);
  });

  it("dedupes consecutive identical values", () => {
    const f = fxController();
    f.nav.processEvents("ctrl1", [
      { kind: "axis", axis: "RightStickY", value: 0.5 },
      { kind: "axis", axis: "RightStickY", value: 0.5 },
    ]);
    f.nav.processEvents("ctrl1", [
      { kind: "axis", axis: "RightStickY", value: 0.5 },
    ]);
    expect(f.emittedAxis).toEqual([["RightStickY", 0.5]]);
  });

  it("emits again when the value changes (including to zero)", () => {
    const f = fxController();
    f.nav.processEvents("ctrl1", [
      { kind: "axis", axis: "RightStickY", value: 0.5 },
    ]);
    f.nav.processEvents("ctrl1", [
      { kind: "axis", axis: "RightStickY", value: 0 },
    ]);
    expect(f.emittedAxis).toEqual([
      ["RightStickY", 0.5],
      ["RightStickY", 0],
    ]);
  });

  it("reset() drops the last-analog dedupe — same value re-emits after reset", () => {
    // Scenario: stick is held during overlay close (which fires
    // nav.reset()); on reopen, the kernel will rebroadcast the still-held
    // value. The dedupe map must NOT swallow it — otherwise the webview
    // would never learn the stick is deflected until the user re-centers
    // and pushes again.
    const f = fxController();
    f.nav.processEvents("ctrl1", [
      { kind: "axis", axis: "RightStickY", value: 0.7 },
    ]);
    expect(f.emittedAxis).toEqual([["RightStickY", 0.7]]);

    f.nav.reset();

    f.nav.processEvents("ctrl1", [
      { kind: "axis", axis: "RightStickY", value: 0.7 },
    ]);
    expect(f.emittedAxis).toEqual([
      ["RightStickY", 0.7],
      ["RightStickY", 0.7],
    ]);
  });
});

describe("NavController — empty events tick", () => {
  it("processEvents with [] after a press still services repeat timers", () => {
    const f = fxController();
    // This is the important pattern for the read loop: every tick, call
    // processEvents even with no new events, so key repeat fires.
    f.nav.processEvents("ctrl1", [
      { kind: "button", button: "A", pressed: true },
    ]);
    f.clock.advance(REPEAT_DELAY_MS + 10);
    f.nav.processEvents("ctrl1", [] as InputEvent[]);
    expect(f.emitted).toEqual(["a", "a"]);
  });
});
