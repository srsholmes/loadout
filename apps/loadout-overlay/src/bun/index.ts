// Bun main process for the overlay. Owns:
//   - the single overlay BrowserWindow (hidden on boot)
//   - RPC handlers registered via Electrobun's defineRPC
//   - the evdev worker (emits NavController actions to the webview)
//   - the X11 / Gamescope atom loop (50 ms active / 500 ms idle)

// DISPLAY detection MUST happen before `electrobun/bun` is imported — the
// native wrapper dlopens libNativeWrapper.so on module load and that in
// turn triggers GTK's X11 connection via its ctor. ES module imports run
// in source order, so placing this side-effect import first guarantees
// process.env.DISPLAY is set before libNativeWrapper is even resolved.
import "./native/display-detect";

// Registers the crash handlers. MUST stay above the `electrobun/bun` import
// below: Electrobun installs an `uncaughtException` listener that natively
// force-exits, and listeners run in registration order — anything registered
// after it is dead code. See crash-init.ts.
import "./crash-init";

import { detectOverlayDisplay } from "./native/display-detect";
const DISPLAY = detectOverlayDisplay();

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — resolved at runtime once electrobun is installed.
import { BrowserWindow, BrowserView, GlobalShortcut } from "electrobun/bun";
import { existsSync, readFileSync } from "node:fs";
import type {
  ControllerShortcuts,
} from "../webview/lib/electrobun";
import {
  formatMissingToolsBanner,
  shouldBlockOverlayOpen,
} from "./lib/x11-preflight";
import { GamescopeAtoms } from "./native/gamescope-atoms";
import { detectGamescopeScreenSizeSync } from "./native/screen-size";
import {
  startInputIntercept,
  type InputInterceptHandle,
  type WakeEvent,
} from "./native/input-intercept";
import {
  startIpIntercept,
  type IpInterceptHandle,
} from "./native/ip-intercept";
import {
  startDeckHidrawWatcher,
  type DeckHidrawWatcherHandle,
} from "./native/deck-hidraw-watcher";
import {
  readPluginStorage,
  pluginStoragePath,
} from "@loadout/plugin-storage";
import { watch as fsWatch, type FSWatcher } from "node:fs";
import { dirname, basename } from "node:path";
import type { WebviewMessages } from "@loadout/types";
import {
  findSteamPid,
  suspendSteam,
  resumeSteam,
  isGameModeActive,
} from "./native/process-control";

import { trace } from "./native/trace";
import { captureFatalSync } from "@loadout/crash-report";
import { createOverlayState } from "./lib/overlay-state";
import { routeWake, isStartupWakePhantom } from "./lib/wake-routing";
import { loadPersistedShortcuts } from "./lib/persisted-shortcuts";
import { decideInputStrategy } from "./lib/input-strategy";
import { isSteamDeck } from "@loadout/devices";
import { isBindableDeckButton } from "@loadout/deck-hid";

// ---- State ------------------------------------------------------------------
// PendingFlags + the flag-lifecycle helpers live in lib/overlay-state.ts so
// the pure logic is unit-testable without booting the full main process.
//
// Desktop smoke test: start visible so the window shows immediately, no QAM
// trigger required. Gaming-mode / Gamescope path still uses `hidden: true`
// + show()/minimize() via the management loop. Hoisted up here so the
// initial overlay state agrees with the BrowserWindow's `hidden` option
// in a single place rather than via a follow-up `state.isOpen = ...`
// assignment after the BrowserWindow constructor.
const DESKTOP_SMOKE_TEST = process.env.DECK_OVERLAY_DESKTOP_DEV === "1";

const state = createOverlayState(DESKTOP_SMOKE_TEST);

// These are the fallback defaults. The persisted user config is loaded from
// disk in the startup IIFE below (loadPersistedShortcuts) and overwrites
// `current` before the input loop starts — so a saved binding survives a
// process restart instead of reverting until the user re-edits it.
//
// Guide+A and Guide+Y are reserved by Steam / InputPlumber on Bazzite
// (QAM and guide menu respectively). Even if a saved user config has them
// bound, onWake() ignores those events to avoid the focus flicker between
// our overlay and Steam's UI.
// Wrapped as a ref (B-030 step 3) so setControllerShortcuts (in
// rpc-handlers.ts) and onWake (down below) see the same mutation.
const shortcuts: { current: ControllerShortcuts } = {
  current: {
    guide_a: { type: "None" },
    guide_b: { type: "ToggleOverlay" },
    guide_x: { type: "None" },
    guide_y: { type: "None" },
  },
};

// Resolve Steam's sounds dir once — install layout doesn't change mid-session.
const STEAM_SOUNDS_CANDIDATES = (() => {
  const home = process.env.HOME ?? "";
  return [
    `${home}/.local/share/Steam/steamui/sounds`,
    `${home}/.steam/steam/steamui/sounds`,
    `${home}/.var/app/com.valvesoftware.Steam/data/Steam/steamui/sounds`,
  ];
})();
const cachedSteamSoundsPath: string | null =
  STEAM_SOUNDS_CANDIDATES.find((p) => existsSync(p)) ?? null;

const gamescopeMode = detectGamescopeMode();

function detectGamescopeMode(): boolean {
  return !!process.env.GAMESCOPE_DISPLAY || !!process.env.GAMESCOPE_WAYLAND_DISPLAY;
}

// Audit B-030 (2026-05): the orchestrator's body was split out into
// three sibling modules so this file stays a wire-up entry point:
//   - rpc-handlers.ts   — the BrowserView.defineRPC handlers factory
//   - lifecycle.ts      — the management loop + SIGINT/SIGTERM shutdown
//   - system-actions.ts — polkit-gated + service-restart RPCs
// Mutable singletons that handlers / lifecycle helpers mutate are
// wrapped as `{ current: T }` refs below so all sides share the same
// instance without an exported setter dance.
import { buildRpcHandlers } from "./rpc-handlers";
import { overlayManagementLoop, shutdown } from "./lifecycle";
import { cleanupUpdateArtifacts, reapOldGeneration } from "./lib/updater";

// ---- Singleton refs ---------------------------------------------------------
// Mutable state index.ts owns, wrapped as `{ current: T }` refs so
// rpc-handlers / lifecycle / toggleOverlay can all read and write the
// same value without an exported setter for every field. Hoisted above
// the BrowserView.defineRPC call below (which feeds them into the RPC
// factory).

// Cached on first open — stable for the session. `findSteamPid()` is
// a /proc scan; we don't want to run it on every toggle. Wrapped in
// a ref (B-030 step 2) so shutdown() in ./lifecycle can read the
// latest value without re-exporting a setter.
const steamPid: { current: number | null } = { current: null };

// Audit B-027: handle for the close-path 250ms deferred SIGCONT. Held
// so shutdown() can cancel it and so back-to-back close events
// reset rather than stack timers. Wrapped in a ref (B-030 step 2)
// alongside steamPid for the same reason.
const pendingResumeTimer: { current: ReturnType<typeof setTimeout> | null } = {
  current: null,
};

// Freeze watchdog state. The webview pings `overlayHeartbeat` ~1×/s; we stamp
// the time here. If pings stop while Steam is frozen (overlay hung) — or the
// freeze exceeds a hard cap — the watchdog force-closes the overlay and thaws
// Steam, so a hung/degraded overlay can never strand Steam. (A SIGKILL→restart
// is already covered by the startup SIGCONT; this covers a HANG, where the bun
// process is alive but the CEF renderer is wedged.)
const lastHeartbeat: { current: number } = { current: 0 };

// True once the webview has sent its FIRST real heartbeat this session.
// Only the overlayHeartbeat RPC handler sets it — never the freeze
// watchdog's "assume alive at open" seeding of lastHeartbeat above —
// so it is proof of a rendering webview, not merely an opened window.
// Gates the `.old` rollback-generation reap below.
const webviewEverAlive: { current: boolean } = { current: false };

// Input interceptor — opens every controller + keyboard + QAM device
// up-front and toggles EVIOCGRAB on the controllers when the overlay
// shows/hides. Also emits wake events (F16 / Guide+B / Ctrl+4) that
// route back into toggleOverlay(). Wrapped as a ref so the async
// startup .then() assignment below is visible to lifecycle.shutdown()
// and to the close-path `intercept.current?.release()` inside
// toggleOverlay.
const intercept: { current: InputInterceptHandle | null } = { current: null };
// Monotonic baseline for the startup phantom-wake guard (see onWake /
// isStartupWakePhantom). Seeded at module load so the guard is armed even for
// a wake that somehow arrives before the interceptors finish starting, then
// RE-ANCHORED to the moment the evdev nodes actually open (the evdev
// `onReady` below). The phantom F16 is observed ~1s after the nodes open, and
// the async startup before that (persisted-config read + IP DBus discovery)
// is variable — anchoring to node-open gives a deterministic 5s window that
// matches the observed failure timing rather than eating into it.
const inputStartedAt = { current: performance.now() };
// InputPlumber intercept-mode path — runs alongside the evdev interceptor on
// IP-managed handhelds (deck-uhid target, no grabbable evdev). On grab it sets
// InterceptMode=2 so Steam BPM is starved and nav arrives over D-Bus; on hosts
// without IP it's an inert no-op and the evdev grab above does the work. See
// native/ip-intercept.ts.
const ipIntercept: { current: IpInterceptHandle | null } = { current: null };
const deckHidraw: { current: DeckHidrawWatcherHandle | null } = { current: null };
// Picker changes flow back to the watcher via two mechanisms: (1) fs.watch
// on the plugin-storage directory fires within ~10ms of the atomic rename,
// so a user who picks a button and immediately presses it sees the new
// binding take effect; (2) a 30s heartbeat poll catches the rare case
// inotify silently misses (NFS-mounted home, container layers, etc.).
// Both handles are tracked so shutdown closes them rather than leaving them
// ticking against a stopped watcher.
const deckWakeStorageWatcher: { current: FSWatcher | null } = { current: null };
const deckWakeRefreshTimer: { current: ReturnType<typeof setInterval> | null } =
  { current: null };

// ---- Window -----------------------------------------------------------------
//
// Minimize-on-close model: one persistent BrowserWindow created hidden at
// boot. `show()` brings it up for the QAM toggle; `minimize()` iconifies
// on close. Keeps React state, WS subscriptions, and spatial-nav focus
// position across open/close cycles.
//
// Electrobun v1.16 gotchas:
//   - WindowOptions are `frame: {x,y,width,height}`, `titleBarStyle`,
//     `hidden`; no `label`, `wmClass`, `alwaysOnTop`, `skipTaskbar`,
//     `resizable`. The X11 bits (WM_CLASS, atoms) land in X11Overlay.
//   - `rpc` must be a `BrowserView.defineRPC({handlers: ...})` handle,
//     not a plain methods object — otherwise createStreams() crashes
//     with `setTransport is not a function`.
//   - TODO(stage-2): if Gamescope ignores iconify (its WM story is
//     minimal), swap minimize/show for destroy/rebuild with localStorage
//     rehydration. One-line change, not worth doing speculatively.

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — defineRPC schema is typed generically at runtime.
const rpc = BrowserView.defineRPC({
  handlers: buildRpcHandlers({
    state,
    shortcuts,
    gamescopeMode,
    cachedSteamSoundsPath,
    steamPid,
    lastHeartbeat,
    webviewEverAlive,
  }),
});

// ---- Webview-bound message schema -----------------------------------------
// `BrowserView.defineRPC` is `@ts-ignore`'d above (its schema is generic at
// runtime), so `rpc.send` arrives here untyped. Rather than scatter
// `(rpc as any).send?.(...)` + eslint-disable across every call site, we
// centralize the cast once and expose a typed surface. The `WebviewMessages`
// schema lives in `@loadout/types` so plugins and other consumers can
// import the channel surface without depending on overlay-electrobun.

type RpcSendable = { send?: (name: string, payload: unknown) => void };

function sendToWebview<K extends keyof WebviewMessages>(
  name: K,
  payload: WebviewMessages[K],
): void {
  // Errors here are non-fatal — `rpc.send` can throw mid-reload, and a
  // dropped channel-message is much better than crashing the input loop
  // or the visibility broadcaster. `.send?.` also silently drops to
  // unsubscribed channels, so calling before the webview connects is OK.
  try {
    (rpc as unknown as RpcSendable).send?.(name, payload);
  } catch (err) {
    console.warn(`[overlay] rpc.send(${name}) failed:`, err);
  }
}

// Overlay window size, decided once at startup so the window is *born at
// the right size*. Live resize is now safe: GDK_GL=disable was removed
// from the unit (it forced software rendering, and reallocating the
// software-rendered CEF surface on resize segfaulted — PR #113), so with
// GL re-enabled the user can drag-resize the desktop window freely.
//
// Desktop: 1920×1080 so the overlay opens large on a monitor (issue #108).
// The window stays resizable, so users on smaller panels can shrink it.
//
// Gaming Mode: size to the gamescope inner-X resolution so the X11 window
// maps 1:1 to the visible output. Born too large (the 1920×1080 default on
// a 1280×800 panel), gamescope scales the visual down but routes pointer
// input in unscaled window space — the cursor only reaches a corner and
// clicks land far from where they're drawn (issue #106). Fall back to the
// Deck's native 1280×800 if xrandr can't be read.
const DESKTOP_SIZE = { width: 1920, height: 1080 };
const GAMESCOPE_FALLBACK_SIZE = { width: 1280, height: 800 };
const overlaySize = gamescopeMode
  ? (detectGamescopeScreenSizeSync(DISPLAY) ?? GAMESCOPE_FALLBACK_SIZE)
  : DESKTOP_SIZE;
const OVERLAY_WIDTH = overlaySize.width;
const OVERLAY_HEIGHT = overlaySize.height;

const overlay = new BrowserWindow({
  title: "Loadout Overlay",
  frame: { x: 0, y: 0, width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT },
  titleBarStyle: "default",
  // The window is freely resizable. The drag-resize / drag-between-monitors
  // crash was an Xlib thread-safety bug in Electrobun's native wrapper
  // (OnPaint painted the OSR buffer on the CEF UI thread while
  // process_x11_events drained events on the main thread, same Display, no
  // XInitThreads) — fixed in our patched libNativeWrapper.so (electrobun
  // #426). See apps/loadout-overlay/vendor/README.md.
  transparent: false,
  hidden: !DESKTOP_SMOKE_TEST,
  url: process.env.ELECTROBUN_DEV_URL ?? "views://overlay/index.html",
  rpc,
});

// ---- QAM / F16 toggle (evdev) ----------------------------------------------
//
// Read /dev/input/event* directly and watch for KEY_F16 press events. This
// is how the Tauri overlay (input_interceptor.rs) does it, and it's the
// only path that works in both desktop X11 and Gamescope — Gamescope
// intercepts input before it reaches any X11 global grab, so
// Electrobun's GlobalShortcut can't see the QAM press under a game.
//
// Requires membership in the `input` group (so /dev/input/event* is
// readable). Doesn't EVIOCGRAB yet — that's the gaming-mode piece that
// prevents Steam from also seeing the QAM press and opening its own
// QAM menu underneath ours.

// Gamescope atom lifecycle — set STEAM_OVERLAY=1 etc on show, zero on
// hide. Without this under Gamescope, the overlay either never renders
// (no atoms) or traps all input with no way to escape (atoms never
// cleared). Uses xprop subprocess until the xcb FFI port lands.
const atoms = new GamescopeAtoms({
  display: DISPLAY,
  windowName: "Loadout Overlay",
  // Keep on-show centring in sync with the BrowserWindow frame above.
  windowWidth: OVERLAY_WIDTH,
  windowHeight: OVERLAY_HEIGHT,
  // Kill switch: set OVERLAY_FORCE_XPROP=1 to bypass the libxcb fast
  // path and use the original xprop-subprocess writes. Useful for
  // bisecting if the libxcb port is suspected of new bugs.
  forceXprop: process.env.OVERLAY_FORCE_XPROP === "1",
});

// Wait ~500 ms for Electrobun to actually create the X window, then
// run prepare() so it starts hidden even in gamescope.
setTimeout(() => {
  atoms.prepare().catch((e) => console.warn("[overlay] atoms.prepare:", e));
}, 500);

// ---- X11 CLI tool preflight -------------------------------------------------
//
// `xdotool` (and `xprop`, when libxcb is unavailable) are hard requirements
// for the gamescope path — see lib/x11-preflight.ts for why there's no
// fallback. Probed once at boot and re-probed after any refused open, so
// installing the package and pressing the button again is enough to
// recover without restarting the service.
const missingX11Tools: { current: string[] } = { current: [] };

/** /etc/os-release verbatim, for the install hint in the banner. Read once
 *  — it doesn't change under us, and the banner is on the toggle path. */
const osReleaseText: string = (() => {
  try {
    return readFileSync("/etc/os-release", "utf8");
  } catch {
    return "";
  }
})();

async function refreshMissingX11Tools(): Promise<void> {
  try {
    const missing = await atoms.probeMissingTools();
    const changed = missing.join(",") !== missingX11Tools.current.join(",");
    missingX11Tools.current = missing;
    if (missing.length > 0 && changed) {
      console.error(
        formatMissingToolsBanner({
          missingTools: missing,
          osRelease: osReleaseText,
          gameModeActive: isGameModeActive(),
        }),
      );
    } else if (missing.length === 0 && changed) {
      console.log("[overlay] X11 tool preflight: all required tools present");
    }
  } catch (err) {
    // A failed probe must not be read as "tools missing" — that would
    // refuse every open on a healthy host. Leave the last known state.
    console.warn("[overlay] X11 tool preflight failed:", err);
  }
}

// Probed after prepare() so the atoms object has settled on its libxcb-vs-
// xprop path — probeMissingTools() only demands xprop when libxcb is out.
// (The delay is belt-and-braces, not a race fix: `this.x11` is assigned in
// the GamescopeAtoms constructor, not in prepare(), so the probe can't
// observe a half-settled path. It also keeps the banner out of the noisiest
// part of boot.)
setTimeout(() => {
  void refreshMissingX11Tools();
}, 600);

// Tell the webview when the overlay opens / closes. The webview uses
// this to gate useGamepadInput so its Web Gamepad API poller doesn't
// keep dispatching synthetic keyboard events into spatial-nav while
// the overlay window is hidden (which under gamescope doesn't flip
// document.hidden on the page). Safe to call before the webview is
// connected — rpc.send silently drops to unsubscribed channels.
function broadcastOverlayVisibility(): void {
  sendToWebview("overlay-visibility", { isOpen: state.isOpen });
}

// Freeze Steam (SIGSTOP) while the overlay is open — OPT-IN (off by default).
//
// We tried this ON by default to block EXTERNAL pads + games, but freezing
// Steam buffers the pad's hidraw input while it's stopped and Steam REPLAYS the
// backlog on SIGCONT → BPM jumps after close (the "resume-burst"; the pad
// reports on-change so the buffer can't be flushed with neutral). The clean fix
// is to have IP MANAGE the external pad (the backend enables ManageAllDevices)
// so the overlay's InterceptMode DIVERTS its input before Steam ever reads it —
// nothing buffers, nothing replays. So the freeze is no longer the mechanism;
// it's kept behind an env flag as a fallback for hosts where IP can't manage a
// pad. The watchdog + startup-resume below stay wired so the flag is safe.
//
// EXTERNAL-PAD FIX: Steam reads external pads directly via hidraw (outside
// gamescope's focus routing), so neither the evdev grab nor the focus atoms
// stop Steam BPM navigating behind the overlay from an external pad. The IP
// InterceptMode=GamepadOnly we set on open only DIVERTS input if IP is actually
// grabbing the source device (ManageAllDevices) — which it currently isn't — so
// on its own it does NOT starve Steam's hidraw read. HHD hits the same wall and
// solves it by freezing Steam ("to avoid HID device dual input"). Freezing
// blocks that — but on the Steam Deck it ALSO kills the built-in controls inside
// the overlay: the Deck's built-in pad navigates via Steam Input's virtual pad
// (read by CEF's Web Gamepad API), and a frozen Steam stops emitting on it.
//
// These hosts need DIFFERENT behaviour, so the freeze is decided PER-HOST by
// decideInputStrategy (lib/input-strategy.ts), finalized after IP + Deck-hidraw
// discovery below. The rule: freeze wherever overlay nav does NOT depend on a
// live Steam process —
//   - External IP-managed pad (e.g. OXP APEX): nav arrives over IP's DBus
//     stream, independent of Steam, so freezing Steam blocks its direct hidraw
//     read (no double-capture) WITHOUT starving overlay nav → freeze ON.
//   - Steam Deck with a working hidraw watcher: nav now arrives from OUR OWN
//     hidraw read (deck-hidraw-watcher nav mode), also independent of Steam →
//     freeze ON. This is what stops BPM / Steam-Input-fed games responding
//     behind the overlay on the Deck — the historical "Deck must not freeze"
//     rule only applied while the Deck's nav source was Steam's virtual pad.
//   - Deck whose hidraw watcher failed (EACCES etc.): nav falls back to
//     reading Steam's virtual pad, which a frozen Steam stops emitting →
//     freeze OFF, exactly the legacy behavior.
// #99 made freeze a single global opt-in to save the Deck, which regressed the
// APEX (Steam captured the pad again behind the overlay). Coupling the decision
// to host type fixes both. DECK_OVERLAY_SUSPEND_STEAM=1/0 force on/off and
// override the auto policy; DECK_OVERLAY_DECK_CAPTURE=0 disables the whole
// Deck strategy (nav + grabs + freeze) as a kill switch.
const SUSPEND_STEAM_ENV = process.env.DECK_OVERLAY_SUSPEND_STEAM; // "1"=force on, "0"=force off, unset=auto
const DECK_CAPTURE_ENV = process.env.DECK_OVERLAY_DECK_CAPTURE; // "0"=disable Deck strategy
// Provisional until finalized post-discovery. A forced-on freeze applies
// immediately; auto/off start false so an open during the brief discovery
// window can't freeze the Deck.
let suspendSteamEnabled = SUSPEND_STEAM_ENV === "1";
// True once the Deck strategy is live: overlay nav comes from the hidraw
// watcher while open (toggleOverlay flips its nav mode on show/hide).
let deckNavActive = false;
/** Controller id prefix for hidraw-injected nav events (see
 *  externalNavSources in input-intercept). */
const DECK_NAV_SOURCE = "deck-hidraw";
// Deck resume-burst mitigation state (see the close path in toggleOverlay):
// whether THIS open actually SIGSTOPped Steam, and the deferred evdev
// release that stays grabbed across SIGCONT + drain so the game can't see
// Steam's replayed hidraw backlog.
let steamFrozenThisOpen = false;
let pendingReleaseTimer: ReturnType<typeof setTimeout> | null = null;
/** How long after SIGCONT the evdev grabs are held so Steam's buffered
 *  hidraw backlog (≤64 reports) drains into a grabbed virtual pad instead
 *  of the game. Chosen > TOGGLE_DEBOUNCE_MS - 250 so a reopen can overlap
 *  it — the open path cancels + flushes the deferred release. */
const DECK_RESUME_DRAIN_MS = 500;

// Startup safety net for the frozen-Steam risk: a previous overlay instance
// that crashed or was SIGKILLed *while open* could have left Steam SIGSTOPped
// (whole UI frozen, only fixable by reboot otherwise). On every startup,
// unconditionally SIGCONT Steam once. SIGCONT on a running process is a kernel
// no-op, so this is free; combined with systemd's auto-restart it bounds any
// stuck-frozen window to a single overlay restart. (HHD does NOT do this — it's
// our crash-recovery edge.)
// Unconditional: the freeze policy is now decided per-host at runtime, so a
// prior session may have frozen Steam under a different policy than this one.
// SIGCONT on a running process is a kernel no-op, so this is always safe.
{
  const bootSteamPid = findSteamPid();
  if (bootSteamPid !== null) {
    resumeSteam(bootSteamPid);
    trace("[overlay] startup: SIGCONT Steam (thaw any stale freeze)");
  }
}

// ---- Freeze watchdog -------------------------------------------------------
//
// Guarantees Steam is never left SIGSTOPped by a hung overlay. While Steam is
// frozen we poll once a second: if the webview stopped sending
// `overlayHeartbeat` pings (renderer wedged) we emergency-close the overlay and
// thaw Steam. A SIGKILL→restart is handled by the startup SIGCONT above; this
// handles the HANG case (bun alive, CEF renderer wedged) the startup path can't
// see.
//
// NOTE: there is deliberately NO time-since-open hard cap. Steam stays frozen
// the whole time the overlay is open, so any fixed ceiling would force-close a
// perfectly healthy overlay that the user is actively using (issue #102 — "the
// overlay keeps closing automatically" was a 30s cap firing on every open).
// A genuinely wedged renderer stops the heartbeat, which the staleness check
// below catches within FREEZE_HEARTBEAT_TIMEOUT_MS — that is the real safety net.
const FREEZE_HEARTBEAT_TIMEOUT_MS = 5_000; // no ping this long while frozen → hung
let freezeWatchTimer: ReturnType<typeof setInterval> | null = null;

function stopFreezeWatchdog(): void {
  if (freezeWatchTimer) clearInterval(freezeWatchTimer);
  freezeWatchTimer = null;
}

function startFreezeWatchdog(): void {
  lastHeartbeat.current = Date.now(); // assume alive at open; webview keeps it fresh
  stopFreezeWatchdog();
  freezeWatchTimer = setInterval(() => {
    if (!state.isOpen) {
      stopFreezeWatchdog();
      return;
    }
    const sinceBeat = Date.now() - lastHeartbeat.current;
    // Only force-close when the renderer has actually gone quiet — a
    // healthy overlay keeps the heartbeat fresh and stays open as long as
    // the user wants (no time-since-open cap; see note above).
    if (sinceBeat > FREEZE_HEARTBEAT_TIMEOUT_MS) {
      forceCloseOverlay(`unresponsive (sinceBeat=${sinceBeat}ms)`);
    }
  }, 1_000);
}

// Emergency teardown when the watchdog fires: thaw Steam IMMEDIATELY, drop the
// grabs/intercept, hide the window and mark closed. Mirrors the close path but
// skips the debounce/deferred-resume so a wedged overlay self-heals.
/** Returns once the gamescope atom writes have settled. Callers that are
 *  about to kill the process MUST await this (see the onDeath handler):
 *  atoms.hide() restores ROOT STEAM_TOUCH_CLICK_MODE and Steam's BPM
 *  STEAM_OVERLAY / STEAM_INPUT_FOCUS, none of which die with our window.
 *  Exiting before those writes land leaves gamescope routing touch at a
 *  window that no longer exists — the same strand shutdown() in
 *  lifecycle.ts already guards with an awaited, retried hide(). */
function forceCloseOverlay(reason: string): Promise<void> {
  console.warn(`[freeze-watchdog] ${reason} — emergency close + thaw Steam`);
  trace(`[freeze-watchdog] ${reason} — emergency close`);
  stopFreezeWatchdog();
  if (pendingResumeTimer.current !== null) {
    clearTimeout(pendingResumeTimer.current);
    pendingResumeTimer.current = null;
  }
  if (pendingReleaseTimer !== null) {
    clearTimeout(pendingReleaseTimer);
    pendingReleaseTimer = null;
  }
  if (steamPid.current === null) steamPid.current = findSteamPid();
  if (steamPid.current !== null) resumeSteam(steamPid.current);
  // Emergency path: release immediately (no resume-burst drain — a wedged
  // renderer is worse than a replayed edge) and thaw.
  intercept.current?.release();
  ipIntercept.current?.release();
  deckHidraw.current?.setNavActive(false);
  steamFrozenThisOpen = false;
  const hidden = atoms
    .hide()
    .catch((e) => console.warn("[freeze-watchdog] atoms.hide:", e));
  try {
    overlay.minimize();
  } catch (e) {
    console.warn("[freeze-watchdog] minimize:", e);
  }
  state.isOpen = false;
  broadcastOverlayVisibility();
  return hidden;
}

/** Cap on how long a process-killing path waits for forceCloseOverlay's atom
 *  writes. Bounded because the writes shell out to xprop — if that wedges we
 *  still have to exit, and systemd's ExecStopPost thaws Steam regardless. */
const ATOM_CLEAR_TIMEOUT_MS = 1000;

// Minimum gap between toggleOverlay() calls. On the OXP Apex, InputPlumber
// emits F16 on several evdev nodes simultaneously when the user presses
// the hardware QAM-adjacent button — Gaming Mouse Keyboard, Apple Magic
// Keyboard, and InputPlumber Keyboard all see the same key event.
// Without this guard, each firing onWake("QamToggle") would call
// toggleOverlay in the same tick and we'd end up open→close→open on a
// single user press — the "overlay flickering on its own" bug.
//
// 200 ms is well under any human double-tap interval while still
// collapsing the multi-device storm into one toggle.
// 600ms is long enough to collapse the 1Hz flicker observed on Apex
// (game/Konsole + Steam QAM + our overlay) while staying well below
// human rapid-tap intent. Original 200ms wasn't enough — cycles were
// ~1s apart, well past the old debounce window.
const TOGGLE_DEBOUNCE_MS = 600;
let lastToggleAt = 0;

function toggleOverlay(source: string) {
  const now = performance.now();
  if (now - lastToggleAt < TOGGLE_DEBOUNCE_MS) {
    trace(
      `[toggle] ${source} → IGNORED (debounced, ${Math.round(now - lastToggleAt)}ms since last)`,
    );
    return;
  }
  lastToggleAt = now;

  if (state.isOpen) {
    // --- Close path: hide visually first, then release input. Order
    // matches input_interceptor.rs::close_overlay — atoms go down
    // before the grab releases so Gamescope re-focuses the game
    // before any queued controller events slip through.
    stopFreezeWatchdog();
    overlay.minimize();
    atoms.hide().catch((e) => console.warn("[overlay] atoms.hide:", e));
    // Deck strategy resume-burst mitigation: while Steam was SIGSTOPped its
    // own hidraw fd kept buffering (the kernel ring keeps the FIRST ~64
    // reports after the freeze — which contain the wake button's release
    // edge and any early nav input — and drops the rest). On SIGCONT Steam
    // drains that backlog and forwards it to the virtual pad; if our evdev
    // grabs were already gone, the game would replay those stale edges on
    // every overlay close. So on a frozen-Deck close the evdev release is
    // DEFERRED until after SIGCONT + a drain window, keeping the virtual
    // pad (and built-in nodes) grabbed while the burst flushes. Steam's own
    // BPM reaction to the buffered wake release can't be blocked this way —
    // paddle wake bindings (R4/L4/…) avoid it entirely since Steam ignores
    // unmapped paddles. Non-Deck hosts keep the immediate release.
    const deferRelease = deckNavActive && steamFrozenThisOpen;
    if (!deferRelease) intercept.current?.release();
    ipIntercept.current?.release();
    // Stop decoding Deck hidraw nav. The wake-bit path stays live so the
    // wake button can re-open; the diff baseline resets on next open.
    deckHidraw.current?.setNavActive(false);
    // Always SIGCONT Steam on close, even when suspendSteamEnabled is
    // off. Users have reported Steam appearing frozen after the overlay
    // closes (menu visible but inputs ignored) — if anything left Steam
    // TASK_STOPPED earlier (a prior session with the flag on, a stuck
    // suspend, etc.) the only recovery without this is a reboot. SIGCONT
    // on a running process is a kernel no-op, so this is free.
    if (steamPid.current === null) steamPid.current = findSteamPid();
    if (steamPid.current !== null) {
      const pid = steamPid.current;
      // Audit B-027: track the handle so shutdown() can cancel a
      // pending resume; otherwise the deferred SIGCONT fires post-exit
      // and logs spurious "process exited" noise from the helper.
      if (pendingResumeTimer.current !== null) clearTimeout(pendingResumeTimer.current);
      pendingResumeTimer.current = setTimeout(() => {
        pendingResumeTimer.current = null;
        resumeSteam(pid);
        if (deferRelease) {
          if (pendingReleaseTimer !== null) clearTimeout(pendingReleaseTimer);
          pendingReleaseTimer = setTimeout(() => {
            pendingReleaseTimer = null;
            intercept.current?.release();
          }, DECK_RESUME_DRAIN_MS);
        }
      }, 250);
    } else if (deferRelease) {
      // No Steam pid found — nothing to drain; release now rather than never.
      intercept.current?.release();
    }
    steamFrozenThisOpen = false;
    state.isOpen = false;
    broadcastOverlayVisibility();
    trace(`[toggle] ${source} → MINIMIZE`);
  } else {
    // Refuse the open outright when we know we can't become visible.
    // Without xdotool there's no window id, so GamescopeAtoms.show()
    // returns on its `if (!this.windowId)` guard and gamescope is never
    // told we exist — but everything below still runs, grabbing the
    // controller and SIGSTOPping Steam. That combination is what a
    // CachyOS user reported as "Steam freezes and nothing appears".
    // Doing nothing is strictly better: Steam stays usable and the
    // journal explains why.
    if (
      shouldBlockOverlayOpen({
        missingTools: missingX11Tools.current,
        gameModeActive: isGameModeActive(),
      })
    ) {
      console.error(
        formatMissingToolsBanner({
          missingTools: missingX11Tools.current,
          osRelease: osReleaseText,
          gameModeActive: true,
        }),
      );
      trace(
        `[toggle] ${source} → REFUSED (missing ${missingX11Tools.current.join(", ")})`,
      );
      // Re-probe so installing the tool recovers on the next press rather
      // than requiring a restart of the service. Note the refusal has
      // already consumed this press's debounce slot (lastToggleAt was set
      // above), and this probe is fire-and-forget — so "install it and
      // press again" needs the next press to be >600ms later, which any
      // human retry is.
      void refreshMissingX11Tools();
      return;
    }
    // --- Open path: suspend Steam (if enabled), grab controllers,
    // raise the window, set atoms. Also matches open_overlay().
    // Freeze Steam ONLY in Gaming Mode. In gaming mode Steam reads the
    // overlay's controller/QAM inputs while it's open (so we SIGSTOP it to
    // stop input bleed-through); in desktop mode there's no game underneath
    // and the frozen `steam` process IS the client window the user is using,
    // so freezing it just wedges Steam — the bug this gate fixes. The evdev
    // grab below still runs in both modes, so the controller overlay keeps
    // working on the desktop without touching Steam.
    // A rapid close→open can land while the close path's deferred SIGCONT /
    // deferred release timers are still pending. Cancel them (this open owns
    // the freeze again), and if the evdev release was still deferred (grabs
    // held from last session), flush it synchronously so grab() below runs
    // a fresh generation with clean NavController/combo state.
    if (pendingResumeTimer.current !== null) {
      clearTimeout(pendingResumeTimer.current);
      pendingResumeTimer.current = null;
    }
    if (pendingReleaseTimer !== null) {
      clearTimeout(pendingReleaseTimer);
      pendingReleaseTimer = null;
    }
    // Release UNCONDITIONALLY, not just when a deferred release was pending.
    // A reopen inside the close path's 250ms pre-SIGCONT window cancels the
    // resume timer above while pendingReleaseTimer is still null (it's only
    // armed inside the resume callback), so keying the flush off that handle
    // would skip it — and doGrab() below would then early-return on
    // `intercepting`, reusing the previous generation's NavController and
    // combo state (stuck-held direction, or dead nav for the whole session).
    // doRelease() no-ops when not intercepting, so this is free otherwise.
    intercept.current?.release();
    if (suspendSteamEnabled && isGameModeActive()) {
      if (steamPid.current === null) steamPid.current = findSteamPid();
      if (steamPid.current !== null) {
        // Track what ACTUALLY happened: steamPid is cached for the session, so
        // after Steam restarts the SIGSTOP can fail with ESRCH/EPERM. Assuming
        // success made every later close take the deferred-release path and
        // hold the grabs ~750ms for a drain that never happens.
        steamFrozenThisOpen = suspendSteam(steamPid.current);
        if (steamFrozenThisOpen) startFreezeWatchdog();
      }
    } else if (suspendSteamEnabled) {
      trace("[toggle] desktop mode (no gamescope) — skipping Steam freeze");
    }
    intercept.current?.grab();
    ipIntercept.current?.grab();
    // Deck strategy: overlay nav comes from the hidraw stream while open.
    // AFTER intercept.grab() so the first injected events land on the new
    // grab generation, not the previous one.
    if (deckNavActive) deckHidraw.current?.setNavActive(true);
    overlay.show();
    atoms.show().catch((e) => console.warn("[overlay] atoms.show:", e));
    // Desktop mode has no gamescope to composite us above Big Picture, so
    // the atoms above are a no-op there — bring the window to the front and
    // focus it via the WM instead. Gate on the live /proc gamescope check,
    // NOT the boot-time `gamescopeMode` flag: that keys off $GAMESCOPE_DISPLAY,
    // which is stale-set to :0 in the desktop service environment and falsely
    // reports gaming mode (so the raise never ran). isGameModeActive() scans
    // /proc for a "gamescope*" comm and is true only under a real session.
    if (!isGameModeActive()) {
      atoms
        .raiseAboveDesktop()
        .catch((e) => console.warn("[overlay] atoms.raiseAboveDesktop:", e));
    }
    state.isOpen = true;
    broadcastOverlayVisibility();
    trace(`[toggle] ${source} → SHOW`);
  }
}

// Wake events from the interceptor that should open/close the overlay.
//
// QamToggle / CtrlThree / CtrlFour stay hardcoded — they're keyboard
// wake shortcuts, not part of the user-configurable ControllerShortcuts.
// F16 is the overlay's fixed internal wake key. *Which physical button*
// emits it is now user-configurable: the input-plumber plugin renders an
// InputPlumber profile mapping the chosen button (a back paddle, the
// QAM/keyboard button, etc.) → KeyF16, driven by the connected device's
// runtime Capabilities. So F16 stays a toggle here and the binding lives
// in IP, device-agnostically, rather than being hardcoded per device.
//
// Guide+A/B/X/Y go through the user-configurable `shortcuts` map so the
// UI's controller-shortcut bindings actually take effect (previously
// these were a hardcoded subset that ignored the config — Guide+X
// did nothing despite defaulting to ToggleOverlay).
function onWake(event: WakeEvent): void {
  // Drop boot-time phantom wakes that would open the overlay before the
  // graphical session is ready. On IP-managed handhelds the InputPlumber
  // virtual keyboard sometimes emits a spurious F16 (→ QamToggle) ~1s into
  // boot; acting on it opens the overlay invisibly and diverts the pad away
  // from Steam (Steam looks dead until InputPlumber is restarted). See
  // isStartupWakePhantom. Only opens are suppressed — a close always works.
  const elapsed = performance.now() - inputStartedAt.current;
  if (isStartupWakePhantom({ elapsedSinceStartMs: elapsed, isOpen: state.isOpen })) {
    trace(
      `[overlay] ignoring wake=${event} within startup grace (${Math.round(elapsed)}ms) — likely boot phantom`,
    );
    return;
  }
  // The branch-table for "which wake event does what given the current
  // shortcut config" is pure — extracted into lib/wake-routing.ts so
  // the table is unit-tested without booting the full main process.
  const action = routeWake(event, shortcuts.current);
  if (action.kind === "ignore") return;
  if (action.kind === "toggle") {
    toggleOverlay(action.reason);
    return;
  }
  // Every other kind needs the overlay open first — the webview
  // listener is always live (window is minimized, not destroyed) so
  // we could send in either order, but opening first lines up the
  // visual transition with the navigation / OSK reveal.
  if (!state.isOpen) toggleOverlay(action.reason);
  if (action.kind === "open-plugin") {
    sendToWebview("overlay-open-plugin", { pluginId: action.pluginId });
    return;
  }
  if (action.kind === "open-settings") {
    sendToWebview("overlay-open-settings", {});
    return;
  }
  if (action.kind === "open-home") {
    sendToWebview("overlay-open-home", {});
    return;
  }
  if (action.kind === "toggle-keyboard") {
    sendToWebview("overlay-toggle-keyboard", {});
    return;
  }
}

// Start the input paths. ORDER MATTERS: the InputPlumber intercept-mode path
// discovers IP composite devices first, then the Deck hidraw watcher starts,
// and only then is the strategy decided (lib/input-strategy.ts) and the evdev
// interceptor configured from it.
//
// Why: nav sources differ per host. IP hosts get nav over IP's DBus stream
// (virtual pads grab-only). A Deck with a working hidraw watcher gets nav from
// OUR hidraw read (virtual pads + built-in nodes grab-only, Steam frozen while
// open — see the freeze comment above). A Deck whose watcher failed falls back
// to reading Steam's virtual X360 pad (28de:11ff) — the only evdev nav source
// Steam Input leaves for the built-in controller, and only while a game runs.
void (async () => {
  // Seed the wake-routing engine from the persisted config BEFORE either
  // intercept starts — no wake event can arrive until they do, so the ref
  // is guaranteed populated before routeWake() first reads it. Falls back
  // to the hardcoded default (already in `shortcuts.current`) when there's
  // no saved config or it's malformed.
  const persisted = await loadPersistedShortcuts();
  if (persisted) {
    shortcuts.current = persisted;
    console.log("[overlay] seeded controller shortcuts from config", persisted);
  }

  let ipHandle: IpInterceptHandle | null = null;
  try {
    ipHandle = await startIpIntercept({
      onAction: (action) => {
        sendToWebview("overlay-action", { action });
      },
      onAxis: (axis, value) => {
        sendToWebview("overlay-scroll", { axis, value });
      },
      onWake,
      onReady: (info) =>
        console.log(
          `[overlay] ip intercept ready — ${info.composites} composite device(s)`,
        ),
    });
    ipIntercept.current = ipHandle;
    if (ipHandle.available) {
      console.log("[overlay] ip intercept ACTIVE — using InterceptMode + DBus nav");
    }
  } catch (err) {
    console.error("[overlay] ip intercept failed to start:", err);
  }

  // Deck hidraw watcher — started BEFORE the strategy decision because the
  // Deck strategy (hidraw nav + Steam freeze) is only safe when the watcher
  // actually opened; a Deck where it failed (EACCES) must keep the legacy
  // virtual-pad-nav behavior or the user is stranded with zero nav. On
  // non-Deck hosts findDeckHidrawPath() returns null and this is a no-op.
  let isDeck = false;
  try {
    isDeck = await isSteamDeck();
  } catch (err) {
    console.warn("[overlay] isSteamDeck probe failed:", err);
  }
  try {
    const initialButton = await readDeckWakeBinding();
    const handle = await startDeckHidrawWatcher({
      onWake,
      initialButton,
      // Nav events flow into the evdev interceptor's NavController. The
      // optional chain covers the watcher-before-intercept startup window;
      // nav mode can't be active before the first grab() anyway.
      onNavEvents: (events) =>
        intercept.current?.injectNavEvents(DECK_NAV_SOURCE, events),
      // Mid-session stream death (driver rebind, controller re-enumeration
      // around suspend/resume): under the Deck strategy the watcher is the
      // ONLY nav source AND the wake button, while the baked-in strategy
      // would still freeze Steam + grab everything on the next open — the
      // exact stranded-with-zero-nav state the startup gate exists to
      // prevent. The strategy can't be re-derived live (intercept options
      // are fixed at startInputIntercept), so exit and let systemd restart
      // us: startup re-probes and picks the right strategy (watcher back →
      // full Deck strategy; still dead → legacy fallback). The startup
      // unconditional SIGCONT covers a death while frozen.
      onDeath: () => {
        console.error(
          "[overlay] Deck hidraw watcher died mid-session — " +
            (deckNavActive
              ? "restarting overlay to re-derive the input strategy"
              : "Deck wake button lost until next overlay restart"),
        );
        if (deckNavActive) {
          // Steam's SIGCONT and the evdev release inside forceCloseOverlay are
          // synchronous, so they're already done when it returns. The atom
          // writes are NOT — they shell out to xprop — and exiting before they
          // land strands ROOT STEAM_TOUCH_CLICK_MODE at TOUCH_MODE_OVERLAY,
          // i.e. gamescope routing touch to a window that no longer exists.
          // Deferring the exit costs nothing: nothing else can use this
          // process, and the timeout bounds a wedged xprop.
          const settled = state.isOpen
            ? forceCloseOverlay("deck hidraw watcher died")
            : Promise.resolve();
          void Promise.race([
            settled,
            new Promise((r) => setTimeout(r, ATOM_CLEAR_TIMEOUT_MS)),
          ]).then(() => process.exit(1));
        }
      },
    });
    if (handle) {
      deckHidraw.current = handle;
      armDeckWakeBindingRefresh(handle);
    }
  } catch (err) {
    console.error("[overlay] Deck hidraw watcher failed to start:", err);
  }

  // Finalize the input strategy now that host type is known (see the
  // SUSPEND_STEAM_ENV comment above and lib/input-strategy.ts for the row
  // table). IP hosts keep their exact pre-Deck behavior.
  const strategy = decideInputStrategy({
    isDeck,
    ipAvailable: !!ipHandle?.available,
    // isAlive guards the (tiny) window where the stream died between open
    // and this decision — a dead watcher must not enable the freeze.
    deckHidrawOpened: deckHidraw.current?.isAlive() ?? false,
    suspendEnv: SUSPEND_STEAM_ENV,
    deckCaptureEnv: DECK_CAPTURE_ENV,
  });
  deckNavActive = strategy.deckNavActive;
  suspendSteamEnabled = strategy.suspendSteamEnabled;
  const readVirtualPadsForNav = strategy.readVirtualPadsForNav;
  console.log(
    `[overlay] input strategy: deckNav=${deckNavActive ? "ON" : "OFF"} ` +
      `steam-freeze=${suspendSteamEnabled ? "ON" : "OFF"} ` +
      `readVirtualPads=${readVirtualPadsForNav} ` +
      `(isDeck=${isDeck}, ipManaged=${!!ipHandle?.available}, ` +
      `hidraw=${deckHidraw.current !== null}, ` +
      `env: suspend=${SUSPEND_STEAM_ENV ?? "auto"}, deckCapture=${DECK_CAPTURE_ENV ?? "auto"})`,
  );

  try {
    const handle = await startInputIntercept({
      readVirtualPadsForNav,
      grabDeckBuiltinNodes: strategy.grabDeckBuiltinNodes,
      externalNavSources: deckNavActive ? [DECK_NAV_SOURCE] : [],
      onWake,
      onAction: (action) => {
        // Bridge to the webview. onOverlayAction() in main.tsx turns these
        // into synthetic KeyboardEvents (ArrowUp/Down/Enter/Escape/...) so
        // norigin-spatial-navigation picks them up unchanged.
        sendToWebview("overlay-action", { action });
      },
      onAxis: (axis, value) => {
        // Right-stick analog values — webview drives smooth scroll of the
        // main content area with its own rAF + momentum loop.
        sendToWebview("overlay-scroll", { axis, value });
      },
      onReady: (c) => {
        // Re-anchor the phantom-wake grace window to the moment the evdev
        // nodes are open (see inputStartedAt). onReady fires synchronously
        // after the devices are opened and before the read loop polls, so no
        // wake can be observed before this reset.
        inputStartedAt.current = performance.now();
        console.log(
          `[overlay] input intercept ready — ${c.controllers} controller(s), ${c.keyboards} keyboard(s), ${c.qam} qam device(s) (readVirtualPadsForNav=${readVirtualPadsForNav})`,
        );
      },
    });
    intercept.current = handle;
  } catch (err) {
    console.error("[overlay] input intercept failed to start:", err);
  }
})();

// Steam-Deck-native wake button + nav source: read /dev/hidrawN (the
// controller's gamepad interface) in parallel with Steam Input. Open
// multiplexes fine — the kernel hid-steam driver allows concurrent
// readers — and the bound button fires onWake("QamToggle") just like F16
// does over evdev. Started from the startup IIFE above (the strategy
// decision needs to know whether it opened); the binding-refresh plumbing
// lives in armDeckWakeBindingRefresh below.
const STORAGE_PATH = pluginStoragePath("input-plumber");
const STORAGE_DIR = dirname(STORAGE_PATH);
const STORAGE_FILENAME = basename(STORAGE_PATH);
/** Heartbeat cadence: rare safety net for inotify-silent filesystems
 *  (NFS, overlayfs corner cases). Real updates flow via fs.watch. */
const DECK_WAKE_HEARTBEAT_MS = 30_000;
/** Coalesce write-tmp + rename into a single re-read. The plugin-storage
 *  layer does atomic writes — write to `${path}.<uuid>.tmp`, then rename —
 *  which fires two inotify events; debouncing prevents the watcher seeing
 *  partial state. 50ms is comfortably above filesystem write latency. */
const DECK_WAKE_DEBOUNCE_MS = 50;

async function readDeckWakeBinding(): Promise<string | null> {
  const s = await readPluginStorage<{ wake?: { selectedRaw: string | null } }>(
    "input-plumber",
  );
  const raw = s.wake?.selectedRaw ?? null;
  // Raw is either a synthetic "deck:<Button>" string we wrote here, or an
  // InputPlumber capability string written on a non-Deck host. Only the
  // deck:* form is meaningful for the watcher — and only bindable buttons:
  // Steam/Qam are reserved system buttons (the picker no longer offers
  // them, but a binding persisted before they were blocked must not arm
  // the watcher either).
  if (raw && raw.startsWith("deck:")) {
    const name = raw.slice(5);
    return isBindableDeckButton(name) ? name : null;
  }
  return null;
}

/** Wire live wake-binding updates into a started watcher: fs.watch on the
 *  plugin-storage dir (debounced across atomic write-tmp+rename) plus a slow
 *  heartbeat for inotify-silent filesystems. Extracted from the startup IIFE
 *  so it stays a readable wire-up. */
function armDeckWakeBindingRefresh(handle: DeckHidrawWatcherHandle): void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const refresh = async (): Promise<void> => {
    try {
      const next = await readDeckWakeBinding();
      if (next !== handle.getBinding()) handle.setBinding(next);
    } catch {
      // Storage read failure is transient — try again next tick / event.
    }
  };
  const scheduleRefresh = (): void => {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void refresh();
    }, DECK_WAKE_DEBOUNCE_MS);
  };

  // fs.watch on the parent dir (not the file itself — atomic rename
  // invalidates a file-scoped watcher). Filter for any filename that
  // matches our storage or its `<storage>.<uuid>.tmp` siblings.
  try {
    deckWakeStorageWatcher.current = fsWatch(
      STORAGE_DIR,
      (_event, filename) => {
        if (!filename) return;
        if (filename === STORAGE_FILENAME || filename.startsWith(STORAGE_FILENAME + ".")) {
          scheduleRefresh();
        }
      },
    );
  } catch (err) {
    // Storage dir might not exist on first boot if no plugin has written
    // yet — heartbeat picks it up. Log so the journal records why fs.watch
    // didn't arm.
    console.warn(
      `[overlay] Deck wake-binding fs.watch failed (${err instanceof Error ? err.message : String(err)}); falling back to heartbeat only.`,
    );
  }

  // Heartbeat: covers inotify-silent filesystems (NFS, some container
  // overlays). 30s is long enough that the cost is negligible and short
  // enough that a stuck watcher self-heals within the typical session.
  deckWakeRefreshTimer.current = setInterval(refresh, DECK_WAKE_HEARTBEAT_MS);
}

// Backup shortcut for desktop dev — works whether or not evdev picks up
// the QAM button correctly. Useful when we're investigating why F16
// isn't firing. Override via DECK_OVERLAY_TOGGLE=<accelerator>.
const TOGGLE_ACCELERATOR =
  process.env.DECK_OVERLAY_TOGGLE ?? "CommandOrControl+Shift+O";
const shortcutRegistered = GlobalShortcut.register(TOGGLE_ACCELERATOR, () =>
  toggleOverlay(TOGGLE_ACCELERATOR),
);
if (!shortcutRegistered) {
  console.warn(
    `[overlay] failed to register ${TOGGLE_ACCELERATOR} global shortcut — ` +
      "another process may already have it grabbed.",
  );
}

// ---- X11 / Gamescope loop + shutdown ---------------------------------------
// Audit B-030 step 2 (2026-05): the management loop and the
// SIGINT/SIGTERM-driven shutdown ladder now live in ./lifecycle so the
// orchestrator stays a wire-up file. Mutable singletons (steamPid,
// pendingResumeTimer, managementLoopRunning) are passed as `{ current: T }`
// refs so the lifecycle helpers and the in-file toggleOverlay see the
// same value without a setter dance.
const managementLoopRunning: { current: boolean } = { current: true };

// Reap self-update leftovers (abandoned `.staging`, downloaded
// tarball) and restore from `.old` if a mid-swap crash left the live
// tree missing. The `.old` rollback generation itself is deliberately
// KEPT at this point: "the bun process started" doesn't prove the new
// overlay works — CEF can still crash after this line. It's reaped
// below only once the webview's first heartbeat arrives (a rendering
// webview = a genuinely working overlay), which is the real end of
// the one-generation rollback window. If the new overlay never gets
// healthy, `.old` survives as the manual recovery copy.
void cleanupUpdateArtifacts({ keepOldGeneration: true });
const oldGenReaper = setInterval(() => {
  // Gate on webviewEverAlive, NOT lastHeartbeat: the freeze watchdog
  // seeds lastHeartbeat on every overlay OPEN ("assume alive"), so a
  // Guide-press on a crash-looping post-update CEF would otherwise
  // reap the rollback copy in the exact case it exists for.
  if (webviewEverAlive.current) {
    clearInterval(oldGenReaper);
    void reapOldGeneration();
  }
}, 5000);
(oldGenReaper as unknown as { unref?: () => void }).unref?.();

overlayManagementLoop({
  state,
  running: managementLoopRunning,
  toggleOverlay,
}).catch((e) => {
  console.error("[overlay] management loop crashed:", e);
  // Spooled synchronously, not sent. `process.exit(1)` on the next line kills
  // any in-flight request, so an async send here would never arrive — the
  // report is written to disk and shipped by the next start instead.
  captureFatalSync(e);
  process.exit(1);
});

function runShutdown(): Promise<void> {
  if (deckWakeRefreshTimer.current !== null) {
    clearInterval(deckWakeRefreshTimer.current);
    deckWakeRefreshTimer.current = null;
  }
  if (deckWakeStorageWatcher.current !== null) {
    try {
      deckWakeStorageWatcher.current.close();
    } catch {
      /* swallow — best-effort on shutdown */
    }
    deckWakeStorageWatcher.current = null;
  }
  return shutdown({
    running: managementLoopRunning,
    pendingResumeTimer,
    steamPid,
    atoms,
    intercept,
    ipIntercept,
    deckHidraw,
    globalShortcut: GlobalShortcut,
  });
}
process.on("SIGINT", runShutdown);
process.on("SIGTERM", runShutdown);
// Global uncaughtException / unhandledRejection handlers live in
// ./crash-init, imported at the top of this file — they must be registered
// before `electrobun/bun` installs its own force-exiting listener.
