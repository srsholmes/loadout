# InputPlumber

> Install the InputPlumber input-routing daemon — no-op if a system package or a previous run already installed it

Installs the InputPlumber input-routing daemon that other controller features rely on, and quietly does nothing if it's already present. Mostly a one-time setup helper so the rest 'just works'.

## Device configs

InputPlumber only builds a `CompositeDevice` for hardware one of its configs
matches, and matching is on the exact `/sys/class/dmi/id/product_name`. On a
handheld it has no config for there is no composite device at all — so the
wake-button picker lists nothing and overlay input intercept has nothing to
act on. Every InputPlumber-dependent feature is inert on hardware that is
otherwise completely conventional.

For devices we can describe, this plugin offers to drop a config into
`/etc/inputplumber/devices.d`. That directory is searched *before*
`/usr/share/inputplumber/devices`, with ties broken by basename — so these
files deliberately use the name upstream would use, and *shadow* a future
upstream config rather than loading alongside it and matching the same
machine twice. When upstream does ship one, the UI says so and suggests
removing ours, since theirs is tested on the hardware.

The card only appears when we have a config for this exact machine **and**
InputPlumber has genuinely produced no composite devices. A device that
already works is never offered one.

Currently shipped:

| Device | DMI `product_name` | Notes |
| --- | --- | --- |
| OneXPlayer X2 Mini Pro | `ONEXPLAYER X2Mini PRO` | Not in InputPlumber 0.78.1. Gamepad + MCU only. |

Each config is deliberately minimal — enough to make a composite device
exist, and no more. See the docblock in `lib/device-config.ts` for what is
left out and why (the system keyboard, and the back-paddle capability map).

## Screenshots

![InputPlumber](./assets/screenshot.png)

## See also

- [All plugins](../../README.md#plugins)
- [Plugin model](../../README.md#plugin-model)
