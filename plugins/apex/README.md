# OneXPlayer

> OneXPlayer device fixes: recover the internal gamepad when its xHCI controller dies on resume, and block the fingerprint reader from waking the device on a light touch.

## Fingerprint wake block, and why it heals itself

The power button's fingerprint reader wakes the device from sleep on a light
touch. The touch reaches the SoC by **two independent paths, and both must
close** — closing one leaves the device wakeable:

- **Controller PME** — `power/wakeup=disabled` on the xHCI controller hosting
  the reader, plus a udev rule to persist it. Derived from your hardware at
  runtime; takes effect immediately, no reboot.
- **GPIO wake line** — disarmed only by a kernel argument,
  `gpiolib_acpi.ignore_wake=AMDI0030:00@58`. Boot-time, so it needs a reboot,
  and it names a pin that is board wiring rather than a family constant.

Because the karg is the only way to close path 1, "which bootloader is this"
decides whether we can deliver a complete block:

| Distro | Kernel arg | Result |
| --- | --- | --- |
| SteamOS | `/etc/default/grub-steamos`, behind `steamos-readonly` | automatic |
| Bazzite and other rpm-ostree images | `rpm-ostree kargs` | automatic |
| CachyOS / Arch / Fedora | `/etc/default/grub` + `grub-mkconfig` | automatic, verified against the generated `grub.cfg` |
| Anything else | — | we print the arg; you add it |
| A board whose pin we haven't measured | — | withheld: the wrong pin is worse than none |

GRUB is *assumed* on the Arch/Fedora family. CachyOS also ships systemd-boot
and limine, where `/etc/default/grub` exists but nothing reads it — so after
writing we check the karg actually reached `grub.cfg` and roll back with an
error if it didn't, rather than reporting a block the device doesn't have.

Where we can't stage it, the UI says one wake path is still open. It does not
claim the block is complete.

### Healing itself

Both paths live in `/etc`, and a SteamOS A/B update regenerates that tree — so
an update silently removes the block and the device quietly starts waking on a
touch again, with nothing to tell you.

So the plugin checks at startup and puts it back. The user's choice is stored
in plugin storage under `$HOME` (`fingerprintBlock`), not inferred from
`/etc`: every signal in the live status is derived from the files an update
deletes, so afterwards they cannot distinguish "never wanted it" from "wanted
it and the OS ate it". Healing off those would enable the block on machines
whose owner deliberately never turned it on.

The re-apply runs fire-and-forget from `onLoad` — the loader awaits each
plugin's `onLoad` in turn with no timeout and the HTTP server doesn't start
until that loop finishes, so blocking on `update-grub` would stall the whole
backend boot.

You are told it happened via a toast at overlay startup — the plugin declares
`loadOnStartup` and exports `init()`, which pulls the outcome and waits for
the window to actually be on screen before notifying (the overlay boots
hidden, so a toast fired at boot is consumed by nobody). The same notice
renders as an alert on the plugin page — reading it doesn't consume it, so
both surfaces can show it and it isn't lost if the webview reloads before you
look.

Uninstalling Loadout removes the udev rule and re-enables the controller, so
the block doesn't outlive the app. The kernel arg is deliberately left alone —
editing a bootloader during an uninstall is a worse failure than a stale arg,
which is inert once the rule is gone.

## Vibration

Sets the gamepad's global rumble level (`rumble_intensity`, 0-5), a single
attenuator the MCU applies to everything — so it scales rumble even in games
that ignore Steam's own setting.

It lives here rather than in a plugin of its own because it is
OneXPlayer-only in practice. `rumble_intensity` is a `hid-oxp` attribute and
no other handheld exposes an equivalent through the kernel: MSI Claw and ROG
Ally only pass force-feedback *events* through, and Ayaneo, Legion Go and
Orange Pi have nothing. GPD Win does have a real global setting
(off/medium/high) but writes it into a config blob over the `wincontrols`
vendor HID protocol with no sysfs at all, sharing no mechanism with this. A
standalone plugin would have meant a permanently dead sidebar entry on every
non-OneXPlayer device.

The value we store wins over the one the driver reports: `rumble_intensity`
reads back a driver-side cache initialised to maximum on probe, which never
queries the MCU, so it says 5 after every module load regardless of what the
firmware is doing. We re-apply the stored level on load for the same reason.

## Screenshots

![Apex](./assets/screenshot.png)

The plugin runs on any OneXPlayer-family handheld and detects each feature's
hardware for itself — the fingerprint reader by USB id, the dead xHCI controller
from the kernel log. It was gated to the Apex alone until an X2 Mini Pro owner
reported being locked out of fixes their hardware could use.

Two things stay Apex-specific, because they are board wiring rather than family
behaviour, and both degrade rather than misfire:

- **The fingerprint GPIO kernel arg** (`AMDI0030:00@58`) names a specific pin.
  On any other board it is offered as text to apply by hand; the PME wake path,
  which is derived from the reader's own PCI parent, still applies everywhere.
- **The gamepad USB ids** (`1a86:fe00`, `045e:028e`). If neither enumerates and
  the kernel log shows nothing dead, the plugin says it can't identify the pad
  rather than offering a rebind that could never report success.

The plugin id stays `apex` so existing settings survive; only the display name
changed.

## Gamepad recovery

On the OneXPlayer Apex the xHCI USB host controller (`0000:65:00.4`) can die when the device wakes from sleep:

```
xhci_hcd 0000:65:00.4: xHCI host controller not responding, assume dead
xhci_hcd 0000:65:00.4: HC died; cleaning up
usb 1-1: USB disconnect ...
```

That drops the built-in gamepad (`1a86:fe00` HID MCU + `045e:028e` Xbox 360 pad) clean off the USB bus, so the controller looks dead and restarting InputPlumber doesn't help — there's no source device left to grab. The **Recover gamepad** button unbinds and rebinds the PCI controller so the whole bus re-enumerates and the pad comes back; it then re-grabs InputPlumber to pick up the freshly enumerated source. That re-grab is delegated to the InputPlumber plugin so the wake-button profile is reloaded too — a plain `systemctl restart inputplumber` would drop it.

The same logic is also available as a standalone shell script for use outside Loadout: [`scripts/fix-controller-resume.sh`](../../scripts/fix-controller-resume.sh).

## The hid-oxp blacklist (removal only)

Loadout once recommended blacklisting the OneXPlayer HID driver, because it
looked implicated in the xHCI controller dying on resume. **We no longer offer
to apply it, and shouldn't again.** It disabled the driver instead of fixing
the wake bug — that's what **Recover gamepad** above is for — and `hid-oxp` is
where OneXPlayer's device controls live: rumble intensity, gamepad mode and
button remapping all disappear with it, on a machine that has no way to know
why.

What remains is a **Driver blacklist** card that appears only if the drop-in
is still on disk, offering to remove it. There is deliberately no path to
write it, in the UI or in [`lib/hid-oxp.ts`](lib/hid-oxp.ts) — a unit test
asserts the module exports no `set`/`apply`/`enable` function. If the wake bug
resurfaces, the fix belongs in [`lib/xhci.ts`](lib/xhci.ts).

## Fingerprint wake

The power button's fingerprint sensor wakes the Apex from sleep on a light touch — annoying in a bag. The **Block fingerprint wake** toggle disables it as a wake source (controller PME at runtime + a GPIO kernel argument); a deliberate power-button press still wakes the device. The kernel-arg change needs a reboot, and on non-SteamOS distros the GPIO arg may need to be added manually (the panel shows the exact arg).

## See also

- [All plugins](../../README.md#plugins)
- [Plugin model](../../README.md#plugin-model)
