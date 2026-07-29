# WiFi

> Stop WiFi dropping out by disabling the radio's power saving. Writes a NetworkManager drop-in (and an iwd quirk where iwd is installed), applies it instantly, and re-asserts it on every wake. Also recovers a crashed WiFi radio without a reboot — reloads the driver (escalating to a PCI reset) manually or automatically when the radio goes unavailable. Cross-distro: SteamOS, Bazzite, CachyOS.

## Screenshots

![WiFi](./assets/screenshot.png)

## Power saving

Toggling power saving off:

1. Writes `/etc/NetworkManager/conf.d/wifi-powersave-off.conf` (`wifi.powersave = 2`) — NetworkManager's "off" value, applied via nl80211 regardless of backend.
2. Where iwd is installed, merges `[DriverQuirks] PowerSaveDisable=*` into `/etc/iwd/main.conf` (existing sections are preserved).
3. Runs `nmcli general reload` so the new default goes live without a connection-dropping restart, then `iw dev <iface> set power_save off` for the current session.
4. Re-asserts the runtime state on every wake from sleep (power saving otherwise re-enables on resume).

Turn it off to remove the config and restore the system default.

## Caveats

- **SteamOS major updates** can reset `/etc`, dropping the config — re-toggle after a big SteamOS upgrade.
- A saved connection that pins `802-11-wireless.powersave` explicitly (some vendor images do) overrides the global default; this toggle sets the default, so such a connection would need its own `powersave` cleared.

## Radio recovery

WiFi firmware can crash outright (seen in the field on an Intel AX210:
`HW problem - can not stop rx aggregation` and an endless firmware reload
loop in dmesg), leaving NetworkManager's wifi device stuck `unavailable`
with no way back but a reboot. The **Recover WiFi radio** button brings it
back in place:

1. Reloads the driver stack in dependency order (`modprobe -r` the
   dependent modules first — e.g. `iwlmvm` before `iwlwifi` — then
   `modprobe` the driver back).
2. If the reload isn't enough, escalates to a PCI function reset, and then
   a PCI remove + rescan. The escalation tiers only ever run when the
   radio is already dead, so the worst case equals the status quo.
3. Re-detects the wifi interface from `nmcli` at every step — the
   interface can come back renamed after a reload (`wlan0` → `wlan1`).
   NetworkManager then reconnects the saved network on its own.

The driver and PCI address are captured while the radio is healthy and
persisted, so recovery still works after the interface has vanished
entirely. Recovery is skipped when the radio is off on purpose (rfkill or
the NetworkManager radio switch).

The **Auto-recover radio** toggle (off by default) arms a watchdog that
runs the same recovery when the radio goes `unavailable` without being
switched off. It's debounced (two consecutive polls), cooled down (60s
between attempts), and suspends itself after three consecutive failed
recoveries so it can't modprobe-crash-loop.

## See also

- [All plugins](../../README.md#plugins)
- [Plugin model](../../README.md#plugin-model)
