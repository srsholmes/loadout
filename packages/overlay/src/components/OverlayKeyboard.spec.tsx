import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent } from "../../../../test/render";
import { OverlayKeyboard } from "./OverlayKeyboard";
import {
  setKeyboardVisible,
  setKeyboardDefaultHandler,
  pushKeystrokeHandler,
  type ResolvedKey,
} from "@loadout/ui";

// react-simple-keyboard renders buttons with `data-skbtn="<button>"` and
// invokes `onKeyPress(button)` / `onKeyReleased(button)` synchronously
// from the DOM listeners it attaches. Drive the watchdog/hold loop by
// firing those listeners directly through the buttons it renders.
function pressKey(button: string) {
  const el = document.querySelector(
    `[data-skbtn="${button}"]`,
  ) as HTMLElement | null;
  if (!el) throw new Error(`OSK button not found: ${button}`);
  // RSK attaches `.onpointerdown` / `.onpointerup` property handlers
  // when pointer events are supported (which they are under happy-dom).
  fireEvent.pointerDown(el);
}

function releaseKey(button: string) {
  const el = document.querySelector(
    `[data-skbtn="${button}"]`,
  ) as HTMLElement | null;
  if (!el) throw new Error(`OSK button not found: ${button}`);
  fireEvent.pointerUp(el);
}

describe("OverlayKeyboard", () => {
  beforeEach(() => {
    // Make sure the OSK store starts hidden + with no leftover handlers
    // between tests.
    setKeyboardDefaultHandler(null);
    setKeyboardVisible(false);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    setKeyboardDefaultHandler(null);
    setKeyboardVisible(false);
  });

  it("renders nothing when not visible", () => {
    const { container } = render(<OverlayKeyboard />);
    expect(container.querySelector("#overlay-osk")).toBeNull();
  });

  it("mounts the keyboard root when visible", () => {
    const { container } = render(<OverlayKeyboard />);
    act(() => setKeyboardVisible(true));
    expect(container.querySelector("#overlay-osk")).toBeTruthy();
    // react-simple-keyboard renders at least one key with data-skbtn.
    expect(document.querySelector('[data-skbtn]')).toBeTruthy();
  });

  it("dispatches a single keystroke on press", () => {
    render(<OverlayKeyboard />);
    act(() => setKeyboardVisible(true));
    const received: ResolvedKey[] = [];
    const unsub = pushKeystrokeHandler((k) => {
      received.push(k);
      return true;
    });
    act(() => pressKey("q"));
    expect(received).toEqual([{ type: "char", value: "q" }]);
    unsub();
  });

  it("starts repeating after the 500ms delay and 40ms interval", () => {
    render(<OverlayKeyboard />);
    act(() => setKeyboardVisible(true));
    const received: ResolvedKey[] = [];
    const unsub = pushKeystrokeHandler((k) => {
      received.push(k);
      return true;
    });

    act(() => pressKey("a"));
    expect(received).toHaveLength(1); // initial press

    // Before the 500ms delay, no repeats.
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(received).toHaveLength(1);

    // Cross the delay threshold + a couple of intervals.
    act(() => {
      vi.advanceTimersByTime(1 + 40 + 40);
    });
    // 1 initial + 2 repeats = 3
    expect(received.length).toBeGreaterThanOrEqual(3);
    expect(received[received.length - 1]).toEqual({ type: "char", value: "a" });
    unsub();
  });

  it("stops repeating on release (onKeyReleased)", () => {
    render(<OverlayKeyboard />);
    act(() => setKeyboardVisible(true));
    const received: ResolvedKey[] = [];
    const unsub = pushKeystrokeHandler((k) => {
      received.push(k);
      return true;
    });

    act(() => pressKey("a"));
    act(() => {
      vi.advanceTimersByTime(500 + 40 + 40); // 2 repeats fired
    });
    const afterHold = received.length;

    act(() => releaseKey("a"));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(received.length).toBe(afterHold);
    unsub();
  });

  // NOTE: We can't cleanly isolate the absolute 5s watchdog in this test
  // environment — `react-simple-keyboard` has its own hold-repeat that
  // re-fires `onKeyPress` every ~100 ms, and the defensive `stopHold()`
  // at the top of our `onKeyPress` resets the watchdog on every re-fire.
  // The watchdog only meaningfully kicks in when rsk's own loop stops
  // re-firing but no release event lands either — a state that requires
  // mocking rsk's internals to reproduce. Instead, the surrounding
  // pointerup/touchend safety net is exercised by the test below.
  it("re-pressing while held cancels any prior hold (defensive stopHold)", () => {
    render(<OverlayKeyboard />);
    act(() => setKeyboardVisible(true));
    const received: ResolvedKey[] = [];
    const unsub = pushKeystrokeHandler((k) => {
      received.push(k);
      return true;
    });

    act(() => pressKey("a"));
    act(() => {
      vi.advanceTimersByTime(500 + 40 * 3); // ~3 repeats deep
    });
    const beforeSecondPress = received.length;
    expect(beforeSecondPress).toBeGreaterThanOrEqual(2);

    // Press a different key without releasing 'a'. The defensive
    // `stopHold()` at the top of onKeyPress must clear the prior
    // hold so we don't end up with two concurrent repeat intervals.
    act(() => pressKey("b"));
    expect(received[received.length - 1]).toEqual({ type: "char", value: "b" });

    // Then immediately release. No more repeats should land.
    act(() => releaseKey("b"));
    const atRelease = received.length;
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(received.length).toBe(atRelease);
    unsub();
  });

  it("document-level pointerup stops the hold even off the button", () => {
    render(<OverlayKeyboard />);
    act(() => setKeyboardVisible(true));
    const received: ResolvedKey[] = [];
    const unsub = pushKeystrokeHandler((k) => {
      received.push(k);
      return true;
    });

    act(() => pressKey("a"));
    // Push past delay, get a repeat.
    act(() => {
      vi.advanceTimersByTime(500 + 40);
    });
    const beforeStop = received.length;
    // Fire pointerup on the document (not the button itself) — the
    // capture-phase listener that OverlayKeyboard installs should still
    // catch it and clear the hold.
    act(() => {
      document.dispatchEvent(new Event("pointerup", { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(received.length).toBe(beforeStop);
    unsub();
  });

  it("toggle keys ({shift}) do not arm the auto-repeat loop", () => {
    render(<OverlayKeyboard />);
    act(() => setKeyboardVisible(true));
    const received: ResolvedKey[] = [];
    const unsub = pushKeystrokeHandler((k) => {
      received.push(k);
      return true;
    });

    act(() => pressKey("{shift}"));
    // Drive the clock well past delay + interval — shift swaps the
    // layout but should never produce repeat dispatches.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(received).toHaveLength(0);
    unsub();
  });
});
