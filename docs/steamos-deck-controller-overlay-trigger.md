# Configurable overlay wake button (any handheld, via InputPlumber)

This documents how Loadout opens/toggles the overlay from a **physical button**
on any handheld — including a **Steam Deck on SteamOS**, where the obvious
approaches don't work — and how the user picks *which* button.

> TL;DR — The overlay's internal wake key is fixed at **`KEY_F16`**. *Which
> physical button emits it* is **user-selectable**: the **input-plumber plugin**
> renders an **InputPlumber profile** mapping the chosen button (a back paddle,
> the Quick Access / keyboard button, anything the device exposes) → **F16**.
> The button list comes from the connected device's runtime
> `CompositeDevice.Capabilities`, so there's **no per-device code** — any handheld
> InputPlumber supports works the moment the user picks a button. All the
> privileged work is **TypeScript in the plugin backend** (the backend runs as
> root); there are no wake-trigger shell scripts and no systemd one-shot.

## Background: how the overlay receives a "wake"

The overlay (`apps/loadout-overlay`) opens on:

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
| **`Guide+X` / `Guide+B`** controller combo (the overlay's `ControllerShortcuts`) | ❌ on Deck | Works on **Bazzite** because the overlay reads the controller's evdev directly and there's no competing chord layer. On the Deck the Steam button is owned by Steam and its chords are live, so they collide / never reach the overlay. |
| **Reading the Steam Deck controller hidraw report** directly | ❌ as a general answer | Only sees buttons present in the Deck *controller* report (paddles, Steam, QAM). A **keyboard-type** button (e.g. the Apex's button next to QAM, which IP exposes as a key) never appears there, so it couldn't be a wake trigger — and the user gets no real button choice. |

The throughline: **anything injected at the X layer, or read from the Steam
frontend, can't reach the overlay's evdev watch in-game.** Only a real evdev
event works — which is exactly what InputPlumber produces. And only an IP profile
mapping gives the user free choice of *which* button (including keyboard-type
ones).

## What works: a user-chosen button → F16 (InputPlumber)

InputPlumber is the input-routing layer on the handheld fleet:

- **Bazzite / most handhelds**: IP is already the active layer, so we just load a
  profile mapping the chosen button → F16.
- **Steam Deck (SteamOS)**: IP **is installed but ships disabled** (Steam Input
  drives the built-in controller via `hid-steam`). We enable it + have it manage
  the Deck controller, *then* load the profile.

The same four ingredients are needed; on non-Deck handhelds the first is a no-op.

### 1. (Deck only) Let IP manage the Deck at boot
`/etc/inputplumber/devices.d/50-steam_deck.yaml` with **`auto_manage: true`** so
IP claims the Deck controller, and `systemctl enable --now inputplumber.service`.
On other handhelds IP already manages the pad — this step is skipped.

### 2. Profile — map the chosen button → F16, preserving the controller
The rendered profile **preserves the device's existing target devices** (read
live from `CompositeDevice.TargetDevices`) and **adds `keyboard`** so the overlay
has an F16 source. On the Deck IP's target is **`deck-uhid`** (a faithful Steam
Deck Controller emulation — avoids a double controller), but it drops the
keyboard target, so re-adding it is essential:

```yaml
target_devices:
  - deck-uhid      # whatever the device already uses (xb360, deck-uhid, …)
  - keyboard       # essential — added by us
mapping:
  - name: Overlay wake (RightPaddle1 -> F16)
    source_event:
      gamepad:
        button: RightPaddle1
    target_events:
      - keyboard: KeyF16
```

Button **source names differ per device** (`RightPaddle1` on the Deck vs `LeftTop`
on the APEX, etc.) — which is exactly why the picker is driven by the device's
**runtime `Capabilities`** rather than hardcoded. A keyboard-type button is
rendered with a `keyboard:` source instead of `gamepad:`.

### 3. Permission — let the overlay OPEN IP's virtual keyboard
The overlay runs as a **user** service. Physical keyboards get a logind
**`uaccess`** ACL; IP's *virtual* keyboard doesn't on the Deck (SteamOS's
`90-steam-inputplumber.rules` gates the tag on `USE_INPUTPLUMBER==1`, unset on the
Deck), so the overlay's `open()` of it `EACCES`es. We install a udev rule and
reload udev so it applies without a replug:

```
# /etc/udev/rules.d/71-loadout-inputplumber-uaccess.rules
SUBSYSTEM=="input", ATTRS{name}=="InputPlumber*", TAG+="uaccess"
```

### 4. Boot persistence — reload the profile before the overlay starts
IP loads its **default** profile at boot (no wake mapping). Ours must be loaded
*before the overlay enumerates input devices*. The **Loadout backend** (a root
system service) does this in `onLoad`: it waits for IP's D-Bus, then calls
`CompositeDevice.LoadProfilePath`. Because the backend comes up and signals `/up`
**before** the overlay user-service launches (the overlay waits on the `/up`
curl loop in `loadout-overlay.service`), the IP keyboard exists before the overlay
enumerates devices — **no separate systemd one-shot needed**.

## Per-device prerequisites

This feature drives **already-running InputPlumber**. It does not install IP
itself, nor ship device-recognition YAMLs. Each handheld needs the upstream IP
package + a matching device file under `/etc/inputplumber/devices.d/` (or
`/usr/share/inputplumber/devices/`) so IP exposes it as a `CompositeDevice`. The
picker can only list buttons IP can already see; without a device file the
picker shows "No controller detected by InputPlumber".

| Handheld | IP daemon | Device YAML | Notes |
|----------|-----------|-------------|-------|
| **Steam Deck (SteamOS)** | Ships **disabled** — opt-in via the picker's *Enable & detect buttons* button, which writes `auto_manage: true` to `/etc/inputplumber/devices.d/50-steam_deck.yaml` + `systemctl enable --now inputplumber.service`. Deck profile targets `deck-uhid` to preserve Steam Input chord compatibility. | Bundled with IP upstream. | Steam Input keeps working post-takeover (controller still looks identical to Steam). |
| **OXP Apex** (Bazzite) | Bazzite ships IP enabled. | **Loadout does not ship this file.** Apex requires `/etc/inputplumber/devices.d/50-onexplayer_apex.yaml` — currently provided out-of-band (legacy steam-loader install, or to-be-migrated `apex-fixes` plugin). | Apex's QAM-adjacent button surfaces as `Gamepad:Button:Keyboard` once the device YAML is in place. |
| **ROG Ally / Ally X**, **Legion Go**, **AYANEO** | IP packages ship matching device YAMLs upstream. | Bundled. | Works out-of-box once IP is enabled. |
| **CachyOS / Nobara / ChimeraOS** desktops | IP via package manager; no auto-managed handheld. | None pre-installed. | Picker shows whatever IP enumerates. |

**Pre-existing IP profile collision:** `LoadProfilePath` is replace-not-merge —
the user's chosen wake profile fully supersedes IP's previously-loaded default
on that composite device. The picker probes for a legacy
`/var/lib/inputplumber/data/inputplumber/profiles/default.yaml` with substantive
mappings and surfaces a one-time *I understand, continue* gate so existing paddle
/ dial / QAM mappings aren't silently lost. If the user accepts, those mappings
move from active to dormant (the file is unchanged, just not loaded onto the
device).

## Where this lives (all TypeScript)

Everything is in the **`input-plumber` plugin**, because the backend runs as root
and can do the privileged work directly:

| Concern | Module |
|---------|--------|
| Pure templating + capability parsing (profile YAML, udev rule, Deck override, button labels, default-button heuristic) | `plugins/input-plumber/lib/profile.ts` |
| IP D-Bus client (`busctl`: `Capabilities`, `LoadProfilePath`, `TargetDevices`) | `plugins/input-plumber/lib/ipdbus.ts` |
| Orchestration (DMI detect, fs writes, `systemctl`/`udevadm`, render+load, persistence, boot reload) | `plugins/input-plumber/lib/wake-trigger.ts` |
| RPC surface (`getWakeStatus` / `prepareWake` / `setWakeButton` / `clearWakeButton`) + `onLoad` reload | `plugins/input-plumber/backend.ts` |
| Picker UI (lists the device's buttons, recommends extras, Off, live-apply) | `plugins/input-plumber/app.tsx` |

The picker is populated from the connected device's `Capabilities`; recommended
("extra") buttons — paddles, the QAM/keyboard button — sort first, core gameplay
buttons are grouped under a warning. Changing the selection re-renders the profile
and `LoadProfilePath`s it live — **no reboot**.

### Install destinations

| Piece | Written by | Destination |
|-------|-----------|-------------|
| Profile (rendered) | `lib/wake-trigger.ts` (`renderProfile` → `node:fs`) | `/etc/loadout/inputplumber/overlay-profile.yaml` |
| Device override (Deck only) | `lib/wake-trigger.ts` (`node:fs`) | `/etc/inputplumber/devices.d/50-steam_deck.yaml` |
| Permission (uaccess) rule | `lib/wake-trigger.ts` (`node:fs`) | `/etc/udev/rules.d/71-loadout-inputplumber-uaccess.rules` |

All destinations are under `/etc` so they survive ostree deployment switches on
SteamOS (`/usr` is read-only and overlay-scoped to the current deployment).
Boot-time loading is handled by the backend's `onLoad` (no `/etc/systemd` unit and
no `/etc` loader script — those were used by the earlier shell-script prototype).

## Why this is the right answer for the broader fleet

- **The overlay side is universal**: watch F16. No per-device overlay code.
- **The button choice is universal**: the picker reads the connected device's
  runtime capabilities, so a new handheld works the moment InputPlumber supports
  it — the user just picks a button. No per-device InputPlumber config files.
- **Steam Deck** is the one device needing an enable+`auto_manage` step; that's a
  single bounded override for known-fixed hardware, applied only when the user
  opts in by choosing a wake button.

> History note: the long debugging path behind the "what doesn't work" table
> (chord injection, CDP frontend probing, the `deck-uhid`/keyboard-target
> discovery, paddle source names, and the `uaccess` permission gotcha) is
> summarised above — each was a dead end or a required piece discovered the hard
> way. The original recipe was a set of vendored shell scripts + a systemd
> one-shot; now that the backend runs as root it's all TypeScript in the
> input-plumber plugin.
