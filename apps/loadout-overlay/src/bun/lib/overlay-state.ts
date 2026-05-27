// Overlay open/close state machine. Extracted from index.ts so the pure
// flag-flipping logic is testable without booting the full Electrobun
// main process (which dlopens libNativeWrapper.so + opens X11 on
// `import "electrobun/bun"`). The RPC handlers in index.ts call
// `requestShow` / `requestHide` / `requestToggle` to flip flags; the
// overlay-management loop polls those flags and triggers the actual
// window + atom + intercept side effects.
//
// Audit B-006: the orchestrator in index.ts is 25+ commits old and has
// zero unit tests for the toggle debounce + flag lifecycle. The shape
// here is deliberately the same PendingFlags object index.ts already
// owns — extraction is structural, not behavioural.

/**
 * Triple-flag state used by the QAM / show / hide / toggle paths in
 * index.ts. `isOpen` is the source of truth for "is the overlay window
 * up right now"; the two `pending*` flags are one-shot requests
 * produced by the RPC handlers and consumed by `overlayManagementLoop`.
 */
export interface OverlayState {
  pendingToggle: boolean;
  pendingClose: boolean;
  isOpen: boolean;
}

/**
 * Construct a fresh state object. `initialIsOpen` is wired so
 * desktop-smoke-test mode can boot already-visible without having to
 * mutate the returned object before passing it around.
 */
export function createOverlayState(initialIsOpen = false): OverlayState {
  return {
    pendingToggle: false,
    pendingClose: false,
    isOpen: initialIsOpen,
  };
}

/**
 * RPC `show` handler. If the overlay is already up, this is a no-op —
 * a redundant `pendingToggle` would still get cleared by the loop's
 * leftover-flag sweep, but skipping the write keeps the state object
 * stable for callers observing it directly (tests, future devtools).
 */
export function requestShow(state: OverlayState): void {
  if (!state.isOpen) state.pendingToggle = true;
}

/**
 * RPC `hide` handler. Always sets `pendingClose` — even when the
 * overlay is already hidden, matching the original index.ts behaviour
 * (the leftover-flag sweep in the management loop will clear it on
 * the next tick).
 */
export function requestHide(state: OverlayState): void {
  state.pendingClose = true;
}

/**
 * RPC `toggle` handler. Returns the desired open state after the toggle
 * so the webview's RPC client can update its local UI optimistically
 * without waiting for the `overlay-visibility` broadcast.
 */
export function requestToggle(state: OverlayState): boolean {
  if (state.isOpen) {
    state.pendingClose = true;
    return false;
  }
  state.pendingToggle = true;
  return true;
}

/**
 * Result of one iteration of the management loop's flag sweep. The
 * loop in index.ts will translate the action into the real
 * side-effects (window.show/minimize, atoms, intercept, Steam SIGCONT),
 * but the decision of *what* to do given the current flags is pure —
 * and tested here.
 */
export type SweepAction = "show" | "hide" | "none";

/**
 * One iteration of the management loop's flag sweep. Returns the
 * action the caller should run, *and* clears the consumed flag plus
 * any stale flags that no longer match the current `isOpen` state.
 *
 * Mirrors the four-branch sequence in `overlayManagementLoop`:
 *   1. pendingToggle && !isOpen → show
 *   2. pendingClose && isOpen   → hide
 *   3. pendingToggle && isOpen  → stale, clear
 *   4. pendingClose && !isOpen  → stale, clear
 *
 * Crucially this does *not* flip `isOpen` itself — the caller does
 * that after the side-effect succeeds (window.show()/minimize() can
 * throw under Gamescope teardown; we don't want to wedge the flag
 * machine if it does).
 */
export function sweepPendingFlags(state: OverlayState): SweepAction {
  let action: SweepAction = "none";
  if (state.pendingToggle && !state.isOpen) {
    state.pendingToggle = false;
    action = "show";
  } else if (state.pendingClose && state.isOpen) {
    state.pendingClose = false;
    action = "hide";
  }
  // Drop leftover flags that no longer match the current state so the
  // loop doesn't spin on them forever.
  if (state.pendingToggle && state.isOpen) state.pendingToggle = false;
  if (state.pendingClose && !state.isOpen) state.pendingClose = false;
  return action;
}

/**
 * True if the management loop should be polling at the faster 50ms
 * cadence rather than the idle 500ms cadence. Active = overlay is
 * visible OR a pending request is in flight. Extracted so a test can
 * cover the edge: the loop must NOT idle while a `pendingClose` is
 * waiting to fire, even though `isOpen` is already false.
 */
export function isActiveTick(state: OverlayState): boolean {
  return state.isOpen || state.pendingToggle || state.pendingClose;
}
