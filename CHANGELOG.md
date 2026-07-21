# Changelog

All notable user-facing changes to Loadout.

Starting with **v0.1.0**, releases are versioned — see [docs/releasing.md](docs/releasing.md) for the process and semver policy. The dated sections below v0.1.0 are the earlier rolling-build history, reconstructed by cross-referencing the pull requests merged at the time.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com).

---

## [v0.6.0] — 2026-07-21

### Added
- **Eight more handhelds get correct TDP ranges out of the box** (#219) — Headlined by the **GPD Win 5** (Strix Halo), which previously fell through to the generic GPD fallback and was capped at 28 W against its real 4–85 W envelope — Win 5 owners had to hand-enter a custom device to use the hardware they paid for. Also newly recognized: GPD Win Mini and Win Mini 2025 (the 2025 model gets its proper 30 W ceiling), GPD Win Max 2 2024, ROG Xbox Ally (a 20 W-class part the generic fallback would have *over*shot by 75%), ROG Xbox Ally X, ROG Flow Z13, OneXPlayer OneXFly F1 Pro/EVA-02, and OrangePi Neo.

## [v0.5.0] — 2026-07-21

### Added
- **Power draw now tracks your game, not your TDP slider** (#218) — Field bug: with a TDP limit set, total draw always sat *at the limit* even with a frame cap — set 45 W with a 30 fps cap and the chip burned 45 W where ~30 W would do. Root cause: CPU boost stays on and races the cores to max clocks under any sustained load — regardless of governor or EPP — filling whatever envelope the limit allows. TDP Control now keeps CPU boost **off by default** and re-asserts that choice with every TDP write, at service startup (the kernel resets the knob on every boot), after SMT changes, and on resume — so the fix survives reboots without any manual sysfs poking. A new **CPU Boost** toggle in the plugin is the persistent opt-out for when you do want boost clocks (plugged in, CPU-bound emulation). Devices with no TDP control method are left untouched unless you explicitly pick a state. Verified live on Strix Halo: 45 W limit + 30 fps cap now draws ~30 W, rising to the limit only when uncapped.

### Fixed
- **TDP readout updates again on stock SteamOS** (#217) — The plugin's TDP number could sit frozen on "last set value": reading the current TDP back exec'd a bare `ryzenadj` instead of the bundled binary the plugin ships, so the read silently failed on any system without ryzenadj installed globally. Reads now go through the same resolved binary as writes.

## [v0.4.0] — 2026-07-18

### Added
- **Fix a crashed WiFi radio without rebooting** (#215) — When the WiFi firmware crashes, the radio shows *unavailable* and the connection is gone until a reboot (seen in the field on an Intel AX210: `HW problem` + an endless firmware reload loop in dmesg). A new **Recover WiFi radio** button in the WiFi plugin reloads the driver in place — escalating to a PCI reset of the card if the reload isn't enough — and NetworkManager then reconnects your saved network on its own. An **Auto-recover radio** toggle (off by default) watches for the crashed state and runs the same recovery automatically; it never fights a radio you switched off on purpose (rfkill / airplane mode) and suspends itself after repeated failures rather than crash-looping. Driver-agnostic: the driver is detected live (Intel, MediaTek, Qualcomm, …) and captured while the radio is healthy, so recovery still works when the interface has vanished entirely — and if you have WiFi power saving disabled, recovery re-asserts that too, so the fix never quietly reintroduces the dropout bug this plugin exists to prevent.

### Fixed
- **Overlay crash at startup on AMD after the 2026-07-14 Arch/CachyOS update** (#214) — Arch's webkit2gtk 2.52.5 regressed to exporting libstdc++'s private `std::call_once` machinery, which hijacked Mesa's radeonsi/LLVM initialization inside the overlay process and segfaulted it at GL init. The overlay now preloads the real libstdc++ so it wins interposition (the zink fallback from #211 remains as a safety net).
- **Desktop sessions no longer misdetected as Gaming Mode** (#212) — the overlay's own service environment exported `GAMESCOPE_DISPLAY`, so the gamescope detection matched itself and reported Gaming Mode on plain desktop sessions. Detection now checks for a real running gamescope process.
- **`curl | sh` install prompts are answerable again** (#213) — piped through `sh`, the installer's prompts consumed the script itself as input, so every question silently took its default (controller-setup "Phase 2" was always skipped, uninstall questions self-answered). Prompts now read from the terminal (`/dev/tty`), matching the exact command the README tells people to run.

### Changed
- **Workspace typechecking restored** (#209) — all seventeen `@loadout/*` workspace packages are now resolvable by the typechecker (22 stale errors → 0), keeping `bun run typecheck` a trustworthy release gate.

## [v0.3.2] — 2026-07-09

### Fixed
- **Your TDP setting survives a reboot** (#205) — A manually-set TDP was lost on every shutdown (hardware power limits reset to firmware defaults), so the device came back at whatever the per-game default was — e.g. set 35 W, reboot, get 12 W. The last TDP you set by hand is now saved to disk and restored on startup, and it's treated as the "no game running" wattage even with per-game profiles enabled — a game's saved profile still takes over when that game launches, and adjusting TDP mid-game no longer overwrites your idle setting.
- **Wake button recovers after system updates** (#206) — When a SteamOS/InputPlumber update wiped the overlay wake-button mapping, the boot-time restore could silently fail (device not yet enumerated) and the button reverted to its OS default (opening the on-screen keyboard) with nothing in the logs. The restore now retries while InputPlumber finishes coming up, and logs each step — so a failed restore is diagnosable with `journalctl -u loadout.service -b | grep "wake reload"`.

### Changed
- **Type-safety hardening across the codebase** (#207) — Enabled TypeScript's strictest indexed-access checking and reworked ~330 spots where array/object lookups could silently produce `undefined` into explicit guards and safe fallbacks; corrupt Steam config files (VDF) now log a warning when partially parsed instead of failing silently. Also adopted the Go-native TypeScript compiler (`tsgo`) as the primary typecheck — ~9× faster and slightly stricter (it caught a real type hole in the LSFG-VK layer-version picker). No behavior changes for valid inputs; two adversarial review rounds verified this on-device.

### Fixed
- **Controller shortcuts survive a restart** (#203) — A controller button bound to *Toggle Overlay* (or any non-default action) quietly reverted to its default whenever the overlay restarted, so a custom binding stopped working until you re-set it in Settings. The overlay now loads your saved shortcuts from disk at startup — before it begins listening for input — so your bindings stick across restarts and reboots.

## [v0.3.0] — 2026-07-07

### Added
- **Custom TDP device** (#201) — On a newer or unlisted handheld? A new **settings page in the TDP plugin** (the gear in the top-right) lets you enter your device's own TDP range, battery cap, and Silent / Balanced / Performance presets by hand. Once saved it becomes the default device the TDP control uses, overriding auto-detection — so you can tune power on a device Loadout doesn't ship a profile for yet, without waiting for a release. Clear it to revert to auto-detection.
- **OneXPlayer Super X** (#200) — Added a built-in TDP profile for the OneXPlayer Super X (Ryzen AI Max+ 395 / Strix Halo): a 5–90 W range, capped at 65 W on battery.

### Fixed
- **Installer on fresh / sessionless systems** (#198) — The installer now creates the systemd user directory and guards the `--user` service enable, so a first-time or headless install no longer fails partway through.

## [v0.2.0] — 2026-07-03

### Added
- **Open the overlay from Steam's menu** (#169) — An optional **"Loadout"** entry in Steam's main menu that opens the overlay. It lives in Steam's own focus tree, so it stays reachable by D-pad even if the controller wake-shortcut is mis-configured or the pads wedge on wake — a backup way in. Toggle it under **Settings → General → Steam menu**; selecting it opens the overlay without navigating you anywhere.
- **Seven more recompiled N64 games** (#193, #194) — Bomberman Hero, Quest 64, Chameleon Twist, Perfect Dark, Ghostship, SpaghettiKart, and Mega Man 64 join the Recomp plugin's curated catalogue of native PC ports. Each was installed and launched on-device against its repo's actual latest release before shipping.

### Fixed
- **Overlay toasts now scale with the UI** (#195) — Toasts ignored the UI Scale setting (the toaster was mounted outside the scaled wrapper), so they were tiny on a TV. They now scale with the rest of the UI and have a larger base size.

## [v0.1.0] — 2026-07-03

First versioned release. Establishes the versioned release process and bundles everything from the rolling-build history below; the notable recent additions:

### Added
- **Storage plugin** (#187) — A second internal SSD holding a Steam library sometimes stops auto-mounting after a SteamOS update. This plugin **detects an unmounted data drive and mounts it where Steam expects**, with a **"Mount on boot"** toggle that pins it in `/etc/fstab` so future updates can't silently drop it. Fully auto-detected — works on any device/distro, and never formats anything.
- **WiFi plugin** (#186) — A persistent **"disable WiFi power-saving"** toggle that fixes the WiFi drop-out which previously needed a reboot to recover. Cross-distro (SteamOS, Bazzite, CachyOS).
- **Custom fan curve** (#175) — A new **Custom** mode in Fan Control alongside Silent / Balanced / Performance. Map temperature → fan % by dragging nodes on a graph, or select a point and nudge it with sliders (gamepad-friendly). Add/remove points (2–8), reset to default, and a live marker shows the current temperature on the curve.

### Changed
- **Fan Control layout redesign** — Reordered to Live Status → Fan Speed → Presets → collapsible Temperature Sensors → Per-Game Profiles, with game-art cards for per-game profiles.
- **Apex hid-oxp blacklist is now revert-only** — You can no longer *add* the fragile kernel-level blacklist from the UI (SteamOS updates can leave it half-applied); anyone who previously enabled it gets a simple **Remove blacklist** button instead.
- **Storage detection hardening** (#189) — Dropped a redundant scan and anchored the system-label match so legitimate drives aren't skipped.
- **Install robustness** — The installer now fails loudly if `bun` is missing or plugins didn't stage, instead of silently shipping a stale/empty build.

## 2026-06-26

### Changed
- **Apex: auto-recover gamepad on wake** (#165) — Re-introduced the auto-recover toggle that rebinds the internal gamepad when the device wakes from sleep, now carrying the InputPlumber re-grab fix so the pad no longer ends up "working in menus but dead in Steam's main UI."

## 2026-06-25

### Added
- **Power-source-aware TDP limits** (#168) — Separate TDP caps for battery vs. plugged-in (e.g. the OneXPlayer APEX now caps at 55W on battery, 80W on AC) instead of one limit for both. Device limits centralised into a shared database.

### Fixed
- **External controller dead after closing the overlay** (#172) — Every button was acting as a Guide chord (X = keyboard, L2 = zoom, stick = volume). The overlay was grabbing the pad while Guide was still held, so Steam stayed stuck thinking Guide was down. The grab is now deferred until Guide is released.
- **Overlay hidden behind Big Picture in Desktop Mode** (#171) — The overlay floated correctly in Gaming Mode but sat *behind* Big Picture in Desktop Mode. It's now raised above it.

## 2026-06-24

### Added
- **Apex: block fingerprint wake** (#162) — Stop the power button's fingerprint sensor from waking the device on a light touch; a deliberate press still wakes it.
- **Apex: gamepad wake handling** (#160, #164) — Added an auto-recover-on-wake toggle and an optional `hid-oxp` driver blacklist to prevent the internal gamepad dropping out on wake. *(This wake behaviour was iterated across the next two releases — see 2026-06-26 and 2026-07-01.)*
- **RecompHub: GoldenEye + Snowboard Kids 2** (#167) — Two more N64 recomp/decomp titles in the catalog.

### Fixed
- **Apex: re-grab InputPlumber after a rebind** (#161) — After recovering the gamepad, InputPlumber is re-grabbed cleanly so the pad isn't read as a duplicate/dead controller.

### Docs
- README FAQ and a note clarifying Loadout runs in both Gaming Mode and Desktop Mode (#153, #154, #155).

## 2026-06-23

### Added
- **Apex plugin** (#150) — One-button recovery for the OneXPlayer Apex's internal gamepad when its xHCI USB controller dies on resume from sleep.

### Fixed
- **Installer no longer aborts before installing plugins/services**, and refreshes plugins on a re-run (#152).
- **Graceful overlay restart** to avoid a blank CEF webview after install (#151).

## 2026-06-22

### Added
- **"Save logs" button in Settings** (#133) — Export overlay logs for troubleshooting.
- **All plugins enabled by default** on the welcome screen, with a master toggle (#134).
- **Flowing game-card grid** with full-width tile buttons across plugins (#136).
- **RecompHub: TimeSplitters Rewind** added to the catalog (#146).

### Changed
- **Electrobun 1.16.0 → 1.18.1** (CEF 145 → 147) — overlay engine update (#135).

### Fixed
- **Window move/resize crash** fixed via a patched native wrapper (#132).
- **Stuck Guide/dpad state** cleared across overlay open/close (#139).
- **InputPlumber Restart button no longer bricks InputPlumber** (#147).
- **Reliable first-run auto-open** and correct window class (#149).
- **Curl installer fetches the SteamOS overlay lib closure** so fresh installs render (#148).

## 2026-06-19 — Initial public release

The first public build of **Loadout** — a controller-driven overlay you open over your game on handhelds (SteamOS, Bazzite, CachyOS), rendered with CEF and navigable entirely by gamepad. It takes D-pad/controller focus from games and Steam Big Picture (including external controllers) and ships with a full plugin suite:

- **Performance:** TDP Control (with per-game profiles as a cover grid), Fan Control, Battery Tracker, PlayTime
- **System:** Bluetooth, Display Settings, Network Info, RGB Control, Storage Cleaner, Flatpak Manager, InputPlumber, Disable Controller Input
- **Games:** SteamGridDB artwork, ProtonDB Badges, HowLongToBeat, Launch Options, LSFG-VK frame generation, Quick Links, Store Bridge, RecompHub (N64 recomps)
- **Theming:** Theme Loader, Sound Loader
- **Setup:** opens automatically for first-run setup, with a one-line installer

[//]: # (Older pre-launch history: PRs #2–#131 built the platform, migrated every)
[//]: # (plugin off the legacy app, and extracted the shared @loadout/* packages.)
