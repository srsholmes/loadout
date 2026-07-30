# Ambient overlay mode — spike protocol & findings

Ambient mode is a third overlay state: the CEF window is **visible over
the running game** with an input-passthrough atom set — no EVIOCGRAB, no
InputPlumber intercept, no Steam freeze. The game plays normally while
Loadout renders transparent, non-interactive widgets (battery / temps /
fan HUD; later toasts and plugin ambient widgets).

The state machine already models it (`overlay-state.ts`: `mode`,
`ambientDesired`, `enter-ambient` / `exit-ambient` sweep actions). What
gates the rest of the implementation is one empirical question this
spike answers per device/OS:

> Which atom arrangement composites our window above the game while
> gamescope keeps routing all input to the game?

## Why the current atoms can't just be reused

The interactive open path (`gamescope-atoms.ts show()`) sets
`STEAM_OVERLAY=1` **and** `STEAM_INPUT_FOCUS=1`, zeroes Steam's own
claim on the slot, rewrites root `STEAM_TOUCH_CLICK_MODE`, and runs a
reclaim watcher — all of which exist to *take* input. Ambient needs the
opposite: composite without input. Visibility
(`_NET_WM_WINDOW_OPACITY`) and input routing (`STEAM_INPUT_FOCUS`) are
independent atoms, so an arrangement should exist; which one works is
gamescope-build-dependent.

## Candidate arrangements

### Arrangement 1 — `GAMESCOPE_EXTERNAL_OVERLAY=1` (preferred)

The slot mangoapp (Steam's Performance HUD) uses. Gamescope composites
external-overlay windows above the game and never routes input to them
— click-through by construction, no contention with Steam's
`STEAM_OVERLAY` arbitration, no reclaim/yield watcher needed.

Risks to verify:
- The atom is unused in this repo, and prior art warns other
  gamescope-adjacent atoms (`STEAM_NOTIFICATION`, `GAMESCOPE_NO_FOCUS`)
  turned out **unregistered** in gamescope's table
  (`gamescope-atoms.ts:434`). Setting an unregistered atom is a silent
  no-op — the window just won't composite.
- Gamescope tracks a **single** external overlay window. Steam's
  Performance HUD is mangoapp using this exact slot; enabling both may
  be last-writer-wins.

### Arrangement 2 — `STEAM_OVERLAY=1` + `STEAM_INPUT_FOCUS=0` (fallback)

Claim the overlay slot for compositing but decline input focus
(steamcompmgr consults `STEAM_INPUT_FOCUS` only on the window holding
the overlay slot — `gamescope-atoms.ts:544-550`).

Risks to verify:
- **No-game halt**: an overlay window with no focus window nulls
  gamescope's `inputFocusWindow` → device-wide input halt
  (`gamescope-atoms.ts:642-656`). Ambient must be hard-gated on a
  running game; the spike must confirm what actually happens at BPM
  home.
- **Slot contention**: Steam re-asserts `STEAM_OVERLAY=1` when the
  user opens the QAM. Ambient would need a *yield* watcher (drop our
  opacity while Steam claims the slot — the inverse of `show()`'s
  reclaim watcher). The spike measures how ugly the handoff is.
- Some gamescope builds may route input to the overlay-slot window
  regardless of `STEAM_INPUT_FOCUS`.

### Fallback if CEF transparency fails

Ambient also needs per-pixel alpha from the CEF window
(`transparent: true` on the BrowserWindow, `src/bun/index.ts` — spike
separately in desktop mode first). If ARGB visuals don't survive
gamescope, plan B is a corner-sized window (resize/move) with
fractional `_NET_WM_WINDOW_OPACITY` — uglier, no per-pixel alpha, same
atom question.

## Protocol

On the handheld, in the gamescope session, **over SSH**, with a game
running:

```sh
./scripts/spike-ambient-atoms.sh status
./scripts/spike-ambient-atoms.sh try-external   # arrangement 1
# … verify checklist, record below …
./scripts/spike-ambient-atoms.sh restore
./scripts/spike-ambient-atoms.sh try-slot      # arrangement 2
# … verify checklist, record below …
./scripts/spike-ambient-atoms.sh restore        # or restart loadout-overlay
```

Checklist per arrangement (the script prints it too):

1. Overlay composites above the game (semi-transparent)?
2. Gamepad / keyboard / touch input still reaches the game?
3. Steam QAM open + close: flicker? slot stolen? input intact?
4. Exit to BPM home: input halt? (keep SSH ready to `restore`)
5. Steam Performance HUD toggled on: coexists with arrangement 1?

## Findings

> Fill in per device/OS. Ambient implementation phase A2 picks the
> arrangement from this table.

| Device / OS / gamescope ver | Arrangement | Composites | Input passthrough | QAM behavior | No-game behavior | Perf-HUD coexist | Verdict |
| --------------------------- | ----------- | ---------- | ----------------- | ------------ | ---------------- | ---------------- | ------- |
| _e.g. OXP APEX / Bazzite 42 / gamescope 3.x_ | 1: external | ? | ? | ? | ? | ? | ? |
| | 2: slot | ? | ? | ? | ? | ? | ? |

CEF transparency (desktop mode, then gamescope):

| Device / OS | `transparent: true` works | Notes |
| ----------- | ------------------------- | ----- |
| ? | ? | ? |

## Decision record

- **Chosen arrangement**: _pending spike_
- **Transparency plan**: _pending spike_
- Once decided, phase A2 implements `showAmbient()` / `hideAmbient()`
  in `gamescope-atoms.ts` writing exactly the winning atom set (and,
  for arrangement 2 only, the yield watcher).
