# Plan: Replicate Top Decky Plugins for Loadout

## Context

The user has 17 Decky plugins installed and wants equivalent functionality in the Loadout plugin system. The project already has 19 plugins covering many use cases. This plan identifies gaps, prioritizes new plugins by complexity, and provides implementation details for each.

## Coverage Assessment

### Already Covered (skip)
| Decky Plugin | Our Plugin | Status |
|---|---|---|
| decky-speed-test | `network-info` | Done |
| SDH-CssLoader (GPL-3) | `css-loader` | Done |
| PowerTools (GPL-3) | `tdp-control` + `fan-control` | Done |
| OneXPlayer Apex Tools | `tdp-control` | Done |
| vibrantDeck (LGPL-3) | `display-settings` | Done |
| decky-steamgriddb (GPL-3) | `steamgriddb` | Done |
| hltb-for-deck (MIT) | `hltb` | Done |
| loadout-launcher | Our own launcher | N/A |

### Needs Building (from installed Decky plugins)
| # | Decky Plugin | License | Complexity |
|---|---|---|---|
| 1 | Shotty | BSD-3 | Low |
| 2 | decky-autoflatpaks | BSD-3 | Low |
| 3 | decky-launch-options | MIT | Medium |
| 4 | SDH-AnimationChanger | BSD-3 | Medium |
| 5 | decky-lsfg-vk | BSD-3 | Medium |
| 6 | decky-terminal | BSD-3 | High |
| 7 | EmuDecky | AGPL-3 | Medium |
| 8 | RecompHub | None | Medium |
| 9 | TabMaster | GPL-3 | High (CEF) |

### Additional Top Plugins (not installed, high demand)
| # | Plugin | Complexity |
|---|---|---|
| 10 | MangoPeel (MangoHud config) | Low |
| 11 | MusicControl (DBUS media) | Medium |
| 12 | Decky Recorder | Medium |
| 13 | Controller Tools | Low |
| 14 | DeckMTP | Medium |
| 15 | DeckSettings | Medium |
| 16 | Game Theme Music | Medium |
| 17 | Junk Store (Epic/GOG) | Very High |

### License Strategy
- **BSD-3 / MIT plugins**: Can reference Decky source, translate Python to TS
- **GPL-3 / AGPL-3 plugins** (TabMaster, EmuDecky): Write from scratch, do NOT reference source code. Use only public API docs and feature descriptions
- All our plugins will be BSD-3 or MIT licensed

---

## Shared Utilities (build first)

Before building plugins, extract common patterns into reusable modules. Multiple existing plugins duplicate this logic.

### 1. VDF Parser/Writer — `packages/loader/src/vdf.ts`
- Parse Valve Data Format (used by localconfig.vdf, libraryfolders.vdf, appmanifest_*.acf)
- Currently duplicated with regex in: `game-browser/backend.ts`, `storage-cleaner/backend.ts`, `playtime/backend.ts`
- Needed by: launch-options, animation-changer, deck-settings, junk-store

### 2. Steam Path Resolver — `packages/loader/src/steam-paths.ts`
- Resolve Steam install dir (standard, Flatpak, custom)
- Parse `libraryfolders.vdf` for all library folders
- Return userdata paths, steamapps paths
- Currently best implementation in `game-browser/backend.ts` `getLibraryPaths()`
- Needed by: launch-options, animation-changer, shotty, deck-settings

### 3. Shell Exec Helper — `packages/loader/src/exec.ts`
- Standardized `run(cmd, args)` returning `{stdout, stderr, exitCode}`
- `commandExists(name)` check
- Currently duplicated in: `bluetooth/backend.ts`, `display-settings/backend.ts`, `rgb-control/backend.ts`
- Needed by: nearly every new plugin

---

## Phase 1: Quick Wins (1-2 hours each)

### Plugin 1: `screenshots` (Shotty replacement)
**Source ref:** `~/homebrew/plugins/Shotty/` (BSD-3, can reference)

**What it does:** Copy Steam screenshots to ~/Pictures, browse, delete

**Backend (`plugins/screenshots/backend.ts`):**
```
getScreenshots(): Screenshot[]     — scan ~/.local/share/Steam/userdata/*/760/remote/*/screenshots/
copyToPhotos(paths: string[]): {copied, errors}  — cp to ~/Pictures/Screenshots/
deleteScreenshots(paths: string[]): {deleted}
openFolder(path: string): void    — xdg-open
```

**Frontend (`plugins/screenshots/app.tsx`):**
- Full page: thumbnail grid with checkboxes, "Copy All" / "Delete" buttons
- QAM widget: latest screenshot count, quick copy button

**Dependencies:** `cp`, `xdg-open`, filesystem access

### Plugin 2: `flatpak-manager` (decky-autoflatpaks replacement)
**Source ref:** `~/homebrew/plugins/decky-autoflatpaks/` (BSD-3, can reference)

**What it does:** List Flatpaks, check/apply updates, cleanup unused

**Backend (`plugins/flatpak-manager/backend.ts`):**
```
getInstalled(): FlatpakApp[]       — flatpak list --app --columns=...
checkUpdates(): FlatpakUpdate[]    — flatpak remote-ls --updates
updateAll(): void                  — flatpak update -y (stream progress via events)
updateApp(appId): void             — flatpak update -y <appId>
removeUnused(): {removed: string[]} — flatpak uninstall --unused -y
```

**Frontend (`plugins/flatpak-manager/app.tsx`):**
- Full page: app list with size, version, update badges
- QAM widget: update count badge, "Update All" button

**Dependencies:** `flatpak` CLI

### Plugin 3: `mangopeel` (MangoHud configuration)
**Source ref:** Write from scratch (MangoHud config format is documented)

**What it does:** Toggle MangoHud, edit config, presets

**Backend (`plugins/mangopeel/backend.ts`):**
```
getConfig(): MangoHudConfig        — parse ~/.config/MangoHud/MangoHud.conf (key=value)
setConfig(config): void            — write back
getPresets(): Preset[]             — built-in presets (minimal, full, fps-only, battery)
applyPreset(name): void
isInstalled(): boolean             — which mangohud
```

**Frontend (`plugins/mangopeel/app.tsx`):**
- Full page: toggle switches for each MangoHud option, position selector, preset buttons
- QAM widget: quick preset switcher, toggle

**Dependencies:** MangoHud installed, `~/.config/MangoHud/MangoHud.conf`

### Plugin 4: `controller-info` (Controller Tools replacement)
**Source ref:** Write from scratch

**What it does:** Show connected controllers, battery %, connection type (BT/USB)

**Backend (`plugins/controller-info/backend.ts`):**
```
getControllers(): Controller[]     — parse /sys/class/power_supply/ for gamepad batteries
                                     + /sys/class/input/ for input devices
                                     + bluetoothctl info for BT connection type
pollControllers(): void            — emit events on change (2s interval)
```

**Frontend (`plugins/controller-info/app.tsx`):**
- QAM widget only: compact list of controllers with battery bars and BT/USB icon
- Extends existing `battery-tracker` or coexists alongside it

**Dependencies:** sysfs, `bluetoothctl`

---

## Phase 2: Medium Complexity (2-4 hours each)

### Plugin 5: `launch-options` (decky-launch-options replacement)
**Source ref:** `~/homebrew/plugins/decky-launch-options/` (MIT, can reference)
**Prereq:** Shared VDF parser + Steam path resolver

**What it does:** View/edit game launch options, save presets

**Backend (`plugins/launch-options/backend.ts`):**
```
getGames(): GameLaunchOption[]           — parse localconfig.vdf for all games with launch options
getLaunchOptions(appId): string          — get current options for one game
setLaunchOptions(appId, opts): void      — modify localconfig.vdf (needs VDF writer)
getPresets(): LaunchPreset[]             — saved presets (mangohud, gamescope, etc.)
savePreset(preset): void
applyPreset(appId, presetName): void     — append preset to launch options
```

**Frontend:** Full page with game list, editable text fields, preset chips

**Dependencies:** VDF parser/writer, Steam userdata path

### Plugin 6: `animation-changer` (SDH-AnimationChanger replacement)
**Source ref:** `~/homebrew/plugins/SDH-AnimationChanger/` (BSD-3, can reference)

**What it does:** Swap boot/suspend/throbber animations

**Backend (`plugins/animation-changer/backend.ts`):**
```
getCurrentAnimations(): AnimationSet       — check ~/.local/share/Steam/steamui/movies/
getAvailableAnimations(): Animation[]      — list ~/.config/loadout/animations/
applyAnimation(type, path): void           — backup original, copy/symlink new
revertAnimation(type): void                — restore backup
importAnimation(localPath): void           — copy to animations dir
deleteAnimation(name): void
```

**Frontend:** Full page with current animation preview, browse available, apply/revert buttons

**Dependencies:** `~/.local/share/Steam/steamui/movies/`, filesystem

### Plugin 7: `screen-recorder` (Decky Recorder replacement)
**Source ref:** Write from scratch (CLI wrapper)

**What it does:** Record screen, replay buffer, save clips

**Backend (`plugins/screen-recorder/backend.ts`):**
```
detectRecorder(): string                — check gpu-screen-recorder, wf-recorder
getStatus(): RecorderStatus             — is recording? replay buffer active?
startRecording(opts): void              — spawn gpu-screen-recorder
stopRecording(): {path}                 — kill process, return file
startReplayBuffer(seconds): void        — gpu-screen-recorder -r <n>
saveReplay(): {path}                    — signal to save buffer
getRecordings(): Recording[]            — list ~/Videos/SteamLoader/
getSettings(): RecorderSettings
updateSettings(s): void
```

**Frontend:** QAM widget with record/stop button + replay save. Full page with recording list and settings.

**Dependencies:** `gpu-screen-recorder` (preferred) or `wf-recorder`

### Plugin 8: `music-control` (DBUS MusicControl replacement)
**Source ref:** Write from scratch (MPRIS2 is a standard)

**What it does:** Control system media players (Spotify, Firefox, etc.) via DBUS

**Backend (`plugins/music-control/backend.ts`):**
```
getPlayers(): MediaPlayer[]             — playerctl -l (or busctl)
getPlaybackInfo(player): PlaybackInfo   — playerctl metadata + status
play/pause/next/previous(player): void  — playerctl commands
setVolume(player, vol): void
pollPlayback(): void                    — emit events every 2s
```

**Frontend:** QAM widget with now-playing card (art, title, artist), transport controls, volume slider

**Dependencies:** `playerctl` (preferred) or `dbus-send`/`busctl`

### Plugin 9: `lsfg-vk` (Lossless Scaling Frame Generation)
**Source ref:** `~/homebrew/plugins/decky-lsfg-vk/` (BSD-3, can reference)

**What it does:** Enable/configure Vulkan frame generation layer

**Backend (`plugins/lsfg-vk/backend.ts`):**
```
isInstalled(): boolean                  — check ~/.local/share/vulkan/implicit_layer.d/
getStatus(): LsfgStatus                — current settings, enabled/disabled
getSettings(): LsfgSettings            — FG multiplier, quality mode
updateSettings(s): void                — write config
enableGlobal(): void                   — set VK_LAYER env
disableGlobal(): void
getPerGameConfig(appId): LsfgSettings | null
setPerGameConfig(appId, s): void       — set in launch options
```

**Frontend:** Full page with global toggle, FG mode selector, per-game config list. QAM widget with quick toggle.

**Dependencies:** LSFG-VK Vulkan layer installed, Vulkan layer config files

### Plugin 10: `emudeck` (EmuDecky replacement)
**Source ref:** Write from scratch (AGPL-3, do NOT reference source)

**What it does:** Dashboard for EmuDeck emulator suite

**Backend (`plugins/emudeck/backend.ts`):**
```
isInstalled(): boolean                  — check ~/emudeck/ or ~/Emulation/
getEmulators(): Emulator[]              — scan for RetroArch, Dolphin, PCSX2, etc. (Flatpak + AppImage)
getEmulatorStatus(name): Status         — installed? version?
getRomCounts(): {system, path, count}[] — count ROMs per system dir
launchEmulator(name): void              — flatpak run or exec AppImage
runSetup(): void                        — launch EmuDeck wizard
```

**Frontend:** Full page dashboard with emulator grid, ROM counts, launch buttons

**Dependencies:** EmuDeck at `~/emudeck/` or `~/Emulation/`, emulator Flatpaks

### Plugin 11: `recomp-hub` (RecompHub replacement)
**Source ref:** Write from scratch (no license specified, safer to rewrite)

**What it does:** Browse and install statically recompiled N64/PS1 game ports

**Backend (`plugins/recomp-hub/backend.ts`):**
```
getAvailable(): Recomp[]                — fetch from community index (GitHub releases)
getInstalled(): InstalledRecomp[]       — scan ~/Applications/Recomps/ or similar
install(recomp): void                   — download, chmod +x, create .desktop
uninstall(name): void
launch(name): void
checkUpdates(): RecompUpdate[]
```

**Frontend:** Full page gallery with cover art, install/launch/update buttons, download progress

**Dependencies:** Network access to GitHub, `chmod`, `xdg-desktop-menu`

---

## Phase 3: Complex (4+ hours each)

### Plugin 12: `terminal` (decky-terminal replacement)
**Source ref:** `~/homebrew/plugins/decky-terminal/` (BSD-3, can reference)

**What it does:** Full terminal emulator with xterm.js frontend + PTY backend

**Backend (`plugins/terminal/backend.ts`):**
```
createSession(shell?): sessionId        — spawn PTY via Bun.spawn with pty
write(sessionId, data): void            — write to PTY stdin
resize(sessionId, cols, rows): void     — resize PTY (SIGWINCH)
getSessions(): TerminalSession[]
closeSession(sessionId): void
Events: terminalOutput (stream stdout chunks)
```

**Frontend (`plugins/terminal/app.tsx`):**
- Full page with xterm.js renderer
- Tab bar for multiple sessions
- Touch keyboard support
- npm dep: `xterm`, `xterm-addon-fit`, `xterm-addon-web-links`

**Key challenge:** Bun's `Bun.spawn` doesn't natively support PTY allocation. Options:
1. Use `script -q /dev/null <shell>` to force PTY allocation
2. Use `socat` as PTY wrapper
3. Bundle a small native helper for PTY creation
4. Check if `node-pty` works under Bun (likely does via N-API)

**Dependencies:** xterm.js (npm), PTY allocation mechanism

### Plugin 13: `tab-master` (TabMaster replacement)
**Source ref:** Write from scratch (GPL-3, do NOT reference source)

**What it does:** Custom library tabs with filters, hide/reorder tabs

**Backend (`plugins/tab-master/backend.ts`):**
```
getTabs(): Tab[]                        — get library tabs via CDP injection
createTab(config): void                 — inject custom tab via CDP JavaScript
removeTab(id): void
reorderTabs(order): void
hideTab(id): void
getFilters(): Filter[]                  — genre, tag, controller support, etc.
saveConfig(tabs): void                  — persist to disk
```

**Requires:** CEF injection via CDP (same infrastructure as `protondb-badges` and `css-loader`). Fragile - Steam updates can break injection.

**Frontend:** Full page with tab list, drag-to-reorder, filter builder dialog

**Dependencies:** Steam CEF debug port (localhost:8080), CDP WebSocket

### Plugin 14: `deck-mtp` (DeckMTP replacement)
**Source ref:** Write from scratch

**What it does:** Enable device as MTP storage when USB-connected

**Backend:**
```
getStatus(): MtpStatus                  — check umtp-responder/mtp-server running
startMtp(paths): void                   — start MTP server exposing directories
stopMtp(): void
getExposedPaths(): string[]
setExposedPaths(paths): void
```

**Dependencies:** `umtp-responder`, USB gadget kernel support

### Plugin 15: `deck-settings` (Community Performance Settings)
**Source ref:** Write from scratch

**What it does:** Community-sourced per-game TDP/GPU/fan settings

**Backend:**
```
searchSettings(appId): GameSetting[]    — query community API
applySettings(appId, profile): void     — cross-plugin RPC to tdp-control
getLocalProfiles(): SavedProfile[]
saveProfile(profile): void
submitSettings(appId, profile): void    — contribute back
```

**Key challenge:** Needs a community data source/API. Start with local profiles, add sharing later.

### Plugin 16: `game-theme-music` (Game Theme Music replacement)
**Source ref:** Write from scratch

**What it does:** Play theme songs when browsing game pages

**Backend:**
```
getThemeForGame(appId): ThemeInfo | null — lookup from theme database
playTheme(appId): void                  — play via mpv/paplay
stopTheme(): void
setVolume(vol): void
downloadThemes(): void                  — bulk download from community source
```

**Dependencies:** `mpv` or audio playback mechanism, theme source

### Plugin 17: `junk-store` (Non-Steam Game Launcher)
**Source ref:** Write from scratch (massive scope)

**What it does:** Browse/install Epic, GOG, Amazon games

**Backend:**
```
getStores(): Store[]
authenticateStore(store, creds): void   — login to Epic/GOG
getLibrary(store): StoreGame[]
installGame(store, gameId): void        — download via legendary/gogdl
addToSteam(game): void                  — add non-Steam shortcut
getProgress(): InstallProgress
```

**Dependencies:** `legendary` (Epic), `gogdl` (GOG), Proton, Steam shortcuts VDF

**Note:** This is essentially building a game launcher. Consider deferring or treating as a separate project.

---

## Implementation Order

```
Prereqs:  shared/exec.ts → shared/steam-paths.ts → shared/vdf.ts

Phase 1 (quick wins) — DONE:
  1. screenshots ✓
  2. flatpak-manager ✓
  3. mangopeel ✓
  4. controller-info ✓

Phase 2 (medium) — DONE:
  5. launch-options ✓
  6. animation-changer ✓
  7. screen-recorder ✓
  8. music-control ✓
  9. lsfg-vk ✓
  10. emudeck ✓
  11. recomp-hub — deferred (will be standalone plugin ported from recomp-launcher)

Phase 3 (complex, do last):
  12. terminal (PTY challenge)
  13. tab-master (CEF injection, fragile)
  14. deck-mtp
  15. deck-settings (needs community API)
  16. game-theme-music
  17. junk-store (massive scope, consider deferring)
```

## Verification

For each plugin:
1. `bun run dev` — start dev server
2. Open `http://localhost:33820/overlay` — verify plugin appears in QAM sidebar
3. Test each backend method via the UI
4. Test QAM widget renders correctly
5. Test full page view (if applicable)
6. Test gamepad navigation works
7. Verify no console errors

For shared utilities:
1. Write unit tests for VDF parser (round-trip parse → serialize)
2. Test Steam path resolution on both standard and Flatpak Steam installs
