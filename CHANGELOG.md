# Changelog

All notable user-facing changes to Loadout.

Until now, releases have shipped as a single rolling build that's rebuilt from `main` on demand, so there are no version numbers yet — entries below are grouped by the date each build was published, and reconstructed by cross-referencing the pull requests that had merged at the time. Proper semantic versioning and a fixed release cadence are coming next.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com).

---

## 2026-07-01

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
