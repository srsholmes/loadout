# Bundled `oxpec.ko` kernel modules

Per-kernel-version builds of the out-of-tree [`oxpec`][oxpec] driver (OneXPlayer
EC sensor driver). Used by the `apex-fixes` plugin to expose fan RPM and PWM
control under `/sys/class/hwmon` on the OneXPlayer APEX.

At runtime the plugin picks the directory matching `uname -r`. If no match, it
falls back to `modprobe oxpec` (which uses whatever ships in `/lib/modules/…`).

## Kernel versions shipped here

- `6.17.7-ba25.fc43.x86_64`
- `6.17.7-ba28.fc43.x86_64`
- `6.17.7-ba29.fc43.x86_64`

These were copied from the upstream Decky plugin
[`OneXPlayer Apex Tools`][decky-plugin] and track Bazzite's kernel releases.
Adding support for a new kernel = rebuild `oxpec.ko` against its headers and
drop it into a matching directory here.

## Why bundle instead of `modprobe`?

The mainline kernel's `oxpec` module does not yet carry a DMI alias for the
APEX, so `modprobe oxpec` fails with `No such device` on this hardware even
though the `.ko.xz` ships. Bundled builds include the extra DMI entry and
work today. Once the upstream alias lands, this directory becomes vestigial.

[oxpec]: https://github.com/Samsagax/oxpec
[decky-plugin]: https://github.com/srsholmes/onexplayer-apex-bazzite-fixes
