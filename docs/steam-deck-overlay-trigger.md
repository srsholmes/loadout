# Toggling the overlay from a controller button on the Steam Deck (SteamOS)

This documents how to open/toggle the Electrobun overlay from a **controller
button on a Steam Deck running SteamOS**, why the obvious approaches don't work
there, and the validated recipe (proven working: **bottom-right back paddle →
overlay toggles**).

> TL;DR — On SteamOS the only signal that can reach the overlay in-game is a
> **real evdev key event**. We get one by having **InputPlumber** map a back
> paddle → **F16** (the overlay's QAM wake key), loaded **at boot**, plus a
> **permission fix** so the overlay can actually open InputPlumber's virtual
> keyboard. This is the same mechanism the OneXPlayer APEX uses (the apex-fixes
> plugin, not yet ported into Loadout — see the original `linux-gaming-plugin-manager`
> repo for the reference shape), adapted to the Deck.

## Background: how the overlay receives a "wake"

The overlay (`packages/overlay-electrobun`) opens on:

- **`KEY_F16`** read from any evdev device that advertises it ("QAM" wake) —
  `input-intercept.ts` (`QAM_KEY_CODES = [KEY_F16]`), and
- **`Ctrl+3` / `Ctrl+4`** on keyboard-class devices, and
- **`Ctrl+Shift+O`** via an Electrobun X11 GlobalShortcut.

The key constraint: the overlay reads **evdev** (`/dev/input/event*`). It only
reacts to **real** kernel input events.

## What does NOT work on SteamOS (and why)

| Approach | Result | Why |
|----------|--------|-----|
| Steam Input **chord** → inject a key (e.g. `chord_neptune.vdf` `key_press`) | ❌ | Steam injects chord keystrokes as **synthetic X events to the focused window** (XTEST-style), *not* evdev. Confirmed by monitoring all 21 evdev nodes (0 events) while a chord typed into the focused terminal. Also: Steam **rewrites `chord_neptune.vdf` on shutdown**, reverting edits. |
| Steam **frontend** via CDP (`SteamClient.Input`) | ❌ | `RegisterForControllerInputMessages` delivers nothing passively; only `RegisterForControllerCommandMessages` fires, and **only for the Steam button** (`eAction 65`). Regular buttons/paddles/combos are invisible to the frontend in-game. |
| `xdotool`/synthetic `Ctrl+Shift+O` | ❌ in-game | Goes to the focused window, not the overlay's grab, under gamescope. |
| **`Guide+X` / `Guide+B`** controller combo (the overlay's `ControllerShortcuts`) | ❌ on Deck | Works on **Bazzite** because the overlay reads the controller's evdev directly and there's no competing chord layer. On the Deck the Steam button is owned by Steam and its chords are live (`Guide+X`=keyboard, `Guide+A`=record…), so they collide / never reach the overlay. |

The throughline: **anything injected at the X layer, or read from the Steam
frontend, can't reach the overlay's evdev watch in-game.** Only a real evdev
event works — which is exactly what InputPlumber produces.

## What works: InputPlumber → F16 (the APEX recipe, adapted)

InputPlumber **is installed on SteamOS** (`/usr/bin/inputplumber`,
`inputplumber.service`) but **disabled by default** on the Deck (Steam Input
drives the built-in controller via `hid-steam`). We enable it, have it manage
the Deck controller, and map a back paddle to F16.

Five parts — **all five are required**:

### 1. Device config — let IP manage the Deck at boot
`/etc/inputplumber/devices.d/50-steam_deck.yaml` (writable override of the
shipped `/usr/share/...` config) with **`auto_manage: true`** so IP claims the
Deck controller at boot. The Deck's source config uses
`hidraw 0x28de:0x1205 interface_num 2`.

### 2. Profile — map paddles → F16, and FORCE a keyboard target
IP's Deck handling switches the gamepad target to **`deck-uhid`** (a faithful
Valve Steam Deck Controller emulation — good, it avoids a double controller),
but **that drops the keyboard target**. The profile must re-add it:

```yaml
target_devices: [ deck-uhid, keyboard, mouse, touchpad ]   # keyboard is essential
mapping:
  - { name: RightPaddle1 -> F16, source_event: { gamepad: { button: RightPaddle1 } }, target_events: [ { keyboard: KeyF16 } ] }
  # ...LeftPaddle1/2, RightPaddle2 likewise
```

**Deck paddle source names are `LeftPaddle1`/`LeftPaddle2`/`RightPaddle1`/
`RightPaddle2`** — *not* `LeftTop`/`RightTop` (that's the APEX naming, and was
the cause of an hour of "nothing happens"). Confirm names via the composite
device's `Capabilities` D-Bus property.

### 3. Boot timing — load the profile BEFORE the overlay starts
IP loads its **default** profile at boot (no keyboard target). Our profile must
be loaded *before the overlay enumerates input devices*, or the overlay never
sees IP's keyboard. A **systemd one-shot** ordered `After=inputplumber.service`,
`Before=graphical.target` calls `CompositeDevice.LoadProfilePath`. (Loading it
manually after the session starts is too late — that wasted a lot of time.)

### 4. ⚠️ Permission — let the overlay OPEN IP's virtual keyboard
**This is the non-obvious gotcha that blocked everything.** The overlay logged:

```
[input-intercept] open failed for /dev/input/event18 (InputPlumber Keyboard)
[overlay] input intercept ready — 0 controller(s), 3 keyboard(s), 2 qam device(s)
```

The overlay finds IP's keyboard but **can't open it**. The `deck` user is **not
in the `input` group**; physical keyboards work via a logind **`uaccess`** ACL,
but IP's virtual keyboard doesn't get that ACL — SteamOS's
`90-steam-inputplumber.rules` gates the `uaccess` tag on `USE_INPUTPLUMBER==1`,
which **isn't set on the Deck**. Compare ACLs:

```
event14 (Apple kbd, opens): user:deck:rw-     ← uaccess ACL present
event18 (InputPlumber kbd): (no deck ACL)      ← open() → EACCES
```

**Fix (pick one):**
- **udev `uaccess` rule** for IP's virtual devices (recommended for shipping —
  grants the active session user, no group change):
  ```
  # /etc/udev/rules.d/71-loadout-inputplumber-uaccess.rules
  SUBSYSTEM=="input", ATTRS{name}=="InputPlumber*", TAG+="uaccess"
  ```
- **or** add the user to the `input` group: `usermod -aG input deck` (this is
  the overlay's documented requirement; **the validated working setup used
  this**). Requires re-login/reboot.

### 5. Enable the services
`systemctl enable inputplumber.service loadout-ip-profile.service`, reboot.

## Result

Boot order becomes: InputPlumber starts → one-shot loads the paddle→F16 profile
(IP keyboard now exists) → session + overlay start and enumerate that keyboard →
**press a back paddle → F16 → overlay toggles.** No double controller
(`deck-uhid` keeps it single), renders normally on a clean boot.

## Why this is the right answer for the broader fleet

- **Steam Deck**: this recipe (IP off by default → we enable + manage + uaccess).
- **OneXPlayer APEX / ROG Ally / Legion Go (Bazzite/SteamOS-other)**: InputPlumber
  is already the active input layer, so just the profile mapping is needed
  (button source names differ per device — handled by per-device handheld plugins
  that will land in later milestones).
- The **overlay side is universal**: watch F16. No per-device overlay code.

So per-device InputPlumber profiles aren't ideal, but they're the only thing
that works on SteamOS, and they match the pattern already established for APEX.

## The installer: vendored assets + a thin wrapper

The five pieces above are all **vendored as real files** under
`scripts/deck-overlay-trigger/`, and `scripts/setup-deck.sh`
is a thin wrapper that copies them into place. Only one piece is rendered
per-install: the profile's `mapping:` list, which is generated from the
user-selected button names by `inputplumber/render-profile.sh`.

```
scripts/
├── setup-deck.sh        ← entry-point (~90 lines, no heredocs)
└── deck-overlay-trigger/
    ├── inputplumber/
    │   ├── devices/50-steam_deck.yaml          ← device override (static)
    │   ├── profiles/overlay-trigger.header.yaml← profile header (static)
    │   └── render-profile.sh                   ← appends mapping entries
    ├── systemd/loadout-ip-profile.service ← boot one-shot (static)
    ├── udev/71-inputplumber-uaccess.rules      ← permission rule (static)
    └── bin/ip-load-profile.sh                  ← deployed to /etc (static)
```

Real YAMLs with `yaml-language-server` schema headers, reviewable in diffs,
editable in any LSP-aware editor. The installer is a thin wrapper around them.

### Future: user-configurable button via the overlay UI

1. **DMI-guarded setup**: on a Deck (`product_name` Galileo/Jupiter,
   `sys_vendor` Valve, exposed by `@loadout/device`), a future onboarding
   step or settings panel can shell out to `setup-deck.sh`.
2. **Button picker in a settings panel**: L4 / L5 / R4 / R5 / Off — *not* a
   `Guide+` chord (those can't work on the Deck, see above). Changing the
   selection **re-runs `render-profile.sh`** with the new button list and
   reloads via `CompositeDevice.LoadProfilePath` — no reboot.
3. **F16 is the wake key**: single key, no terminal/SIGQUIT side effects,
   and matches the overlay's existing QAM evdev watch.

### Validated configuration reference (install destinations)

| Piece | Source (in repo) | Destination |
|-------|------------------|-------------|
| Device override | `inputplumber/devices/50-steam_deck.yaml` | `/etc/inputplumber/devices.d/50-steam_deck.yaml` |
| Profile (rendered) | `inputplumber/profiles/overlay-trigger.header.yaml` + `render-profile.sh` | `/etc/loadout/inputplumber/overlay-profile.yaml` |
| Boot loader script | `bin/ip-load-profile.sh` | `/etc/loadout/inputplumber/ip-load-profile.sh` |
| Boot one-shot unit | `systemd/loadout-ip-profile.service` | `/etc/systemd/system/loadout-ip-profile.service` |
| Permission (uaccess) rule | `udev/71-inputplumber-uaccess.rules` | `/etc/udev/rules.d/71-loadout-inputplumber-uaccess.rules` |

All destinations are under `/etc` so they survive ostree deployment switches
on SteamOS (`/usr` is read-only and overlay-scoped to the current deployment).

> History note: the long debugging path that produced this (chord injection,
> CDP frontend probing, the `deck-uhid`/keyboard-target discovery, paddle source
> names, and the `uaccess` permission gotcha) is summarised in the table above —
> each row was a dead end or a required piece discovered the hard way.
