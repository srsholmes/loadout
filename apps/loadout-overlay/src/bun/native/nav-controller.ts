// Port of src-tauri/src/nav_controller.rs.
//
// Turns raw gamepad input events (from the evdev read loop) into
// high-level NavActions that the webview maps onto synthetic
// KeyboardEvents for norigin-spatial-navigation. Handles:
//
//   - key repeat: 500 ms initial delay, 200 ms thereafter (matches OS
//     keyboard-repeat defaults so norigin feels like a native input).
//   - axis → dpad: analog stick tilt past |0.5| fires a directional
//     keyboardEvent. Deadzone = 0.5 on the -1..1 normalized range.
//   - modifier suppression: while Mode/Select is held the combo detector
//     owns the event stream, so nothing is emitted here.
//   - B-on-release: prevents a phantom Escape leaking into Steam BPM
//     immediately after SIGCONT (if we ever bring SIGSTOP back).
//   - X press+release: X emits "x" on press, "x_up" on release so the
//     frontend can track hold-duration (used for long-press actions).
//
// Pure TS — no FFI. The evdev reader calls processEvents() with raw
// button/axis updates; emitAction is whatever bridge you wire up (in
// our case, RPC-send to the webview which dispatches a KeyboardEvent).

// ---- Timing constants (match nav_controller.rs exactly) ---------------------

export const REPEAT_DELAY_MS = 500;
export const REPEAT_RATE_MS = 200;
export const AXIS_DEADZONE = 0.5;

// ---- Input event shapes ----------------------------------------------------

export type GamepadButton =
  | "A"
  | "B"
  | "X"
  | "Y"
  | "LB"
  | "RB"
  | "Mode"
  | "Select";

export type GamepadAxis =
  | "LeftStickX"
  | "LeftStickY"
  | "RightStickX"
  | "RightStickY"
  | "HatX"
  | "HatY";

export type InputEvent =
  | { kind: "button"; button: GamepadButton; pressed: boolean }
  | { kind: "axis"; axis: GamepadAxis; value: number };

/** Actions emitted to the webview. Mirrors the `NavAction` enum in Rust
 *  PLUS "x_up" for the press+release split that frontend long-press UX
 *  relies on. */
export type NavAction =
  | "up"
  | "down"
  | "left"
  | "right"
  | "a"
  | "b"
  | "x"
  | "x_up"
  | "y"
  | "lb"
  | "rb";

// ---- Key-repeat tracker ----------------------------------------------------

/**
 * Timestamp of the next firing for a held action. `advance()` returns true
 * each time `now >= nextFire`, stepping `nextFire` forward by REPEAT_RATE_MS.
 * Matches RepeatTracker in nav_controller.rs exactly — the initial delay
 * (REPEAT_DELAY_MS) is longer than the steady-state rate to avoid misfires
 * when the user is already about to release.
 */
class RepeatTracker {
  nextFire: number;

  constructor(now: number) {
    this.nextFire = now + REPEAT_DELAY_MS;
  }

  checkAndAdvance(now: number): boolean {
    if (now >= this.nextFire) {
      this.nextFire = now + REPEAT_RATE_MS;
      return true;
    }
    return false;
  }
}

// Actions that participate in key repeat — excludes x_up (release-only)
// and the combo modifiers (Mode/Select).
type RepeatableAction =
  | "up"
  | "down"
  | "left"
  | "right"
  | "a"
  | "b"
  | "x"
  | "y"
  | "lb"
  | "rb";

// ---- Per-controller state --------------------------------------------------

interface ControllerState {
  held: Map<RepeatableAction, RepeatTracker>;
  modeHeld: boolean;
  selectHeld: boolean;
  /** Last value emitted for each continuous-analog axis (right stick).
   *  Used to dedupe rebroadcast events from the kernel so we don't spam
   *  the webview with identical scroll messages. */
  lastAnalog: Partial<Record<AnalogAxis, number>>;
}

function newControllerState(): ControllerState {
  return { held: new Map(), modeHeld: false, selectHeld: false, lastAnalog: {} };
}

/** Continuous-analog axes — bypass the dpad/deadzone path and get
 *  forwarded verbatim via emitAxis so the webview can drive smooth
 *  scrolling. */
export type AnalogAxis = "RightStickX" | "RightStickY";

function isAnalogAxis(axis: GamepadAxis): axis is AnalogAxis {
  return axis === "RightStickX" || axis === "RightStickY";
}

// ---- NavController ---------------------------------------------------------

export interface NavControllerOptions {
  /** Called whenever a NavAction fires. The Bun-side overlay wires this to
   *  `rpc.send("overlay-action", {action})` which the webview catches and
   *  translates into a synthetic KeyboardEvent. */
  emit: (action: NavAction) => void;
  /** Called for continuous-analog axes (right stick). The Bun-side overlay
   *  wires this to `rpc.send("overlay-scroll", {axis, value})`; the webview
   *  runs its own rAF loop with momentum to scroll the main content area.
   *  Skipped entirely for axes that go through the dpad path (left stick
   *  and hat). */
  emitAxis?: (axis: AnalogAxis, value: number) => void;
  /** Injected for tests — defaults to performance.now(). */
  now?: () => number;
}

/**
 * NavController — one instance for the whole app. Tracks per-controller
 * state keyed by an opaque controller id (we use `${device.hash}_${generation}`
 * so reconnects reset state).
 *
 * This class is synchronous and single-threaded. Call processEvents() from
 * the input-read loop for every batch of events, and pump() regularly
 * (e.g. every 50 ms) to service key repeat for held buttons.
 */
export class NavController {
  private emit: (action: NavAction) => void;
  private emitAxis?: (axis: AnalogAxis, value: number) => void;
  private now: () => number;
  private controllers = new Map<string, ControllerState>();

  constructor(opts: NavControllerOptions) {
    this.emit = opts.emit;
    this.emitAxis = opts.emitAxis;
    this.now = opts.now ?? (() => performance.now());
  }

  /**
   * Feed a batch of events from a single controller. Call this from the
   * read loop after every read() — even with an empty array, so key repeat
   * has a chance to fire without needing a separate pump.
   */
  processEvents(controllerId: string, events: InputEvent[]): void {
    let st = this.controllers.get(controllerId);
    if (!st) {
      st = newControllerState();
      this.controllers.set(controllerId, st);
    }

    // Pending edge-triggered emissions — (action, isPress). Key-repeat
    // ticks go into the same list below. Held action bookkeeping must
    // be done before the modifier-suppression short-circuit so the
    // Mode/Select flags are up to date for subsequent events.
    const edges: Array<[RepeatableAction, boolean]> = [];
    const now = this.now();

    for (const ev of events) {
      if (ev.kind === "axis") {
        this.applyAxis(st, ev.axis, ev.value, now, edges);
      } else {
        // button
        if (ev.button === "Mode") {
          st.modeHeld = ev.pressed;
          continue;
        }
        if (ev.button === "Select") {
          st.selectHeld = ev.pressed;
          continue;
        }
        const action = buttonToAction(ev.button);
        if (!action) continue;
        const wasHeld = st.held.has(action);
        if (ev.pressed && !wasHeld) {
          st.held.set(action, new RepeatTracker(now));
          edges.push([action, true]);
        } else if (!ev.pressed && wasHeld) {
          st.held.delete(action);
          edges.push([action, false]);
        }
      }
    }

    // Modifier suppression: while Mode or Select is held the combo
    // detector in the input-intercept module owns the event stream —
    // don't fire navigation on top of it.
    if (st.modeHeld || st.selectHeld) return;

    // Key repeat for held actions. Mutates nextFire inside the tracker.
    for (const [action, tracker] of st.held) {
      if (tracker.checkAndAdvance(now)) {
        edges.push([action, true]);
      }
    }

    // Final emit with per-button special cases.
    for (const [action, isPress] of edges) {
      switch (action) {
        // B fires on RELEASE only. nav_controller.rs's comment: prevents
        // a phantom Escape getting into Steam when we're resuming it
        // from SIGSTOP and our B-press raced the SIGCONT. Even without
        // SIGSTOP, release-triggering makes B feel more like a "commit
        // to close" action and less like it's always-firing on held B.
        case "b":
          if (!isPress) this.emit("b");
          break;
        // X emits both press and release as distinct actions so the UI
        // can tell a tap from a long-press (e.g. QAM quick-swap vs a
        // held-X context menu).
        case "x":
          this.emit(isPress ? "x" : "x_up");
          break;
        default:
          if (isPress) this.emit(action);
      }
    }
  }

  /** Reset all per-controller state. Called when the overlay opens or
   *  closes so a half-held button from last session doesn't spam the
   *  first frame of the new one. */
  reset(): void {
    this.controllers.clear();
  }

  /**
   * Axis → dpad conversion with deadzone. Writes to `edges` and updates
   * `state.held` in place.
   *
   * Right-stick axes (RightStickX/Y) short-circuit before the dpad
   * switch — they're continuous analog input for scrolling, not
   * direction triggers, so they must skip key-repeat / `state.held`
   * entirely and go straight to `emitAxis`.
   */
  private applyAxis(
    state: ControllerState,
    axis: GamepadAxis,
    value: number,
    now: number,
    edges: Array<[RepeatableAction, boolean]>,
  ): void {
    if (isAnalogAxis(axis)) {
      if (state.lastAnalog[axis] === value) return;
      state.lastAnalog[axis] = value;
      this.emitAxis?.(axis, value);
      return;
    }

    let posAction: RepeatableAction;
    let negAction: RepeatableAction;
    switch (axis) {
      case "LeftStickX":
      case "HatX":
        posAction = "right";
        negAction = "left";
        break;
      case "LeftStickY":
      case "HatY":
        posAction = "down";
        negAction = "up";
        break;
    }

    const posActive = value > AXIS_DEADZONE;
    const negActive = value < -AXIS_DEADZONE;

    const wasPos = state.held.has(posAction);
    const wasNeg = state.held.has(negAction);

    if (posActive && !wasPos) {
      state.held.set(posAction, new RepeatTracker(now));
      edges.push([posAction, true]);
    } else if (!posActive && wasPos) {
      state.held.delete(posAction);
      edges.push([posAction, false]);
    }

    if (negActive && !wasNeg) {
      state.held.set(negAction, new RepeatTracker(now));
      edges.push([negAction, true]);
    } else if (!negActive && wasNeg) {
      state.held.delete(negAction);
      edges.push([negAction, false]);
    }
  }
}

function buttonToAction(b: GamepadButton): RepeatableAction | null {
  switch (b) {
    case "A":
      return "a";
    case "B":
      return "b";
    case "X":
      return "x";
    case "Y":
      return "y";
    case "LB":
      return "lb";
    case "RB":
      return "rb";
    case "Mode":
    case "Select":
      return null;
  }
}
