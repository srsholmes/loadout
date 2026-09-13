# Running Loadout alongside Handheld Daemon (HHD) — Anatase

How Loadout could work on a handheld where **Handheld Daemon** owns the
controller, instead of **InputPlumber**. Design record only — nothing here
is implemented yet. Read this before touching `plugins/input-plumber/`,
`apps/loadout-overlay/src/bun/native/input-intercept.ts`, or
`scripts/install.sh`'s `phase2_inputplumber`.

> TL;DR — Loadout's wake trigger is *"user button → `KEY_F16` → overlay"*,
> and HHD **cannot emit an arbitrary key**: its bindable actions are a fixed
> seven-item list with no keyboard-output option. So the existing contract
> isn't degraded under HHD, it's unreachable. What HHD *does* offer is
> **`HHD_OVERLAY`**, an env var naming any executable to use as its
> gamescope overlay in place of `hhd-ui`. Registering Loadout there hands us
> the wake signal, the pad grab, key repeat, the Steam freeze and the
> gamescope atoms for free — at the cost of displacing `hhd-ui`. That's the
> recommended integration; everything else in this document is either the
> safety work that has to land first, or the fallback for users who won't
> give up `hhd-ui`.

## Why this matters now: Anatase

[Anatase](https://github.com/anatase-org/anatase) is a second-generation
immutable image from the people behind Bazzite — one image for handhelds,
desktops, laptops and HTPCs. It ships **HHD**, and HHD's own README points
users at Anatase as the distro carrying its latest tested commit.

HHD and InputPlumber are mutually exclusive in practice:

- HHD `EVIOCGRAB`s the physical pad and re-emits an emulated DualSense plus
  a "shortcuts" uinput keyboard. InputPlumber wants to do the same job.
- The upstream InputPlumber COPR build literally declares `Conflicts: hhd`,
  which is why `plugins/input-plumber/scripts/install-inputplumber.sh:9-11`
  skips the `rpm-ostree` layering path entirely.

So on Anatase, Loadout's three supported distros' assumptions
(`docs/os-compatibility.md`: SteamOS, Bazzite, CachyOS — all InputPlumber
hosts, or Steam-Input hosts we special-case) do not hold.

## What does NOT work under HHD, and why

| Loadout wake path | Under HHD | Why |
|---|---|---|
| **`KEY_F16`** from an InputPlumber-rendered profile (`plugins/input-plumber/lib/profile.ts`, `WAKE_KEY = "KeyF16"`) | ❌ **Impossible** | HHD's user-bindable shortcut actions are a closed list in `src/hhd/plugins/overlay/shortcuts.yml`: `disabled`, `keyboard` (Steam OSK), `steam_qam`, `steam_expanded`, `hhd_qam`, `hhd_expanded`, `tdp_cycle`. There is no "emit key X" action, and no user-editable keymap that could add one. |
| **`Ctrl+3` / `Ctrl+4`** (`input-intercept.ts::processShortcut`) | ⚠️ **Collides** | HHD binds `keyboard.ctrl_3 → hhd_expanded` and `keyboard.ctrl_4 → hhd_qam` **by default** (same file). Pressing either opens HHD's overlay as well as ours. |
| **Guide+X / Guide+B chords** (`input-intercept.ts::processCombo`) | ❓ **Unverified** | HHD owns the physical pad and runs its own combo layer (`controller.xbox_b`, `xbox_x`, … in `shortcuts.yml`). Whether a Guide chord survives onto HHD's emulated DualSense — and whether Steam sees it too — needs a device. |
| **Installing InputPlumber to get F16 back** | ❌ **Actively harmful** | Two daemons grabbing the same pad. This is the documented HHD-vs-IP failure mode: HHD grabs the pad but applies the wrong button map. |

The throughline mirrors `docs/steamos-deck-controller-overlay-trigger.md`:
only a **real evdev event** can reach the overlay in-game, and under HHD
there is no way to make one appear on demand.

## Conflict matrix

Everywhere Loadout and HHD reach for the same resource.

| Resource | Loadout | HHD | Verdict |
|---|---|---|---|
| Physical pad evdev | `EVIOCGRAB` while the overlay is open (`input-intercept.ts`) | `EVIOCGRAB` permanently; re-emits an emulated DualSense | HHD wins — Loadout must read HHD's *virtual* pad, or not read evdev at all |
| Wake key | `KEY_F16`, `Ctrl+3`, `Ctrl+4`, Guide chords | consumes `Ctrl+3`/`Ctrl+4`; cannot emit F16 | Direct collision, see above |
| Gamescope atoms | `GamescopeAtoms` writes `STEAM_OVERLAY`, `STEAM_INPUT_FOCUS`, `STEAM_GAME`, `STEAM_BIGPICTURE`, `_NET_WM_WINDOW_OPACITY`, root `STEAM_TOUCH_CLICK_MODE` | `src/hhd/plugins/overlay/x11.py` writes the same set, with its own snapshot/restore of Steam's values | Two writers with independent caches of Steam's state. Safe only while never open simultaneously — and neither knows about the other |
| Steam freeze | `suspendSteam()` / `resumeSteam()` (SIGSTOP/SIGCONT), freeze watchdog, `ExecStopPost` thaw | `freeze_steam(True)` around interception | Nested SIGSTOP/SIGCONT between two unrelated supervisors. A thaw from one while the other believes Steam frozen is exactly the "device looks dead" class of bug |
| InputPlumber install | `scripts/install.sh::phase2_inputplumber` offers to install it | conflicts with it | See the installer bug below |
| **TDP / fan / RGB** | `plugins/tdp-control` (ryzenadj + `platform_profile`), `plugins/fan-control` (`ectool`), `plugins/rgb-control` (OXP HID / OpenRGB) | HHD is a *vendor interface replacement* — it owns exactly these knobs | Two writers on the same hardware. **Live on Anatase today, independent of anything to do with the overlay.** |

### The installer bug, today

`scripts/install.sh:1668-1675`:

```sh
if command -v inputplumber >/dev/null 2>&1 \
   && systemctl is-active --quiet inputplumber.service 2>/dev/null \
   && ! systemctl list-units … 'hhd*' … | grep -q hhd; then
    success "InputPlumber is already installed, active, and uncontested. Skipping."
    return
fi
```

The HHD test is a **negation inside the skip condition**. A live HHD makes
the installer fall *through* to the install prompt, not skip it. On Anatase
(HHD live, InputPlumber absent) `phase2_inputplumber` therefore offers to
install InputPlumber; `install-inputplumber.sh` skips the `rpm-ostree` path
but still runs the **tarball fallback**, which stages a binary under
`/var/lib/inputplumber`, synthesises `/etc/systemd/system/inputplumber.service`
and `systemctl enable --now`s it — standing InputPlumber up next to a live
HHD, the precise conflict the comment block above it claims is prevented.

The surrounding comment is accurate about intent ("that early exit … keeps
IP from being enabled alongside a live HHD") but the early exit it describes
only fires when IP is *already active*, which on Anatase it is not.

### The dead HHD branch in the wizard

`apps/loadout-overlay/src/overlay/components/WelcomeScreen.tsx:659-828`
defines `HhdStatus { installed, active, units }`, an `hhdConflict` flag, a
*"Disable conflicting HHD"* button and a *"Running — conflicts with IP"*
chip. None of it renders: `status.hhd` is optional and
`plugins/input-plumber/lib/install.ts::getStatus()` never sets it (the
field's own comment says so).

It is also **wrong**. The button routes to `startInstall` on the stated
premise that *"the install script is what stops/masks HHD"*, while
`scripts/install.sh:1646` states plainly:

> It does NOT touch HHD. This comment used to claim it "stops + masks any
> conflicting `hhd*.service` units"; nothing here has ever done that.

Reviving that branch as-written would promise the user something no code
does. Either rewire it to a real detector and a real action, or delete it.

## The `HHD_OVERLAY` protocol

This is the integration seam, and it is a deliberate extension point, not a
hack — HHD reads it first, ahead of its own binaries.

`src/hhd/plugins/overlay/overlay.py::find_overlay_exe` resolves, in order:

1. `$HHD_OVERLAY`, if the path exists;
2. `~/.local/bin/{hhd-ui.AppImage,hhd-ui-dbg,hhd-ui}`;
3. the same names on `PATH`.

It then spawns it (`inject_overlay`):

```python
subprocess.Popen(
    [fn],
    env={"HOME": …, "DISPLAY": …, "STEAM_OVERLAY": "1"},
    text=True, stdin=PIPE, stdout=PIPE, stderr=PIPE,
    start_new_session=True, user=uid, group=gid,
)
```

and separately calls `fn --version` with a **5 s timeout**
(`get_overlay_version`).

Note what is *absent* from that env: no `PATH`, no `XDG_*`, no
`XDG_RUNTIME_DIR`, no `LOADOUT_PORT`, no `DBUS_SESSION_BUS_ADDRESS`. A
desktop-mode variant (`launch_overlay_de`) adds `XAUTHORITY` and
`HHD_MANAGED=1` instead of `STEAM_OVERLAY`.

### Line protocol

`src/hhd/plugins/overlay/base.py` + `overlay/controllers.py::OverlayWriter`.

**HHD → overlay (stdin):**

| Line | Meaning |
|---|---|
| `cmd:open_qam` | open the side menu |
| `cmd:open_qam_if_closed` | open only if currently closed |
| `cmd:open_expanded` | open the full menu |
| `cmd:open_notification` | show a notification |
| `cmd:close` | close gracefully |
| `cmd:close_now` | terminate |
| `cmd:mute` | sent at startup when HHD will do the interception itself |
| `action:<code>` | navigation — `up down left right a b x y rb lb mode select`, plus `action:x_up` |

**Overlay → HHD (stdout):**

| Line | Meaning |
|---|---|
| `stat:closed` | UI hidden — HHD hides the window and releases its grab |
| `stat:qam` / `stat:expanded` / `stat:notification` | which view is up |
| `grab:enable` / `grab:disable` | ask HHD to take / release input focus |

stderr is logged by HHD, prefixed `"UI: "`. **stdout is the protocol
channel** — a stray `console.log` corrupts it.

### The semantics already match `NavController`

HHD's `OverlayWriter` does its own key repeat (`REPEAT_INITIAL` /
`REPEAT_INTERVAL`), its own stick deadzone (`AXIS_LIMIT`), fires `b` on
**release only**, and splits `x` into `x` / `x_up`. That is, line for line,
what `apps/loadout-overlay/src/bun/native/nav-controller.ts` implements
(`REPEAT_DELAY_MS = 500`, `REPEAT_RATE_MS = 200`, `AXIS_DEADZONE = 0.5`,
`case "b": if (!isPress)`, `case "x": emit(isPress ? "x" : "x_up")`).

`action:*` therefore maps onto `NavAction` essentially one-to-one, and the
mapping is a pure function — trivially unit-testable without HHD.

### The `WM_CLASS` requirement

`loop_manage_overlay` finds the overlay window via
`find_hhd(display)` → `find_win(display, ["dev.hhd.hhd-ui"])` or
`["dev-hhd-hhd-ui"]`, matched against `WM_CLASS` over
`root.query_tree().children`. It polls for `STARTUP_MAX_DELAY = 10 s`, and
if the window never appears:

```
logger.error("UI Window not found, exitting overlay.")
break
```

When it *is* found, **HHD** runs `prepare_hhd` / `show_hhd` / `hide_hhd` —
writing `STEAM_GAME`, `STEAM_BIGPICTURE`, `_NET_WM_WINDOW_OPACITY`,
`STEAM_NOTIFICATION`, `GAMESCOPE_NO_FOCUS`, `STEAM_INPUT_FOCUS`,
`STEAM_OVERLAY`, and caching/restoring Steam's prior values. That is the job
`GamescopeAtoms` does today.

Loadout can satisfy the class requirement: the overlay already rewrites its
own `WM_CLASS` after the window exists —
`native/gamescope-atoms.ts:470 setWmClass(instance, cls)`, libxcb
`setString(win, "WM_CLASS", "inst\0Class\0")` with an
`xdotool set_window --classname --class` fallback — currently called as
`setWmClass("loadout", "Loadout")` from `prepare()`.

### HHD's other surfaces

- **REST API** — `127.0.0.1:5335`, token at `~/.config/hhd/token`,
  `Authorization: Bearer <token>`. `GET /api/v1/settings` (the settings
  schema tree), `GET | POST /api/v1/state` (values; POST merges),
  `GET /api/v1/version`, plus `profile/{list,get,set,apply,del}`.
  Loadout can read *and rewrite* HHD's configuration, including its shortcut
  bindings, programmatically.
- **Units** — `hhd@<user>.service` (system unit, root,
  `ExecStart=/usr/bin/hhd --user %i`,
  `SELinuxContext=system_u:unconfined_r:unconfined_t:s0`), or
  `hhd_local@<user>.service` for pip installs
  (`~/.local/share/hhd/venv/bin/hhd`). Injecting `HHD_OVERLAY` therefore
  means a drop-in under `/etc/systemd/system/hhd@.service.d/`.

## Phase A — detect, and stop fighting

Independently shippable, no new input path, and it is the phase that stops
Loadout from making an Anatase box worse. Everything here is a bug fix.

**A1. An HHD detector.** Signals, cheapest first:

- `systemctl is-active hhd@$USER.service` / `hhd_local@$USER.service`
- `GET http://127.0.0.1:5335/api/v1/version` (no token needed)
- `~/.config/hhd/token` exists
- HHD's emulated devices in `/proc/bus/input/devices`

Where the overlay main process needs this before the backend is up, follow
the dependency-free-read precedent in
`apps/loadout-overlay/src/bun/lib/persisted-shortcuts.ts` (reads
`~/.config/loadout/config.json` directly: "no loader port, no auth token,
and it works even if the backend is still coming up"). Where the backend
needs it, `@loadout/exec` + `fetch` is fine.

**A2. Fix `phase2_inputplumber`.** Invert the HHD test: a live `hhd*` unit
should skip the phase outright with an explanation, never fall through to
the install prompt. Mirror it in `install-inputplumber.sh::detect_installed`
so the plugin-triggered path is safe too — today only "IP already on disk"
short-circuits it.

**A3. Honest UI.** `plugins/input-plumber/lib/install.ts::getStatus()` and
`plugins/input-plumber/shared.ts::InstallStatus` gain an `hhd` field (neither
has one today). `plugins/input-plumber/app.tsx:529`'s *"InputPlumber isn't
running. Install or start it above…"* becomes an HHD-aware message that does
**not** invite the user to install InputPlumber. Then either rewire or delete
the dead `WelcomeScreen.tsx` branch — see above.

**A4. Hardware-knob deference.** Decide and document what
`plugins/tdp-control`, `plugins/fan-control` and `plugins/rgb-control` do
when HHD is active: defer (hide the controls), proxy (write through
`POST /api/v1/state`), or warn. This is a Phase A item, not a Phase C one —
it bites on Anatase whether or not the overlay integration ever ships.

**A5. Triage.** `scripts/loadout-doctor.sh` gains an HHD section: both unit
names and states, `hhd --version`, API reachability, the `state.yml`
shortcut bindings, and HHD's emulated device names from
`/proc/bus/input/devices`. Per `CLAUDE.md`, the doctor output is what makes
a report triageable; an Anatase report today would look like "the wake
button does nothing" with nothing in the dump to explain it.

**A6. Docs.** Add Anatase to `docs/os-compatibility.md`; note in
`docs/dependencies.md` that `inputplumber` is not merely optional but
*contraindicated* on an HHD host.

## Phase B — Loadout as HHD's overlay (recommended)

Register Loadout at `HHD_OVERLAY` and let HHD drive it. HHD then owns the
wake gesture, the pad grab, key repeat, the Steam freeze and the gamescope
atoms — i.e. every conflict row in the matrix above collapses, because
there is only one actor left.

**B1. New backend module.** `apps/loadout-overlay/src/bun/native/hhd-overlay.ts`,
following the established backend shape (`native/ip-intercept.ts`,
`native/deck-hidraw-watcher.ts`): `startHhdOverlay(opts) → HhdOverlayHandle`.
It reads `cmd:` / `action:` lines from stdin, writes `stat:` / `grab:` to
stdout, and feeds a `NavController` exactly as `ip-intercept.ts` does.

Extract these as pure, per the repo's convention
(`lib/wake-routing.ts`, `lib/input-strategy.ts`, `ip-intercept.ts`'s
`parseInputEventLine` / `uiToInputEvent`):

```ts
export function parseHhdLine(line: string): HhdLine | null;   // cmd | action | unknown
export function hhdActionToNavAction(code: string): NavAction | null;
export function hhdCommandToWake(cmd: HhdCommand): WakeAction | null;
```

with a sibling `hhd-overlay.test.ts`. No HHD required to test any of it.

**B2. Redirect stdout.** stdout is the protocol channel. In this mode every
`console.log` in the main process must go to stderr (HHD logs stderr for us,
prefixed `"UI: "`). This is a one-line shim at startup but a silent,
total-corruption bug if missed — call it out in the module header.

**B3. Turn off what HHD now owns.** evdev intercept + grabbing, IP
intercept, and `suspendSteam()`/`resumeSteam()`. Thread it through
`lib/input-strategy.ts::decideInputStrategy` by adding an input rather than
branching at call sites — it is pure and already fully unit-tested
(`lib/input-strategy.test.ts` covers every row of the host matrix). Note the
existing constraint: **strategy is baked at startup**, and the Deck watcher's
`onDeath` handler `process.exit(1)`s rather than re-deriving. A mode switch
means a service restart (`system-actions.ts::restartApp()` already exists for
exactly this).

**B4. Atoms — delegate to HHD.** Recommended: call
`setWmClass("dev.hhd.hhd-ui", "dev.hhd.hhd-ui")` in this mode and skip
`GamescopeAtoms.show()` / `.hide()`, letting HHD's `show_hhd` / `hide_hhd`
drive the window. `prepare()`'s other work (window discovery, sizing) still
runs.

*Rejected alternative:* keep Loadout's atom code and skip the class rename.
HHD then never finds a window, logs *"UI Window not found, exitting
overlay"* after 10 s, tears the loop down and retries on the next press —
leaving HHD's interception state and Steam freeze in an undefined state
while Loadout's own atoms fight HHD's cached snapshot of Steam's. Worse on
every axis than spoofing one string.

*Open question:* HHD's window search is `find_win(...)[0]` — first match
wins. If `hhd-ui` is also installed and somehow running, two windows claim
the class. Needs a device to characterise.

**B5. Launch path.** HHD spawns the process itself, with the minimal env
above and `start_new_session=True`. Two sub-problems:

- `fn --version` must answer in well under 5 s **without booting CEF**. A
  small launcher shim, or an early `--version` branch in the existing
  launcher before Electrobun is imported. Note `index.ts`'s hard ordering
  constraint: the `./native/display-detect` side-effect import must precede
  `electrobun/bun`, because the native wrapper dlopens `libNativeWrapper.so`
  on module load. A `--version` fast path has to sit ahead of both.
- The missing env. `loadout-overlay.service`'s `ExecStart` currently does
  substantial `DISPLAY`/`GAMESCOPE_DISPLAY` resolution before exec'ing the
  launcher; under HHD, `DISPLAY` arrives pre-resolved but everything else is
  gone.

**B6. Lifecycle.** `loadout-overlay.service` is
`UpheldBy=graphical-session.target` — it will re-launch a *second* overlay
within seconds of any stop (the unit file's own comment warns that
`systemctl --user stop` is reverted, and `mask --now` is the real off
switch). Enabling HHD mode has to mask or disable the user unit, and
disabling it has to restore it. The unit's `ExecStopPost` thaw
(`pkill -CONT -x steam`) and the 5 s heartbeat freeze watchdog both assume
Loadout owns the freeze; under HHD it does not, and thawing Steam out from
under HHD's interception is its own failure mode.

**B7. Opt-in and revert.** The root backend writes
`/etc/systemd/system/hhd@.service.d/10-loadout-overlay.conf`:

```ini
[Service]
Environment=HHD_OVERLAY=/home/<user>/.local/share/loadout-overlay/bin/launcher
```

then `systemctl daemon-reload` + restarts the HHD unit.
`scripts/uninstall.sh` must remove it, following the marker-gated
only-remove-what-we-wrote pattern already used by `revert_inputplumber()`
(which only deletes `/etc/inputplumber/devices.d/50-steam_deck.yaml` when it
contains `"Generated by Loadout"`).

**Risk to hold in mind throughout.** Loadout's own history is the warning:
an overlay that grabs the pad and freezes Steam while showing no UI is
indistinguishable from a dead device (`docs/overlay-gamescope-integration.md`,
"Hard dependency: xdotool"). Every failure path in this phase — HHD can't
find the window, the protocol desyncs, the shim crashes — must fail *open*,
leaving the pad ungrabbed and Steam running, exactly as
`lib/x11-preflight.ts` declines to open rather than half-open.

## Phase C — `plugins/hhd/`, the `hhd-ui` replacement

Taking `HHD_OVERLAY` displaces `hhd-ui`. Scope the gap accurately: Loadout
already covers TDP, fan and RGB natively, so what's actually lost is the
**HHD-specific** surface — controller emulation mode (x-input vs DS5), gyro,
back-button and shortcut bindings, and per-device vendor features.

A `plugins/hhd/` renders HHD's own settings tree from
`GET /api/v1/settings` + `GET | POST /api/v1/state`:

- **Minimum viable:** emulation mode + the shortcut bindings — the things
  nothing else in Loadout can reach, and the ones a user must be able to
  change to undo Phase B.
- **Full:** a generic renderer over HHD's settings schema (it is a typed
  tree of containers / multiples / bools / modes — see `shortcuts.yml` for
  the shape), which would cover new HHD features without Loadout changes.
- **Token handling:** read `~/.config/hhd/token` as the user, never log it,
  never send it anywhere but `127.0.0.1:5335`.

The `tdp-control` / `fan-control` / `rgb-control` deference question is
A4, not C — it is live before any of this ships.

## Phase D — fallback coexistence mode

For users who won't give up `hhd-ui`. Be honest: this is the weak path, and
every wake option is compromised.

| Option | Status |
|---|---|
| `KEY_F16` | **Source-proven impossible.** No HHD action emits a key. |
| `Ctrl+3` / `Ctrl+4` | Possible **only** if Loadout rewrites HHD's `keyboard.ctrl_3` / `ctrl_4` bindings to `disabled` via `POST /api/v1/state` — which silently takes HHD's own menus away from those keys. And on a handheld with no keyboard, nothing emits them anyway. |
| Guide chords off HHD's emulated DualSense | **Hardware-pending.** Plausible — HHD's pad is an ordinary uinput evdev node and `input-intercept.ts` would classify it as a controller — but HHD runs its own combo layer over the same buttons, and `wake-routing.ts` already treats `GuideA`/`GuideY` as reserved. |
| HHD's `steam_qam` → `Ctrl+1` from `QamHandlerKeyboard`'s uinput device | Readable, but it also opens Steam's QAM. Not a usable trigger. |
| Reading the device's hidraw directly, as on the Deck | Per-device work, and HHD hits the same external-pad hidraw wall Loadout does (`index.ts:409`). Not a general answer. |

Recommendation: ship Phase A, offer Phase B as the supported path, and
document Phase D as "you can run both, but the overlay will only open from a
keyboard" rather than building it.

## Open questions needing hardware

Separated deliberately from everything above, which is provable from source.

1. Do Guide chords reach HHD's emulated DualSense, and does Steam see them
   too?
2. Does `hhd-ui` coexisting break `find_win`'s first-match window lookup?
3. What does HHD's interception state look like if our overlay process dies
   mid-session — does the pad come back?
4. Does Anatase ship InputPlumber at all, active or dormant? The detector's
   branches depend on the answer.
5. Does `SELinuxContext=…unconfined_t` on the HHD unit carry to a spawned
   Electrobun/CEF child cleanly on a bootc image?
6. Nested SIGSTOP/SIGCONT: if HHD freezes Steam and Loadout's
   `ExecStopPost` thaws it, what does Steam actually do?

## References

- HHD (LGPL-2.1): <https://github.com/hhd-dev/hhd> —
  `src/hhd/plugins/overlay/{overlay.py,base.py,controllers.py,x11.py,shortcuts.yml}`,
  `docs/http.md`, `usr/lib/systemd/system/hhd@.service`
- Anatase: <https://github.com/anatase-org/anatase>
- `docs/steamos-deck-controller-overlay-trigger.md` — the F16 wake contract
  this document explains we cannot honour under HHD
- `docs/overlay-gamescope-integration.md` — the atom protocol, and the
  existing HHD comparison table

As in `docs/overlay-gamescope-integration.md`: HHD is LGPL-2.1, our
implementation is structurally similar in protocol because both target
gamescope's public contract, and **no code is copied**. This document
describes HHD's protocol and extension points so we can interoperate with
them.
