// Lifecycle plumbing for the overlay main process — the X11 / Gamescope
// management loop and the SIGINT/SIGTERM-driven shutdown ladder.
// Extracted from index.ts so the orchestrator stays a wire-up file,
// not a 600-LOC monolith. Both functions need to read/write the same
// pieces of module-global state index.ts owns (steamPid cache, the
// pending close-path SIGCONT timer, the management-loop running flag),
// so they take dependency-injected refs rather than touching the
// orchestrator's bindings directly. `{ current: T }` wrappers match
// the pattern used inside this codebase for the same problem.

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — resolved at runtime once electrobun is installed.
import type { GlobalShortcut as GlobalShortcutType } from "electrobun/bun";
import { resumeSteam } from "./native/process-control";
import type { GamescopeAtoms } from "./native/gamescope-atoms";
import type { InputInterceptHandle } from "./native/input-intercept";
import {
  isActiveTick,
  sweepPendingFlags,
  type OverlayState,
} from "./lib/overlay-state";

/**
 * `{ current: T }` ref wrapper — same shape React uses for mutable
 * singletons. Used here so the management loop + shutdown can read and
 * write the same value index.ts owns without re-exporting a setter for
 * every field.
 */
export interface Ref<T> {
  current: T;
}

// ---- Management loop -------------------------------------------------------

export interface ManagementLoopDeps {
  /** Triple-flag state from lib/overlay-state.ts. */
  state: OverlayState;
  /**
   * Audit B-023: running flag lets shutdown() break the otherwise-
   * infinite loop. Wrapped in a ref so the loop and shutdown share the
   * exact same boolean — no setter dance.
   */
  running: Ref<boolean>;
  /**
   * Forwarded to toggleOverlay() in index.ts. The decision of *what* to
   * do given the current flags is pure (sweepPendingFlags); the loop
   * just dispatches to the orchestrator's toggle which handles the
   * window + atom + intercept side effects.
   */
  toggleOverlay: (source: string) => void;
}

/**
 * Replaces overlay_management_loop() in main.rs. 50 ms when active
 * (overlay open or transitioning), 500 ms when idle — matches the
 * Rust cadence so responsiveness is identical.
 *
 * The sweep + flag cleanup logic lives in lib/overlay-state.ts. Both
 * pending paths route through toggleOverlay() — same code path the
 * QAM/F16 watcher + GlobalShortcut use.
 */
export async function overlayManagementLoop(
  deps: ManagementLoopDeps,
): Promise<void> {
  while (deps.running.current) {
    const active = isActiveTick(deps.state);

    const action = sweepPendingFlags(deps.state);
    if (action === "show") deps.toggleOverlay("rpc:show");
    else if (action === "hide") deps.toggleOverlay("rpc:hide");

    await new Promise((r) => setTimeout(r, active ? 50 : 500));
  }
}

// ---- Shutdown --------------------------------------------------------------

export interface ShutdownDeps {
  /** Audit B-023: flipped to false so the management loop drops out. */
  running: Ref<boolean>;
  /**
   * Audit B-027: the close-path 250 ms deferred SIGCONT timer. Held so
   * shutdown can cancel it; otherwise the deferred resume fires post-
   * exit and the helper logs spurious "process exited" noise.
   */
  pendingResumeTimer: Ref<ReturnType<typeof setTimeout> | null>;
  /** Cached Steam PID — null if we never opened the overlay this session. */
  steamPid: Ref<number | null>;
  /** Gamescope X11 atoms object; .hide() zeroes STEAM_OVERLAY=1. */
  atoms: GamescopeAtoms;
  /** Input interceptor handle — may be null if it failed to start. */
  intercept: Ref<InputInterceptHandle | null>;
  /** Electrobun GlobalShortcut module — we unregister whatever we grabbed. */
  globalShortcut: typeof GlobalShortcutType;
}

/**
 * Clean shutdown driven by SIGINT/SIGTERM. Releases the gamepad grab,
 * resumes Steam, and zeroes the Gamescope atoms — in that order, since
 * leaving Steam TASK_STOPPED or STEAM_OVERLAY=1 set on exit strands
 * the user with no recovery short of a reboot.
 */
export async function shutdown(deps: ShutdownDeps): Promise<void> {
  console.log("[overlay] shutting down");
  // Audit B-023: tell the management loop to stop so it doesn't fire
  // one last toggleOverlay() against an atoms object we've already
  // shut down below.
  deps.running.current = false;
  // Audit B-027: cancel the pending close-path SIGCONT timer. Steam is
  // resumed unconditionally below; running the deferred resume after
  // process.exit(0) is harmless but logs a benign "process exited"
  // error from the resumeSteam helper, which is noise on shutdown.
  if (deps.pendingResumeTimer.current !== null) {
    clearTimeout(deps.pendingResumeTimer.current);
    deps.pendingResumeTimer.current = null;
  }
  try {
    // Critical #1: RESUME STEAM. If we exit with Steam still in
    // TASK_STOPPED, the whole machine looks frozen to the user and
    // the only recovery is a hard reboot. Do this FIRST, before any
    // other teardown that might hang. SIGCONT on a running process
    // is a no-op, so calling this unconditionally is safe.
    if (deps.steamPid.current !== null) resumeSteam(deps.steamPid.current);
    // Critical #2: zero the Gamescope atoms so we never exit with
    // STEAM_OVERLAY=1 still on the window — that would leave the
    // overlay visually on top with no way for the user to dismiss it.
    // We retry once: the first attempt can race with the
    // window-manager teardown when shutdown is SIGTERM-driven from
    // session exit. Failure to clear the atom strands the user
    // (no input until reboot), so it's worth surfacing in the log
    // rather than swallowing — `journalctl --user -u
    // loadout-overlay` will then show why.
    try {
      await deps.atoms.hide();
    } catch (err) {
      console.warn("[overlay] atoms.hide failed on shutdown, retrying:", err);
      try {
        await deps.atoms.hide();
      } catch (err2) {
        console.error(
          "[overlay] atoms.hide failed twice on shutdown — gamescope may keep STEAM_OVERLAY=1 set:",
          err2,
        );
      }
    }
    // Release + close all evdev grabs + FDs. Kernel would release
    // them on process death anyway, but explicit shutdown avoids a
    // window where another process can't grab them because we
    // haven't fully exited yet.
    deps.intercept.current?.shutdown();
    deps.globalShortcut.unregisterAll();
    deps.atoms.shutdown();
  } finally {
    process.exit(0);
  }
}
