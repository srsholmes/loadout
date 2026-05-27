# Companion App

A mobile app that connects to the Loadout backend over the local network (or remotely via config sync service). Communicates with the same Bun server and WebSocket bridge that plugins use.

## Remote Control

- **Full remote QAM** — Every plugin panel accessible from phone
- **Remote game launching** — Browse library, launch a game before sitting down
- **Remote shutdown / sleep / restart**
- **Remote controller remapping** — Edit configs with phone keyboard
- **Remote keyboard input** — Type on phone, appears on Deck
- **Plugin settings editor** — Proper mobile UI for complex settings

## Session Dashboard

- **Live game session overlay** — Current game, duration, FPS, CPU/GPU temps, TDP, battery, RAM
- **Performance graphs** — Historical FPS, temps, power draw charts
- **Battery intelligence** — Projected time remaining, charge cycles, health percentage, custom threshold notifications
- **Download progress** — Live progress, speed, ETA, queue reorder, pause/resume, completion notifications
- **Achievement progress** — Live tracking, closest to completion, rare achievement alerts

## Notifications

- Download complete
- Game invite / friend activity
- Screenshot taken (with preview, one-tap share)
- Thermal warnings
- Battery thresholds (custom alerts at 30%, 100%)
- Game crash detection
- SteamOS update available
- Plugin compatibility alerts (post-update pass/fail status)

## Library and Game Management

- **Full library browser** — Filter by installed, genre, playtime, ProtonDB rating
- **ProtonDB ratings inline**
- **Playtime analytics** — Per game, per week/month, heatmap
- **Game notes** — Per-game notes synced to Deck QAM panel
- **Install queue management**
- **Hidden games manager**

## Screenshots and Media

- **Screenshot gallery** — Per game
- **One-tap sharing** — Twitter, Instagram, Reddit, Discord
- **Screenshot backup** — To phone camera roll or cloud
- **Clip management** — Preview, trim, rename, share, delete
- **Game artwork browser** — SteamGridDB integration

## Performance and Hardware

- **TDP profiles** — Create, save, switch named profiles
- **Fan curve editor** — Touch graph interface
- **Per-game performance profiles**
- **Storage manager** — Visual breakdown, delete games, clear caches
- **Hardware health history** — Battery health, thermal performance, storage trends

## Social and Multiplayer

- **Friend activity feed** — Live feed of what friends are playing
- **Game together suggestions** — "You and 3 friends all own Deep Rock Galactic"
- **Session invites** — Send/receive from companion app
- **Shared wishlists** — Browse, sale alerts, gifting

## Parental and Family Features

- **Remote monitoring** — Current game, play duration, battery
- **Session time limits** — Set from parent's phone, warning + optional suspend
- **Game approval** — Child requests, parent approves/denies
- **Bedtime enforcement** — Scheduled automatic sleep, weekend override

## Automation and Scripting

If-this-then-that style automations:
- "When battery drops below 20%, enable battery saver TDP profile"
- "When I launch Cyberpunk 2077, switch to my Cyberpunk CSS theme"
- "When a download completes between 11pm and 7am, shut down"
- "When the Deck connects to home WiFi, start queued downloads"

Additional:
- **Scheduled tasks** — Downloads, updates, restarts
- **Macros** — Record sequence of actions, trigger from one button

## Streaming and Content Creation

- **Stream status dashboard** — Viewer count, chat activity, bitrate, dropped frames
- **Read stream chat on phone** — Reply from keyboard, pin messages
- **Clip tagging** — Tap button to tag last 30 seconds as highlight
- **Stream alerts** — Follower, subscriber, donation notifications

## Multi-Device

- **Desktop Steam integration** — Companion app connects to both Deck and desktop
- **Handoff** — "Continue on Deck" — suspend on desktop, launch on Deck from same point
- **Cross-device notifications** — Unified activity feed

## Customisation

- **Theme editor** — Edit/preview CSS themes from companion app with live preview
- **Plugin manager** — Browse store, install/remove, view permissions
- **Layout editor** — Drag-drop reorder plugins in QAM and companion dashboard

## Genuinely Surprising Features

- **Deck as second screen source** — Mirror Deck screen to companion app
- **Voice commands via phone** — Wake words triggering loader actions
- **NFC triggers** — Tap NFC tag to trigger loader preset
- **Haptic feedback for game events** — Phone vibrates on achievement, low health, etc.
- **Accessibility remote** — Customised large-button controller for motor difficulties

## Most Differentiated

The features that no existing tool provides: automation/scripting, parental controls, per-game profiles triggered automatically, and stream chat on phone.
