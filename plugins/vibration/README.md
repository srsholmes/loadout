# Vibration

> Global rumble intensity for OneXPlayer-family handhelds.

Sets a master level for the built-in gamepad's motors, from **Off** to **Full**.
Games and Steam Input still decide what rumbles and how strongly — this scales
all of it, which makes it the only control that reaches titles ignoring Steam's
own rumble setting, and the only one that affects Big Picture's UI feedback.

## How it works

The kernel's `hid-oxp` driver exposes two attributes on the gamepad's HID
device:

| Attribute | Mode | Meaning |
| --- | --- | --- |
| `rumble_intensity` | RW | a single `u8`; the driver rejects anything above the range max |
| `rumble_intensity_range` | RO | the literal string `0-5` |

This is **not** force feedback. There is no `FF_RUMBLE` and no `EVIOCSFF`, so
nothing appears under `/sys/class/input/*/device/ff*` and never will — it is one
global attenuator on the MCU. The driver declares left/right constants but does
not use them, so there is no per-motor split to expose.

The range is read from the device rather than hardcoded: it is a read-only
attribute precisely so userspace doesn't bake in `0–5`.

## Supported devices

Detection globs `/sys/bus/hid/devices/*/rumble_intensity` — **any** device the
driver binds this attribute to works, with no per-model table to maintain. In
practice that is the gen-2 OneXPlayer family: X1 mini series, G1 A/i, AOKZOE
A1X, and the Apex.

First-generation OneXPlayers (`1A2C:B001`) get RGB from the same driver but no
rumble attributes, so the plugin reports no hardware there.

`hid-oxp` reached mainline in Linux 7.2, and SteamOS backports it — an Apex on
SteamOS 6.18 already has these nodes.

## Why the stored value wins

`rumble_intensity_show` returns a driver-side cache initialised to the maximum
in `oxp_cfg_probe`; it never queries the MCU. So a read after boot reports the
maximum whatever the firmware is actually doing, and the level you picked is the
better record. The plugin re-applies it once the hardware is detected, because
that cache resets on every module load.

It does **not** install a wake listener: the driver re-applies its own cache
after resume, watching for the MCU's post-wake status event.

## If it says no hardware was found

- The `hid-oxp` driver isn't loaded — check your kernel has it, and that it
  isn't blacklisted. Loadout used to recommend blacklisting it as a workaround
  for the Apex's controller dying on resume; the **Apex** plugin offers to
  remove that, and **Recover gamepad** is the fix now.
- The device is a first-generation OneXPlayer (RGB only).
- The device isn't a OneXPlayer-family handheld.

## Not included

**Per-game intensity.** Tempting — subtle in a strategy game, full in a racer —
and `packages/per-game-profiles` makes it cheap. Held back because each change
is a synchronous HID output report under the driver's mutex, and whether writing
mid-rumble is safe for the MCU is untested. Worth adding once that's known.

**Gamepad mode and button remapping.** The same driver exposes `gamepad_mode`
(`xinput`/`debug`) and a 19-attribute remap surface. Both need their own
thinking about how they interact with Steam Input and InputPlumber, so they are
deliberately out of scope here rather than bolted on.
