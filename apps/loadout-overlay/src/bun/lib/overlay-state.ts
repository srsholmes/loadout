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
 * The overlay's three presentation modes:
 *
 *   "closed"  — window minimized, no atoms, game untouched.
 *   "ambient" — window mapped with the click-through atom set: visible
 *               over the game but input is NOT grabbed and Steam is NOT
 *               frozen. Non-interactive HUD only.
 *   "open"    — the interactive overlay: input grabbed, Steam frozen,
 *               STEAM_INPUT_FOCUS routed to us.
 *
 * Invariant: `isOpen === (mode === "open")`. `isOpen` stays on the
 * interface because every existing consumer (index.ts, rpc-handlers,
 * wake-routing) keys off it; flip both together via `applyMode`.
 */
export type OverlayMode = "closed" | "ambient" | "open";

/**
 * Triple-flag state used by the QAM / show / hide / toggle paths in
 * index.ts. `isOpen` is the source of truth for "is the overlay window
 * up right now"; the two `pending*` flags are one-shot requests
 * produced by the RPC handlers and consumed by `overlayManagementLoop`.
 *
 * `mode` / `ambientDesired` extend the machine with the ambient
 * (click-through HUD) state. Until the orchestrator adopts `applyMode`
 * for its post-side-effect flips, direct `isOpen` writes leave `mode`
 * at "closed" — harmless while nothing dispatches the ambient sweep
 * actions, but new code must use `applyMode`.
 */
export interface OverlayState {
  pendingToggle: boolean;
  pendingClose: boolean;
  isOpen: boolean;
  mode: OverlayMode;
  /**
   * Standing request from the webview (`setAmbientDesired` RPC): "the
   * user wants the ambient HUD and a game is running". Unlike the
   * one-shot `pending*` flags this is level-triggered — the sweep
   * reconciles `mode` toward it whenever the overlay isn't open.
   */
  ambientDesired: boolean;
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
    mode: initialIsOpen ? "open" : "closed",
    ambientDesired: false,
  };
}

/**
 * Flip `mode` and keep the `isOpen` invariant in one place. Callers in
 * index.ts run this *after* the corresponding side-effect succeeded,
 * same contract as the historical bare `state.isOpen = …` writes.
 */
export function applyMode(state: OverlayState, mode: OverlayMode): void {
  state.mode = mode;
  state.isOpen = mode === "open";
}

/**
 * Level-triggered ambient request (webview RPC handler). The sweep
 * turns a desire/mode mismatch into "enter-ambient" / "exit-ambient"
 * actions; nothing happens synchronously here, mirroring how the
 * `pending*` request functions never run side effects themselves.
 */
export function setAmbientDesired(state: OverlayState, desired: boolean): void {
  state.ambientDesired = desired;
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
export type SweepAction =
  | "show"
  | "hide"
  | "enter-ambient"
  | "exit-ambient"
  | "none";

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
 * The one-shot show/hide requests always win over ambient
 * reconciliation; only a "none" tick considers the ambient axis:
 *   5. closed  && ambientDesired  → enter-ambient
 *   6. ambient && !ambientDesired → exit-ambient
 *
 * Two consequences worth spelling out. "show" fires from ambient too
 * (isOpen is false there) — the open side-effect path is responsible
 * for demoting the ambient atom set before claiming the interactive
 * one. And a hide from "open" always lands on "closed" first; if
 * `ambientDesired` still holds, the *next* sweep tick promotes to
 * ambient. That one-tick detour keeps every transition single-step.
 *
 * Crucially this does *not* flip `isOpen`/`mode` itself — the caller
 * does that via `applyMode` after the side-effect succeeds
 * (window.show()/minimize() can throw under Gamescope teardown; we
 * don't want to wedge the flag machine if it does).
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

  if (action === "none") {
    if (state.mode === "closed" && state.ambientDesired) {
      action = "enter-ambient";
    } else if (state.mode === "ambient" && !state.ambientDesired) {
      action = "exit-ambient";
    }
  }
  return action;
}

/**
 * True if the management loop should be polling at the faster 50ms
 * cadence rather than the idle 500ms cadence. Active = overlay is
 * visible OR a pending request is in flight. Extracted so a test can
 * cover the edge: the loop must NOT idle while a `pendingClose` is
 * waiting to fire, even though `isOpen` is already false.
 *
 * An ambient desire/mode mismatch counts as "in flight" so entering or
 * leaving ambient doesn't lag up to 500ms; *steady* ambient idles at
 * the slow cadence — it's a passive HUD, nothing is transitioning.
 */
export function isActiveTick(state: OverlayState): boolean {
  return (
    state.isOpen ||
    state.pendingToggle ||
    state.pendingClose ||
    (!state.isOpen && (state.mode === "ambient") !== state.ambientDesired)
  );
}
