import { describe, it, expect } from "bun:test";
import {
  applyMode,
  createOverlayState,
  requestShow,
  requestHide,
  requestToggle,
  setAmbientDesired,
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

describe("ambient mode", () => {
  it("createOverlayState starts closed with no ambient desire", () => {
    const s = createOverlayState();
    expect(s.mode).toBe("closed");
    expect(s.ambientDesired).toBe(false);
  });

  it("createOverlayState(true) starts in open mode, isOpen invariant holds", () => {
    const s = createOverlayState(true);
    expect(s.mode).toBe("open");
    expect(s.isOpen).toBe(true);
  });

  it("applyMode keeps isOpen === (mode === 'open') for every mode", () => {
    const s = createOverlayState();
    applyMode(s, "open");
    expect(s.isOpen).toBe(true);
    applyMode(s, "ambient");
    expect(s.isOpen).toBe(false);
    expect(s.mode).toBe("ambient");
    applyMode(s, "closed");
    expect(s.isOpen).toBe(false);
    expect(s.mode).toBe("closed");
  });

  it("closed + ambientDesired sweeps to 'enter-ambient'", () => {
    const s = createOverlayState();
    setAmbientDesired(s, true);
    expect(sweepPendingFlags(s)).toBe("enter-ambient");
  });

  it("enter-ambient is level-triggered: repeats until the caller applies the mode", () => {
    // Unlike the one-shot pending* flags, a failed enter side-effect
    // must be retried on the next tick — the desire isn't consumed.
    const s = createOverlayState();
    setAmbientDesired(s, true);
    expect(sweepPendingFlags(s)).toBe("enter-ambient");
    expect(sweepPendingFlags(s)).toBe("enter-ambient");
    applyMode(s, "ambient");
    expect(sweepPendingFlags(s)).toBe("none");
  });

  it("ambient + desire dropped sweeps to 'exit-ambient'", () => {
    const s = createOverlayState();
    setAmbientDesired(s, true);
    applyMode(s, "ambient");
    setAmbientDesired(s, false);
    expect(sweepPendingFlags(s)).toBe("exit-ambient");
    applyMode(s, "closed");
    expect(sweepPendingFlags(s)).toBe("none");
  });

  it("no ambient action while the overlay is open, even with desire set", () => {
    // "open" outranks ambient: the interactive overlay must never be
    // demoted underneath the user by a background desire flip.
    const s = createOverlayState(true);
    setAmbientDesired(s, true);
    expect(sweepPendingFlags(s)).toBe("none");
    expect(s.mode).toBe("open");
  });

  it("'show' wins over enter-ambient on the same tick", () => {
    const s = createOverlayState();
    setAmbientDesired(s, true);
    requestShow(s);
    expect(sweepPendingFlags(s)).toBe("show");
  });

  it("'show' fires from ambient (pendingToggle beats exit-ambient)", () => {
    // Opening the interactive overlay straight from the ambient HUD:
    // the open path re-writes the full atom set, so the sweep just
    // reports "show" and lets applyMode("open") absorb the mode.
    const s = createOverlayState();
    setAmbientDesired(s, true);
    applyMode(s, "ambient");
    requestToggle(s);
    expect(sweepPendingFlags(s)).toBe("show");
    applyMode(s, "open");
    expect(sweepPendingFlags(s)).toBe("none");
  });

  it("pendingClose while ambient is cleared as stale, ambient untouched", () => {
    // hide targets the *interactive* overlay; ambient teardown goes
    // through setAmbientDesired(false), never through pendingClose.
    const s = createOverlayState();
    setAmbientDesired(s, true);
    applyMode(s, "ambient");
    requestHide(s);
    expect(sweepPendingFlags(s)).toBe("none");
    expect(s.pendingClose).toBe(false);
    expect(s.mode).toBe("ambient");
  });

  it("close from open lands on closed, then promotes to ambient next tick", () => {
    // The one-tick detour documented on sweepPendingFlags: hide →
    // applyMode("closed") → the still-standing desire re-enters ambient.
    const s = createOverlayState();
    setAmbientDesired(s, true);
    applyMode(s, "ambient");
    requestToggle(s);
    expect(sweepPendingFlags(s)).toBe("show");
    applyMode(s, "open");

    requestToggle(s);
    expect(sweepPendingFlags(s)).toBe("hide");
    applyMode(s, "closed");
    expect(sweepPendingFlags(s)).toBe("enter-ambient");
    applyMode(s, "ambient");
    expect(sweepPendingFlags(s)).toBe("none");
  });

  it("sweep does not mutate mode — caller applies after the side-effect", () => {
    const s = createOverlayState();
    setAmbientDesired(s, true);
    sweepPendingFlags(s);
    expect(s.mode).toBe("closed");
  });

  it("desire flip-flop before any side-effect settles back to 'none'", () => {
    const s = createOverlayState();
    setAmbientDesired(s, true);
    setAmbientDesired(s, false);
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

  it("active while an ambient enter is pending (desire set, still closed)", () => {
    const s = createOverlayState();
    setAmbientDesired(s, true);
    expect(isActiveTick(s)).toBe(true);
  });

  it("active while an ambient exit is pending (desire dropped, still ambient)", () => {
    const s = createOverlayState();
    setAmbientDesired(s, true);
    applyMode(s, "ambient");
    setAmbientDesired(s, false);
    expect(isActiveTick(s)).toBe(true);
  });

  it("idle in steady ambient — a passive HUD must not hold the 50ms cadence", () => {
    const s = createOverlayState();
    setAmbientDesired(s, true);
    applyMode(s, "ambient");
    expect(isActiveTick(s)).toBe(false);
  });
});
