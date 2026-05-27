import { describe, it, expect } from "bun:test";
import {
  createOverlayState,
  requestShow,
  requestHide,
  requestToggle,
  sweepPendingFlags,
  isActiveTick,
  type OverlayState,
} from "./overlay-state";

// These specs cover audit finding B-006 — the overlay open/close
// state machine that lives in index.ts had zero unit tests across
// 25 commits in 3 months. The pure flag-flipping logic is what
// the QAM toggle, the show/hide/toggle RPC handlers, and the
// management-loop sweep all share. Booting the full Electrobun
// main process to test it would dlopen libNativeWrapper.so + open
// X11, so the logic is extracted here and tested in isolation.

describe("createOverlayState", () => {
  it("defaults to all-false", () => {
    const s = createOverlayState();
    expect(s.pendingToggle).toBe(false);
    expect(s.pendingClose).toBe(false);
    expect(s.isOpen).toBe(false);
  });

  it("accepts initial isOpen=true for desktop-smoke-test boot", () => {
    // Mirrors DESKTOP_SMOKE_TEST=1 in index.ts where the window starts
    // visible and the state object must agree.
    const s = createOverlayState(true);
    expect(s.isOpen).toBe(true);
    expect(s.pendingToggle).toBe(false);
    expect(s.pendingClose).toBe(false);
  });

  it("returns a fresh object each call (no shared mutable state)", () => {
    const a = createOverlayState();
    const b = createOverlayState();
    a.isOpen = true;
    expect(b.isOpen).toBe(false);
  });
});

describe("requestShow", () => {
  it("sets pendingToggle when the overlay is closed", () => {
    const s = createOverlayState();
    requestShow(s);
    expect(s.pendingToggle).toBe(true);
    expect(s.pendingClose).toBe(false);
    expect(s.isOpen).toBe(false);
  });

  it("is a no-op when the overlay is already open", () => {
    // Match the `if (!state.isOpen) state.pendingToggle = true` branch
    // — calling show on an already-open overlay must not queue a
    // pending toggle that the loop would then immediately discard.
    const s = createOverlayState(true);
    requestShow(s);
    expect(s.pendingToggle).toBe(false);
    expect(s.pendingClose).toBe(false);
  });

  it("is idempotent across multiple calls", () => {
    const s = createOverlayState();
    requestShow(s);
    requestShow(s);
    requestShow(s);
    expect(s.pendingToggle).toBe(true);
  });
});

describe("requestHide", () => {
  it("sets pendingClose when the overlay is open", () => {
    const s = createOverlayState(true);
    requestHide(s);
    expect(s.pendingClose).toBe(true);
    expect(s.pendingToggle).toBe(false);
  });

  it("also sets pendingClose when the overlay is already closed", () => {
    // index.ts unconditionally sets the flag; the management-loop
    // sweep is responsible for clearing the no-op. This keeps the
    // RPC handler trivial and pushes the "is this needed" decision
    // to a single place (the sweep).
    const s = createOverlayState(false);
    requestHide(s);
    expect(s.pendingClose).toBe(true);
  });
});

describe("requestToggle", () => {
  it("when closed: queues pendingToggle and returns true", () => {
    const s = createOverlayState(false);
    const next = requestToggle(s);
    expect(next).toBe(true);
    expect(s.pendingToggle).toBe(true);
    expect(s.pendingClose).toBe(false);
  });

  it("when open: queues pendingClose and returns false", () => {
    const s = createOverlayState(true);
    const next = requestToggle(s);
    expect(next).toBe(false);
    expect(s.pendingClose).toBe(true);
    expect(s.pendingToggle).toBe(false);
  });

  it("does NOT immediately flip isOpen — that's the side-effect's job", () => {
    // The window.show()/minimize() side-effects can throw under
    // gamescope teardown; flipping isOpen here would desync the
    // state machine from reality. The sweep + toggleOverlay()
    // pair in index.ts does the flip after the side-effect runs.
    const open = createOverlayState(true);
    requestToggle(open);
    expect(open.isOpen).toBe(true);

    const closed = createOverlayState(false);
    requestToggle(closed);
    expect(closed.isOpen).toBe(false);
  });
});

describe("sweepPendingFlags", () => {
  it("returns 'none' when no flags are set", () => {
    const s = createOverlayState();
    expect(sweepPendingFlags(s)).toBe("none");
  });

  it("returns 'show' and clears pendingToggle when closed + pendingToggle", () => {
    const s = createOverlayState(false);
    s.pendingToggle = true;
    expect(sweepPendingFlags(s)).toBe("show");
    expect(s.pendingToggle).toBe(false);
  });

  it("returns 'hide' and clears pendingClose when open + pendingClose", () => {
    const s = createOverlayState(true);
    s.pendingClose = true;
    expect(sweepPendingFlags(s)).toBe("hide");
    expect(s.pendingClose).toBe(false);
  });

  it("clears leftover pendingToggle when overlay is already open", () => {
    // Without this sweep the management loop would spin at 50ms
    // forever (isActiveTick stays true because pendingToggle is true).
    const s = createOverlayState(true);
    s.pendingToggle = true;
    const action = sweepPendingFlags(s);
    expect(action).toBe("none");
    expect(s.pendingToggle).toBe(false);
  });

  it("clears leftover pendingClose when overlay is already closed", () => {
    const s = createOverlayState(false);
    s.pendingClose = true;
    const action = sweepPendingFlags(s);
    expect(action).toBe("none");
    expect(s.pendingClose).toBe(false);
  });

  it("prefers show over hide when both flags are set and overlay is closed", () => {
    // Defensive: in practice the flags shouldn't both be true at
    // once, but if they are, the original loop ordering processes
    // pendingToggle first. Lock that in.
    const s = createOverlayState(false);
    s.pendingToggle = true;
    s.pendingClose = true;
    expect(sweepPendingFlags(s)).toBe("show");
    // pendingClose is dropped as leftover (overlay still closed).
    expect(s.pendingClose).toBe(false);
    expect(s.pendingToggle).toBe(false);
  });

  it("prefers hide over show when both flags are set and overlay is open", () => {
    const s = createOverlayState(true);
    s.pendingToggle = true;
    s.pendingClose = true;
    expect(sweepPendingFlags(s)).toBe("hide");
    expect(s.pendingClose).toBe(false);
    expect(s.pendingToggle).toBe(false);
  });

  it("does NOT mutate isOpen — caller flips after side-effect", () => {
    const closed: OverlayState = createOverlayState(false);
    closed.pendingToggle = true;
    sweepPendingFlags(closed);
    expect(closed.isOpen).toBe(false);

    const open: OverlayState = createOverlayState(true);
    open.pendingClose = true;
    sweepPendingFlags(open);
    expect(open.isOpen).toBe(true);
  });

  it("multi-tick cycle: closed → show request → swept → open → hide request → swept → closed", () => {
    // Walk a full open/close cycle the way the management loop would,
    // with the caller flipping isOpen after each side-effect.
    const s = createOverlayState(false);
    requestShow(s);
    expect(sweepPendingFlags(s)).toBe("show");
    s.isOpen = true; // caller side-effect: overlay.show() succeeded.
    expect(sweepPendingFlags(s)).toBe("none");

    requestHide(s);
    expect(sweepPendingFlags(s)).toBe("hide");
    s.isOpen = false; // caller side-effect: overlay.minimize() succeeded.
    expect(sweepPendingFlags(s)).toBe("none");
  });
});

describe("isActiveTick", () => {
  it("idle when overlay is closed and no pending flags", () => {
    expect(isActiveTick(createOverlayState())).toBe(false);
  });

  it("active when overlay is open", () => {
    expect(isActiveTick(createOverlayState(true))).toBe(true);
  });

  it("active when a show request is pending, even if overlay is still closed", () => {
    const s = createOverlayState(false);
    s.pendingToggle = true;
    expect(isActiveTick(s)).toBe(true);
  });

  it("active when a hide request is pending, even after the overlay is closed", () => {
    // This is the edge that motivated extracting isActiveTick — the
    // loop must not idle while a pendingClose is waiting to be swept,
    // or the visibility broadcast lags 500ms behind the side-effect.
    const s = createOverlayState(false);
    s.pendingClose = true;
    expect(isActiveTick(s)).toBe(true);
  });
});
