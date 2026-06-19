# Overlay ↔ gamescope integration

How the Loadout overlay (Electrobun/CEF, atoms in
`apps/loadout-overlay/src/bun/native/`) coexists with Steam Big
Picture Mode and games under gamescope. Reflects the architecture as
of PR #53. Read this first if you're touching `gamescope-atoms.ts`,
`x11.ts`, or `steam-quick-access.ts`.

## Mental model

Gamescope is a Wayland compositor that hosts an Xwayland server for
its X11 clients. Steam Big Picture Mode (BPM) and most games run as
X clients inside that Xwayland. Compositing decisions — which window
draws on top, which receives input, how touches route — are driven by
**X11 atoms** that gamescope reads off windows or off the root window.

We are an X client too: a CEF window owned by Electrobun. To live above
games and BPM, we have to participate in gamescope's atom protocol.

The protocol is defined in gamescope's source, primarily
`src/steamcompmgr.cpp`. Our code is engineered against that contract,
not against any third-party project.

## Atoms gamescope reads

Verified against `gamescope/src/steamcompmgr.cpp:7772-7811`. Anything
not in this list is *not read by gamescope* — including
`STEAM_NOTIFICATION` and `GAMESCOPE_NO_FOCUS`, which earlier overlay
implementations write but which gamescope ignores.

| Atom | Where | What it controls |
|---|---|---|
| `STEAM_OVERLAY` | per-window | Marks the window as an overlay candidate (`isOverlay=true`). Gamescope picks the highest-opacity wide-enough overlay window as the active overlay layer (`g_zposOverlay`). |
| `STEAM_INPUT_FOCUS` | per-window | Routes input to this window when it's the overlay window (`overlayWindow.inputFocusMode != 0`). Steam *also* uses it on its own BPM window as an internal "am I the active overlay?" self-state signal — so we don't write to it on Steam's window. |
| `STEAM_GAME` | per-window | The Steam appID of the window's owner. We claim `OVERLAY_APP_ID = 0x534c` ("SL"). |
| `STEAM_BIGPICTURE` | per-window | Marks window as Steam-style Big-Picture. Sets `isSteamLegacyBigPicture` for focus prioritisation. |
| `_NET_WM_WINDOW_OPACITY` | per-window | 0 = invisible, 0xFFFFFFFF = fully opaque. We toggle this to show/hide. |
| `STEAM_TOUCH_CLICK_MODE` | root | `gamescope::TouchClickMode` enum: `0=Hover, 1=Left, 2=Right, 3=Middle, 4=Passthrough, 5=Disabled, 6=Trackpad`. We set 4 (Passthrough → forward to focused window) when our overlay is up. |
| `STEAM_GAMES_RUNNING` | root | CARDINAL count of running games. Steam writes inconsistently — observed unset in BPM home with a game alive. Don't rely on it as a "game running" signal. |

`GAMESCOPECTRL_BASELAYER_APPID` (root, list of baselayer appIDs in
priority order) is also part of gamescope's protocol but isn't read
by our overlay code today. Mentioned here for diagnostic completeness
— `freeze-watch.sh` dumps it.

## Lifecycle

### `prepare()` (once at boot, apps/loadout-overlay/src/bun/native/gamescope-atoms.ts)

Sets the overlay-static atoms on our window:

- `STEAM_GAME = 0x534c` (us)
- `STEAM_BIGPICTURE = 1`
- `_NET_WM_WINDOW_OPACITY = 0` (start hidden)
- `STEAM_OVERLAY = 0` and `STEAM_INPUT_FOCUS = 0` (start un-claimed)

Warm-resolves `findSteamWindow()` so the first `show()` doesn't pay a
~40ms cold xdotool/xprop survey.

### `show()` (per overlay open)

In strict order:

1. **Pre-show menu dismissal.** Connect to Steam's CDP at
   `localhost:8080`, find the `QuickAccess_uid2` page, and if it's
   visible dispatch an `Input.dispatchKeyEvent({type:"keyDown",
   key:"Escape"})` to it. Steam closes its QAM. See
   [§"The QAM problem"](#the-qam-problem) below — the trigger for our
   long-running freeze bug.
2. **Snapshot Steam BPM's atoms.** We only snapshot `STEAM_OVERLAY`
   (the only atom we manage on Steam's window).
3. **Conditional zero-pass.** If snapshot showed Steam asserting
   `STEAM_OVERLAY=1`, write `STEAM_OVERLAY=0` on Steam's window. Skip
   otherwise (common case in BPM home).
4. **Claim our atoms.** `STEAM_OVERLAY=1`, `STEAM_INPUT_FOCUS=1`,
   `_NET_WM_WINDOW_OPACITY=visible` on our window — all queued via
   libxcb, dispatched in one `xcb_flush()`. Gamescope sees the entire
   sequence as one PropertyNotify burst and runs
   `DetermineAndApplyFocus` once on the final state. No intermediate
   "two windows at STEAM_OVERLAY=1" frame → no flicker.
5. **Touch mode.** `STEAM_TOUCH_CLICK_MODE = 4` on root, with a 100ms
   gap between writing focus atoms and writing touch mode (gives
   gamescope time to settle the focus change). Snapshot the prior
   value for restore on hide.
6. **Start the reclaim watcher.** See [§Reclaim watcher](#reclaim-watcher).

### `hide()` (per overlay close)

In strict order:

1. **Stop the reclaim watcher.**
2. **Zero our atoms.** `STEAM_INPUT_FOCUS=0`, `STEAM_OVERLAY=0`,
   `_NET_WM_WINDOW_OPACITY=0` on our window.
3. **Conditional restore on Steam.** Read `STEAM_GAMES_RUNNING`:
   - **No game** → force `STEAM_OVERLAY=0` on Steam's BPM. Restoring
     `=1` would make BPM the only `isOverlay` window with no
     `focusWindow` → gamescope nulls `overlayWindow` and
     `inputFocusWindow` (steamcompmgr.cpp:4192-4209) → device-wide
     input halt.
   - **Game running** → restore the snapshot value verbatim. The
     game is a `focusWindow` candidate, so making BPM `isOverlay`
     again is fine.
   - In both regimes, never touch `STEAM_INPUT_FOCUS` or
     `STEAM_NOTIFICATION` on Steam's window — those are Steam's own
     CEF self-state signals.
4. **Flush.** All hide writes land in one PropertyNotify burst.
5. **Restore root touch mode** to whatever we snapshotted.

## Reclaim watcher

When our overlay is up and Steam's BPM later writes
`STEAM_OVERLAY=1` on itself (e.g. user pressed a Steam-side hotkey to
open the QAM while we were up), gamescope sees two overlay candidates
and the focus-fight returns. We need to counter-zero Steam's
`STEAM_OVERLAY` to stay the active overlay.

**Two implementations** in `gamescope-atoms.ts`. The path is chosen
once at `GamescopeAtoms` construction time: libxcb if `xcb_connect`
succeeds AND `OVERLAY_FORCE_XPROP` is unset; xprop otherwise.

- **Event-driven** (libxcb path, default). On show() we
  `xcb_change_window_attributes(steamWindow, EVENT_MASK,
  PropertyChangeMask)`, then drain events with the non-blocking
  `xcb_poll_for_event` on a 50ms timer. We only react when Steam
  *actually* changes its `STEAM_OVERLAY` — steady-state atom write
  traffic from us is zero. This is the same model HHD uses.
- **Polling fallback** (xprop path, when libxcb is unavailable or
  forced off via `OVERLAY_FORCE_XPROP=1`). Reads Steam's atom every
  100ms, counter-zeros if it's set.

The polling watcher's traffic profile (10 atom reads/sec idle, ~30
ops/sec under contention) appeared to overwhelm gamescope's
compositor under repeated overlay-toggle cycles in earlier testing —
the event-driven path eliminates that.

## The QAM problem

Steam's Quick Access Menu is **not a separate X window**. It's a CEF
`browser_view` popup INSIDE Steam BPM's existing X window. Live CDP
probing of Steam's `localhost:8080` shows:

```
QuickAccess_uid2  hidden=false 855x0     (when open)
QuickAccess_uid2  hidden=true  1x0       (when closed)
```

There's nothing on the X tree for us to manipulate. Steam doesn't
even reliably set `STEAM_OVERLAY=1` on BPM when the QAM is up in BPM
home — *we already know this because none of the X-level signals
flagged the trigger state during testing*.

Earlier attempts to handle the trigger via X11 (XSelectInput on
Steam's atoms, xdotool key Escape on BPM's window) all failed for the
same reason: the QAM's input handlers are inside CEF, not on an X
window we can target.

The fix in `steam-quick-access.ts`:

1. `fetch("http://localhost:8080/json/list")` — Steam's CDP target
   listing.
2. Find the page with `title === "QuickAccess_uid2"`.
3. Open a WebSocket to its `webSocketDebuggerUrl`.
4. `Runtime.evaluate("!document.hidden")` — probe visibility.
5. If visible: `Input.dispatchKeyEvent({type:"keyDown", key:"Escape",
   code:"Escape", windowsVirtualKeyCode:27})` followed by the matching
   `keyUp`. Steam's CEF page event loop processes the synthetic
   Escape and closes the QAM.

Each CDP op has an 800ms hard timeout. Failure / unreachable / page
not found are silent — best-effort, never blocks `show()`.

## Window detection

`findSteamWindow()` in `gamescope-atoms.ts` resolves Steam's BPM
window in priority order. The WM_NAME match is the *primary* path;
the scored heuristic is the fallback for desktop Steam / older shapes
where WM_NAME isn't `"Steam Big Picture Mode"`.

1. **Primary: WM_NAME exact match** against `"Steam Big Picture Mode"`
   — only the real BPM has this name.
2. **Fallback: scored heuristic.** Filter `--class steamwebhelper` and
   `--class steam` results to those with both `_NET_WM_WINDOW_TYPE`
   set *and* `STEAM_GAME = 769` (Steam's own appID). Prefer one
   asserting overlay/focus; else first qualifying.
3. Last resort: first managed candidate.

Live xprop surveys on an OneXPlayer Apex showed Steam runs ~10
windows of class `steamwebhelper` or `steam` simultaneously — the
real BPM, the renderer helper, "VRStream", `_NET_WM_WINDOW_TYPE_MENU`
popups, 10×10 utility windows. Earlier heuristics regularly latched
onto the renderer helper, missing the real BPM, and writing atoms to
a window gamescope ignored. The WM_NAME match is unambiguous.

## CEF helper crash sidestep

The Electrobun-shipped `bun Helper` binary (the wrapper that hosts
each Chromium subprocess type) crashes immediately on launch with
`*** stack smashing detected *** in main()` when invoked with
`--change-stack-guard-on-fork=enable`. That flag is set on every
utility helper Chromium spawns by default.

The most reliably reproducible offender is the
`unzip.mojom.Unzipper` utility used to unpack Chromium's variations
seed. We disable the variations system entirely in
`electrobun.config.ts`'s `chromiumFlags`:

```ts
"disable-features": "FieldTrialConfig,Variations,GlicActorUi,LensOverlay",
"disable-field-trial-config": "",
"disable-component-update": "",
```

The unzipper is never spawned, the helper never crashes. Side
benefit: a kiosk-style overlay shouldn't be participating in remote
A/B experiments anyway.

## Diagnostics

Two log files are written to the repo root, both gitignored:

- `overlay.trace` — append-only structured log of every overlay
  lifecycle event. Path is hard-coded to the dev's repo because it's
  a dev-only artefact. Survives reboots so you can diagnose freezes
  that need power-cycling.
- `freeze-watch.log` — output of the optional polling watcher
  (`freeze-watch.sh` in the repo root) that dumps gamescope root
  atoms + per-window state every 1s. Run it under `systemd-run --user
  --scope --unit=freeze-watch` so it survives shell exit.

Steam's CDP is at `http://localhost:8080`. Its DevTools target list
(`/json/list`) is human-readable JSON; you can also connect Chrome
DevTools to any of the listed pages by visiting `http://localhost:8080`
directly.

Our overlay's CDP is at `http://localhost:9222` (different port,
configured in `electrobun.config.ts`).

## Comparison with HHD

[Handheld Daemon](https://github.com/hhd-dev/hhd) (LGPL-2.1) is the
closest comparable project. Our implementation is structurally
similar in protocol — both use the same gamescope atoms, both use
event-driven `PropertyChangeMask` monitoring — but **no code is
copied**. Architectural differences:

| Aspect | HHD | Loadout |
|---|---|---|
| Language / X11 binding | Python + `python-Xlib` | TypeScript + `bun:ffi` against raw `libxcb` |
| Steam window lookup | `query_tree` walk + WM_CLASS dual match | xdotool + `WM_NAME = "Steam Big Picture Mode"` exact match |
| Atoms managed on Steam BPM | `STEAM_OVERLAY` + `STEAM_INPUT_FOCUS` + `STEAM_NOTIFICATION` | `STEAM_OVERLAY` only (Steam's other two are its self-state, we don't touch them) |
| Restore strategy on hide | Always restore from snapshot | Conditional on `STEAM_GAMES_RUNNING` |
| QAM interaction | `XTestFakeKeyEvent(Ctrl+2)` to **open** the QAM | CDP `Input.dispatchKeyEvent(Escape)` to **close** the QAM (different goal, different mechanism — HHD does not use CDP) |

The CDP-based QAM dismissal in `steam-quick-access.ts` is a technique
HHD does not use; we discovered it independently by probing Steam's
CEF target list while diagnosing the BPM-home + QAM freeze.

The atoms, magic constants (`TARGET_TOUCH = 4`, the 100ms touch-mode
settle delay), and event-driven model are gamescope's public protocol
— not LGPL-owned by HHD or anyone else.

## Testing

- `gamescope-atoms.test.ts` — 23 tests covering the atom-write
  sequencing, the window-detection heuristic, the conditional-restore
  logic, the touch-mode snapshot/restore, and the reclaim watcher's
  re-resolve behaviour. Mocks the `@loadout/exec` module.
- `steam-quick-access.test.ts` — 8 tests covering the CDP dismissal
  flow. Mocks `globalThis.fetch` and `globalThis.WebSocket`. Each test
  file passes individually; cross-file Bun test runs may show a
  module-cache quirk from the global mocks. CI should invoke files
  individually if it cares.

Run the full overlay test suite from the package directory:

```sh
cd apps/loadout-overlay
bun test src/bun/native/gamescope-atoms.test.ts
bun test src/bun/native/steam-quick-access.test.ts
```

## References

- gamescope source: <https://github.com/ValveSoftware/gamescope>
- `steamcompmgr.cpp` is the X11 / atom side; `wlserver.cpp` is the
  Wayland / input side.
- HHD overlay plugin (LGPL-2.1, for reference only):
  <https://github.com/hhd-dev/hhd/blob/main/src/hhd/plugins/overlay/x11.py>
- Chrome DevTools Protocol: <https://chromedevtools.github.io/devtools-protocol/>
