# Plugin Ideas

## Already Exists (Room to Improve)

These plugins exist in Decky's ecosystem but could be significantly better with Loadout's capabilities:

- **Library tab customisation** (TabMaster) — Custom filtered tabs by any criteria
- **CSS theming** (CSS Loader) — Steam aesthetic overhaul
- **Performance overlays** (PowerTools, CryoUtilities) — TDP/clock/governor control
- **Non-Steam game library integration** (UnifiDeck) — Epic/GOG embedded in Steam library
- **Per-game performance profiles** — Automatically apply settings when a game launches

## Doable / Unexplored

These are feasible with Loadout's architecture and APIs but haven't been built:

### Smart Game Suggestions Panel
Hook `SteamClient.Apps` for library + playtime data, call external APIs (HLTB, ProtonDB, SteamDB), build a "what should I play tonight" recommendation panel with mood/time/compatibility filters. Pure `SteamClient` API — no fragile injection needed.

### Live Session Dashboard
Inject into the in-game overlay QAM showing real-time stats: achievement progress, hours played in current session, friend activity in the same game, ProtonDB reports, controller button reminders.

### Achievement Hunt Tracker
Subscribe to achievement unlock events, pull rarity data from Steam Web API, surface a "you're close to these" widget ordered by rarity/difficulty. Renders in QAM and on the game detail page.

### Custom Library Page Sections
Inject React components into game detail pages: "Community Tips" from ProtonDB, "Similar games you own" computed locally, HLTB completion estimates.

### Proton Compatibility Advisor
Hook the game launch event, check ProtonDB in real time, surface a toast with known workarounds before the game starts. Especially valuable for newly installed games.

### Download Queue Intelligence
Intercept download events, schedule during off-peak hours, prioritise by "upcoming play session" logic, show time estimates based on actual network speed history.

### Cross-Device Sync Beyond Steam Cloud
Watch `SteamClient.GameSessions` for session end, rsync save files to NAS/cloud for games without Steam Cloud support. Solves a real pain point for many games.

### Social Play Coordination
Read friend activity from `SteamClient.Friends`, detect when multiple friends are playing the same game, surface a "join them?" nudge with one-tap join.

## Deep / Experimental

These push the boundaries of what's possible and may require Layer 3-4 injection:

### Custom Store Front
HTTP request interception to augment store pages with HLTB times, IGDB scores, regional pricing history, historical sale prices inline. Requires Millennium-style request interception.

### XR / Second-Screen Extension
Drive a companion phone app showing stats, maps, and guides via WebSocket from the Bun backend. The companion app becomes a live second screen for any game.

### Controller Macro System
Intercept controller input events via `SteamClient` and Linux `evdev`, implement a per-game macro/combo system. Could enable accessibility features like simplified input for complex games.
