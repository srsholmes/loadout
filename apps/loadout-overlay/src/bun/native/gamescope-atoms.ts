// Shell-out to xprop / xdotool to drive the Gamescope atom lifecycle on our
// overlay window. This is the Bun-side equivalent of the Tauri overlay's
// overlay_display.rs — minimal enough to unblock gaming-mode testing, not
// yet a full FFI port (that's TODO(stage-2), see native/x11.ts stubs).
//
// Why shell out? xprop is tiny and always present on any system running
// gamescope. A real port uses bun:ffi against libxcb, but:
//   - we're still in scaffold territory;
//   - xprop's surface is stable;
//   - the hot path is one-shot on open/close — spawn cost is fine.
//
// The magic numbers here match overlay_display.rs's constants exactly.

import { run as _runRaw, commandExists } from "@loadout/exec";
import { trace } from "./trace";
import { X11Connection } from "./x11";
import { dismissSteamMenusIfOpen } from "./steam-quick-access";

// From overlay_display.rs
const OVERLAY_APP_ID = 0x534c; // 21324, "SL"
const OPACITY_VISIBLE = 0xffffffff;
const OPACITY_HIDDEN = 0;

// Hard cap on every xprop / xdotool subprocess this module spawns.
// Without it, a single hung X server query (gamescope wedged in some
// state) blocks Bun's event loop for the entire overlay process —
// observed as 20+ seconds of process silence after a show() in the
// trace, during which the user's own toggle button presses also
// failed to register and the whole device looked frozen. 1.5s is well
// past any healthy xprop round-trip but short enough that the user
// can hit the toggle again and recover.
const X11_SUBPROC_TIMEOUT_MS = 1500;

/** Wrapper around exec.run that always applies a timeout. Prevents a
 *  stuck X server from hanging Bun's event loop. */
function run(
  cmd: string[],
): Promise<{ stdout: string; exitCode: number }> {
  return _runRaw(cmd, { timeoutMs: X11_SUBPROC_TIMEOUT_MS });
}
// gamescope::TouchClickModes enum values from gamescope/src/backend.h:
//   0=Hover, 1=Left, 2=Right, 3=Middle, 4=Passthrough, 5=Disabled, 6=Trackpad.
// "Passthrough" = touches forward to the focused window (overlay or game).
const TOUCH_MODE_OVERLAY = 4;
// Gap between flipping the focus atoms and writing touch mode — mirrors
// the flush/sync/sleep(100ms) in overlay_display.rs::show_overlay(). Gives
// Gamescope a chance to process the focus change before we redirect touch.
const TOUCH_MODE_APPLY_DELAY_MS = 100;

// Reclaim-focus watcher cadence. Polling fallback for the xprop path
// only. Under libxcb we use PropertyChangeMask events instead — no
// idle traffic, react only when Steam actually changes state.
const RECLAIM_WATCH_INTERVAL_MS = 100;
// Event-drain cadence for the libxcb path. Cheap (just `xcb_poll_for_event`
// — non-blocking, returns immediately when the queue is empty), so we
// can run it fairly fast without generating any X server load.
const RECLAIM_EVENT_DRAIN_INTERVAL_MS = 50;
// If we read Steam's atoms as 0/0 for this many consecutive ticks we
// re-run findSteamWindow() on the assumption we latched onto the wrong
// candidate — steamwebhelper spawns several windows and only one of
// them is the real BPM / QAM host. 20 ticks × 100ms = 2 s of "quiet"
// before we re-resolve, which is well below any realistic human
// perception of flicker.
const RECLAIM_RERESOLVE_AFTER_QUIET_TICKS = 20;

export interface AtomTargetOptions {
  /** Which X display to talk to. On Bazzite gamescope-session, :0 is the
   *  inner X where Steam BPM + overlays live. :1 is the outer (konsole). */
  display: string;
  /** The window name xdotool should search for. Electrobun doesn't let us
   *  set a stable WM_CLASS, so we look up by the window title instead. */
  windowName: string;
  /** Force the xprop-subprocess fallback path even if libxcb is
   *  available. Kill switch for the libxcb migration — set
   *  `OVERLAY_FORCE_XPROP=1` in the environment to flip this. */
  forceXprop?: boolean;
}

export class GamescopeAtoms {
  private display: string;
  private windowName: string;
  /** Cached window id; re-resolved on first failure. */
  private windowId: string | null = null;
  /** Cached Steam Big Picture window id — re-resolved on show(). */
  private steamWindowId: string | null = null;
  /** libxcb connection for the atom-write hot path. null = use xprop
   *  fallback (either because OVERLAY_FORCE_XPROP=1 was set, or because
   *  xcb_connect failed at startup — desktop dev without an X server,
   *  WSL, etc.). When non-null, show()/hide()/reclaim batch all writes
   *  on this connection and flush in one round-trip — eliminates the
   *  ~60ms multi-subprocess race window where flicker happens. */
  private x11: X11Connection | null = null;
  /** Cached interned id for STEAM_OVERLAY — used by the event-driven
   *  reclaim watcher to filter PropertyNotify events down to the one
   *  atom we actually care about. 0 means "not yet looked up". */
  private steamOverlayAtomId = 0;
  /** Snapshot of STEAM_TOUCH_CLICK_MODE on root before show() overwrote it.
   *  Restored on hide(). null means either no prior value was set or it was
   *  already TOUCH_MODE_OVERLAY, in which case we don't restore. Matches
   *  SteamAtomSnapshot::touch_mode in overlay_display.rs. */
  private snapshotTouchMode: number | null = null;

  /** Snapshot of Steam's BPM window atoms (STEAM_OVERLAY /
   *  STEAM_INPUT_FOCUS / STEAM_NOTIFICATION) taken in show() before our
   *  reclaim loop starts hammering them down to zero. Restored in hide()
   *  so Steam's QAM comes back to whatever state it was in before we
   *  took over. Without this, closing our overlay left Steam in a state
   *  where its QAM was conceptually open but STEAM_INPUT_FOCUS=0, so
   *  gamescope refused to route input and Steam looked frozen. */
  private snapshotSteamAtoms: Map<string, number> | null = null;

  /** Reclaim-focus watcher handle. Set while the overlay is shown — polls
   *  Steam's atoms and counter-asserts ours if Steam re-grabs them. Null
   *  between hide() and the next show(). */
  private reclaimTimer: ReturnType<typeof setInterval> | null = null;
  /** Reentrancy guard — skip a tick if the previous xprop round-trip is
   *  still in flight. Prevents stacking up xprop subprocess calls on a stuck
   *  gamescope (e.g. during display hotplug). */
  private reclaimInFlight = false;
  /** Consecutive reclaim ticks where Steam's atoms read as 0/0. When
   *  this crosses RECLAIM_RERESOLVE_AFTER_QUIET_TICKS we re-resolve
   *  steamWindowId in case we latched onto the wrong steamwebhelper
   *  child window on the first pass. */
  private reclaimQuietTicks = 0;

  constructor(opts: AtomTargetOptions) {
    this.display = opts.display;
    this.windowName = opts.windowName;

    // Try to open a libxcb connection up front. Failure (server down,
    // wrong display, libxcb missing) is non-fatal — we silently fall
    // back to spawning xprop subprocesses.
    if (!opts.forceXprop) {
      const x11 = new X11Connection();
      if (x11.connect(this.display)) {
        this.x11 = x11;
        trace(`[gamescope-atoms] libxcb connection opened on ${this.display}`);
      } else {
        trace(
          `[gamescope-atoms] libxcb connect failed on ${this.display}; falling back to xprop subprocess path`,
        );
      }
    }
  }

  /** Convert an "0x..." hex window id to its numeric uint32 form.
   *  Returns null on parse failure. Not cached — the conversion is
   *  cheap and caching invited stale-value bugs across re-resolves. */
  private _windowIdNumFor(kind: "own" | "steam"): number | null {
    const hex = kind === "own" ? this.windowId : this.steamWindowId;
    if (hex === null) return null;
    const n = Number(hex);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Snapshot the win-id via xdotool. Returns a hex id like "0x2e00001"
   * (xprop's preferred format). Called once on prepare and again on
   * each open in case the window was torn down and rebuilt.
   */
  async findWindow(): Promise<string | null> {
    if (!(await commandExists("xdotool"))) {
      console.warn("[gamescope-atoms] xdotool not found on PATH");
      return null;
    }
    try {
      const { stdout, exitCode } = await run([
        "env",
        `DISPLAY=${this.display}`,
        "xdotool",
        "search",
        "--name",
        this.windowName,
      ]);
      if (exitCode !== 0) return null;
      const id = stdout.split("\n")[0]?.trim();
      if (!id) return null;
      this.windowId = "0x" + Number(id).toString(16);
      return this.windowId;
    } catch (err) {
      console.warn("[gamescope-atoms] findWindow failed:", err);
      return null;
    }
  }

  /**
   * Look up Steam's Big Picture window.
   *
   * Live xprop survey of an Apex in BPM (May 2026) showed a handful of
   * Steam-owned windows present at the same time: the real BPM window, the
   * steamwebhelper renderer, a "VRStream" 32×32, MENU/tooltip 64×24
   * popups, plus 10×10 utility windows. We have to pick the right one or
   * we end up zeroing atoms on a window gamescope ignores.
   *
   * Heuristic, in priority order — strongest signal first:
   *
   *   1. WM_NAME = "Steam Big Picture Mode" — only the actual BPM window
   *      has this exact name; if we find one, take it and stop.
   *   2. Otherwise, score candidates that pass ALL of:
   *        - WM_CLASS includes "steamwebhelper"
   *        - _NET_WM_WINDOW_TYPE = _NET_WM_WINDOW_TYPE_NORMAL set
   *        - STEAM_GAME = 769 (Steam's own appID — set on real BPM, not
   *          on the renderer-only helper)
   *      Among those, prefer one currently asserting overlay/focus.
   *   3. Fallback: first managed window we found (preserves legacy /
   *      desktop-Steam behaviour for shapes we haven't surveyed).
   *
   * The previous implementation skipped step 1, fell through to a
   * non-deterministic pool[0] when no window asserted overlay/focus, and
   * frequently latched onto the wrong steamwebhelper child — so the
   * reclaim watcher was monitoring a window gamescope ignores.
   */
  async findSteamWindow(): Promise<string | null> {
    if (!(await commandExists("xdotool"))) return null;

    // Collect candidates from --class steamwebhelper + steam.
    // Empirically xdotool's --name regex doesn't match BPM's
    // _NET_WM_NAME-only "Steam Big Picture Mode" title (only WM_NAME
    // gets indexed for --name in some xdotool builds), so we always
    // enumerate by class and filter ourselves by reading WM_NAME via
    // xprop on each.
    const allIds = new Set<string>();
    for (const cls of ["steamwebhelper", "steam"]) {
      for (const id of await this._xdotoolSearchClass(cls)) {
        allIds.add(id);
      }
    }
    if (allIds.size === 0) return null;
    const candidates = [...allIds];

    // 1. Strongest signal: WM_NAME = "Steam Big Picture Mode".
    for (const id of candidates) {
      const name = await this._readWmName(id);
      if (name === "Steam Big Picture Mode") {
        this.steamWindowId = id;
        trace(
          `[gamescope-atoms] findSteamWindow → ${id} (by WM_NAME) candidates=${candidates.length}`,
        );
        return id;
      }
    }

    // 2. Scored fallback for non-BPM scenarios (e.g. desktop Steam,
    //    older Steam shapes that label BPM differently).
    const chosen = await this._pickBpmWindow(candidates);
    this.steamWindowId = chosen;
    trace(
      `[gamescope-atoms] findSteamWindow → ${chosen} (scored, candidates: ${candidates.join(",")})`,
    );
    return chosen;
  }

  /** Read a window's WM_NAME / _NET_WM_NAME via xprop. Returns the
   *  string body or null if neither is set. */
  private async _readWmName(windowId: string): Promise<string | null> {
    try {
      const { stdout, exitCode } = await run([
        "env",
        `DISPLAY=${this.display}`,
        "xprop",
        "-id",
        windowId,
        "_NET_WM_NAME",
        "WM_NAME",
      ]);
      if (exitCode !== 0) return null;
      // Output looks like:
      //   _NET_WM_NAME(UTF8_STRING) = "Steam Big Picture Mode"
      //   WM_NAME(STRING) = "Steam"
      // Or: "_NET_WM_NAME:  not found." if absent.
      // Prefer _NET_WM_NAME (UTF-8) when both are present.
      const lines = stdout.split("\n");
      for (const prefix of ["_NET_WM_NAME", "WM_NAME"]) {
        for (const line of lines) {
          if (!line.startsWith(prefix + "(")) continue;
          const m = line.match(/=\s*"((?:[^"\\]|\\.)*)"/);
          if (m) return m[1];
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Pick the BPM window from a set of Steam-owned X windows. See
   *  findSteamWindow()'s doc for the heuristic. */
  private async _pickBpmWindow(candidates: readonly string[]): Promise<string> {
    // Filter to candidates that pass the structural BPM signature:
    // managed window (WM_TYPE_NORMAL set) AND tagged with STEAM_GAME=769.
    // Either alone is too weak — managed alone also matches VRStream,
    // STEAM_GAME=769 alone also matches the 200×200 renderer helper.
    const managed: string[] = [];
    for (const id of candidates) {
      const hasWindowType = await this._hasAtom(id, "_NET_WM_WINDOW_TYPE");
      if (!hasWindowType) continue;
      const atoms = await this._readAtoms(id, ["STEAM_GAME"]);
      if ((atoms.get("STEAM_GAME") ?? 0) === 769) {
        managed.push(id);
      }
    }
    const pool = managed.length > 0 ? managed : candidates;

    // Prefer a pool window currently claiming overlay/focus.
    for (const id of pool) {
      const atoms = await this._readAtoms(id, [
        "STEAM_OVERLAY",
        "STEAM_INPUT_FOCUS",
      ]);
      if (
        (atoms.get("STEAM_OVERLAY") ?? 0) !== 0 ||
        (atoms.get("STEAM_INPUT_FOCUS") ?? 0) !== 0
      ) {
        return id;
      }
    }
    return pool[0];
  }

  /** True if `atom` is set on `windowId`. Uses xprop output to
   *  distinguish "not found" from a zero-value atom. */
  private async _hasAtom(windowId: string, atom: string): Promise<boolean> {
    try {
      const { stdout, exitCode } = await run([
        "env",
        `DISPLAY=${this.display}`,
        "xprop",
        "-id",
        windowId,
        atom,
      ]);
      if (exitCode !== 0) return false;
      return !stdout.includes("not found");
    } catch {
      return false;
    }
  }

  private async _xdotoolSearchClass(cls: string): Promise<string[]> {
    try {
      const { stdout, exitCode } = await run([
        "env",
        `DISPLAY=${this.display}`,
        "xdotool",
        "search",
        "--class",
        cls,
      ]);
      if (exitCode !== 0) return [];
      return stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((decimal) => "0x" + Number(decimal).toString(16));
    } catch (err) {
      console.warn(
        `[gamescope-atoms] _xdotoolSearchClass(${cls}) failed:`,
        err,
      );
      return [];
    }
  }

  /**
   * One-time setup — sets atoms that mark this window as a Loadout
   * overlay. Defaults to hidden (opacity 0) so Gamescope doesn't render
   * it until the user toggles.
   */
  async prepare(): Promise<void> {
    if (!this.windowId) await this.findWindow();
    if (!this.windowId) return;
    // Only set atoms gamescope actually reads. Verified against
    // steamcompmgr.cpp:7772-7811 (May 2026): STEAM_NOTIFICATION and
    // GAMESCOPE_NO_FOCUS that the Rust prior art set are NOT registered
    // in gamescope's atom table — writing them was a no-op.
    await this._set("STEAM_GAME", OVERLAY_APP_ID);
    await this._set("STEAM_BIGPICTURE", 1);
    await this._set("_NET_WM_WINDOW_OPACITY", OPACITY_HIDDEN);
    await this._set("STEAM_OVERLAY", 0);
    await this._set("STEAM_INPUT_FOCUS", 0);
    this._flush();
    // Warm the Steam window cache so the first show() doesn't pay a
    // ~40ms cold xdotool/xprop survey. Best-effort: if Steam isn't up
    // yet at boot, show() still falls back to a lazy resolve.
    if (!this.steamWindowId) {
      this.findSteamWindow().catch(() => {});
    }
  }

  /** Show: tell Gamescope to composite us on top + route input to us.
   *  Also repositions the window onto the currently-primary monitor so
   *  unplugging an external HDMI display (and re-plugging one) still
   *  lands the overlay where the user is looking. Under gamescope's
   *  inner X there's only one output, so this is a no-op there; under
   *  KDE/GNOME multi-monitor it matters.
   *
   *  Atom write order matters when Steam's QAM is already open. If we
   *  flip our opacity visible BEFORE zeroing Steam's atoms, gamescope
   *  sees two windows claiming STEAM_OVERLAY=1 for the duration of our
   *  own-window atom writes (~60ms of xprop subprocess spawns) and
   *  oscillates compositing between them — visible as a brief flicker.
   *  Zero Steam first, then claim our atoms, then flip opacity — by
   *  the time we're visible, Steam is already yielding. */
  async show(): Promise<void> {
    if (!this.windowId) await this.findWindow();
    if (!this.windowId) return;
    await this._positionOnPrimary();
    // 1. Snapshot Steam's current BPM atoms BEFORE we touch them, so
    //    hide() can put them back. Without this, the reclaim watcher
    //    keeps Steam's atoms at 0 for the whole time our overlay is
    //    open, and on close Steam's QAM is stuck visually open with
    //    STEAM_INPUT_FOCUS=0 — gamescope refuses to route input to it
    //    and Steam "looks frozen."
    await this._snapshotSteamAtoms();
    // 1.5. If the snapshot shows Steam is asserting STEAM_OVERLAY=1
    //      on BPM, Steam is in "menu-over-game" mode — that's the
    //      trigger scenario for the device-wide compositor freeze
    //      (gamescope can't handle our overlay competing for the
    //      slot when Steam's already there with a game in baselayer).
    //      Send Escape to BPM to dismiss its menu before we proceed.
    //      Using snapshot-derived signal instead of STEAM_GAMES_RUNNING
    //      because Steam doesn't reliably write that atom — empirically
    //      observed it unset even when a game is genuinely running and
    //      Steam IS asserting overlay (the only signal we can trust).
    await this._maybeDismissSteamMenu();
    // 2. Suppress Steam's QAM atoms BEFORE we become visible. Resolved
    //    lazily: Steam's window may not exist in standalone desktop
    //    dev — optional, we still composite fine without it.
    //
    //    Skip the 3 xprop -set calls (~30ms) when the snapshot already
    //    shows Steam isn't claiming overlay/focus/notification — i.e.
    //    user opened our overlay without Steam's QAM up. The reclaim
    //    watcher will catch any subsequent re-assertion within 100ms.
    if (this._steamSnapshotIsAsserted()) {
      await this._zeroSteamFocusAtoms();
    }
    // 3. Claim overlay status on our own window.
    await this._set("STEAM_OVERLAY", 1);
    await this._set("STEAM_INPUT_FOCUS", 1);
    // 4. Flip to visible. Gamescope sees exactly one STEAM_OVERLAY=1
    //    claimant and composites us unambiguously.
    await this._set("_NET_WM_WINDOW_OPACITY", OPACITY_VISIBLE);
    // 5. Flush the entire show() write batch in one X11 round-trip.
    //    Gamescope sees [Steam=0,0,0; ours overlay=1, focus=1, opac=visible]
    //    as a single sequence of PropertyNotify events and runs
    //    DetermineAndApplyFocus once on the final state. No intermediate
    //    "both at STEAM_OVERLAY=1" frame → no flicker. (No-op on the
    //    xprop fallback path; each subprocess auto-flushes.)
    this._flush();
    await this._applyOverlayTouchMode();
    // Steam's BPM re-asserts STEAM_OVERLAY=1 whenever its internal
    // state says "QAM should be open" (e.g. the user opened Steam's
    // QAM before ours via a different hotkey). Without a
    // counter-assertion loop, gamescope oscillates between focusing
    // Steam and focusing us, visible as fast flicker. Matches the
    // Rust overlay's per-tick steam_reclaimed/reclaim_focus check
    // from main.rs — the piece that never got ported when we moved
    // from Tauri to Electrobun.
    this._startReclaimWatcher();
  }

  /** True if Steam's BPM has STEAM_OVERLAY=1 in the most recent
   *  snapshot. Used by show() to skip a no-op zero pass when Steam
   *  isn't claiming the overlay slot. */
  private _steamSnapshotIsAsserted(): boolean {
    return (this.snapshotSteamAtoms?.get("STEAM_OVERLAY") ?? 0) !== 0;
  }

  /**
   * Zero only STEAM_OVERLAY on Steam's BPM window — leave INPUT_FOCUS
   * and NOTIFICATION alone.
   *
   * STEAM_OVERLAY drives gamescope's overlay-slot arbitration; we
   * zero it so we win the contest. STEAM_INPUT_FOCUS, however, is
   * Steam's CEF-UI self-state signal ("am I the active overlay?") —
   * Steam toggles it on its own window when its menu/QAM is open and
   * uses it to decide whether to process menu inputs. If we zero it,
   * Steam's UI keeps the menu visually rendered but stops handling
   * inputs (the user-reported "Steam UI frozen" failure mode).
   *
   * Gamescope only consults STEAM_INPUT_FOCUS on the *overlay window*
   * (steamcompmgr.cpp:4201). Since we've zeroed Steam's STEAM_OVERLAY,
   * BPM is not the overlay window from gamescope's POV, so leaving
   * its INPUT_FOCUS at 1 is invisible to gamescope's input routing.
   *
   * No-op when Steam isn't running (desktop dev) or its window hasn't
   * been mapped yet.
   */
  private async _zeroSteamFocusAtoms(): Promise<void> {
    if (!this.steamWindowId) await this.findSteamWindow();
    if (!this.steamWindowId) return;
    await this._setOn(this.steamWindowId, "STEAM_OVERLAY", 0);
  }

  /**
   * If one of Steam's BPM menus (Quick Access Menu or the main
   * Steam-button menu) is currently open, dismiss it via Chrome
   * DevTools Protocol before we open our overlay.
   *
   * Why this hook exists at all: when the user has a Steam menu open
   * in BPM home with a game alive in baselayer, and they then toggle
   * our overlay, gamescope's compositor reliably wedges into a
   * device-wide input freeze that requires reboot. Empirically the
   * trigger is the menu-open state, not Steam's STEAM_OVERLAY atom or
   * any X11-visible signal — both menus are CEF browser_view popups
   * INSIDE Steam BPM's existing X window, with no separate window we
   * can manipulate via X atoms.
   *
   * Earlier shapes of this hook tried to detect the trigger via
   * STEAM_GAMES_RUNNING (Steam writes it inconsistently — observed
   * unset even with a game running) and via the snapshot's
   * STEAM_OVERLAY (Steam doesn't assert it on BPM in this scenario).
   * Both signals missed the trigger state. The reliable path is to
   * ask Steam's CEF directly: connect to its CDP at localhost:8080,
   * find the `QuickAccess_uid2` / `MainMenu_uid2` pages, check if
   * either is visible, and dispatch Escape into the open one via
   * Input.dispatchKeyEvent.
   *
   * No-op if Steam's CDP isn't reachable, the menu pages aren't found,
   * or both menus are already hidden. The CDP operation has its own
   * 800ms timeout so a stalled Steam doesn't block our show() path.
   */
  private async _maybeDismissSteamMenu(): Promise<void> {
    try {
      const dismissed = await dismissSteamMenusIfOpen();
      if (dismissed) {
        trace(`[gamescope-atoms] pre-show: dismissed Steam menu via CDP`);
      }
    } catch (err) {
      console.warn("[gamescope-atoms] _maybeDismissSteamMenu:", err);
    }
  }

  /**
   * Read STEAM_OVERLAY / STEAM_INPUT_FOCUS / STEAM_NOTIFICATION off
   * Steam's BPM window into `snapshotSteamAtoms` so hide() can restore
   * them. No-op without a resolvable Steam window. Stores zeros for
   * any atom that wasn't set — the restore path treats "not in map"
   * and "zero" identically, so either shape is fine.
   */
  private async _snapshotSteamAtoms(): Promise<void> {
    this.snapshotSteamAtoms = null;
    if (!this.steamWindowId) await this.findSteamWindow();
    if (!this.steamWindowId) return;
    // Only snapshot STEAM_OVERLAY — that's the only one we manage on
    // Steam's window. INPUT_FOCUS and NOTIFICATION are Steam's
    // self-state signals; we never write them, so we don't need to
    // remember them.
    const atoms = await this._readAtoms(this.steamWindowId, [
      "STEAM_OVERLAY",
    ]);
    this.snapshotSteamAtoms = atoms;
    trace(
      `[gamescope-atoms] snapshot Steam STEAM_OVERLAY=${atoms.get("STEAM_OVERLAY") ?? 0}`,
    );
  }

  /**
   * Restore Steam's STEAM_OVERLAY on hide based on whether a game is
   * running. Leaves STEAM_INPUT_FOCUS and STEAM_NOTIFICATION untouched
   * — those are Steam's self-state signals (see _zeroSteamFocusAtoms
   * doc) and must not be disturbed.
   *
   * Two regimes, picked by STEAM_GAMES_RUNNING on root:
   *
   * **No game running** (BPM home, no game in baselayer):
   *   Force STEAM_OVERLAY=0. Restoring overlay=1 would make BPM the
   *   only isOverlay window with no focusWindow → gamescope nulls
   *   overlayWindow + inputFocusWindow (steamcompmgr.cpp:4192-4209) →
   *   device-wide input halt.
   *
   * **Game running** (game in baselayer):
   *   Restore the snapshotted STEAM_OVERLAY value. The game is a
   *   focusWindow candidate, so making BPM isOverlay again is fine —
   *   gamescope gives BPM the overlay slot, BPM's INPUT_FOCUS (which
   *   we never touched) routes inputs into Steam's CEF UI.
   */
  private async _maybeRestoreSteamAtoms(): Promise<void> {
    const snap = this.snapshotSteamAtoms;
    this.snapshotSteamAtoms = null;
    if (!this.steamWindowId) await this.findSteamWindow();
    if (!this.steamWindowId) return;

    const gamesRunning = await this._getRootAtom("STEAM_GAMES_RUNNING");
    const gameAlive = gamesRunning !== null && gamesRunning > 0;
    const snapOverlay = snap?.get("STEAM_OVERLAY") ?? 0;

    const targetOverlay = gameAlive ? snapOverlay : 0;
    await this._setOn(this.steamWindowId, "STEAM_OVERLAY", targetOverlay);
    trace(
      `[gamescope-atoms] hide: gameAlive=${gameAlive} (count=${gamesRunning ?? "unset"}), wrote STEAM_OVERLAY=${targetOverlay} (snap was ${snapOverlay}); INPUT_FOCUS/NOTIFICATION left untouched`,
    );
  }

  /**
   * Start event-driven monitoring of Steam's STEAM_OVERLAY atom.
   *
   * Subscribes to PropertyChangeMask on Steam's BPM window via libxcb,
   * then polls the X event queue at a slow cadence. We only react when
   * Steam actually sets STEAM_OVERLAY=1 — there's no atom write traffic
   * in steady state. Matches HHD's approach (`win.change_attributes(
   * event_mask=Xlib.X.PropertyChangeMask)` + `process_events(disp)`).
   *
   * The previous 100ms-poll-and-write reclaim loop generated up to
   * ~30 atom operations per second and appeared to overwhelm
   * gamescope's compositor under repeated overlay-toggle cycles —
   * device-wide input freezes. Event-driven reduces idle traffic to
   * zero and reactive traffic to one read + maybe one write per
   * actual Steam-side change.
   *
   * Falls back to the old polling loop on the xprop path (no libxcb
   * connection / events). No-op if already running.
   */
  private _startReclaimWatcher(): void {
    if (this.reclaimTimer !== null) return;

    // libxcb path: subscribe to PropertyChangeMask, poll events.
    if (this.x11 && this.steamWindowId) {
      const idNum = this._windowIdNumFor("steam");
      if (idNum !== null) {
        this.x11.selectPropertyChanges(idNum);
        this.steamOverlayAtomId = this.x11.internAtom("STEAM_OVERLAY");
        const timer = setInterval(() => {
          void this._drainPropertyEvents();
        }, RECLAIM_EVENT_DRAIN_INTERVAL_MS);
        (timer as unknown as { unref?: () => void }).unref?.();
        this.reclaimTimer = timer;
        trace(
          `[gamescope-atoms] reclaim watcher: event-driven (PropertyChangeMask on ${this.steamWindowId}, atom=${this.steamOverlayAtomId})`,
        );
        return;
      }
    }

    // Fallback (xprop path or steam-window not resolved): old polling.
    this.reclaimQuietTicks = 0;
    const timer = setInterval(() => {
      void this._reclaimTick();
    }, RECLAIM_WATCH_INTERVAL_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.reclaimTimer = timer;
    trace(
      `[gamescope-atoms] reclaim watcher: polling (xprop fallback at ${RECLAIM_WATCH_INTERVAL_MS}ms)`,
    );
  }

  /** Stop the reclaim watcher. Safe to call multiple times. */
  private _stopReclaimWatcher(): void {
    if (this.reclaimTimer === null) return;
    clearInterval(this.reclaimTimer);
    this.reclaimTimer = null;
  }

  /**
   * Drain pending PropertyNotify events from the X server. Called on
   * the event-driven path only. If we see STEAM_OVERLAY change on the
   * BPM window, read its current value; if 1, counter-zero + re-assert
   * ours. Single read + (conditional) single write per actual change.
   *
   * Audit B-025: mirrors `_reclaimTick`'s `reclaimInFlight` guard.
   * Without it a rapid burst of PropertyNotify events can interleave
   * two zero-then-reassert sequences and end up writing STEAM_OVERLAY=0
   * after the second reassert lands — leaving us unfocused.
   */
  private async _drainPropertyEvents(): Promise<void> {
    if (!this.x11) return;
    if (!this.steamWindowId) return;
    if (this.reclaimInFlight) return;
    const events = this.x11.pollPropertyChanges();
    if (events.length === 0) return;
    const steamIdNum = this._windowIdNumFor("steam");
    if (steamIdNum === null) return;
    // Did the STEAM_OVERLAY atom on Steam's BPM window change?
    const sawOverlay = events.some(
      (e) =>
        e.window === steamIdNum &&
        this.steamOverlayAtomId !== 0 &&
        e.atom === this.steamOverlayAtomId,
    );
    if (!sawOverlay) return;
    // Read current value; only counter-write if it's actually 1.
    const v = this.x11.getCardinals(steamIdNum, ["STEAM_OVERLAY"]);
    const overlay = v.get("STEAM_OVERLAY") ?? 0;
    if (overlay === 0) return;
    this.reclaimInFlight = true;
    try {
      trace(
        `[gamescope-atoms] PropertyNotify: Steam re-asserted STEAM_OVERLAY=1 — taking it back`,
      );
      await this._zeroSteamFocusAtoms();
      if (this.windowId) {
        await this._setOn(this.windowId, "STEAM_OVERLAY", 1, true);
      }
      this._flush();
    } finally {
      this.reclaimInFlight = false;
    }
  }

  /**
   * Polling fallback for the xprop path (no libxcb event queue).
   * Reads Steam's STEAM_OVERLAY; if Steam re-asserted it, counter-zero
   * and re-claim ours. Identical to the previous reclaim implementation.
   */
  private async _reclaimTick(): Promise<void> {
    if (this.reclaimInFlight) return;
    if (!this.steamWindowId) {
      await this.findSteamWindow();
      if (!this.steamWindowId) return;
    }
    this.reclaimInFlight = true;
    try {
      const atoms = await this._readAtoms(this.steamWindowId, [
        "STEAM_OVERLAY",
      ]);
      const stole = (atoms.get("STEAM_OVERLAY") ?? 0) !== 0;
      if (!stole) {
        this.reclaimQuietTicks++;
        if (this.reclaimQuietTicks >= RECLAIM_RERESOLVE_AFTER_QUIET_TICKS) {
          trace(
            `[gamescope-atoms] reclaim quiet for ${this.reclaimQuietTicks} ticks — re-resolving Steam window`,
          );
          this.reclaimQuietTicks = 0;
          this.steamWindowId = null;
        }
        return;
      }
      this.reclaimQuietTicks = 0;
      trace(
        `[gamescope-atoms] Steam reclaimed STEAM_OVERLAY — taking it back`,
      );
      await this._zeroSteamFocusAtoms();
      if (this.windowId) {
        await this._setOn(this.windowId, "STEAM_OVERLAY", 1, true);
      }
      this._flush();
    } finally {
      this.reclaimInFlight = false;
    }
  }

  /**
   * Read several CARDINAL atoms off a specific window in one xprop call.
   * Returns a map of atom name → numeric value for every atom that was
   * set and parseable. Missing / malformed entries are omitted rather
   * than surfaced as nulls so callers can treat "no entry" identically
   * to "not set".
   */
  private async _readAtoms(
    windowId: string,
    names: readonly string[],
  ): Promise<Map<string, number>> {
    if (names.length === 0) return new Map();

    // libxcb path: pipelined reads on the persistent connection. Issues
    // all cookies first, collects replies — one round-trip total.
    if (this.x11) {
      // Decide which cached numeric id maps to this hex string. The
      // reclaim loop and snapshot path read off Steam's window; show()
      // reads off our own. Any other window id (rare) we still
      // accept by parsing on the fly.
      let idNum: number | null = null;
      if (windowId === this.steamWindowId) {
        idNum = this._windowIdNumFor("steam");
      } else if (windowId === this.windowId) {
        idNum = this._windowIdNumFor("own");
      } else {
        const n = Number(windowId);
        if (Number.isFinite(n)) idNum = n;
      }
      if (idNum !== null) {
        return this.x11.getCardinals(idNum, names);
      }
      // Fall through to xprop on parse failure — rare.
    }

    // xprop fallback path.
    const out = new Map<string, number>();
    try {
      const { stdout, exitCode } = await run([
        "env",
        `DISPLAY=${this.display}`,
        "xprop",
        "-id",
        windowId,
        ...names,
      ]);
      if (exitCode !== 0) return out;
      for (const line of stdout.split("\n")) {
        // "NAME(CARDINAL) = 1" — match name and value. Absent atoms
        // print as "NAME:  not found." and don't match this regex.
        const m = line.match(/^(\w+)\([^)]+\)\s*=\s*(-?\d+)/);
        if (!m) continue;
        const n = Number(m[2]);
        if (Number.isFinite(n)) out.set(m[1], n);
      }
    } catch (err) {
      console.warn(
        `[gamescope-atoms] xprop read ${names.join(",")} on ${windowId} failed:`,
        err,
      );
    }
    return out;
  }

  /** Move the window onto the primary monitor's geometry. Best-effort —
   *  if xrandr isn't on PATH, or there's only one output, this is a
   *  no-op. Called on every show() so hot-plug/unplug of external
   *  displays gets picked up at the next overlay open. */
  private async _positionOnPrimary(): Promise<void> {
    if (!this.windowId) return;
    if (!(await commandExists("xrandr")) || !(await commandExists("xdotool"))) {
      return;
    }
    try {
      const { stdout, exitCode } = await run([
        "env",
        `DISPLAY=${this.display}`,
        "xrandr",
        "--current",
        "--query",
      ]);
      if (exitCode !== 0) return;
      // Line we're looking for: "HDMI-1 connected primary 1920x1080+0+0 ..."
      // Under gamescope's inner X usually: "DP-1 connected 2560x1440+0+0 ..."
      const geom = this._pickMonitorGeometry(stdout);
      if (!geom) return;
      // windowmove + windowsize: center the overlay in the monitor.
      const x = geom.x + Math.max(0, Math.floor((geom.w - 1280) / 2));
      const y = geom.y + Math.max(0, Math.floor((geom.h - 800) / 2));
      await run([
        "env",
        `DISPLAY=${this.display}`,
        "xdotool",
        "windowmove",
        this.windowId,
        String(x),
        String(y),
      ]);
    } catch (err) {
      console.warn("[gamescope-atoms] _positionOnPrimary:", err);
    }
  }

  private _pickMonitorGeometry(
    xrandr: string,
  ): { x: number; y: number; w: number; h: number } | null {
    // Each monitor line looks roughly:
    //   "<name> connected [primary] <W>x<H>+<X>+<Y> ..."
    // We prefer the line marked "primary"; otherwise the first connected
    // output with a concrete geometry.
    const geomRe = /(\d+)x(\d+)\+(\d+)\+(\d+)/;
    let primary: RegExpMatchArray | null = null;
    let firstConnected: RegExpMatchArray | null = null;
    for (const line of xrandr.split("\n")) {
      if (!line.includes(" connected")) continue;
      const m = line.match(geomRe);
      if (!m) continue;
      if (line.includes(" primary ")) {
        primary = m;
        break;
      }
      if (!firstConnected) firstConnected = m;
    }
    const m = primary ?? firstConnected;
    if (!m) return null;
    return {
      w: Number(m[1]),
      h: Number(m[2]),
      x: Number(m[3]),
      y: Number(m[4]),
    };
  }

  /** Hide: zero our atoms, drop opacity, force Steam's atoms back to 0,
   *  restore touch mode. Order matters:
   *    1. Stop the reclaim watcher so it can't race us
   *    2. Clear our overlay/focus claims FIRST so we're no longer an
   *       overlay candidate from gamescope's perspective
   *    3. Drop our opacity so we're no longer painted
   *    4. Force-zero Steam's atoms (see _forceZeroSteamAtoms doc — we do
   *       NOT restore the snapshot; that path was the regression that
   *       caused the "Steam frozen / QAM stuck open" bug)
   *    5. Restore root STEAM_TOUCH_CLICK_MODE if we changed it
   */
  async hide(): Promise<void> {
    this._stopReclaimWatcher();
    if (!this.windowId) await this.findWindow();
    if (!this.windowId) return;
    await this._set("STEAM_INPUT_FOCUS", 0);
    await this._set("STEAM_OVERLAY", 0);
    await this._set("_NET_WM_WINDOW_OPACITY", OPACITY_HIDDEN);
    await this._maybeRestoreSteamAtoms();
    // Flush the whole hide batch in one round-trip — gamescope sees
    // our atoms drop to 0/0/0 and Steam's atoms restored to their
    // pre-show values in one PropertyNotify burst. Steam's UI logic
    // sees its self-state signals come back, picks back up where it
    // was; gamescope arbitrates input routing once on the final state.
    this._flush();
    await this._restoreTouchMode();
  }

  /**
   * Snapshot the current root STEAM_TOUCH_CLICK_MODE and overwrite it with
   * TOUCH_MODE_OVERLAY so Gamescope routes touch straight to our window
   * instead of synthesizing a fake mouse cursor. Writes unconditionally —
   * even when the atom is unset ("not found"), because under Gamescope the
   * atom may simply not have been populated yet (e.g. fresh gamescope-session
   * boot before BPM touched any touch-aware UI). Skipping the write there
   * leaves Gamescope with no target for touch and our overlay never sees
   * finger input.
   *
   * On hide() we only restore when we captured a non-null, non-4 prior —
   * there's nothing meaningful to restore to otherwise. Steam BPM reasserts
   * the atom whenever it needs a different mode.
   */
  private async _applyOverlayTouchMode(): Promise<void> {
    const prior = await this._getRootAtom("STEAM_TOUCH_CLICK_MODE");
    // Snapshot whatever prior was (including TOUCH_MODE_OVERLAY=4 if
    // Steam's QAM was already up) so hide() can restore it. null prior
    // (fresh gamescope session, atom never set) means there's nothing
    // to restore to — leave snapshot null, let hide() leave the atom
    // at our value.
    this.snapshotTouchMode = prior;
    // 100ms gives gamescope time to settle our STEAM_OVERLAY=1 /
    // Steam=0 before we fiddle with root touch routing — empirically
    // necessary to avoid a brief overlay flicker when Steam's QAM is
    // already open at show() time.
    await new Promise((r) => setTimeout(r, TOUCH_MODE_APPLY_DELAY_MS));
    await this._setRootAtom("STEAM_TOUCH_CLICK_MODE", TOUCH_MODE_OVERLAY);
  }

  /**
   * Restore root STEAM_TOUCH_CLICK_MODE to its pre-show value.
   *
   * Always verbatim — even if the snapshot was TOUCH_MODE_OVERLAY (4).
   * Pairs with _restoreSteamAtoms (which also restores Steam's
   * STEAM_OVERLAY / STEAM_INPUT_FOCUS): if Steam's menu was open at
   * our show() time, BOTH the touch routing AND the per-window flags
   * need to come back together — otherwise BPM ends up with stale
   * mismatched state and its menu UI stops processing inputs.
   */
  private async _restoreTouchMode(): Promise<void> {
    if (this.snapshotTouchMode === null) return;
    await this._setRootAtom(
      "STEAM_TOUCH_CLICK_MODE",
      this.snapshotTouchMode,
    );
    trace(
      `[gamescope-atoms] touch_mode restored to ${this.snapshotTouchMode}`,
    );
    this.snapshotTouchMode = null;
  }

  /**
   * Read a CARDINAL atom off the screen root via `xprop -root`.
   * Returns null for the "not found" case, for parse failures, and for
   * any subprocess error — all callers treat those identically.
   */
  private async _getRootAtom(atom: string): Promise<number | null> {
    try {
      const { stdout, exitCode } = await run([
        "env",
        `DISPLAY=${this.display}`,
        "xprop",
        "-root",
        atom,
      ]);
      if (exitCode !== 0) return null;
      // Output for a set CARDINAL atom looks like:
      //   "STEAM_TOUCH_CLICK_MODE(CARDINAL) = 1"
      // For an unset atom:
      //   "STEAM_TOUCH_CLICK_MODE:  not found."
      const m = stdout.match(/=\s*(-?\d+)/);
      if (!m) return null;
      const n = Number(m[1]);
      return Number.isFinite(n) ? n : null;
    } catch (err) {
      console.warn(`[gamescope-atoms] xprop -root ${atom} read failed:`, err);
      return null;
    }
  }

  /** Write a CARDINAL atom to the screen root via `xprop -root -set`. */
  private async _setRootAtom(atom: string, value: number): Promise<void> {
    try {
      const { exitCode } = await run([
        "env",
        `DISPLAY=${this.display}`,
        "xprop",
        "-root",
        "-f",
        atom,
        "32c",
        "-set",
        atom,
        String(value),
      ]);
      if (exitCode !== 0) {
        console.warn(
          `[gamescope-atoms] xprop -root set ${atom}=${value} exited ${exitCode}`,
        );
      }
    } catch (err) {
      console.warn(`[gamescope-atoms] xprop -root ${atom} failed:`, err);
    }
  }

  private async _set(atom: string, value: number): Promise<void> {
    if (!this.windowId) return;
    await this._setOn(this.windowId, atom, value, /* isOwnWindow */ true);
  }

  private async _setOn(
    windowId: string,
    atom: string,
    value: number,
    isOwnWindow = false,
  ): Promise<void> {
    // Fast path: libxcb queues the write on a persistent connection.
    // Doesn't actually hit the X server until _flush() is called, so
    // multiple writes batched in show()/hide() land on gamescope's
    // event queue back-to-back — eliminating the multi-subprocess race
    // window where Steam re-asserts STEAM_OVERLAY=1 mid-sequence.
    if (this.x11) {
      const idNum = isOwnWindow
        ? this._windowIdNumFor("own")
        : this._windowIdNumFor("steam");
      if (idNum !== null) {
        this.x11.setCardinal(idNum, atom, value);
        return;
      }
      // Fall through to xprop if for some reason we don't have a
      // numeric id (parse failure on a malformed cache entry).
    }

    // Slow path: shell-out fallback. Used when libxcb isn't available
    // (no DISPLAY, gamescope down at startup, OVERLAY_FORCE_XPROP=1).
    try {
      const { exitCode } = await run([
        "env",
        `DISPLAY=${this.display}`,
        "xprop",
        "-id",
        windowId,
        "-f",
        atom,
        "32c",
        "-set",
        atom,
        String(value),
      ]);
      if (exitCode !== 0) {
        console.warn(
          `[gamescope-atoms] xprop set ${atom}=${value} on ${windowId} exited ${exitCode}`,
        );
        // Invalidate the matching cache so the next call re-resolves.
        // Steam's BPM window can be recreated between sessions too.
        if (isOwnWindow) this.windowId = null;
        else this.steamWindowId = null;
      }
    } catch (err) {
      console.warn(`[gamescope-atoms] xprop ${atom} failed:`, err);
      if (isOwnWindow) this.windowId = null;
      else this.steamWindowId = null;
    }
  }

  /** Dispatch any libxcb-queued property writes to the X server. No-op
   *  when running on the xprop fallback (each xprop subprocess flushes
   *  itself). Safe to call multiple times. */
  private _flush(): void {
    this.x11?.flush();
  }

  /** Free libxcb resources. Called from index.ts on process exit so we
   *  don't leak the X connection. */
  shutdown(): void {
    this.x11?.disconnect();
    this.x11 = null;
  }
}
